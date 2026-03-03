import Database from "better-sqlite3";
import type { ChannelIntervalRow } from "../types/index.js";

const TABLE = "channel_intervals";

/**
 * Get interval row for a channel, if any.
 */
export function getByChannelId(
  db: Database.Database,
  channelId: number
): ChannelIntervalRow | null {
  return db
    .prepare(
      `SELECT channel_id, interval_minutes FROM ${TABLE} WHERE channel_id = ?`
    )
    .get(channelId) as ChannelIntervalRow | undefined ?? null;
}

/**
 * Set or replace interval for a channel. interval_minutes must be > 0 (e.g. 4320 = 3 days).
 */
export function set(
  db: Database.Database,
  channelId: number,
  intervalMinutes: number
): ChannelIntervalRow {
  db.prepare(
    `INSERT INTO ${TABLE} (channel_id, interval_minutes) VALUES (?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET interval_minutes = excluded.interval_minutes`
  ).run(channelId, intervalMinutes);
  return db
    .prepare(`SELECT channel_id, interval_minutes FROM ${TABLE} WHERE channel_id = ?`)
    .get(channelId) as ChannelIntervalRow;
}

/**
 * Remove interval for a channel (revert to slot-only or no schedule).
 */
export function remove(db: Database.Database, channelId: number): void {
  db.prepare(`DELETE FROM ${TABLE} WHERE channel_id = ?`).run(channelId);
}

/**
 * Channel IDs that have an interval and are due (last_scraped_at + interval_minutes <= now, or never scraped).
 */
export function getDueChannelIds(
  db: Database.Database,
  asOf: Date
): number[] {
  const asOfMs = asOf.getTime();
  const rows = db
    .prepare(
      `SELECT c.id AS channel_id, c.last_scraped_at, i.interval_minutes
       FROM channels c
       INNER JOIN ${TABLE} i ON i.channel_id = c.id
       WHERE c.active = 1`
    )
    .all() as {
    channel_id: number;
    last_scraped_at: string | null;
    interval_minutes: number;
  }[];
  const due: number[] = [];
  for (const r of rows) {
    if (r.last_scraped_at == null) {
      due.push(r.channel_id);
      continue;
    }
    const lastMs = new Date(r.last_scraped_at).getTime();
    if (lastMs + r.interval_minutes * 60 * 1000 <= asOfMs) due.push(r.channel_id);
  }
  return due;
}

/**
 * Whether any channel has an interval (interval-driven mode exists).
 */
export function hasAnyChannelIntervals(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM ${TABLE} LIMIT 1`).get() != null;
}

/**
 * Milliseconds from fromDate until the next time an interval channel is due (last_scraped_at + interval).
 * Returns null if no intervals or no channel is due in the future (all already due).
 */
export function getNextIntervalDueMs(
  db: Database.Database,
  fromDate: Date
): number | null {
  const fromMs = fromDate.getTime();
  const rows = db
    .prepare(
      `SELECT c.id, c.last_scraped_at, i.interval_minutes
       FROM channels c INNER JOIN ${TABLE} i ON i.channel_id = c.id WHERE c.active = 1`
    )
    .all() as { id: number; last_scraped_at: string | null; interval_minutes: number }[];
  let nextMs: number | null = null;
  for (const r of rows) {
    const lastMs = r.last_scraped_at != null ? new Date(r.last_scraped_at).getTime() : 0;
    const dueAtMs = lastMs + r.interval_minutes * 60 * 1000;
    if (dueAtMs > fromMs) {
      const delta = dueAtMs - fromMs;
      if (nextMs == null || delta < nextMs) nextMs = delta;
    } else {
      // Already due; next run is "now" so return 0 so we don't sleep
      return 0;
    }
  }
  return nextMs;
}
