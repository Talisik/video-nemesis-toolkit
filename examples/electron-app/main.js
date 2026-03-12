/**
 * Minimal Electron app to test the toolkit: scraper + download queue push to renderer.
 * Run from repo root: npm run build && npx electron examples/electron-app/main.js
 * Seed DB first: npm run seed
 *
 * Baseline (Electron without toolkit): set env SKIP_VIDEO_NEMESIS=1 to skip registering
 * the toolkit. Use the main-process RSS/heap as baseline, then subtract from the
 * normal run to get toolkit overhead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

// Disable Chromium sandbox on Linux when chrome-sandbox is not set up (avoids SUID 4755 requirement)
app.commandLine.appendSwitch("no-sandbox");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use project video-nemesis.db (same as npm run seed) when run from repo root
const dbPath = path.join(process.cwd(), "video-nemesis.db");
const skipToolkit = process.env.SKIP_VIDEO_NEMESIS === "1";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  if (skipToolkit) {
    // Baseline: no toolkit. Only expose process load so the UI can show RSS/heap.
    ipcMain.handle("toolkit:process:load", () => {
      const m = process.memoryUsage();
      const c = process.cpuUsage();
      return {
        memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external },
        cpu: { user: c.user, system: c.system },
      };
    });
  } else {
    const { registerVideoNemesisIpcHandlers, VideoNemesisIpcChannels } = await import("../../dist/index.js");
    const sendToRenderer = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    };
    registerVideoNemesisIpcHandlers(ipcMain, {
      dbPath,
      sendToRenderer,
      downloadQueuePushChannel: VideoNemesisIpcChannels.DOWNLOAD_QUEUE_PUSHED,
      scraperNewestOnlyMode: true,
      scraperNewestFirstRunCount: 15,
      scraperNewestSubsequentLimit: 50,
    });
  }
  createWindow();
});

app.on("window-all-closed", () => app.quit());
