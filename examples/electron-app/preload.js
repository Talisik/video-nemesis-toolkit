const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("toolkit", {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onDownloadQueuePushed: (fn) => {
    ipcRenderer.on("toolkit:downloadQueue:pushed", (_event, tasks) => fn(tasks));
  },
  onScraperStatus: (fn) => {
    ipcRenderer.on("toolkit:scraper:status", (_event, event) => fn(event));
  },
  channels: {
    SCHEDULES_LIST: "toolkit:schedules:list",
    SCHEDULES_GET: "toolkit:schedules:get",
    SCHEDULES_CREATE: "toolkit:schedules:create",
    CHANNELS_LIST: "toolkit:channels:list",
    CHANNELS_CREATE: "toolkit:channels:create",
    CHANNEL_SLOTS_LIST: "toolkit:channelSlots:list",
    CHANNEL_SLOTS_REPLACE: "toolkit:channelSlots:replace",
    CHANNEL_SLOTS_ADD: "toolkit:channelSlots:add",
    CHANNEL_SLOTS_GET_NEXT_RUN: "toolkit:channelSlots:getNextRun",
    SCRAPER_START: "toolkit:scraper:start",
    SCRAPER_STOP: "toolkit:scraper:stop",
    SCRAPER_RUN_ONCE: "toolkit:scraper:runOnce",
    DOWNLOAD_TASKS_LIST: "toolkit:downloadTasks:list",
    DOWNLOAD_TASK_MARK_FINISHED: "toolkit:downloadTasks:markFinished",
  },
});
