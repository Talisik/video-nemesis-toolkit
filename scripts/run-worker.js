/**
 * Runs the download worker against a SQLite DB.
 * Usage: node scripts/run-worker.js [dbPath]
 * Default dbPath: ./video-nemesis.db
 *
 * Prerequisites: npm run build, then seed DB with scripts/seed-test-db.js.
 * Requires yt-dlp and ffmpeg on PATH (yt-dlp uses ffmpeg to merge video+audio into .mp4).
 * Install: brew install yt-dlp ffmpeg
 * Press Ctrl+C to stop.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { DownloadWorker } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ytDlpPath = process.env.YT_DLP_PATH || "yt-dlp";

function checkBin(name, installHint) {
  try {
    execSync(process.platform === "win32" ? `where ${name}` : `command -v ${name}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    console.error(`${name} not found. ${installHint}`);
    process.exit(1);
  }
}

checkBin(ytDlpPath, "Install: brew install yt-dlp   or set YT_DLP_PATH.");
checkBin("ffmpeg", "Install: brew install ffmpeg   (needed to merge video+audio into .mp4).");

const dbPath = process.argv[2] || path.join(__dirname, "..", "video-nemesis.db");

const worker = new DownloadWorker({
  dbPath,
  outputDir: path.join(__dirname, "..", "temp_videos"),
  pollIntervalMs: 2000,
  ytDlpPath,
});

worker.start();
console.log("Worker started. DB:", dbPath, "| Output: temp_videos/ | Ctrl+C to stop.");

process.on("SIGINT", () => {
  worker.stop();
  console.log("Worker stopped.");
  process.exit(0);
});
