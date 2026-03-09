# Video Nemesis Toolkit – Host integration

This document describes how to run the toolkit inside a host Electron app (e.g. via the Extendr bridge) and how the frontend can call it and receive push events.

## Frontend integration

Once the toolkit's IPC handlers are registered in the host main process (e.g. by the [Extendr bridge](extendr-bridge/README.md)), the renderer can talk to the toolkit in two ways.

### Option A: Generic invoke (no host preload changes)

If the host already exposes a generic IPC invoke (e.g. `invokeMainProcess(channel, ...args)` or `appBehaviorBridge.invoke(channel, ...args)`), the frontend can call any toolkit channel without adding new preload code:

```ts
// In any renderer component (e.g. React)
const channels = await window.downlodrFunctions.invokeMainProcess('toolkit:channels:list');
const schedules = await window.downlodrFunctions.invokeMainProcess('toolkit:schedules:list');
await window.downlodrFunctions.invokeMainProcess('toolkit:scraper:start');
```

**Limitation:** Main-to-renderer pushes (`toolkit:downloadQueue:pushed`, `toolkit:scraper:status`) are one-way. With only a generic invoke, the renderer cannot subscribe to these events unless the host exposes a way to listen (e.g. a generic "subscribe to channel" in preload). So Option A is enough for all request/response calls but not for live queue or scraper-status updates.

### Option B: Dedicated toolkit bridge (recommended for full UX)

Expose a dedicated bridge in the host's preload, similar to [examples/electron-app/preload.js](examples/electron-app/preload.js):

- **invoke(channel, ...args)** – `ipcRenderer.invoke(channel, ...args)` for all toolkit channels.
- **onDownloadQueuePushed(callback)** – `ipcRenderer.on('toolkit:downloadQueue:pushed', (_, payload) => callback(payload))`, with an unsubscribe return if needed.
- **onScraperStatus(callback)** – `ipcRenderer.on('toolkit:scraper:status', (_, payload) => callback(payload))`.
- **channels** – Optional object with channel name constants so the renderer avoids magic strings (see below).

Then the frontend can:

1. **CRUD:** `window.toolkit.invoke(window.toolkit.channels.CHANNELS_LIST)`, `toolkit:schedules:list`, etc.
2. **Scraper:** `toolkit:scraper:start`, `toolkit:scraper:stop`, `toolkit:scraper:runOnce`.
3. **Download worker:** `toolkit:downloadWorker:start`, `toolkit:downloadWorker:stop`, `toolkit:downloadWorker:getStatus`.
4. **Intelligent schedule:** `toolkit:intelligentSchedule:get`, `getUpcoming`, `getOverdue`, `getStats`, `refreshAll`.
5. **Push updates:** Subscribe once (e.g. in a root component or store) to `onDownloadQueuePushed` and `onScraperStatus` to refresh the UI when the queue or scraper state changes.

### Channel names reference

All IPC channel names are defined in the toolkit as [src/types/enum/ipcChannels_enum.ts](src/types/enum/ipcChannels_enum.ts). The host can re-export or inline that object (e.g. as `toolkit.channels`) for typed usage in the renderer. Handlers are registered for every channel listed there (channels, schedules, slots, analyze, intelligent schedule, download tasks, history, video details, scraper, download worker, and process load).
