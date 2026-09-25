# Environment Doctor
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **DOC** · Phase **P2**

A deep diagnostic run over KalCode, providers, developer tools, the system and the current
project. Each finding offers Details / Fix / Ignore.

## Checks

KalCode (database integrity, migrations, data-folder permissions, disk, logs, WebView runtime) ·
providers (read from Provider Health, never re-probed) · developer tools (read-only `--version`
probes) · system (OS, long paths, PATH sanity, shells, memory, disk) · project (repository state,
`.env` ignored, large files, lockfiles). A check that cannot run reports "could not check".

## Fixes

Chosen from a fixed catalog of typed operations (never free-form commands). Each fix is explained
before it runs (what changes, which permission scopes, how to undo), goes through the Trust
Kernel with origin `doctor`, is reversible where practical (checkpoint or recorded inverse), and
is logged. **Nothing is ever changed automatically.** Installing software defaults to showing the
command.

## Placement

Settings → Environment Doctor; warnings also appear in the Command Center.
