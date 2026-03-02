/**
 * Baseline benchmark: Node only, no toolkit, no DB, no scraper.
 * Run this and subtract from bench:scraper-phases to get the toolkit's load.
 *
 *   Toolkit sleeping overhead ≈ (scraper-phases SLEEPING) − (this baseline)
 *   Toolkit scraping overhead ≈ (scraper-phases SCRAPING) − (this baseline)
 *
 * Usage:
 *   node scripts/benchmark-baseline.js [--duration=20]
 *
 * Example:
 *   npm run bench:baseline
 *   npm run bench:baseline:gc   (with --expose-gc)
 */

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

const durationSec = parseInt(
  process.argv.find((a) => a.startsWith("--duration="))?.split("=")[1] || "20",
  10
) || 20;

async function main() {
  if (typeof globalThis.gc === "function") globalThis.gc();

  console.log("Baseline: Node only (no toolkit, no DB, no scraper)");
  console.log("Sample duration:", durationSec, "s");
  console.log("Subtract these numbers from bench:scraper-phases to get toolkit overhead.");
  console.log("");

  const samples = [];
  const start = sample();
  for (let i = 0; i < durationSec; i++) {
    await sleep(1000);
    samples.push(sample());
  }
  const end = sample();

  const avgRss = samples.reduce((s, x) => s + x.rss, 0) / samples.length;
  const avgHeap = samples.reduce((s, x) => s + x.heapUsed, 0) / samples.length;
  const cpuTotal = (end.cpuUser - start.cpuUser) + (end.cpuSystem - start.cpuSystem);

  console.log("--- BASELINE (Node only) ---");
  console.log("  RSS:  avg", formatBytes(avgRss), "  (start → end:", formatBytes(start.rss), "→", formatBytes(end.rss) + ")");
  console.log("  Heap: avg", formatBytes(avgHeap), "  (start → end:", formatBytes(start.heapUsed), "→", formatBytes(end.heapUsed) + ")");
  console.log("  CPU over", durationSec, "s: user+system", formatMicros(cpuTotal), "(" + (cpuTotal / 1e6 / durationSec * 100).toFixed(2) + "% of one core)");
  console.log("");
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
