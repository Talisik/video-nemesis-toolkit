-- Video Nemesis Toolkit – database schema (reference).
-- Tables are created by ensureSchema() in code (src/schema.ts). This file is for documentation and manual use.
-- Run order: video_details, download_history, download_task, schedules, channels, channel_slots.

-- Cached video metadata from scraped channels (video_duration in seconds)
CREATE TABLE IF NOT EXISTS video_details (
  video_url TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  video_title TEXT,
  video_duration INTEGER,
  date_published TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Completed or failed downloads
CREATE TABLE IF NOT EXISTS download_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  status TEXT NOT NULL,
  error_details TEXT,
  download_format TEXT,
  source TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Pending/downloading tasks (queue)
CREATE TABLE IF NOT EXISTS download_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_url TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Schedules (one schedule has many channels)
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Channels (belong to a schedule)
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  all_words TEXT NOT NULL DEFAULT '[]',
  any_words TEXT NOT NULL DEFAULT '[]',
  none_words TEXT NOT NULL DEFAULT '[]',
  min_duration_minutes INTEGER,
  max_duration_minutes INTEGER,
  download_format TEXT NOT NULL DEFAULT 'mp4',
  download_subtitles INTEGER NOT NULL DEFAULT 0,
  download_thumbnails INTEGER NOT NULL DEFAULT 0,
  last_scraped_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);

-- When to run the scraper per channel. Recurring weekly: day_of_week (0=Sunday..6=Saturday), time_minutes (0–1439).
DROP TABLE IF EXISTS channel_slots;

CREATE TABLE channel_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  time_minutes INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
