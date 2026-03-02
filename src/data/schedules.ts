import Database from "better-sqlite3";
import type { ScheduleRow } from "../types/index.js";

const TABLE = "schedules";
const COLS = "id, name, created_at, updated_at";

export function listSchedules(db: Database.Database): ScheduleRow[] {
  return db
    .prepare(`SELECT ${COLS} FROM ${TABLE} ORDER BY id ASC`)
    .all() as ScheduleRow[];
}

export function getScheduleById(
  db: Database.Database,
  id: number
): ScheduleRow | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM ${TABLE} WHERE id = ?`)
    .get(id) as ScheduleRow | undefined;
  return row ?? null;
}

export function createSchedule(
  db: Database.Database,
  row: Omit<ScheduleRow, "id" | "created_at" | "updated_at">
): ScheduleRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${TABLE} (name, created_at, updated_at) VALUES (?, ?, ?)`
  ).run(
    row.name ?? null,
    now,
    now
  );
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  return getScheduleById(db, id) as ScheduleRow;
}

export function updateSchedule(
  db: Database.Database,
  id: number,
  updates: Partial<Pick<ScheduleRow, "name">>
): void {
  const now = new Date().toISOString();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (fields.length === 1) return;
  values.push(id);
  db.prepare(`UPDATE ${TABLE} SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteSchedule(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
}
