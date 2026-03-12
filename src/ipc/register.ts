import type { IpcMain } from "electron";
import { openDb } from "../db.js";
import { runMigrations } from "../schema.js";
import * as downloadTasksData from "../data/downloadTasks.js";
import { DownloadWorker } from "../workers/download-worker/index.js";
import { YouTubeChannelScraper } from "../workers/scraper-worker/index.js";
import { createIpcHandlers } from "./handlers.js";
import type { IpcBridgeOptions } from "./types.js";
import { IpcChannels } from "../types/enum/ipcChannels_enum.js";

/** Optional custom registration: when provided, called for each (channelName, handler) instead of ipcMain.handle(channel, handler). Used by Extendr bridge to register via channel IDs. */
export type RegisterIpcHandler = (
  channelName: string,
  handler: (event: unknown, ...args: unknown[]) => Promise<unknown>
) => void;

/**
 * Register all toolkit IPC handlers with Electron's ipcMain.
 * Call this from the Electron main process after ensuring schema (e.g. ensureSchema(dbPath)).
 * Creates and holds a DownloadWorker and (when available) a scraper; start/stop them via IPC.
 * If `register` is provided, calls it for each (channelName, handler) instead of ipcMain.handle(channel, handler).
 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  options: IpcBridgeOptions,
  register?: RegisterIpcHandler
): void {
  const db = openDb(options.dbPath);
  runMigrations(db);

  const downloadWorker = new DownloadWorker({
    dbPath: options.dbPath,
    ...(options.outputDir !== undefined && { outputDir: options.outputDir }),
    ...(options.pollIntervalMs !== undefined && { pollIntervalMs: options.pollIntervalMs }),
    ...(options.ytDlpPath !== undefined && { ytDlpPath: options.ytDlpPath }),
    ...(options.maxHeight !== undefined && { maxHeight: options.maxHeight }),
  });

  let downloadWorkerRunning = false;

  const channel = options.downloadQueuePushChannel ?? IpcChannels.DOWNLOAD_QUEUE_PUSHED;
  const statusChannel = options.scraperStatusChannel ?? IpcChannels.SCRAPER_STATUS;
  const scraper = new YouTubeChannelScraper({
    dbPath: options.dbPath,
    ...(options.ytDlpPath !== undefined && { ytDlpPath: options.ytDlpPath }),
    ...(options.pollIntervalMs !== undefined && { pollIntervalMs: options.pollIntervalMs }),
    ...(options.scraperNewestOnlyMode === true && {
      newestOnlyMode: true,
      newestFirstRunCount: options.scraperNewestFirstRunCount ?? 15,
      newestSubsequentLimit: options.scraperNewestSubsequentLimit ?? 50,
    }),
    ...(options.sendToRenderer != null && {
      onRunComplete: () => {
        setImmediate(() => {
          const tasks = downloadTasksData.listDownloadTasks(db, "pending");
          options.sendToRenderer!(channel, tasks);
        });
      },
    }),
    ...(options.sendToRenderer != null && {
      onStatusChange: (event) => {
        options.sendToRenderer!(statusChannel, event);
      },
    }),
  });

  const handlers = createIpcHandlers({
    db,
    options,
    getDownloadWorker: () => downloadWorker,
    getDownloadWorkerRunning: () => downloadWorkerRunning,
    setDownloadWorkerRunning: (running: boolean) => {
      downloadWorkerRunning = running;
    },
    getScraper: () => scraper,
  });

  for (const [channelName, handler] of Object.entries(handlers)) {
    const typedHandler = handler as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    if (register !== undefined) {
      register(channelName, typedHandler);
    } else {
      ipcMain.handle(channelName, typedHandler);
    }
  }
}
