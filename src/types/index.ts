import type { DownloadTaskStatusType } from "./enum/downloadTaskStatus.js";

/**
 * Row from download_task table (scheduler inserts with status 'pending').
 */
export interface DownloadTaskRow {
  id: number;
  video_url: string;
  channel_id: number;
  status: DownloadTaskStatusType;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

/** Re-export for API compatibility (string literal union). */
export type DownloadTaskStatus = DownloadTaskStatusType;

/**
 * Options for the download worker.
 */
export interface DownloadWorkerOptions {
  /** Path to SQLite database file (e.g. from Electron). */
  dbPath: string;
  /** Output directory for downloaded files (default: temp_videos). */
  outputDir?: string;
  /** Poll interval in ms for pending tasks (default: 2000). */
  pollIntervalMs?: number;
  /** Path to yt-dlp executable (default: "yt-dlp" from PATH). */
  ytDlpPath?: string;
  /** Max height for video (default: 720). */
  maxHeight?: number;
}

/**
 * Row from schedules table (one schedule, many channels).
 */
export interface ScheduleRow {
  id: number;
  name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Row from channels table (belongs to one schedule; has download settings, words, duration).
 */
export interface ChannelRow {
  id: number;
  schedule_id: number;
  url: string;
  name: string;
  all_words: string;
  any_words: string;
  none_words: string;
  min_duration_minutes: number | null;
  max_duration_minutes: number | null;
  download_format: string;
  download_subtitles: number;
  download_thumbnails: number;
  last_scraped_at: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Row from channel_slots table. Recurring weekly: day_of_week (0=Sunday..6=Saturday), time_minutes (0–1439, minutes since midnight local).
 */
export interface ChannelSlotRow {
  id: number;
  channel_id: number;
  day_of_week: number;
  time_minutes: number;
}

/**
 * Row from video_details table. video_duration is stored in seconds (integer).
 * release_timestamp is Unix seconds (from yt-dlp release_timestamp).
 */
export interface VideoDetailRow {
  video_url: string;
  channel_name: string;
  video_title: string | null;
  video_duration: number | null;
  release_timestamp: number | null;
  updated_at: string;
  created_at: string;
}

/**
 * Row from download_history table.
 */
export interface DownloadHistoryRow {
  id: number;
  channel_id: number;
  video_url: string;
  status: string;
  error_details: string | null;
  download_format: string | null;
  source: string | null;
  updated_at: string;
  created_at: string;
}
