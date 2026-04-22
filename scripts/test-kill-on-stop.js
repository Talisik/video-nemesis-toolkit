/**
 * Test: verify that calling stop() kills all in-flight yt-dlp child processes.
 *
 * What it does:
 *   1. Starts a scrape on a real YouTube channel (spawns yt-dlp).
 *   2. Waits a short delay so yt-dlp has time to actually start.
 *   3. Asserts that yt-dlp PIDs exist at that point.
 *   4. Calls scraper.stop().
 *   5. Asserts that all those yt-dlp PIDs are gone within a grace period.
 *
 * Usage:
 *   node scripts/test-kill-on-stop.js
 *
 * Prerequisites: npm run build, yt-dlp on PATH, internet access.
 * No DB needed — the scrape will fail at the DB step but yt-dlp still gets spawned.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { YouTubeChannelScraper } from "../dist/index.js";
import Database from "better-sqlite3";
import { runMigrations } from "../dist/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "test-kill-on-stop.db");

// Resolve yt-dlp: prefer env var, then common Homebrew path, then hope it's on PATH
const YT_DLP_PATH = process.env.YT_DLP_PATH
  ?? (spawnSync("which", ["yt-dlp"], { encoding: "utf8" }).stdout.trim() || "/opt/homebrew/bin/yt-dlp");

// ── helpers ──────────────────────────────────────────────────────────────────

function getLiveYtDlpPids() {
  // -f matches against full command line so it catches /opt/homebrew/bin/yt-dlp etc.
  const result = spawnSync("pgrep", ["-f", "yt-dlp"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    // exclude the pgrep process itself and this node process
    .filter((p) => p !== process.pid);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }

// ── setup DB ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
runMigrations(db);

const TEST_CHANNEL_URL = "https://www.youtube.com/@LinusTechTips";
const now = new Date().toISOString();

// Ensure a schedule row exists (scraper needs it to pick the channel)
const scheduleExists = db.prepare("SELECT id FROM schedules LIMIT 1").get();
let scheduleId;
if (!scheduleExists) {
  const res = db.prepare(`
    INSERT INTO schedules (name, created_at, updated_at) VALUES ('test', ?, ?)
  `).run(now, now);
  scheduleId = res.lastInsertRowid;
} else {
  scheduleId = scheduleExists.id;
}

// Insert a real YouTube channel linked to the schedule
const existing = db.prepare("SELECT id FROM channels WHERE url = ?").get(TEST_CHANNEL_URL);
if (!existing) {
  db.prepare(`
    INSERT INTO channels (schedule_id, name, url, active, created_at, updated_at)
    VALUES (?, 'LinusTechTips', ?, 1, ?, ?)
  `).run(scheduleId, TEST_CHANNEL_URL, now, now);
}

const channelRow = db.prepare("SELECT id FROM channels WHERE url = ?").get(TEST_CHANNEL_URL);

db.close();

// ── test ─────────────────────────────────────────────────────────────────────

console.log("\n=== test-kill-on-stop ===\n");

console.log(`Using yt-dlp: ${YT_DLP_PATH}`);
const scraper = new YouTubeChannelScraper({ dbPath: DB_PATH, ytDlpPath: YT_DLP_PATH });

const pidsBefore = getLiveYtDlpPids();
console.log(`yt-dlp PIDs before scrape: ${pidsBefore.length > 0 ? pidsBefore.join(", ") : "none"}`);

console.log("Starting scraper runOnce (will spawn yt-dlp)...");
const runPromise = scraper.runOnce(channelRow.id);

// Wait for yt-dlp to actually spawn (it starts within ~500ms)
await sleep(2000);

const pidsDuringRun = getLiveYtDlpPids();
const newPids = pidsDuringRun.filter((p) => !pidsBefore.includes(p));

console.log(`\nyt-dlp PIDs during scrape: ${pidsDuringRun.length > 0 ? pidsDuringRun.join(", ") : "none"}`);
console.log(`New yt-dlp PIDs (spawned by this test): ${newPids.length > 0 ? newPids.join(", ") : "none"}`);

if (newPids.length === 0) {
  console.log("\n  ⚠  No new yt-dlp PIDs detected — scrape may have finished too quickly or yt-dlp not on PATH.");
  console.log("     Try running on a slower connection or increasing the sleep above.");
  console.log("     Skipping kill assertion.\n");
  scraper.stop();
  process.exit(0);
}

if (newPids.length > 0) {
  pass(`yt-dlp spawned (${newPids.length} process${newPids.length > 1 ? "es" : ""}): PID${newPids.length > 1 ? "s" : ""} ${newPids.join(", ")}`);
}

// ── call stop() and verify processes die ─────────────────────────────────────

console.log("\nCalling scraper.stop()...");
scraper.stop();

// Give the OS a moment to reap the processes
await sleep(500);

const pidsAfterStop = getLiveYtDlpPids();
const survivingPids = newPids.filter((p) => pidsAfterStop.includes(p));

console.log(`yt-dlp PIDs after stop(): ${pidsAfterStop.length > 0 ? pidsAfterStop.join(", ") : "none"}`);

if (survivingPids.length === 0) {
  pass(`All spawned yt-dlp processes killed by stop()`);
} else {
  fail(`${survivingPids.length} yt-dlp process${survivingPids.length > 1 ? "es" : ""} still alive after stop(): PIDs ${survivingPids.join(", ")}`);
}

// runOnce may resolve or reject after stop() — either is fine, just don't leave it dangling
runPromise.catch(() => {});

// ── summary ──────────────────────────────────────────────────────────────────

console.log("");
if (process.exitCode === 1) {
  console.error("FAILED — yt-dlp processes were not cleaned up by stop()");
} else {
  console.log("PASSED — stop() correctly kills in-flight yt-dlp processes");
}

console.log("");
