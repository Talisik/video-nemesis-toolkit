export { DownloadWorker } from "./workers/download-worker/index.js";
export { YouTubeChannelScraper } from "./workers/scraper-worker/index.js";
export type {
  YouTubeChannelScraperOptions,
  ScraperStatusPhase,
  ScraperStatusEvent,
} from "./workers/scraper-worker/index.js";
export type {
  ChannelRow,
  ChannelSlotRow,
  DownloadTaskRow,
  DownloadTaskStatus,
  DownloadWorkerOptions,
  DownloadHistoryRow,
  ScheduleRow,
  VideoDetailRow,
} from "./types/index.js";
export { openDb } from "./db.js";
export { ensureSchema, runMigrations } from "./schema.js";
export { registerIpcHandlers as registerVideoNemesisIpcHandlers } from "./ipc/register.js";
export type { IpcBridgeOptions } from "./ipc/types.js";
export type { HandlerContext } from "./ipc/handlers.js";
export { claimNextPendingTask, setTaskStatus } from "./workers/download-worker/db.js";
export { downloadVideo } from "./workers/download-worker/download.js";
export type { DownloadOptions } from "./workers/download-worker/download.js";
export {
  DownloadTaskStatus as DownloadTaskStatusEnum,
  IpcChannels as VideoNemesisIpcChannels,
} from "./types/enum/index.js";
export type { DownloadTaskStatusType, IpcChannelName } from "./types/enum/index.js";
