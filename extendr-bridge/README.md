# Nemesis Extendr Bridge

This folder is an [Extendr](https://github.com/Talisik/extendr) main-process extension. It registers the Video Nemesis Toolkit's IPC handlers with the host app's Electron `ipcMain` when the host starts, so the toolkit runs as a headless backend extension.

## Deployment (host app, e.g. downlodr_v3)

### (a) Copy or link the extension into the host's Extendr extensions path

The host discovers extensions from one or more directories (e.g. `userData/extensions`, or portable `exe/../extensions`). Put this extension there.

**Option 1 – Symlink (recommended for development)**  
From the host repo root, with the toolkit repo next to it or at a known path:

```bash
mkdir -p extensions
ln -s /path/to/video-nemesis-toolkit/extendr-bridge extensions/nemesis-extension
```

Then build the toolkit so `dist/` exists at `video-nemesis-toolkit/dist/`:

```bash
cd /path/to/video-nemesis-toolkit && npm run build
```

The bridge will load the toolkit via `../dist/index.js` relative to the extension folder.

**Option 2 – Copy**  
Copy this entire `extendr-bridge` folder into the host's extensions directory as `nemesis-extension`. Then add the toolkit as a dependency of the extension (e.g. in `extensions/nemesis-extension/package.json` set `"dependencies": { "video-nemesis-toolkit": "file:../../../video-nemesis-toolkit" }` and run `npm install` inside `extensions/nemesis-extension`). The bridge will then load the toolkit via `import('video-nemesis-toolkit')` when the local `../dist` path is not present.

### (b) Add the extension to the host's load order

Edit the host's `load-order.json` (path is set by the host's Extendr config, often next to the executable or in the app root). Add an entry for this extension, e.g.:

```json
["portable:nemesis-extension:nemesis-extension"]
```

Append to the existing array if there are other extensions. Format is `source:folderName:entryName` (folder name is the directory name under the extensions path; entry name is typically the same).

### (c) Native rebuild in the host

The toolkit uses `better-sqlite3` (native). The extension runs inside the host's Electron process, so native modules must be built for the host's Electron version. In the **host** app directory run:

```bash
npm install
npx electron-rebuild -f -w better-sqlite3
```

If the host already has `video-nemesis-toolkit` as a dependency, this rebuilds it in place. If you only use the symlink/copy approach, ensure the toolkit was built with the same Electron version as the host (e.g. run `electron-rebuild` from the toolkit repo using the host's Electron).

### (d) Build the toolkit before running the host

So that `dist/` exists and the bridge can load the toolkit:

```bash
cd /path/to/video-nemesis-toolkit
npm run build
```

Then start the host app. On startup, Extendr will call the bridge's `main()`, which registers the toolkit's IPC handlers. The database is created at `app.getPath('userData')/nemesis.db`; yt-dlp is resolved next to the host executable (e.g. `yt-dlp.exe` on Windows).

## Behaviour

- **Database:** `nemesis.db` in the host's userData directory.
- **yt-dlp:** Path is set to `{exe directory}/yt-dlp` or `yt-dlp.exe` on Windows. The host may place the binary there when packaged (e.g. via Electron Forge).
- **sendToRenderer:** Omitted so the bridge does not push download-queue or scraper-status to the renderer (Extendr runs before the main window exists). The renderer can still invoke all toolkit IPC channels; see [Frontend integration](../INTEGRATION.md#frontend-integration) in INTEGRATION.md.
