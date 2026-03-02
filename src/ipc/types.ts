/**
 * Options for registerIpcHandlers. Passed from Electron main process.
 */
export interface IpcBridgeOptions {
  /** Path to SQLite database file. */
  dbPath: string;
  /** Output directory for downloaded files (default: temp_videos). */
  outputDir?: string;
  /** Poll interval in ms for download worker (default: 2000). */
  pollIntervalMs?: number;
  /** Path to yt-dlp executable (default: yt-dlp). */
  ytDlpPath?: string;
  /** Max video height for downloads (default: 720). */
  maxHeight?: number;
  /**
   * Send a message to the renderer. If set with downloadQueuePushChannel, the download queue
   * is pushed to the renderer after each scraper run (e.g. sendToRenderer: (ch, payload) => mainWindow.webContents.send(ch, payload)).
   */
  sendToRenderer?: (channel: string, payload: unknown) => void;
  /**
   * IPC channel to push the download queue to the renderer after each scraper run.
   * Use with sendToRenderer. Default: toolkit:downloadQueue:pushed.
   */
  downloadQueuePushChannel?: string;
  /**
   * IPC channel to push scraper status to the renderer (phase: sleeping | running | finished | idle, nextRunAt?).
   * Use with sendToRenderer. Default: toolkit:scraper:status.
   */
  scraperStatusChannel?: string;
  /** Scraper: newest-only mode (first run 15 videos, subsequent runs only new ones). Default false. */
  scraperNewestOnlyMode?: boolean;
  /** Scraper: first-run count when newestOnlyMode. Default 15. */
  scraperNewestFirstRunCount?: number;
  /** Scraper: subsequent-run limit when newestOnlyMode. Default 20. */
  scraperNewestSubsequentLimit?: number;
}
