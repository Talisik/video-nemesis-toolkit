/**
 * Benchmark CPU/memory during scraper "sleeping" (schedule wait) vs "scraping" (runOnce).
 * Simulates the Electron app's main process with the scraper running.
 *
 * Usage:
 *   npm run build && node scripts/benchmark-scraper-phases.js [options] [dbPath]
 *
 * Options:
 *   --sleep-duration N   Sample for N seconds while sleeping (default 20).
 *   --scrape CHANNEL_ID  After sleeping phase, run runOnce(CHANNEL_ID) and report scraping load.
 *   --expose-gc          Use with node --expose-gc for memory stability.
 *
 * Example:
 *   node scripts/benchmark-scraper-phases.js --sleep-duration 15
 *   node scripts/benchmark-scraper-phases.js --scrape=1 ./video-nemesis.db
 *   npm run bench:scraper-phases -- --scrape=1   (use -- so npm passes the flag)
 *   npm run bench:scraper-phases:scrape          (runs with --scrape=1)
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { YouTubeChannelScraper, ensureSchema } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(2) + " KB";
  return n + " B";
}

function formatMicros(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " s";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + " ms";
  return n + " µs";
}

function sample() {
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, cpuUser: c.user, cpuSystem: c.system };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const arg = process.argv.find((a) => a.startsWith("--" + name + "="));
  return arg ? arg.split("=")[1] : def;
};
const dbPath = args[0] || path.join(__dirname, "..", "video-nemesis.db");
const sleepDurationSec = parseInt(opt("sleep-duration", "20"), 10) || 20;
const scrapeChannelId = opt("scrape") ? parseInt(opt("scrape"), 10) : null;

async function main() {
  if (typeof globalThis.gc === "function") globalThis.gc();

  console.log("Benchmark: scraper sleeping vs scraping load");
  console.log("DB:", dbPath);
  console.log("Sleep sampling duration:", sleepDurationSec, "s");
  if (scrapeChannelId != null) console.log("Scrape channel ID:", scrapeChannelId);
  console.log("");

  ensureSchema(dbPath);

  let currentPhase = "idle";
  const scraper = new YouTubeChannelScraper({
    dbPath,
    newestOnlyMode: true,
    newestFirstRunCount: 5,
    newestSubsequentLimit: 10,
    onStatusChange: (event) => {
      currentPhase = event.phase;
      if (process.env.DEBUG_SCRAPER) console.log("[phase]", event.phase, event.nextRunAt ?? "");
    },
  });

  // --- Sleeping phase ---
  scraper.start();
  const waitForSleepMs = 15000;
  const step = 500;
  let elapsed = 0;
  while (elapsed < waitForSleepMs && currentPhase !== "sleeping" && currentPhase !== "idle") {
    await sleep(step);
    elapsed += step;
  }
  if (currentPhase !== "sleeping" && currentPhase !== "idle") {
    console.log("(Scraper did not enter sleeping/idle within 15s; sampling anyway.)");
  }
  await sleep(1000); // settle

  const sleepSamples = [];
  const sleepStart = sample();
  const intervalMs = 1000;
  for (let i = 0; i < sleepDurationSec; i++) {
    await sleep(intervalMs);
    sleepSamples.push(sample());
  }
  const sleepEnd = sample();

  const avgRss = sleepSamples.reduce((s, x) => s + x.rss, 0) / sleepSamples.length;
  const avgHeap = sleepSamples.reduce((s, x) => s + x.heapUsed, 0) / sleepSamples.length;
  const cpuTotalSleep = (sleepEnd.cpuUser - sleepStart.cpuUser) + (sleepEnd.cpuSystem - sleepStart.cpuSystem);

  console.log("--- SLEEPING (schedule wait) ---");
  console.log("  Phase during sample:", currentPhase);
  console.log("  RSS:  avg", formatBytes(avgRss), "  (start → end:", formatBytes(sleepStart.rss), "→", formatBytes(sleepEnd.rss) + ")");
  console.log("  Heap: avg", formatBytes(avgHeap), "  (start → end:", formatBytes(sleepStart.heapUsed), "→", formatBytes(sleepEnd.heapUsed) + ")");
  console.log("  CPU over", sleepDurationSec, "s: user+system", formatMicros(cpuTotalSleep), "(" + (cpuTotalSleep / 1e6 / sleepDurationSec * 100).toFixed(2) + "% of one core)");
  console.log("");

  if (scrapeChannelId != null) {
    // --- Scraping phase ---
    console.log("--- SCRAPING (runOnce) ---");
    const scrapeSamples = [];
    const scrapeStart = sample();
    const scrapePromise = scraper.runOnce(scrapeChannelId);
    const scrapeInterval = setInterval(() => {
      scrapeSamples.push(sample());
    }, 500);
    await scrapePromise;
    clearInterval(scrapeInterval);
    const scrapeEnd = sample();

    const peakRss = scrapeSamples.length ? Math.max(...scrapeSamples.map((s) => s.rss)) : scrapeEnd.rss;
    const peakHeap = scrapeSamples.length ? Math.max(...scrapeSamples.map((s) => s.heapUsed)) : scrapeEnd.heapUsed;
    const cpuTotalScrape = (scrapeEnd.cpuUser - scrapeStart.cpuUser) + (scrapeEnd.cpuSystem - scrapeStart.cpuSystem);

    console.log("  Peak RSS: ", formatBytes(peakRss));
    console.log("  Peak Heap:", formatBytes(peakHeap));
    console.log("  CPU (user+system):", formatMicros(cpuTotalScrape));
    console.log("");
  }

  scraper.stop();
  if (typeof globalThis.gc === "function") globalThis.gc();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
