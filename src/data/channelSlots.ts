import Database from "better-sqlite3";
import type { ChannelSlotRow } from "../types/index.js";

const TABLE = "channel_slots";

/**
 * Next occurrence of (dayOfWeek, timeMinutes) on or after from (local time).
 * dayOfWeek: 0=Sunday, 1=Monday, ... 6=Saturday.
 * timeMinutes: 0–1439 (minutes since midnight).
 */
export function getNextOccurrence(
  from: Date,
  dayOfWeek: number,
  timeMinutes: number
): Date {
  const fromDay = from.getDay();
  const fromMinutes = from.getHours() * 60 + from.getMinutes();
  let daysAhead = dayOfWeek - fromDay;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0 && timeMinutes <= fromMinutes) daysAhead = 7;
  const next = new Date(from);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(
    Math.floor(timeMinutes / 60),
    timeMinutes % 60,
    0,
    0
  );
  return next;
}

/**
 * Last occurrence of (dayOfWeek, timeMinutes) that is before or at asOf (local time).
 * Used for past-due: if this time is after last_scraped_at, the slot is past due.
 */
export function getPreviousOccurrence(
  asOf: Date,
  dayOfWeek: number,
  timeMinutes: number
): Date {
  const d = new Date(asOf);
  d.setDate(d.getDate() - d.getDay() + dayOfWeek);
  d.setHours(
    Math.floor(timeMinutes / 60),
    timeMinutes % 60,
    0,
    0
  );
  if (d.getTime() > asOf.getTime()) {
    d.setDate(d.getDate() - 7);
  }
  return d;
}

export function listSlotsByChannelId(
  db: Database.Database,
  channelId: number
): ChannelSlotRow[] {
  return db
    .prepare(
      `SELECT id, channel_id, day_of_week, time_minutes FROM ${TABLE} WHERE channel_id = ? ORDER BY day_of_week ASC, time_minutes ASC`
    )
    .all(channelId) as ChannelSlotRow[];
}

export function addSlot(
  db: Database.Database,
  channelId: number,
  dayOfWeek: number,
  timeMinutes: number
): ChannelSlotRow {
  db.prepare(
    `INSERT INTO ${TABLE} (channel_id, day_of_week, time_minutes) VALUES (?, ?, ?)`
  ).run(channelId, dayOfWeek, timeMinutes);
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  return db.prepare(`SELECT id, channel_id, day_of_week, time_minutes FROM ${TABLE} WHERE id = ?`).get(id) as ChannelSlotRow;
}

/**
 * Replace all slots for a channel with the given day/time pairs.
 */
export function replaceSlotsForChannel(
  db: Database.Database,
  channelId: number,
  slots: { day_of_week: number; time_minutes: number }[]
): void {
  db.prepare(`DELETE FROM ${TABLE} WHERE channel_id = ?`).run(channelId);
  const stmt = db.prepare(
    `INSERT INTO ${TABLE} (channel_id, day_of_week, time_minutes) VALUES (?, ?, ?)`
  );
  for (const s of slots) {
    stmt.run(channelId, s.day_of_week, s.time_minutes);
  }
}

/**
 * Channel IDs that have at least one slot whose previous occurrence (before or at asOf) is after last_scraped_at.
 * Any slot can trigger past-due (e.g. same day: last scraped 8am, open at 3pm → 11am and 2pm past due → run once).
 */
export function getPastDueChannelIds(
  db: Database.Database,
  asOf: Date
): number[] {
  const slotRows = db
    .prepare(
      `SELECT channel_id, day_of_week, time_minutes FROM ${TABLE}`
    )
    .all() as { channel_id: number; day_of_week: number; time_minutes: number }[];
  if (slotRows.length === 0) return [];
  const channelIds = [...new Set(slotRows.map((r) => r.channel_id))];
  const placeholders = channelIds.map(() => "?").join(",");
  const channelsWithLast = db
    .prepare(
      `SELECT id, last_scraped_at FROM channels WHERE id IN (${placeholders})`
    )
    .all(...channelIds) as { id: number; last_scraped_at: string | null }[];
  const lastScrapedByChannel = new Map(
    channelsWithLast.map((c) => [c.id, c.last_scraped_at])
  );
  const slotsByChannel = new Map<
    number,
    { day_of_week: number; time_minutes: number }[]
  >();
  for (const r of slotRows) {
    if (!slotsByChannel.has(r.channel_id)) {
      slotsByChannel.set(r.channel_id, []);
    }
    slotsByChannel.get(r.channel_id)!.push({
      day_of_week: r.day_of_week,
      time_minutes: r.time_minutes,
    });
  }
  const pastDueIds: number[] = [];
  for (const chId of channelIds) {
    const L = lastScrapedByChannel.get(chId) ?? null;
    if (L == null) continue; // Never scraped: only run when a slot is "due now", not past-due (avoids running when user just added a future slot)
    const Ltime = new Date(L).getTime();
    const slots = slotsByChannel.get(chId) ?? [];
    for (const slot of slots) {
      const prev = getPreviousOccurrence(
        asOf,
        slot.day_of_week,
        slot.time_minutes
      );
      if (prev.getTime() > Ltime) {
        pastDueIds.push(chId);
        break;
      }
    }
  }
  return pastDueIds;
}

/**
 * Channel IDs that are due now: same day and current time is at or past the slot time, within the window after.
 * So a 9:00 slot with 15min window is due from 9:00 to 9:15, not before 9:00.
 * Slot is due when: time_minutes <= currentTimeMinutes (we've reached it) and time_minutes > currentTimeMinutes - window (within window).
 */
export function getDueChannelIds(
  db: Database.Database,
  day: number,
  currentTimeMinutes: number,
  windowMinutes: number
): number[] {
  const hi = currentTimeMinutes;
  const lo = Math.max(0, currentTimeMinutes - windowMinutes);
  const rows = db
    .prepare(
      `SELECT channel_id FROM ${TABLE} WHERE day_of_week = ? AND time_minutes > ? AND time_minutes <= ? ORDER BY time_minutes ASC`
    )
    .all(day, lo, hi) as { channel_id: number }[];
  return [...new Set(rows.map((r) => r.channel_id))];
}

/**
 * Recurring slots: nothing to consume. No-op.
 */
export function deleteConsumedRunAts(
  _db: Database.Database,
  _channelIds: number[],
  _beforeOrAt: Date
): void {
  // no-op: slots are recurring by day_of_week + time_minutes
}

export function hasAnyChannelSlots(db: Database.Database): boolean {
  const row = db.prepare(`SELECT 1 FROM ${TABLE} LIMIT 1`).get();
  return row != null;
}

/**
 * Milliseconds from fromDate until the next slot start (any channel_slot), in local time.
 */
export function getNextSlotStartMs(
  db: Database.Database,
  fromDate: Date
): number | null {
  const next = getNextRunAt(fromDate, db);
  if (!next) return null;
  return Math.max(0, next.getTime() - fromDate.getTime());
}

/**
 * Next run datetime (local), or null if no slots. Computed from all (day_of_week, time_minutes).
 */
export function getNextRunAt(
  fromDate: Date,
  db: Database.Database
): Date | null {
  const rows = db
    .prepare(
      `SELECT day_of_week, time_minutes FROM ${TABLE} ORDER BY day_of_week ASC, time_minutes ASC`
    )
    .all() as { day_of_week: number; time_minutes: number }[];
  if (rows.length === 0) return null;
  let next: Date | null = null;
  for (const r of rows) {
    const candidate = getNextOccurrence(fromDate, r.day_of_week, r.time_minutes);
    if (next == null || candidate.getTime() < next.getTime()) next = candidate;
  }
  return next;
}

/**
 * For API compatibility: return next run as ISO string (using local time converted to Date).
 */
export function getNextRunAtIso(db: Database.Database, fromDate: Date): string | null {
  const d = getNextRunAt(fromDate, db);
  return d ? d.toISOString() : null;
}

