/**
 * CPU and memory benchmark for video-nemesis-toolkit.
 *
 * Usage:
 *   npm run build && node scripts/benchmark.js [options]
 *
 * Options:
 *   --iterations N   Run each benchmark N times (default 5).
 *   --expose-gc      Use with node --expose-gc scripts/benchmark.js to allow gc() for memory tests.
 *
 * For deeper profiling:
 *   node --inspect scripts/benchmark.js   Then open chrome://inspect and capture CPU profile.
 *   npx clinic doctor -- node scripts/benchmark.js   (install clinic: npm i -g clinic) for CPU + memory flame.
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, ensureSchema } from "../dist/index.js";

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

function sampleMemory() {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
  };
}

function sampleCpu() {
  return process.cpuUsage();
}

function runBenchmark(name, iterations, fn) {
  const memBefore = sampleMemory();
  const cpuBefore = sampleCpu();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const elapsed = performance.now() - start;

  const cpuAfter = sampleCpu();
  const memAfter = sampleMemory();

  const cpuUser = cpuAfter.user - cpuBefore.user;
  const cpuSystem = cpuAfter.system - cpuBefore.system;

  return {
    name,
    iterations,
    elapsedMs: elapsed,
    cpuUser,
    cpuSystem,
    memBefore,
    memAfter,
    heapDelta: memAfter.heapUsed - memBefore.heapUsed,
    rssDelta: memAfter.rss - memBefore.rss,
  };
}

function printResult(r) {
  console.log(`\n--- ${r.name} (${r.iterations} iterations) ---`);
  console.log(`  Time:     ${r.elapsedMs.toFixed(2)} ms (${(r.elapsedMs / r.iterations).toFixed(2)} ms/iter)`);
  console.log(`  CPU:      user ${formatMicros(r.cpuUser)}, system ${formatMicros(r.cpuSystem)}`);
  console.log(`  Heap:     ${formatBytes(r.memBefore.heapUsed)} → ${formatBytes(r.memAfter.heapUsed)} (Δ ${formatBytes(r.heapDelta)})`);
  console.log(`  RSS:      ${formatBytes(r.memBefore.rss)} → ${formatBytes(r.memAfter.rss)} (Δ ${formatBytes(r.rssDelta)})`);
}

const args = process.argv.slice(2);
const iterArg = args.find((a) => a.startsWith("--iterations="));
const iterations = iterArg ? Math.max(1, parseInt(iterArg.split("=")[1], 10)) : 5;

const benchDbPath = path.join(os.tmpdir(), "video-nemesis-bench.db");

async function main() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }

  console.log("video-nemesis-toolkit benchmark (CPU & memory)");
  console.log("Iterations per benchmark:", iterations);
  console.log("DB path:", benchDbPath);

  // 1) Open/close DB repeatedly
  const openClose = runBenchmark("openDb + close (cold)", iterations, (i) => {
    const db = openDb(benchDbPath);
    db.close();
  });
  printResult(openClose);

  // 2) ensureSchema once then many reads (prepared statements)
  const db = ensureSchema(benchDbPath);
  const readIterations = Math.min(iterations * 20, 200);
  const manyReads = runBenchmark(
    `SELECT channels (${readIterations}x)`,
    readIterations,
    () => {
      db.prepare("SELECT id, name FROM channels LIMIT 50").all();
    }
  );
  printResult(manyReads);

  // 3) Many inserts (download_task)
  const now = new Date().toISOString();
  const insertIterations = Math.min(iterations * 10, 100);
  const manyWrites = runBenchmark(
    `INSERT download_task (${insertIterations}x)`,
    insertIterations,
    (i) => {
      db.prepare(
        `INSERT INTO download_task (video_url, channel_id, status, created_at, updated_at)
         VALUES (?, 1, 'pending', ?, ?)`
      ).run(`https://youtube.com/watch?v=bench${i}${Date.now()}`, now, now);
    }
  );
  printResult(manyWrites);

  // 4) Mixed read/write
  const mixedIterations = Math.min(iterations * 15, 150);
  const mixed = runBenchmark(
    `Mixed read+write (${mixedIterations}x)`,
    mixedIterations,
    (i) => {
      db.prepare("SELECT COUNT(*) FROM download_task").get();
      db.prepare("SELECT id, name FROM channels LIMIT 10").all();
    }
  );
  printResult(mixed);

  db.close();

  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    const memFinal = sampleMemory();
    console.log("\n--- After GC ---");
    console.log("  Heap:", formatBytes(memFinal.heapUsed));
    console.log("  RSS:", formatBytes(memFinal.rss));
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
