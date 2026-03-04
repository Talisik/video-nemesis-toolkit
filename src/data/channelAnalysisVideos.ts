import Database from "better-sqlite3";

const TABLE = "channel_analysis_videos";

const MAX_VIDEOS_PER_CHANNEL = 100;

export interface AnalysisVideoRow {
  id: number;
  channel_id: number;
  video_id: string;
  duration_seconds: number;
  title: string;
  release_timestamp: number;
  created_at: string;
}

export interface AnalysisVideoInput {
  id: string;
  durationSeconds: number;
  title: string;
  releaseTimestamp: number;
}

/**
 * Upsert videos into the analysis table for a channel. Uses UNIQUE(channel_id, video_id).
 * Caller should cap inputs or we cap per channel after insert.
 */
export function upsert(
  db: Database.Database,
  channelId: number,
  videos: AnalysisVideoInput[]
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO ${TABLE} (channel_id, video_id, duration_seconds, title, release_timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, video_id) DO UPDATE SET
       duration_seconds = excluded.duration_seconds,
       title = excluded.title,
       release_timestamp = excluded.release_timestamp`
  );
  for (const v of videos) {
    if (v.releaseTimestamp == null || !Number.isFinite(v.releaseTimestamp)) continue;
    stmt.run(
      channelId,
      v.id,
      v.durationSeconds ?? 0,
      v.title ?? "",
      Math.floor(v.releaseTimestamp),
      now
    );
  }
}

/**
 * Get release_timestamp values for a channel, newest first, capped at limit.
 * Used to recompute interval from stored analysis data.
 */
export function getTimestampsForChannel(
  db: Database.Database,
  channelId: number,
  limit: number = MAX_VIDEOS_PER_CHANNEL
): number[] {
  const rows = db
    .prepare(
      `SELECT release_timestamp FROM ${TABLE} WHERE channel_id = ? ORDER BY release_timestamp DESC LIMIT ?`
    )
    .all(channelId, limit) as { release_timestamp: number }[];
  return rows.map((r) => r.release_timestamp);
}

/**
 * Get the latest (maximum) release_timestamp for a channel.
 * Returns null if no analysis videos exist for the channel.
 * Used to detect if we've already analyzed a video.
 */
export function getLatestTimestampForChannel(
  db: Database.Database,
  channelId: number
): number | null {
  const row = db
    .prepare(`SELECT MAX(release_timestamp) as latest FROM ${TABLE} WHERE channel_id = ?`)
    .get(channelId) as { latest: number | null } | undefined;
  return row?.latest ?? null;
}

/**
 * Keep only the most recent MAX_VIDEOS_PER_CHANNEL rows per channel (by release_timestamp).
 * Deletes older rows so the table doesn't grow unbounded.
 */
export function capPerChannel(db: Database.Database, channelId: number): void {
  db.prepare(
    `DELETE FROM ${TABLE} WHERE channel_id = ? AND id NOT IN (
      SELECT id FROM ${TABLE} WHERE channel_id = ? ORDER BY release_timestamp DESC LIMIT ? 
    )`
  ).run(channelId, channelId, MAX_VIDEOS_PER_CHANNEL);
}
