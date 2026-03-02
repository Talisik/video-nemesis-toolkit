import { spawn } from "node:child_process";

/** yt-dlp --print uses %(field)s template placeholders. release_timestamp = unix seconds (for upload time window). */
const PRINT_FORMAT = "%(id)s\t%(duration)s\t%(title)s\t%(timestamp)s";

/** YouTube video IDs are 11 chars, alphanumeric + hyphen + underscore. */
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

function isValidYoutubeVideoId(id: string): boolean {
  return YOUTUBE_VIDEO_ID_REGEX.test(id);
}

export interface ScrapedVideo {
  id: string;
  durationSeconds: number;
  title: string;
  /** Unix seconds (from release_timestamp), for upload time-of-day filtering. */
  releaseTimestamp: number | null;
}

const DEFAULT_YT_DLP_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Run yt-dlp --flat-playlist --print to list videos from a channel URL.
 * Returns parsed lines; duration may be 0 if missing (e.g. live/scheduled).
 * Times out after timeoutMs (default 2 min) to avoid hanging on large channels or network issues.
 * When maxVideos is set, only the latest N videos are fetched (--playlist-end); /videos is newest-first.
 */
export function listChannelVideos(
  ytDlpPath: string,
  channelUrl: string,
  options?: { timeoutMs?: number; maxVideos?: number }
): Promise<ScrapedVideo[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_YT_DLP_TIMEOUT_MS;
  const maxVideos = options?.maxVideos;

  const args = [
    "--flat-playlist",
    "--extractor-args",
    "youtubetab:approximate_date",
    "--print",
    PRINT_FORMAT,
    "--no-warnings",
    "--quiet",
  ];
  if (maxVideos !== undefined && maxVideos > 0) {
    args.push("--playlist-end", String(maxVideos));
  }
  args.push(channelUrl);

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    let stderr = "";
    const debugStderr = process.env.DEBUG_SCRAPER !== undefined;
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (debugStderr) process.stderr.write("[yt-dlp] " + text);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s. Channel may be large or slow. Try increasing timeout.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
    }

    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });

    proc.on("close", (code, signal) => {
      cleanup();
      if (signal === "SIGKILL") return; // already rejected in timeout
      if (code !== 0) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const result: ScrapedVideo[] = [];
      for (const line of lines) {
        const parts = line.split("\t");
        const id = (parts[0] ?? "").trim();
        if (id === "id" || id === "title") continue; // skip header if yt-dlp printed one
        const durationRaw = parts[1];
        const durationSeconds = durationRaw ? Number(durationRaw) : 0;
        const title = parts[2] ?? "";
        const releaseTimestampRaw = parts[3];
        const releaseTimestamp =
          releaseTimestampRaw && /^\d+$/.test(releaseTimestampRaw.trim())
            ? parseInt(releaseTimestampRaw.trim(), 10)
            : null;
        if (id && isValidYoutubeVideoId(id)) {
          result.push({
            id,
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
            title,
            releaseTimestamp: releaseTimestamp != null && Number.isFinite(releaseTimestamp) ? releaseTimestamp : null,
          });
        }
      }
      if (process.env.DEBUG_SCRAPER && result.length === 0) {
        if (lines.length === 0) {
          process.stderr.write("[scraper] yt-dlp returned 0 lines (empty stdout). Check URL, cookies, or region.\n");
        } else {
          process.stderr.write(
            `[scraper] yt-dlp returned ${lines.length} line(s) but 0 passed id check. First: ${lines.slice(0, 2).map((l) => JSON.stringify(l.slice(0, 120))).join(" | ")}\n`
          );
        }
      }
      resolve(result);
    });
  });
}
