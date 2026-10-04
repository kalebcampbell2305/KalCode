"""Compare actual closed app databases read-only; never emit row contents."""
import collections
from contextlib import closing
import json
import sqlite3
import sys
from pathlib import Path


def compare(live, candidate, version, schema, live_expected=None):
    def connect(path):
        return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)

    def quote(name):
        return '"' + name.replace('"', '""') + '"'

    def tables(db):
        return [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]

    def cols(db, table):
        return [row[1] for row in db.execute(f"PRAGMA table_info({quote(table)})")]

    with closing(connect(live)) as before, closing(connect(candidate)) as after:
        differences, kept, grew = [], 0, {}
        available = set(tables(after))
        for table in tables(before):
            if table not in available:
                differences.append(f"missing table: {table}")
                continue
            names = cols(before, table)
            if not set(names).issubset(cols(after, table)):
                differences.append(f"lost columns: {table}")
                continue
            query = f"SELECT {', '.join(map(quote, names))} FROM {quote(table)}"
            old, new = list(before.execute(query)), list(after.execute(query))
            if table == "app_meta":
                k, v = names.index("key"), names.index("value")
                old_keys, new_keys = {r[k] for r in old}, {r[k] for r in new}
                if old_keys - new_keys:
                    differences.append("app_meta lost keys")
                if [r[v] for r in new if r[k] == "last_version"] != [version]:
                    differences.append("app_meta candidate version mismatch")
                stable_old = collections.Counter(r for r in old if r[k] != "last_version")
                stable_new = collections.Counter(r for r in new if r[k] != "last_version")
                if stable_old - stable_new:
                    differences.append("app_meta changed non-launch metadata")
                stable_columns = [i for i, name in enumerate(names) if name not in ("value", "updated_at")]
                launch = lambda rows: collections.Counter(tuple(r[i] for i in stable_columns) for r in rows if r[k] == "last_version")
                if launch(old) - launch(new):
                    differences.append("app_meta changed stable launch columns")
                kept += len(old_keys & new_keys)
            else:
                lost = collections.Counter(old) - collections.Counter(new)
                if lost:
                    differences.append(f"{table}: {sum(lost.values())} live rows missing or changed")
                kept += len(old) - sum(lost.values())
            if len(new) > len(old):
                grew[table] = len(new) - len(old)
        def migration(db):
            return db.execute("SELECT COALESCE(MAX(version),0) FROM schema_migrations").fetchone()[0]
        live_schema, candidate_schema = migration(before), migration(after)
        if live_expected is None:
            live_expected = schema
        if live_schema != live_expected or candidate_schema != schema:
            differences.append("database schema does not match pinned live/candidate schemas")
        return dict(liveSchema=live_schema, candidateSchema=candidate_schema,
                    rowsKept=kept, tablesGrew=grew, differences=differences)


if __name__ == "__main__":
    print(json.dumps(compare(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]),
                             int(sys.argv[5]) if len(sys.argv) > 5 else None)))
