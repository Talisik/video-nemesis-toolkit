import Database from "better-sqlite3";

/**
 * Open SQLite at dbPath. Caller must call db.close() when done.
 * Shared: use for any code that needs a connection (scheduler, workers, app).
 */
export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: false });
}
