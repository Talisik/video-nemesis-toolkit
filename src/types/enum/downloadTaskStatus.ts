/**
 * Task status values for download_task table.
 * Scheduler inserts rows with status PENDING; worker claims and sets DOWNLOADING → DOWNLOADED or DOWNLOAD_FAILED.
 */
export const DownloadTaskStatus = {
  PENDING: "pending",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  DOWNLOAD_FAILED: "download_failed",
} as const;

export type DownloadTaskStatusType =
  (typeof DownloadTaskStatus)[keyof typeof DownloadTaskStatus];
