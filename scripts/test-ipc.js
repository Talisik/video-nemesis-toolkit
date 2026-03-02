/**
 * Tests the toolkit without Electron: ensures schema, registers IPC handlers
 * with a mock ipcMain, and invokes a few channels to verify the bridge.
 *
 * Usage: npm run build && node scripts/test-ipc.js
 * Optional: node scripts/test-ipc.js path/to/video-nemesis.db
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

ensureSchema(dbPath);
registerIpcHandlers(ipcMain, { dbPath });

async function invoke(channel, ...args) {
  const fn = handlers[channel];
  if (!fn) throw new Error("No handler for " + channel);
  return fn({}, ...args);
}

async function main() {
  console.log("DB:", dbPath);
  console.log("");

  const listBefore = await invoke(IpcChannels.CHANNELS_LIST);
  console.log("CHANNELS_LIST (before):", Array.isArray(listBefore) ? listBefore.length : listBefore);

  const schedule = await invoke(IpcChannels.SCHEDULES_CREATE, { name: "IPC Test Schedule" });
  const scheduleId = schedule?.id;
  console.log("SCHEDULES_CREATE:", scheduleId ?? schedule);

  const created = await invoke(IpcChannels.CHANNELS_CREATE, {
    schedule_id: scheduleId,
    name: "IPC Test Channel",
    url: "https://www.youtube.com/@YouTube",
    min_duration_minutes: 0,
    max_duration_minutes: 30,
    active: 1,
  });
  const createdId = created?.id;
  console.log("CHANNELS_CREATE:", createdId ?? created);

  const listAfter = await invoke(IpcChannels.CHANNELS_LIST);
  console.log("CHANNELS_LIST (after):", Array.isArray(listAfter) ? listAfter.length : listAfter);

  const tasks = await invoke(IpcChannels.DOWNLOAD_TASKS_LIST);
  console.log("DOWNLOAD_TASKS_LIST:", Array.isArray(tasks) ? tasks.length : tasks);

  const oneChannel = await invoke(IpcChannels.CHANNELS_GET, createdId);
  console.log("CHANNELS_GET(", createdId, "):", oneChannel?.name ?? oneChannel);

  await invoke(IpcChannels.CHANNELS_DELETE, createdId);
  console.log("CHANNELS_DELETE(", createdId, "): ok");

  await invoke(IpcChannels.SCHEDULES_DELETE, scheduleId);
  console.log("SCHEDULES_DELETE(", scheduleId, "): ok");

  console.log("");
  console.log("IPC bridge test done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
