import Database from "better-sqlite3";
import type { ScheduleRow } from "../types/index.js";
import { getNextOccurrence } from "./channelSlots.js";

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

export interface ScheduleWithNextScrape extends ScheduleRow {
  next_scrape_at: string | null;
}

/**
 * List all schedules with the soonest next_scrape_at across their channels.
 * Considers both intelligent schedules and manual channel slots.
 */
export function listSchedulesWithNextScrape(db: Database.Database): ScheduleWithNextScrape[] {
  const schedules = listSchedules(db);
  if (schedules.length === 0) return [];

  // Intelligent schedule: soonest next_scrape_time per schedule
  const intelligentRows = db.prepare(`
    SELECT c.schedule_id, MIN(i.next_scrape_time) AS next_scrape_time
    FROM intelligent_schedule i
    JOIN channels c ON c.id = i.channel_id AND c.active = 1
    GROUP BY c.schedule_id
  `).all() as { schedule_id: number; next_scrape_time: string }[];

  const intelligentBySchedule = new Map(
    intelligentRows.map(r => [r.schedule_id, r.next_scrape_time])
  );

  // Manual slots: compute next occurrence per schedule
  const slotRows = db.prepare(`
    SELECT c.schedule_id, cs.day_of_week, cs.time_minutes
    FROM channel_slots cs
    JOIN channels c ON c.id = cs.channel_id AND c.active = 1
  `).all() as { schedule_id: number; day_of_week: number; time_minutes: number }[];

  const now = new Date();
  const slotBySchedule = new Map<number, string>();
  for (const s of slotRows) {
    const next = getNextOccurrence(now, s.day_of_week, s.time_minutes);
    const nextIso = next.toISOString();
    const current = slotBySchedule.get(s.schedule_id);
    if (!current || nextIso < current) {
      slotBySchedule.set(s.schedule_id, nextIso);
    }
  }

  return schedules.map(schedule => {
    const intelligent = intelligentBySchedule.get(schedule.id) ?? null;
    const slot = slotBySchedule.get(schedule.id) ?? null;

    let next_scrape_at: string | null = null;
    if (intelligent && slot) {
      next_scrape_at = intelligent < slot ? intelligent : slot;
    } else {
      next_scrape_at = intelligent ?? slot;
    }

    return { ...schedule, next_scrape_at };
  });
}
