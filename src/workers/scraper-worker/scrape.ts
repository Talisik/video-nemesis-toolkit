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
