export { DownloadWorker } from "./workers/download-worker/index.js";
export { YouTubeChannelScraper } from "./workers/scraper-worker/index.js";
export type {
  YouTubeChannelScraperOptions,
  ScraperStatusPhase,
  ScraperStatusEvent,
  ScrapeChannelError,
  ScrapeRunResult,
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

import type { IpcMain } from "electron";
import { registerIpcHandlers } from "./ipc/register.js";
import type { IpcBridgeOptions } from "./ipc/types.js";
import { IpcChannels } from "./types/enum/ipcChannels_enum.js";

/**
 * Extendr extension entry point. Registers all video-nemesis-toolkit IPC channels
 * with the extendr event system so the host can invoke them via EventManagr.fire().
 *
 * Usage in extension package.json: "main": "index.js"
 * Extendr calls: main({ events, ...bridgeOptions })
 *
 * Required: events (extendr event bus), dbPath (IpcBridgeOptions).
 * Optional: sendToRenderer, downloadQueuePushChannel, scraperStatusChannel,
 * outputDir, pollIntervalMs, ytDlpPath, maxHeight, scraperNewestOnlyMode, etc.
 *
 * Invocable channels (request/response) are all IpcChannels except the push-only
 * DOWNLOAD_QUEUE_PUSHED and SCRAPER_STATUS.
 */
export function main(
  entry: {
    events: { on(eventName: string, callback: (event: unknown, ...args: unknown[]) => unknown, priority?: number): void };
    dbPath: string;
  } & Omit<IpcBridgeOptions, "dbPath">
): void {
  const { events, dbPath, ...rest } = entry;
  const options: IpcBridgeOptions = { dbPath, ...rest };
  const priority = -10;

  const ipcAdapter = {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void {
      events.on(channel, (event: unknown, ...args: unknown[]) => handler(event, ...args), priority);
    },
  };

  registerIpcHandlers(ipcAdapter as unknown as IpcMain, options);
}

/** All IPC channel names this extension handles (for extendr / host discovery). */
export const extendrChannels = Object.freeze({ ...IpcChannels });
