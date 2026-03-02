import path from "node:path";
import { openDb } from "../../db.js";
import type Database from "better-sqlite3";
import * as channelsData from "../../data/channels.js";
import * as downloadWorkerDb from "./db.js";
import { downloadVideo } from "./download.js";
import type { DownloadWorkerOptions } from "../../types/index.js";
import { DownloadTaskStatus } from "../../types/enum/downloadTaskStatus.js";
import { slugify } from "../../utils/slug.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_OUTPUT_DIR = "temp_videos";
const DEFAULT_YT_DLP = "yt-dlp";

/** YouTube video IDs are 11 chars. Invalid URLs are marked failed without calling yt-dlp. */
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
function isValidYoutubeVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    return v !== null && YOUTUBE_VIDEO_ID_REGEX.test(v);
  } catch {
    return false;
  }
}

function getYoutubeVideoId(url: string): string | null {
  try {
    const v = new URL(url).searchParams.get("v");
    return v && YOUTUBE_VIDEO_ID_REGEX.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Build per-task output dir: {outputDir}/{channel_slug}/{YYYY-MM-DD}.
 * Uses task created_at for the date (day the task was queued / scraped).
 */
function getTaskOutputDir(
  baseOutputDir: string,
  channelSlug: string,
  createdAtIso: string
): string {
  const dateStr = createdAtIso.slice(0, 10); // YYYY-MM-DD
  return path.join(baseOutputDir, channelSlug, dateStr);
}

/**
 * Download worker: polls download_task for status='pending', claims one,
 * runs yt-dlp, then sets status to 'downloaded' or 'download_failed'.
 * Runs until stop() is called.
 */
export class DownloadWorker {
  private dbPath: string;
  private outputDir: string;
  private pollIntervalMs: number;
  private ytDlpPath: string;
  private maxHeight: number;
  private db: Database.Database | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: DownloadWorkerOptions) {
    this.dbPath = options.dbPath;
    this.outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.ytDlpPath = options.ytDlpPath ?? DEFAULT_YT_DLP;
    this.maxHeight = options.maxHeight ?? 720;
  }

  /**
   * Start the worker loop. Idempotent.
   */
  start(): void {
    if (this.timerId !== null) return;
    this.stopped = false;
    this.db = openDb(this.dbPath);
    this.timerId = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  /**
   * Stop the worker and close the DB. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.db === null) return;

    const task = downloadWorkerDb.claimNextPendingTask(this.db);
    if (!task) return;

    if (!isValidYoutubeVideoUrl(task.video_url)) {
      downloadWorkerDb.setTaskStatus(this.db, task.id, DownloadTaskStatus.DOWNLOAD_FAILED, {
        incrementRetry: true,
      });
      downloadWorkerDb.insertDownloadHistory(this.db, {
        channel_id: task.channel_id,
        video_url: task.video_url,
        status: DownloadTaskStatus.DOWNLOAD_FAILED,
        error_details: "Invalid video URL (missing or bad YouTube ID)",
        download_format: "mp4",
        source: "worker",
      });
      return;
    }

    const videoId = getYoutubeVideoId(task.video_url);
    if (!videoId) {
      downloadWorkerDb.setTaskStatus(this.db, task.id, DownloadTaskStatus.DOWNLOAD_FAILED, {
        incrementRetry: true,
      });
      downloadWorkerDb.insertDownloadHistory(this.db, {
        channel_id: task.channel_id,
        video_url: task.video_url,
        status: DownloadTaskStatus.DOWNLOAD_FAILED,
        error_details: "Could not extract video ID from URL",
        download_format: "mp4",
        source: "worker",
      });
      return;
    }

    const channel = channelsData.getChannelById(this.db, task.channel_id);
    const channelSlug = channel ? slugify(channel.name) : `channel_${task.channel_id}`;
    const taskOutputDir = getTaskOutputDir(this.outputDir, channelSlug, task.created_at);

    const success = await downloadVideo({
      id: videoId,
      videoUrl: task.video_url,
      outputDir: taskOutputDir,
      ytDlpPath: this.ytDlpPath,
      maxHeight: this.maxHeight,
    });

    if (this.stopped || this.db === null) return;

    if (success) {
      downloadWorkerDb.setTaskStatus(this.db, task.id, DownloadTaskStatus.DOWNLOADED);
      downloadWorkerDb.insertDownloadHistory(this.db, {
        channel_id: task.channel_id,
        video_url: task.video_url,
        status: DownloadTaskStatus.DOWNLOADED,
        error_details: null,
        download_format: "mp4",
        source: "worker",
      });
    } else {
      downloadWorkerDb.setTaskStatus(this.db, task.id, DownloadTaskStatus.DOWNLOAD_FAILED, {
        incrementRetry: true,
      });
      downloadWorkerDb.insertDownloadHistory(this.db, {
        channel_id: task.channel_id,
        video_url: task.video_url,
        status: DownloadTaskStatus.DOWNLOAD_FAILED,
        error_details: null,
        download_format: "mp4",
        source: "worker",
      });
    }
  }
}
