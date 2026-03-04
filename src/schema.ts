import Database from "better-sqlite3";
import { openDb } from "./db.js";

/**
 * Run all schema migrations on the given database.
 * No versioning: drops and recreates schedule/channel/slot tables each run.
 * Caller is responsible for resetting the DB when needed.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS video_details (
    video_url TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    video_title TEXT,
    video_duration INTEGER,
    release_timestamp INTEGER,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS download_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    video_url TEXT NOT NULL,
    status TEXT NOT NULL,
    error_details TEXT,
    download_format TEXT,
    source TEXT,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS download_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_url TEXT NOT NULL,
    channel_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
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
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    time_minutes INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_analysis_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    release_timestamp INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(channel_id, video_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS intelligent_schedule (
    channel_id INTEGER PRIMARY KEY,
    next_scrape_time TEXT NOT NULL,
    pattern TEXT NOT NULL,
    confidence REAL NOT NULL,
    expected_videos INTEGER NOT NULL,
    is_erratic INTEGER NOT NULL,
    analysis_basis_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  )`);
}

/**
 * Ensure the database at dbPath exists and has the full schema.
 */
export function ensureSchema(dbPath: string): Database.Database {
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}
