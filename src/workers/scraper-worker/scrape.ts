import { spawn } from "node:child_process";

/**
 * yt-dlp --print template. We use %(timestamp)s (Unix seconds).
 * With fullMetadata: false (default): --flat-playlist + approximate_date → date only (midnight UTC).
 * With fullMetadata: true: no flat-playlist → fetch each video's metadata → real upload date/time.
 */
const PRINT_FORMAT = "%(id)s\t%(duration)s\t%(title)s\t%(timestamp)s";

const CHANNEL_DETAILS_TIMEOUT_MS = 60_000; // 1 min
const VIDEO_COUNT_LIMIT = 100;

export interface ChannelDetails {
  channelName: string;
  avatarUrl: string | null;
  subscriberCount: number | null;
  videoCount: string;
  site: string;
}

/**
 * Fetch channel-level metadata from a channel URL using yt-dlp --dump-single-json.
 * Video count is capped: if a channel has more than 100 videos, returns "100+".
 */
export function fetchChannelDetails(
  ytDlpPath: string,
  channelUrl: string,
  options?: { timeoutMs?: number; maxVideoCount?: number }
): Promise<ChannelDetails> {
  const timeoutMs = options?.timeoutMs ?? CHANNEL_DETAILS_TIMEOUT_MS;
  const maxVideoCount = options?.maxVideoCount ?? VIDEO_COUNT_LIMIT;

  // Ensure we hit the /videos tab for consistent metadata
  const videosUrl = channelUrl.trim().endsWith("/videos")
    ? channelUrl
    : `${channelUrl.replace(/\/$/, "")}/videos`;

  const args = [
    "--dump-single-json",
    "--flat-playlist",
    "--playlist-end", String(maxVideoCount + 1),
    "--no-warnings",
    "--quiet",
    "--ignore-errors",
    videosUrl,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s fetching channel details.`));
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
      if (signal === "SIGKILL") return;

      if (!stdout.trim()) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(stdout);
      } catch {
        reject(new Error(`Failed to parse yt-dlp JSON output: ${stdout.slice(0, 200)}`));
        return;
      }

      // Channel name
      const channelName =
        (json.channel as string | undefined) ??
        (json.uploader as string | undefined) ??
        (json.title as string | undefined) ??
        "Unknown";

      // Avatar URL — find avatar_uncropped or id "7" in thumbnails array
      let avatarUrl: string | null = null;
      const thumbnails = json.thumbnails as { id?: string; url?: string }[] | undefined;
      if (Array.isArray(thumbnails)) {
        const avatar =
          thumbnails.find((t) => t.id === "avatar_uncropped") ??
          thumbnails.find((t) => t.id === "7");
        if (avatar?.url) avatarUrl = avatar.url;
      }

      // Subscriber count
      const subscriberCount =
        typeof json.channel_follower_count === "number"
          ? (json.channel_follower_count as number)
          : null;

      // Video count — count entries array, cap at limit
      const entries = json.entries as unknown[] | undefined;
      const entryCount = Array.isArray(entries) ? entries.length : 0;
      const videoCount =
        entryCount > maxVideoCount ? `${maxVideoCount}+` : String(entryCount);

      // Site name — derive from extractor
      const extractor = (json.extractor as string | undefined) ?? "";
      const site = extractor.replace(/:.*$/, "") || "unknown";

      resolve({
        channelName,
        avatarUrl,
        subscriberCount,
        videoCount,
        site,
      });
    });
  });
}

/**
 * Probe the 10 most recent videos via flat-playlist + approximate_date to determine
 * upload frequency. If the 10 videos span < MIN_PROBE_SPAN_DAYS, the channel is
 * high-frequency (e.g. news) and we use flat-playlist for the full fetch (date-only).
 * Otherwise we use full metadata (exact timestamps).
 */
const PROBE_COUNT = 10;
const MIN_PROBE_SPAN_DAYS = 3;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Fetch upload dates for a channel's videos uploaded on or after a given date.
 * Automatically picks the right strategy based on upload frequency:
 * - Low-frequency channels: full metadata with exact timestamps.
 * - High-frequency channels: flat-playlist with date-only (HH:mm:ss = 00:00:00).
 * Returns an array of date-time strings in "YYYY-MM-DD HH:mm:ss" format (UTC).
 */
export async function listChannelUploadDates(
  ytDlpPath: string,
  channelUrl: string,
  options?: { daysBack?: number; timeoutMs?: number; maxPerDay?: number }
): Promise<string[]> {
  const daysBack = options?.daysBack ?? 90;
  const timeoutMs = options?.timeoutMs ?? 0; // 0 = no timeout
  const maxPerDay = options?.maxPerDay ?? 0; // 0 = unlimited

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffTs = Math.floor(cutoff.getTime() / 1000);
  const dateAfter = cutoff.toISOString().slice(0, 10).replace(/-/g, "");

  const highFreq = await probeIsHighFrequency(ytDlpPath, channelUrl);

  if (highFreq) {
    return fetchUploadDatesFlat(ytDlpPath, channelUrl, cutoffTs, timeoutMs, maxPerDay);
  }
  return fetchUploadDatesFull(ytDlpPath, channelUrl, dateAfter, cutoffTs, timeoutMs, maxPerDay);
}

/**
 * Probe: fetch 10 most recent videos via flat-playlist + approximate_date.
 * Returns true if the channel is high-frequency (span < MIN_PROBE_SPAN_DAYS).
 */
function probeIsHighFrequency(ytDlpPath: string, channelUrl: string): Promise<boolean> {
  const args = [
    "--no-download", "--flat-playlist",
    "--extractor-args", "youtubetab:approximate_date",
    "--print", "%(timestamp)s",
    "--no-warnings", "--quiet", "--ignore-errors",
    "--playlist-end", String(PROBE_COUNT),
    channelUrl,
  ];

  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false); // on timeout, assume low-frequency (safer: use full metadata)
    }, PROBE_TIMEOUT_MS);

    proc.on("error", () => { clearTimeout(timer); resolve(false); });

    proc.on("close", (_code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") return;

      const timestamps = stdout.trim().split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .map((l) => parseInt(l, 10))
        .filter((ts) => Number.isFinite(ts));

      if (timestamps.length < 2) { resolve(false); return; }

      const minTs = Math.min(...timestamps);
      const maxTs = Math.max(...timestamps);
      const spanDays = (maxTs - minTs) / (24 * 3600);

      resolve(spanDays < MIN_PROBE_SPAN_DAYS);
    });
  });
}

/**
 * Full metadata path: exact timestamps. Uses --dateafter + --break-on-reject for early stopping.
 */
function fetchUploadDatesFull(
  ytDlpPath: string, channelUrl: string,
  dateAfter: string, cutoffTs: number, timeoutMs: number, maxPerDay: number = 0,
): Promise<string[]> {
  const args = [
    "--no-download",
    "--print", "%(id)s\t%(timestamp)s",
    "--no-warnings", "--quiet", "--ignore-errors",
    "--dateafter", dateAfter, "--break-on-reject",
    channelUrl,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s fetching upload dates.`));
        }, timeoutMs)
      : null;

    proc.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });

    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (signal === "SIGKILL") return;

      const dates = parseTimestampLines(stdout, cutoffTs, maxPerDay);
      if (dates.length > 0) { resolve(dates); return; }
      if (code !== 0) { reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 500)}`)); return; }
      resolve(dates);
    });
  });
}

/**
 * Flat-playlist path: date-only (fast). Uses approximate_date extractor arg.
 * Filters by cutoff in JS since --dateafter can't handle NA entries.
 */
function fetchUploadDatesFlat(
  ytDlpPath: string, channelUrl: string, cutoffTs: number, timeoutMs: number = 0, maxPerDay: number = 0,
): Promise<string[]> {
  const args = [
    "--no-download", "--flat-playlist",
    "--extractor-args", "youtubetab:approximate_date",
    "--print", "%(id)s\t%(timestamp)s",
    "--no-warnings", "--quiet", "--ignore-errors",
    channelUrl,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Track whether we've seen a valid timestamp older than cutoff — means we've passed
    // the date boundary and can stop (channel listing is newest-first).
    let seenOlderThanCutoff = false;
    const checkAndKill = () => {
      if (seenOlderThanCutoff) return;
      const lines = stdout.split("\n");
      for (const line of lines) {
        const raw = (line.split("\t")[1] ?? "").trim();
        if (!/^\d+$/.test(raw)) continue;
        const ts = parseInt(raw, 10);
        if (Number.isFinite(ts) && ts < cutoffTs) {
          seenOlderThanCutoff = true;
          proc.kill("SIGTERM");
          return;
        }
      }
    };
    // Periodically check if we've passed the cutoff
    const pollInterval = setInterval(checkAndKill, 2000);

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          clearInterval(pollInterval);
          proc.kill("SIGKILL");
          reject(new Error("yt-dlp timed out fetching upload dates (flat-playlist)."));
        }, timeoutMs)
      : null;

    proc.on("error", (err) => { if (timer) clearTimeout(timer); clearInterval(pollInterval); reject(err); });

    proc.on("close", (_code, signal) => {
      if (timer) clearTimeout(timer);
      clearInterval(pollInterval);
      if (signal === "SIGKILL") return;

      const dates = parseTimestampLines(stdout, cutoffTs, maxPerDay);
      resolve(dates);
    });
  });
}

/**
 * Parse yt-dlp output lines ("id\ttimestamp") into formatted date strings.
 * Handles both Unix epoch seconds and YYYYMMDD date-only formats.
 */
function parseTimestampLines(stdout: string, cutoffTs: number, maxPerDay: number = 0): string[] {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const dates: string[] = [];
  const dayCount = new Map<string, number>();

  for (const line of lines) {
    const parts = line.split("\t");
    const raw = (parts[1] ?? "").trim();
    if (!raw) continue;

    let ts: number | null = null;
    if (/^\d{8}$/.test(raw)) {
      const y = Number(raw.slice(0, 4));
      const m = Number(raw.slice(4, 6)) - 1;
      const d = Number(raw.slice(6, 8));
      ts = Math.floor(Date.UTC(y, m, d, 0, 0, 0) / 1000);
    } else if (/^\d+$/.test(raw)) {
      ts = parseInt(raw, 10);
    }

    if (ts != null && Number.isFinite(ts) && ts >= cutoffTs) {
      const dt = new Date(ts * 1000);
      const yyyy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      const dayKey = `${yyyy}-${mm}-${dd}`;

      // Enforce per-day cap when maxPerDay > 0
      if (maxPerDay > 0) {
        const count = dayCount.get(dayKey) ?? 0;
        if (count >= maxPerDay) continue;
        dayCount.set(dayKey, count + 1);
      }

      const hh = String(dt.getUTCHours()).padStart(2, "0");
      const mi = String(dt.getUTCMinutes()).padStart(2, "0");
      const ss = String(dt.getUTCSeconds()).padStart(2, "0");
      dates.push(`${dayKey} ${hh}:${mi}:${ss}`);
    }
  }

  return dates;
}

/** YouTube video IDs are 11 chars, alphanumeric + hyphen + underscore. */
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

function isValidYoutubeVideoId(id: string): boolean {
  return YOUTUBE_VIDEO_ID_REGEX.test(id);
}

export interface ScrapedVideo {
  id: string;
  durationSeconds: number;
  title: string;
  /** Unix seconds (from yt-dlp %(timestamp)s). Real upload time when fullMetadata: true; else date-only (midnight UTC). */
  releaseTimestamp: number | null;
}

const DEFAULT_YT_DLP_TIMEOUT_MS = 120_000; // 2 min for flat-playlist
const FULL_METADATA_TIMEOUT_MS = 300_000; // 5 min when fetching each video's metadata

/**
 * Run yt-dlp --print to list videos from a channel URL.
 * - fullMetadata: false (default): --flat-playlist + approximate_date. Fast, but timestamp is date-only (midnight UTC). Use for regular scrape.
 * - fullMetadata: true: no flat-playlist, fetches each video's metadata. Slower (N requests) but %(timestamp)s is real upload time. Use for schedule inference.
 */
export function listChannelVideos(
  ytDlpPath: string,
  channelUrl: string,
  options?: { timeoutMs?: number; maxVideos?: number; fullMetadata?: boolean }
): Promise<ScrapedVideo[]> {
  const fullMetadata = options?.fullMetadata === true;
  const timeoutMs = options?.timeoutMs ?? (fullMetadata ? FULL_METADATA_TIMEOUT_MS : DEFAULT_YT_DLP_TIMEOUT_MS);
  const maxVideos = options?.maxVideos;

  const args = ["--no-download", "--print", PRINT_FORMAT, "--no-warnings", "--quiet", "--ignore-errors"];
  if (fullMetadata) {
    // No --flat-playlist: fetch each video's metadata for real upload time
  } else {
    args.push("--flat-playlist", "--extractor-args", "youtubetab:approximate_date");
  }
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
      const detail = stderr.trim() ? `\n${stderr.slice(0, 500)}` : "";
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s. Channel may be large or slow.${detail}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
    }

    proc.on("error", (err) => {
      cleanup();
      const detail = stderr.trim() ? ` — stderr: ${stderr.slice(0, 500)}` : "";
      reject(new Error(`yt-dlp spawn error: ${err.message}${detail}`));
    });

    proc.on("close", (code, signal) => {
      cleanup();
      if (signal === "SIGKILL") return; // already rejected in timeout
      
      const lines = stdout.trim().split("\n").filter(Boolean);
      const result: ScrapedVideo[] = [];
      for (const line of lines) {
        const parts = line.split("\t");
        const id = (parts[0] ?? "").trim();
        if (id === "id" || id === "title") continue; // skip header if yt-dlp printed one
        const durationRaw = parts[1];
        const durationSeconds = durationRaw ? Number(durationRaw) : 0;
        const title = parts[2] ?? "";
        const releaseTimestampRaw = (parts[3] ?? "").trim();
        let releaseTimestamp: number | null = null;
        if (/^\d+$/.test(releaseTimestampRaw)) {
          // yt-dlp may emit either a Unix timestamp (seconds) or an
          // approximate date as YYYYMMDD (e.g. 20260304). Detect and
          // convert YYYYMMDD / YYYY-MM-DD -> Unix seconds to avoid
          // treating the numeric date as a tiny epoch value.
          if (/^\d{8}$/.test(releaseTimestampRaw)) {
            // YYYYMMDD -> UTC midnight of that date
            const y = Number(releaseTimestampRaw.slice(0, 4));
            const m = Number(releaseTimestampRaw.slice(4, 6)) - 1;
            const d = Number(releaseTimestampRaw.slice(6, 8));
            releaseTimestamp = Math.floor(Date.UTC(y, m, d, 0, 0, 0) / 1000);
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(releaseTimestampRaw)) {
            // YYYY-MM-DD
            const dt = new Date(releaseTimestampRaw + "T00:00:00Z");
            releaseTimestamp = Math.floor(dt.getTime() / 1000);
          } else {
            // Assume it's already a Unix timestamp in seconds
            releaseTimestamp = parseInt(releaseTimestampRaw, 10);
          }
        } else {
          releaseTimestamp = null;
        }
        if (id && isValidYoutubeVideoId(id)) {
          result.push({
            id,
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
            title,
            releaseTimestamp: releaseTimestamp != null && Number.isFinite(releaseTimestamp) ? releaseTimestamp : null,
          });
        }
      }
      
      // If we got any videos, return them even if exit code is non-zero (some videos may have been skipped)
      if (result.length > 0) {
        resolve(result);
        return;
      }
      
      // If no videos were extracted and exit code was non-zero, it's an error
      if (code !== 0) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      
      // Exit code 0 but no videos (empty channel or all videos were private/deleted)
      resolve(result);
    });
  });
}
