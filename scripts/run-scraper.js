/**
 * Runs the YouTube channel scraper once (or in a loop if SCRAPER_POLL_MS is set).
 * Usage: node scripts/run-scraper.js [dbPath] [channelId] [--debug|-d]
 *   dbPath: default ./video-nemesis.db
 *   channelId: optional; if set, only scrape this channel (bypasses schedule; still respects recently-checked).
 *
 * Debug: set DEBUG_SCRAPER=1 (or use --debug / -d) to log channels selected, schedule checks, and per-channel video/task counts.
 * Prerequisites: npm run build, DB with schema (run scripts/seed-test-db.js first). Requires yt-dlp on PATH.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { YouTubeChannelScraper } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => {
  if (a === "--debug" || a === "-d") {
    process.env.DEBUG_SCRAPER = "1";
    return false;
  }
  return true;
});
const dbPath = args[0] || path.join(__dirname, "..", "video-nemesis.db");
const channelId = args[1] !== undefined ? Number(args[1]) : undefined;
const pollMs = process.env.SCRAPER_POLL_MS ? Number(process.env.SCRAPER_POLL_MS) : undefined;

const scraper = new YouTubeChannelScraper({
  dbPath,
  ...(pollMs !== undefined && pollMs > 0 && { pollIntervalMs: pollMs }),
});

if (pollMs !== undefined && pollMs > 0) {
  scraper.start();
  console.log("Scraper started. DB:", dbPath, "| Poll every", pollMs, "ms | Ctrl+C to stop.");
} else {
  (async () => {
    await scraper.runOnce(channelId);
    console.log("Scraper run once done. DB:", dbPath, channelId !== undefined ? `channelId=${channelId}` : "");
  })();
}

process.on("SIGINT", () => {
  scraper.stop();
  console.log("Scraper stopped.");
  process.exit(0);
});
