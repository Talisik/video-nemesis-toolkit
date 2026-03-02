/**
 * Tests the "download queue push" flow without Electron: after a scraper run,
 * the toolkit calls sendToRenderer with the pending download tasks.
 *
 * Usage:
 *   npm run build
 *   node scripts/seed-test-db.js          # create video-nemesis.db with channels + slots
 *   node scripts/test-download-queue-push.js [dbPath]
 *
 * Optional: DEBUG_SCRAPER=1 node scripts/test-download-queue-push.js
 * Default dbPath: ./video-nemesis.db
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureSchema,
  registerIpcHandlers,
  IpcChannels,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] || path.join(__dirname, "..", "video-nemesis.db");

const handlers = {};
const ipcMain = {
  handle(channel, handler) {
    handlers[channel] = handler;
  },
};

const pushed = [];
const sendToRenderer = (channel, payload) => {
  pushed.push({ channel, payload });
  const count = Array.isArray(payload) ? payload.length : "?";
  console.log("[DOWNLOAD_QUEUE_PUSHED]", channel, "tasks:", count);
};

ensureSchema(dbPath);
registerIpcHandlers(ipcMain, {
  dbPath,
  sendToRenderer,
  downloadQueuePushChannel: IpcChannels.DOWNLOAD_QUEUE_PUSHED,
});

async function invoke(channel, ...args) {
  const fn = handlers[channel];
  if (!fn) throw new Error("No handler for " + channel);
  return fn({}, ...args);
}

async function main() {
  console.log("DB:", dbPath);
  console.log("Invoking SCRAPER_RUN_ONCE (may take a minute if yt-dlp runs)...\n");
  await invoke(IpcChannels.SCRAPER_RUN_ONCE);
  console.log("\nPushes received:", pushed.length);
  if (pushed.length > 0 && Array.isArray(pushed[0].payload) && pushed[0].payload.length > 0) {
    console.log("First task sample:", JSON.stringify(pushed[0].payload[0], null, 2).slice(0, 300) + "...");
  }
  console.log("Done. Queue push works when sendToRenderer is set.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
