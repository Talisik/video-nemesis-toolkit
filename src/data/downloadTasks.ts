import Database from "better-sqlite3";
import type { DownloadTaskRow } from "../types/index.js";
import {
  DownloadTaskStatus,
  type DownloadTaskStatusType,
} from "../types/enum/downloadTaskStatus.js";

const TABLE = "download_task";

export function listDownloadTasks(
  db: Database.Database,
  status?: string
): DownloadTaskRow[] {
  if (status) {
    return db
      .prepare(
        `SELECT id, video_url, channel_id, status, retry_count, created_at, updated_at FROM ${TABLE} WHERE status = ? ORDER BY created_at ASC`
      )
      .all(status) as DownloadTaskRow[];
  }
  return db
    .prepare(
      `SELECT id, video_url, channel_id, status, retry_count, created_at, updated_at FROM ${TABLE} ORDER BY created_at ASC`
    )
    .all() as DownloadTaskRow[];
}

export function addDownloadTask(
  db: Database.Database,
  params: {
    video_url: string;
    channel_id: number;
  }
): DownloadTaskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ${TABLE} (video_url, channel_id, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(
    params.video_url,
    params.channel_id,
    DownloadTaskStatus.PENDING,
    now,
    now
  );
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  const row = db
    .prepare(
      `SELECT id, video_url, channel_id, status, retry_count, created_at, updated_at FROM ${TABLE} WHERE id = ?`
    )
    .get(id) as DownloadTaskRow;
  return row;
}

export function getDownloadTaskById(
  db: Database.Database,
  id: number
): DownloadTaskRow | null {
  const row = db
    .prepare(
      `SELECT id, video_url, channel_id, status, retry_count, created_at, updated_at FROM ${TABLE} WHERE id = ?`
    )
    .get(id) as DownloadTaskRow | undefined;
  return row ?? null;
}

/** Returns true if a task (any status) exists for this video_url. */
export function hasTaskForVideoUrl(
  db: Database.Database,
  videoUrl: string
): boolean {
  const row = db.prepare(`SELECT 1 FROM ${TABLE} WHERE video_url = ? LIMIT 1`).get(videoUrl);
  return row != null;
}

/**
 * Claim one pending task and set status to downloading (atomic).
 * Returns the claimed row or null if none.
 */
export function claimNextPendingTask(
  db: Database.Database
): DownloadTaskRow | null {
  const row = db
    .prepare(
      `SELECT id, video_url, channel_id, status, retry_count, created_at, updated_at
       FROM ${TABLE}
       WHERE status = ?
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(DownloadTaskStatus.PENDING) as DownloadTaskRow | undefined;

  if (!row) return null;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ${TABLE} SET status = ?, updated_at = ? WHERE id = ?`
  ).run(DownloadTaskStatus.DOWNLOADING, now, row.id);

  return { ...row, status: DownloadTaskStatus.DOWNLOADING, updated_at: now };
}

/**
 * Set task status and optionally increment retry_count.
 */
export function setTaskStatus(
  db: Database.Database,
  id: number,
  status: DownloadTaskStatusType,
  options?: { incrementRetry?: boolean }
): void {
  const now = new Date().toISOString();
  if (options?.incrementRetry) {
    db.prepare(
      `UPDATE ${TABLE} SET status = ?, updated_at = ?, retry_count = retry_count + 1 WHERE id = ?`
    ).run(status, now, id);
  } else {
    db.prepare(
      `UPDATE ${TABLE} SET status = ?, updated_at = ? WHERE id = ?`
    ).run(status, now, id);
  }
}
