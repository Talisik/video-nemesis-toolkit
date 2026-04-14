/**
 * Test: verifies ScrapeRunResult.message when scraping finds no new videos.
 *
 * Creates a temp DB with one active channel + schedule, points yt-dlp at a
 * tiny shell stub, and asserts the result shape from runOnce().
 *
 * Usage: npm run build && node scripts/test-no-videos-message.js
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "../dist/index.js";
import { YouTubeChannelScraper } from "../dist/workers/scraper-worker/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── helpers ─────────────────────────────────────────────────────── */

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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scraper-test-"));
}

/** Write a tiny shell script that acts as a fake yt-dlp. */
function writeFakeYtDlp(dir, stdout, exitCode = 0) {
  const dataFile = path.join(dir, "fake-yt-dlp-stdout");
  fs.writeFileSync(dataFile, stdout);
  const p = path.join(dir, "fake-yt-dlp");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env bash\ncat ${JSON.stringify(dataFile)}\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
  return p;
}

/** Seed minimal channel + schedule so getChannelsToScrape returns 1 row. */
function seedDb(db) {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO schedules (name, created_at, updated_at) VALUES (?, ?, ?)`
  ).run("test-schedule", now, now);
  const scheduleId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  db.prepare(
    `INSERT INTO channels (name, url, active, schedule_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`
  ).run("TestChannel", "https://www.youtube.com/@TestChannel/videos", scheduleId, now, now);
  const channelId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  return { scheduleId, channelId };
}

/* ── Test 1: yt-dlp returns zero videos → message present ───────── */

async function testNoVideos() {
  console.log("\nTest 1: yt-dlp returns 0 videos (exit 0, empty stdout)");

  const tmp = makeTmpDir();
  const dbPath = path.join(tmp, "test.db");
  const db = ensureSchema(dbPath);
  const { channelId } = seedDb(db);
  db.close();

  const fakeYtDlp = writeFakeYtDlp(tmp, "", 0);

  const scraper = new YouTubeChannelScraper({
    dbPath,
    ytDlpPath: fakeYtDlp,
    channelCheckIntervalMs: 0, // don't skip "recently checked"
  });

  const result = await scraper.runOnce(channelId);

  console.log("  result:", JSON.stringify(result, null, 2));

  assert(result.scrapedCount === 1, `scrapedCount is 1 (got ${result.scrapedCount})`);
  assert(result.errors.length === 0, `no errors (got ${result.errors.length})`);
  assert(result.message === "No new videos found", `message is "No new videos found" (got ${JSON.stringify(result.message)})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── Test 2: yt-dlp returns videos → no message ────────────────── */

async function testWithVideos() {
  console.log("\nTest 2: yt-dlp returns 1 new video → no message");

  const tmp = makeTmpDir();
  const dbPath = path.join(tmp, "test.db");
  const db = ensureSchema(dbPath);
  const { channelId } = seedDb(db);
  db.close();

  // Fake yt-dlp that prints one valid video line (id\tduration\ttitle\ttimestamp)
  const videoLine = "dQw4w9WgXcQ\t212\tTest Video\t1700000000\n";
  const fakeYtDlp = writeFakeYtDlp(tmp, videoLine, 0);

  const scraper = new YouTubeChannelScraper({
    dbPath,
    ytDlpPath: fakeYtDlp,
    channelCheckIntervalMs: 0,
  });

  const result = await scraper.runOnce(channelId);

  console.log("  result:", JSON.stringify(result, null, 2));

  assert(result.scrapedCount === 1, `scrapedCount is 1 (got ${result.scrapedCount})`);
  assert(result.errors.length === 0, `no errors (got ${result.errors.length})`);
  assert(result.message === undefined, `message is undefined (got ${JSON.stringify(result.message)})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── Test 3: yt-dlp fails (exit 1, no output) → error, no message  */

async function testYtDlpError() {
  console.log("\nTest 3: yt-dlp exits with code 1 → error returned, no message");

  const tmp = makeTmpDir();
  const dbPath = path.join(tmp, "test.db");
  const db = ensureSchema(dbPath);
  const { channelId } = seedDb(db);
  db.close();

  const fakeYtDlp = writeFakeYtDlp(tmp, "", 1);

  const scraper = new YouTubeChannelScraper({
    dbPath,
    ytDlpPath: fakeYtDlp,
    channelCheckIntervalMs: 0,
  });

  const result = await scraper.runOnce(channelId);

  console.log("  result:", JSON.stringify(result, null, 2));

  assert(result.scrapedCount === 0, `scrapedCount is 0 (got ${result.scrapedCount})`);
  assert(result.errors.length === 1, `1 error (got ${result.errors.length})`);
  assert(result.message === undefined, `message is undefined (got ${JSON.stringify(result.message)})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── Test 4: yt-dlp outputs garbage (no valid videos parsed) ──── */

async function testGarbageOutput() {
  console.log("\nTest 4: yt-dlp outputs garbage (exit 0, no valid video IDs parsed)");

  const tmp = makeTmpDir();
  const dbPath = path.join(tmp, "test.db");
  const db = ensureSchema(dbPath);
  const { channelId } = seedDb(db);
  db.close();

  // Output that exits 0 but contains no valid video IDs (parser returns empty array)
  const garbage = "not-a-video-id\tsome\trandom\tgarbage\n";
  const fakeYtDlp = writeFakeYtDlp(tmp, garbage, 0);

  const scraper = new YouTubeChannelScraper({
    dbPath,
    ytDlpPath: fakeYtDlp,
    channelCheckIntervalMs: 0,
  });

  const result = await scraper.runOnce(channelId);

  console.log("  result:", JSON.stringify(result, null, 2));

  assert(result.scrapedCount === 1, `scrapedCount is 1 (got ${result.scrapedCount})`);
  assert(result.errors.length === 0, `no errors (got ${result.errors.length})`);
  assert(result.message === "No new videos found", `message is "No new videos found" (got ${JSON.stringify(result.message)})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── Test 5: scraper not initialized (getScraper returns null) ─── */

async function testScraperNull() {
  console.log("\nTest 5: result shape when no channels match (channelId does not exist)");

  const tmp = makeTmpDir();
  const dbPath = path.join(tmp, "test.db");
  const db = ensureSchema(dbPath);
  db.close(); // no channels seeded

  const fakeYtDlp = writeFakeYtDlp(tmp, "", 0);

  const scraper = new YouTubeChannelScraper({
    dbPath,
    ytDlpPath: fakeYtDlp,
    channelCheckIntervalMs: 0,
  });

  // Channel 999 doesn't exist
  const result = await scraper.runOnce(999);

  console.log("  result:", JSON.stringify(result, null, 2));

  assert(result.scrapedCount === 0, `scrapedCount is 0 (got ${result.scrapedCount})`);
  assert(result.errors.length === 0, `no errors (got ${result.errors.length})`);
  assert(result.message === undefined, `message is undefined (got ${JSON.stringify(result.message)})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── run ─────────────────────────────────────────────────────────── */

console.log("=== ScrapeRunResult.message tests ===");
await testNoVideos();
await testWithVideos();
await testYtDlpError();
await testGarbageOutput();
await testScraperNull();

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
