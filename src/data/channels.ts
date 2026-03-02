import Database from "better-sqlite3";
import type { ChannelRow } from "../types/index.js";

const TABLE = "channels";
const COLS =
  "id, schedule_id, url, name, all_words, any_words, none_words, min_duration_minutes, max_duration_minutes, download_format, download_subtitles, download_thumbnails, last_scraped_at, active, created_at, updated_at";

export function listChannels(
  db: Database.Database,
  activeOnly?: boolean,
  scheduleId?: number
): ChannelRow[] {
  let sql = `SELECT ${COLS} FROM ${TABLE}`;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (activeOnly) conditions.push("active = 1");
  if (scheduleId !== undefined) {
    conditions.push("schedule_id = ?");
    params.push(scheduleId);
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at DESC";
  return (params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as ChannelRow[];
}

export function listChannelsByScheduleId(
  db: Database.Database,
  scheduleId: number,
  activeOnly?: boolean
): ChannelRow[] {
  return listChannels(db, activeOnly, scheduleId);
}

export function getChannelById(
  db: Database.Database,
  id: number
): ChannelRow | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM ${TABLE} WHERE id = ?`)
    .get(id) as ChannelRow | undefined;
  return row ?? null;
}

export function createChannel(
  db: Database.Database,
  row: Omit<ChannelRow, "id" | "created_at" | "updated_at">
): ChannelRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${TABLE} (schedule_id, url, name, all_words, any_words, none_words, min_duration_minutes, max_duration_minutes, download_format, download_subtitles, download_thumbnails, last_scraped_at, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.schedule_id,
    row.url,
    row.name,
    row.all_words ?? "[]",
    row.any_words ?? "[]",
    row.none_words ?? "[]",
    row.min_duration_minutes ?? null,
    row.max_duration_minutes ?? null,
    row.download_format ?? "mp4",
    row.download_subtitles ?? 0,
    row.download_thumbnails ?? 0,
    row.last_scraped_at ?? null,
    row.active ?? 1,
    now,
    now
  );
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  return getChannelById(db, id) as ChannelRow;
}

type ChannelUpdate = Partial<
  Pick<
    ChannelRow,
    | "url"
    | "name"
    | "all_words"
    | "any_words"
    | "none_words"
    | "min_duration_minutes"
    | "max_duration_minutes"
    | "download_format"
    | "download_subtitles"
    | "download_thumbnails"
    | "last_scraped_at"
    | "active"
  >
>;

export function updateChannel(
  db: Database.Database,
  id: number,
  updates: ChannelUpdate
): void {
  const now = new Date().toISOString();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];
  const map: [keyof ChannelUpdate, string][] = [
    ["url", "url"],
    ["name", "name"],
    ["all_words", "all_words"],
    ["any_words", "any_words"],
    ["none_words", "none_words"],
    ["min_duration_minutes", "min_duration_minutes"],
    ["max_duration_minutes", "max_duration_minutes"],
    ["download_format", "download_format"],
    ["download_subtitles", "download_subtitles"],
    ["download_thumbnails", "download_thumbnails"],
    ["last_scraped_at", "last_scraped_at"],
    ["active", "active"],
  ];
  for (const [key, col] of map) {
    if (updates[key] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(updates[key]);
    }
  }
  if (fields.length === 1) return;
  values.push(id);
  db.prepare(`UPDATE ${TABLE} SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteChannel(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
}

export function setChannelActive(
  db: Database.Database,
  id: number,
  active: boolean
): void {
  updateChannel(db, id, { active: active ? 1 : 0 });
}

export function updateChannelLastScraped(
  db: Database.Database,
  channelId: number,
  isoDate: string
): void {
  updateChannel(db, channelId, { last_scraped_at: isoDate });
}

export function getChannelsByIds(
  db: Database.Database,
  ids: number[],
  activeOnly = true
): ChannelRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  let sql = `SELECT ${COLS} FROM ${TABLE} WHERE id IN (${placeholders})`;
  if (activeOnly) sql += " AND active = 1";
  return db.prepare(sql).all(...ids) as ChannelRow[];
}
