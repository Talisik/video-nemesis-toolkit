import Database from "better-sqlite3";
import type { VideoDetailRow } from "../types/index.js";

const TABLE = "video_details";

export function listVideoDetails(
  db: Database.Database,
  channelName?: string
): VideoDetailRow[] {
  if (channelName) {
    return db
      .prepare(
        `SELECT video_url, channel_name, video_title, video_duration, release_timestamp, updated_at, created_at FROM ${TABLE} WHERE channel_name = ? ORDER BY created_at DESC`
      )
      .all(channelName) as VideoDetailRow[];
  }
  return db
    .prepare(
      `SELECT video_url, channel_name, video_title, video_duration, release_timestamp, updated_at, created_at FROM ${TABLE} ORDER BY created_at DESC`
    )
    .all() as VideoDetailRow[];
}

/**
 * Returns the latest (max) release_timestamp for a channel from video_details.
 * Used to only process videos newer than already-seen on subsequent scrapes.
 */
export function getLatestReleaseTimestamp(
  db: Database.Database,
  channelName: string
): number | null {
  const row = db
    .prepare(
      `SELECT MAX(release_timestamp) as ts FROM ${TABLE} WHERE channel_name = ? AND release_timestamp IS NOT NULL`
    )
    .get(channelName) as { ts: number | null } | undefined;
  const ts = row?.ts;
  return ts != null && Number.isFinite(ts) ? ts : null;
}

export function getVideoDetailByUrl(
  db: Database.Database,
  videoUrl: string
): VideoDetailRow | null {
  const row = db
    .prepare(
      `SELECT video_url, channel_name, video_title, video_duration, release_timestamp, updated_at, created_at FROM ${TABLE} WHERE video_url = ?`
    )
    .get(videoUrl) as VideoDetailRow | undefined;
  return row ?? null;
}

export function upsertVideoDetail(
  db: Database.Database,
  row: Omit<VideoDetailRow, "updated_at" | "created_at">
): void {
  const now = new Date().toISOString();
  const existing = getVideoDetailByUrl(db, row.video_url);
  if (existing) {
    db.prepare(
      `UPDATE ${TABLE} SET channel_name = ?, video_title = ?, video_duration = ?, release_timestamp = ?, updated_at = ?
       WHERE video_url = ?`
    ).run(
      row.channel_name,
      row.video_title ?? null,
      row.video_duration ?? null,
      row.release_timestamp ?? null,
      now,
      row.video_url
    );
  } else {
    db.prepare(
      `INSERT INTO ${TABLE} (video_url, channel_name, video_title, video_duration, release_timestamp, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.video_url,
      row.channel_name,
      row.video_title ?? null,
      row.video_duration ?? null,
      row.release_timestamp ?? null,
      now,
      now
    );
  }
}
