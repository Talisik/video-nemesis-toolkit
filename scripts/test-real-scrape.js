/**
 * Integration test: scrape a real YouTube channel twice.
 *
 * 1st run — first_scrape_limit=5, should return up to 5 videos.
 * 2nd run — same channel, should find no new videos (message: "No new videos found").
 *
 * Usage: npm run build && node scripts/test-real-scrape.js
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "../dist/index.js";
import { YouTubeChannelScraper } from "../dist/workers/scraper-worker/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_URL = "https://www.youtube.com/@PlatChatVALORANT/streams";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✘ ${label}`);
    failed++;
  }
}

function seedDb(db) {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO schedules (name, created_at, updated_at) VALUES (?, ?, ?)`
  ).run("test-schedule", now, now);
  const scheduleId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  db.prepare(
    `INSERT INTO channels (name, url, active, schedule_id, first_scrape_limit, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)`
  ).run("PlatChat VALORANT", CHANNEL_URL, scheduleId, 5, now, now);
  const channelId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  return { scheduleId, channelId };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-real-test-"));
const dbPath = path.join(tmp, "test.db");
const db = ensureSchema(dbPath);
const { channelId } = seedDb(db);
db.close();

const scraper = new YouTubeChannelScraper({
  dbPath,
  ytDlpPath: "/snap/bin/yt-dlp",
  channelCheckIntervalMs: 0,
});

// ── Scrape 1: first scrape, expect up to 5 videos ──────────────
console.log("\n=== Scrape 1: first scrape (limit 5) ===");
console.log(`  Channel: ${CHANNEL_URL}`);

const result1 = await scraper.runOnce(channelId);
console.log("  result:", JSON.stringify(result1, null, 2));

assert(result1.scrapedCount === 1, `scrapedCount is 1 (got ${result1.scrapedCount})`);
assert(result1.errors.length === 0, `no errors (got ${result1.errors.length})`);
assert(result1.message === undefined, `no "No new videos" message on first scrape (got ${JSON.stringify(result1.message)})`);

// Check what was saved to the DB
const db2 = ensureSchema(dbPath);
const tasks = db2.prepare(`SELECT video_url FROM download_task WHERE channel_id = ?`).all(channelId);
const analysisRows = db2.prepare(`SELECT video_id, release_timestamp FROM channel_analysis_videos WHERE channel_id = ? ORDER BY release_timestamp DESC`).all(channelId);
db2.close();

console.log(`  download_task rows: ${tasks.length}`);
tasks.forEach((t) => console.log(`    - ${t.video_url}`));
console.log(`  channel_analysis_videos rows: ${analysisRows.length}`);
analysisRows.forEach((r) => console.log(`    - ${r.video_id} (ts: ${r.release_timestamp})`));

assert(tasks.length > 0 && tasks.length <= 5, `queued 1-5 videos (got ${tasks.length})`);
assert(analysisRows.length > 0, `analysis data saved (got ${analysisRows.length} rows)`);

// ── Scrape 2: second scrape, expect no new videos ──────────────
console.log("\n=== Scrape 2: subsequent scrape (should find nothing new) ===");

const result2 = await scraper.runOnce(channelId);
console.log("  result:", JSON.stringify(result2, null, 2));

assert(result2.scrapedCount === 1, `scrapedCount is 1 (got ${result2.scrapedCount})`);
assert(result2.errors.length === 0, `no errors (got ${result2.errors.length})`);
assert(result2.message === "No new videos found", `message is "No new videos found" (got ${JSON.stringify(result2.message)})`);

// Verify no new tasks were added
const db3 = ensureSchema(dbPath);
const tasksAfter = db3.prepare(`SELECT video_url FROM download_task WHERE channel_id = ?`).all(channelId);
db3.close();

assert(tasksAfter.length === tasks.length, `no new download tasks added (before: ${tasks.length}, after: ${tasksAfter.length})`);

// ── Cleanup ────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
