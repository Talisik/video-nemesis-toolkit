/**
 * Creates a test SQLite DB with the full schema and sample data.
 *
 * Tables: video_details, download_history, download_task, schedules, channels, channel_slots.
 * channel_slots: (channel_id, day_of_week, time_minutes). Recurring weekly.
 *
 * Inserts one schedule, 2 channels (MKBHD, Mary Bautista), and slots (today, 1 min from now for quick test).
 * Usage: node scripts/seed-test-db.js [dbPath]
 * Default dbPath: ./video-nemesis.db (from project root)
 *
 * Prerequisites: run from project root after `npm run build`.
 * Skip channels: SKIP_CHANNEL=1 node scripts/seed-test-db.js
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] || path.join(__dirname, "..", "video-nemesis.db");

const db = ensureSchema(dbPath);

const now = new Date().toISOString();

const channels = [
  { name: "MKBHD", url: "https://www.youtube.com/@mkbhd" },
  { name: "Mary Bautista", url: "https://www.youtube.com/@MaryBautista" },
];

let firstChannelId = null;

if (!process.env.SKIP_CHANNEL) {
  db.prepare(
    `INSERT INTO schedules (name, created_at, updated_at) VALUES (?, ?, ?)`
  ).run("Test Schedule", now, now);
  const scheduleId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  console.log("Inserted schedule id:", scheduleId);

  const nowDate = new Date();
  const dayOfWeek = nowDate.getDay();
  const timeMinutes = nowDate.getHours() * 60 + nowDate.getMinutes() + 1; // 1 min from now for quick test

  const insertChannel = db.prepare(
    `INSERT INTO channels (schedule_id, url, name, all_words, any_words, none_words, min_duration_minutes, max_duration_minutes, download_format, download_subtitles, download_thumbnails, last_scraped_at, active, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '[]', '[]', ?, ?, 'mp4', 0, 0, NULL, 1, ?, ?)`
  );
  const insertSlot = db.prepare(
    `INSERT INTO channel_slots (channel_id, day_of_week, time_minutes) VALUES (?, ?, ?)`
  );

  for (const ch of channels) {
    insertChannel.run(scheduleId, ch.url, ch.name, 0, 60, now, now);
    const channelId = db.prepare("SELECT last_insert_rowid() as id").get().id;
    if (firstChannelId === null) firstChannelId = channelId;
    insertSlot.run(channelId, dayOfWeek, timeMinutes);
    console.log("Inserted channel:", ch.name, "id:", channelId, "slot: day", dayOfWeek, "time_minutes", timeMinutes);
  }
}

db.close();
console.log("Created:", dbPath);
console.log("Run worker: npm run worker");
console.log("Run scraper: npm run scraper");
