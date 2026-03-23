/**
 * IPC channel names for Electron RPC bridge (reference; consumed by app).
 * The library registers handlers for these in registerIpcHandlers.
 */
export const IpcChannels = {
  // Channels CRUD (belong to a schedule)
  CHANNELS_LIST: "toolkit:channels:list",
  CHANNELS_GET: "toolkit:channels:get",
  CHANNELS_CREATE: "toolkit:channels:create",
  CHANNELS_UPDATE: "toolkit:channels:update",
  CHANNELS_DELETE: "toolkit:channels:delete",
  CHANNELS_SET_ACTIVE: "toolkit:channels:setActive",

  // Schedules (one schedule, many channels)
  SCHEDULES_LIST: "toolkit:schedules:list",
  SCHEDULES_GET: "toolkit:schedules:get",
  SCHEDULES_CREATE: "toolkit:schedules:create",
  SCHEDULES_UPDATE: "toolkit:schedules:update",
  SCHEDULES_DELETE: "toolkit:schedules:delete",

  // Channel slots (day_of_week 0–6, time_minutes 0–1439 per channel)
  CHANNEL_SLOTS_LIST: "toolkit:channelSlots:list",
  CHANNEL_SLOTS_REPLACE: "toolkit:channelSlots:replace",
  CHANNEL_SLOTS_ADD: "toolkit:channelSlots:add",
  CHANNEL_SLOTS_GET_NEXT_RUN: "toolkit:channelSlots:getNextRun",

  /** Infer upload schedule from channel URL (last 50 videos). Returns suggested slots or irregular. */
  CHANNEL_ANALYZE_SCHEDULE: "toolkit:channelAnalyze:schedule",

  /** Fetch accurate timestamps for a channel (full metadata, no flat-playlist). Used after user confirms channel addition. */
  CHANNEL_FETCH_ACCURATE_TIMESTAMPS: "toolkit:channelFetch:accurateTimestamps",

  /** Save videos used for interval inference (e.g. after analyze). Payload: channelId, videos[]. */
  CHANNEL_ANALYSIS_VIDEOS_SAVE: "toolkit:channelAnalysisVideos:save",
  /** @deprecated Recompute interval from channel_analysis_videos. Use intelligent_schedule instead. */
  CHANNEL_ANALYSIS_RECOMPUTE_INTERVAL: "toolkit:channelAnalysis:recomputeInterval",

  // Intelligent schedule predictions (smart analysis-based scheduling)
  INTELLIGENT_SCHEDULE_GET: "toolkit:intelligentSchedule:get",
  INTELLIGENT_SCHEDULE_GET_UPCOMING: "toolkit:intelligentSchedule:getUpcoming",
  INTELLIGENT_SCHEDULE_GET_OVERDUE: "toolkit:intelligentSchedule:getOverdue",
  INTELLIGENT_SCHEDULE_GET_STATS: "toolkit:intelligentSchedule:getStats",
  INTELLIGENT_SCHEDULE_REFRESH_ALL: "toolkit:intelligentSchedule:refreshAll",

  // Download tasks
  DOWNLOAD_TASKS_LIST: "toolkit:downloadTasks:list",
  DOWNLOAD_TASKS_ADD: "toolkit:downloadTasks:add",
  DOWNLOAD_TASKS_GET: "toolkit:downloadTasks:get",
  DOWNLOAD_TASK_MARK_FINISHED: "toolkit:downloadTasks:markFinished",

  // Download history
  DOWNLOAD_HISTORY_LIST: "toolkit:downloadHistory:list",

  // Video details
  VIDEO_DETAILS_LIST: "toolkit:videoDetails:list",
  VIDEO_DETAILS_GET: "toolkit:videoDetails:get",

  // Scraper
  SCRAPER_START: "toolkit:scraper:start",
  SCRAPER_STOP: "toolkit:scraper:stop",
  SCRAPER_RUN_ONCE: "toolkit:scraper:runOnce",

  // Download worker
  DOWNLOAD_WORKER_START: "toolkit:downloadWorker:start",
  DOWNLOAD_WORKER_STOP: "toolkit:downloadWorker:stop",
  DOWNLOAD_WORKER_GET_STATUS: "toolkit:downloadWorker:getStatus",

  /** Main → renderer: download queue pushed after scraper run (payload: DownloadTaskRow[]). */
  DOWNLOAD_QUEUE_PUSHED: "toolkit:downloadQueue:pushed",
  /** Main → renderer: scraper status (payload: { phase: 'sleeping'|'running'|'finished'|'idle', nextRunAt?: string }). */
  SCRAPER_STATUS: "toolkit:scraper:status",

  /** Fetch channel details (name, avatar, subscribers, video count, site) from a channel URL via yt-dlp. */
  CHANNEL_FETCH_DETAILS: "toolkit:channel:fetchDetails",

  /** Renderer → main: get process load (memory + CPU). Returns { memory: { rss, heapUsed, heapTotal, external }, cpu: { user, system } }. */
  PROCESS_LOAD: "toolkit:process:load",
} as const;

export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels];
