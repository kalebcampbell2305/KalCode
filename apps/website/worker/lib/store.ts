/** Persistence for the early-access list. The interface lets tests use an in-memory fake. */

export interface EarlyAccessEntry {
  email: string;
  source: string | null;
  createdAt: string;
  consentVersion: string;
}

export interface EarlyAccessStore {
  /** Adds the address; an address already on the list is left untouched (no error). */
  add(entry: EarlyAccessEntry): Promise<void>;
  /** Removes the address if present; removing an unknown address is not an error. */
  remove(email: string): Promise<void>;
}

export function d1Store(db: D1Database): EarlyAccessStore {
  return {
    async add(entry) {
      await db
        .prepare(
          "INSERT INTO early_access (email, created_at, source, consent_version) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO NOTHING",
        )
        .bind(entry.email, entry.createdAt, entry.source, entry.consentVersion)
        .run();
    },
    async remove(email) {
      await db.prepare("DELETE FROM early_access WHERE email = ?1").bind(email).run();
    },
  };
}
