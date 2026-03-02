import Database from "better-sqlite3";
import type { DownloadHistoryRow } from "../types/index.js";

const TABLE = "download_history";

export interface DownloadHistoryListFilters {
  channel_id?: number;
  video_url?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function listDownloadHistory(
  db: Database.Database,
  filters?: DownloadHistoryListFilters
): DownloadHistoryRow[] {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters?.channel_id) {
    conditions.push("channel_id = ?");
    values.push(filters.channel_id);
  }
  if (filters?.video_url) {
    conditions.push("video_url = ?");
    values.push(filters.video_url);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  let sql = `SELECT id, channel_id, video_url, status, error_details, download_format, source, updated_at, created_at FROM ${TABLE}`;
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at DESC";
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;
  sql += ` LIMIT ? OFFSET ?`;
  values.push(limit, offset);
  return db.prepare(sql).all(...values) as DownloadHistoryRow[];
}

/** Returns true if download_history has any row for this video_url (already downloaded or attempted). */
export function hasHistoryForVideoUrl(
  db: Database.Database,
  videoUrl: string
): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ${TABLE} WHERE video_url = ? LIMIT 1`)
    .get(videoUrl);
  return row != null;
}

export function insertDownloadHistory(
  db: Database.Database,
  row: Omit<DownloadHistoryRow, "id" | "updated_at" | "created_at">
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${TABLE} (channel_id, video_url, status, error_details, download_format, source, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.channel_id,
    row.video_url,
    row.status,
    row.error_details ?? null,
    row.download_format ?? null,
    row.source ?? null,
    now,
    now
  );
}
