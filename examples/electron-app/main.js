/**
 * Minimal Electron app to test the toolkit: scraper + download queue push to renderer.
 * Run from repo root: npm run build && npx electron examples/electron-app/main.js
 * Seed DB first: npm run seed
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { registerVideoNemesisIpcHandlers, VideoNemesisIpcChannels } from "../../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use project video-nemesis.db (same as npm run seed) when run from repo root
const dbPath = path.join(process.cwd(), "video-nemesis.db");

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

app.whenReady().then(() => {
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
  createWindow();
});

app.on("window-all-closed", () => app.quit());
