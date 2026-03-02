import Database from "better-sqlite3";
import * as downloadTasksData from "../../data/downloadTasks.js";
import * as downloadHistoryData from "../../data/downloadHistory.js";
import type { DownloadTaskRow } from "../../types/index.js";
import type { DownloadTaskStatusType } from "../../types/enum/downloadTaskStatus.js";

export function claimNextPendingTask(
  db: Database.Database
): DownloadTaskRow | null {
  return downloadTasksData.claimNextPendingTask(db);
}

export function setTaskStatus(
  db: Database.Database,
  id: number,
  status: DownloadTaskStatusType,
  options?: { incrementRetry?: boolean }
): void {
  downloadTasksData.setTaskStatus(db, id, status, options);
}

export function insertDownloadHistory(
  db: Database.Database,
  row: Parameters<typeof downloadHistoryData.insertDownloadHistory>[1]
): void {
  downloadHistoryData.insertDownloadHistory(db, row);
}
