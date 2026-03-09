/**
 * Extendr bridge for Video Nemesis Toolkit.
 * Export main() for Extendr; runs in the host app's main process and registers
 * the toolkit's IPC handlers (db, scraper, download worker).
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

/**
 * Extendr entry point. Called by Deployr.setupMain() during host app ready.
 * @param {{ events: unknown }} _ - Extendr passes { events }; we do not use it for toolkit logic.
 */
async function main(_) {
  const { app, ipcMain } = require('electron');

  const dbPath = path.join(app.getPath('userData'), 'nemesis.db');

  const exeDir = path.dirname(app.getPath('exe'));
  const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = path.join(exeDir, ytDlpName);

  const options = {
    dbPath,
    ytDlpPath,
  };

  let toolkit;
  const localDistPath = path.join(__dirname, '..', 'dist', 'index.js');
  if (fs.existsSync(localDistPath)) {
    toolkit = await import(pathToFileURL(localDistPath).href);
  } else {
    toolkit = await import('video-nemesis-toolkit');
  }

  toolkit.registerVideoNemesisIpcHandlers(ipcMain, options);
}

module.exports = { main };
