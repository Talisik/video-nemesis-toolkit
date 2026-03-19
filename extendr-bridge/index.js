/**
 * Extendr bridge for Video Nemesis Toolkit.
 * Export main() for Extendr; runs in the host app's main process and registers
 * the toolkit's IPC handlers via Extendr's extension channels (Channelr) so the
 * frontend uses window.extendr.extensions['nemesis-extension'][channelName]().
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

/**
 * Extendr entry point. Called by Deployr.setupMain() during host app ready.
 * @param {{ events: unknown, channels: { register: (name: string) => string }, electron: { app: object, ipcMain: object } }} args - Extendr passes events, channels (Channelr), and electron.
 */
async function main(args) {
  const { channels, electron } = args;
  const { app, ipcMain } = electron;

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

  const customRegister = (channelName, handler) => {
    const channelID = channels.register(channelName);
    ipcMain.handle(channelID, handler);
  };

  toolkit.registerVideoNemesisIpcHandlers(ipcMain, options, customRegister);
}

module.exports = { main };
