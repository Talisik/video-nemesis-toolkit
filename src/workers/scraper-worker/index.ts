import { openDb } from "../../db.js";
import type Database from "better-sqlite3";
import type { ChannelRow } from "../../types/index.js";
import * as scraperDb from "./db.js";
import { listChannelVideos } from "./scrape.js";

const DEFAULT_YT_DLP = "yt-dlp";
const YOUTUBE_VIDEO_PREFIX = "https://www.youtube.com/watch?v=";
const DEFAULT_CHANNEL_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SCHEDULE_WINDOW_MINUTES = 15;

export type ScraperStatusPhase = "sleeping" | "running" | "finished" | "idle";

export interface ScraperStatusEvent {
  phase: ScraperStatusPhase;
  /** ISO date string when the scraper will run next (only when phase is "sleeping"). */
  nextRunAt?: string;
}

export interface YouTubeChannelScraperOptions {
  dbPath: string;
  ytDlpPath?: string;
  /** Run scraper on this interval (ms) when started. If not set, only runOnce() is used. */
  pollIntervalMs?: number;
  /** Min ms between runs per channel (recently-checked). Default 30 minutes. */
  channelCheckIntervalMs?: number;
  /** Minutes after schedule.time during which a channel is considered "due". Default 15. */
  scheduleWindowMinutes?: number;
  /** Called after each runOnce() (schedule loop or tick). Use to e.g. push download queue to renderer. */
  onRunComplete?: () => void;
  /** Called when scraper phase changes: running, finished, sleeping (with nextRunAt), idle. */
  onStatusChange?: (event: ScraperStatusEvent) => void;
  /**
   * When true: ignore slot upload-window filter and scrape by "newest only".
   * First run: fetch newestFirstRunCount videos (default 15). Subsequent: fetch newestSubsequentLimit (default 20); only new URLs are added to download_task.
   */
  newestOnlyMode?: boolean;
  /** With newestOnlyMode: how many videos to fetch on first scrape. Default 15. */
  newestFirstRunCount?: number;
  /** With newestOnlyMode: how many to fetch on subsequent scrapes (only new ones get queued). Default 20. */
  newestSubsequentLimit?: number;
}

/**
 * Scraper that runs on schedule: only scrapes channels that belong to a schedule
 * and are due (day + time window), and skips channels run recently (per-channel interval).
 */
export class YouTubeChannelScraper {
  private dbPath: string;
  private ytDlpPath: string;
  private pollIntervalMs: number | undefined;
  private channelCheckIntervalMs: number;
  private scheduleWindowMinutes: number;
  private db: Database.Database | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private scheduleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private onRunComplete: (() => void) | undefined;
  private onStatusChange: ((event: ScraperStatusEvent) => void) | undefined;
  private newestOnlyMode: boolean;
  private newestFirstRunCount: number;
  private newestSubsequentLimit: number;

  constructor(options: YouTubeChannelScraperOptions) {
    this.dbPath = options.dbPath;
    this.ytDlpPath = options.ytDlpPath ?? DEFAULT_YT_DLP;
    this.pollIntervalMs = options.pollIntervalMs;
    this.channelCheckIntervalMs =
      options.channelCheckIntervalMs ?? DEFAULT_CHANNEL_CHECK_INTERVAL_MS;
    this.scheduleWindowMinutes =
      options.scheduleWindowMinutes ?? DEFAULT_SCHEDULE_WINDOW_MINUTES;
    this.onRunComplete = options.onRunComplete;
    this.onStatusChange = options.onStatusChange;
    this.newestOnlyMode = options.newestOnlyMode ?? false;
    this.newestFirstRunCount = options.newestFirstRunCount ?? 15;
    this.newestSubsequentLimit = options.newestSubsequentLimit ?? 50;
  }

  start(): void {
    if (this.timerId !== null || this.scheduleTimeoutId !== null) return;
    this.stopped = false;
    if (this.pollIntervalMs !== undefined && this.pollIntervalMs > 0) {
      this.db = openDb(this.dbPath);
      this.timerId = setInterval(() => this.tick(), this.pollIntervalMs);
    } else {
      this.runScheduleLoop();
    }
  }

  stop(): void {
    this.onStatusChange?.({ phase: "idle" });
    this.stopped = true;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.scheduleTimeoutId !== null) {
      clearTimeout(this.scheduleTimeoutId);
      this.scheduleTimeoutId = null;
    }
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Run once, then sleep until the next channel_slot start from SQLite; repeat.
   * When there are no slots or no next run, the scraper stops (no constant background polling).
   */
  private runScheduleLoop = (): void => {
    if (this.stopped) return;
    this.runOnce()
      .then(() => {
        if (this.stopped) return;
        const db = openDb(this.dbPath);
        const nextMs = scraperDb.getNextSlotStartMs(db, new Date());
        db.close();
        if (nextMs === null) {
          if (process.env.DEBUG_SCRAPER) console.log("[scraper] no schedules; stopping schedule loop");
          this.stop();
          return;
        }
        if (nextMs <= 0) {
          setImmediate(this.runScheduleLoop);
          return;
        }
        const nextRunAt = new Date(Date.now() + nextMs).toISOString();
        this.onStatusChange?.({ phase: "sleeping", nextRunAt });
        if (process.env.DEBUG_SCRAPER) console.log("[scraper] sleeping", Math.round(nextMs / 1000), "s until next schedule");
        this.scheduleTimeoutId = setTimeout(() => {
          this.scheduleTimeoutId = null;
          this.runScheduleLoop();
        }, nextMs);
      })
      .catch((err) => {
        console.error("[scraper] runScheduleLoop error:", err);
        if (this.scheduleTimeoutId !== null) {
          clearTimeout(this.scheduleTimeoutId);
          this.scheduleTimeoutId = null;
        }
      });
  };

  /**
   * Run scraper once. If channelId is provided, scrape that channel (subject to recently-checked).
   * Otherwise run in schedule-driven mode: only channels that have a schedule due now, and not run recently.
   */
  async runOnce(channelId?: number): Promise<void> {
    this.onStatusChange?.({ phase: "running" });
    const db = this.db ?? openDb(this.dbPath);
    const channels = await this.getChannelsToScrape(db, channelId);

    if (process.env.DEBUG_SCRAPER !== undefined) {
      console.log("[scraper] runOnce: channels to scrape =", channels.length, channelId !== undefined ? `(channelId=${channelId})` : "(schedule mode)");
      channels.forEach((c) => console.log("[scraper]   -", c.id, c.name, c.url));
    }

    for (const channel of channels) {
      if (this.stopped) break;
      await this.scrapeChannel(db, channel);
      scraperDb.updateChannelLastScraped(db, channel.id, new Date().toISOString());
    }

    if (channelId === undefined && channels.length > 0) {
      scraperDb.deleteConsumedRunAts(db, channels.map((c) => c.id), new Date());
    }

    this.onRunComplete?.();
    if (channels.length > 0) this.onStatusChange?.({ phase: "finished" });
    if (this.db === null) db.close();
  }

  /** Resolve channels to scrape: either one by id (with recently-checked) or schedule-due list. */
  private getChannelsToScrape(
    db: Database.Database,
    channelId?: number
  ): Promise<ChannelRow[]> {
    if (channelId !== undefined) {
      const c = scraperDb.getChannelById(db, channelId);
      if (process.env.DEBUG_SCRAPER) {
        console.log("[scraper] getChannelsToScrape(channelId):", c ? `found id=${c.id} active=${c.active} last_scraped=${c.last_scraped_at ?? "never"}` : "channel not found");
      }
      if (!c || !c.active) return Promise.resolve([]);
      if (this.wasScrapedRecently(c)) {
        if (process.env.DEBUG_SCRAPER) console.log("[scraper] channel skipped: scraped recently (within", this.channelCheckIntervalMs, "ms)");
        return Promise.resolve([]);
      }
      return Promise.resolve([c]);
    }
    if (!scraperDb.hasAnySchedules(db)) {
      if (process.env.DEBUG_SCRAPER) console.log("[scraper] no schedules in DB; no channels to scrape (schedule mode)");
      return Promise.resolve([]);
    }
    const now = new Date();
    const day = now.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
    const dueNowIds = scraperDb.getDueChannelIds(
      db,
      day,
      currentTimeMinutes,
      this.scheduleWindowMinutes
    );
    const pastDueIds = scraperDb.getPastDueChannelIds(db, now);
    const allIds = [...new Set([...dueNowIds, ...pastDueIds])];
    if (process.env.DEBUG_SCRAPER) {
      console.log("[scraper] schedule check: day=", day, "timeMinutes=", currentTimeMinutes, "window=", this.scheduleWindowMinutes, "dueNowIds=", dueNowIds, "pastDueIds=", pastDueIds, "allIds=", allIds);
    }
    if (allIds.length === 0) return Promise.resolve([]);
    const channels = scraperDb.getChannelsByIds(db, allIds, true);
    const filtered = channels.filter((c) => !this.wasScrapedRecently(c));
    if (process.env.DEBUG_SCRAPER && filtered.length < channels.length) {
      console.log("[scraper] filtered out", channels.length - filtered.length, "channels (scraped recently)");
    }
    return Promise.resolve(filtered);
  }

  private wasScrapedRecently(channel: Pick<ChannelRow, "last_scraped_at">): boolean {
    if (!channel.last_scraped_at) return false;
    const last = new Date(channel.last_scraped_at).getTime();
    return Date.now() - last < this.channelCheckIntervalMs;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.db === null) return;
    await this.runOnce();
  }

  private async scrapeChannel(
    db: Database.Database,
    channel: {
      id: number;
      name: string;
      url: string;
      min_duration_minutes: number | null;
      max_duration_minutes: number | null;
      last_scraped_at: string | null;
    }
  ): Promise<void> {
    const channelUrl = channel.url.trim().endsWith("/videos")
      ? channel.url
      : `${channel.url.replace(/\/$/, "")}/videos`;

    const firstScrape = !channel.last_scraped_at;
    const maxVideos = this.newestOnlyMode
      ? (firstScrape ? this.newestFirstRunCount : this.newestSubsequentLimit)
      : (firstScrape ? 50 : undefined);

    if (process.env.DEBUG_SCRAPER) {
      console.log(
        "[scraper] fetching video list (yt-dlp) for channel",
        channel.id,
        channel.name,
        maxVideos != null ? ` (latest ${maxVideos} only)` : "",
        "..."
      );
    }

    let videos;
    try {
      videos = await listChannelVideos(this.ytDlpPath, channelUrl, {
        ...(maxVideos !== undefined && { maxVideos }),
      });
    } catch (err) {
      console.error(`[scraper] yt-dlp failed for channel ${channel.id}:`, err);
      return;
    }

    const minMins = channel.min_duration_minutes ?? 0;
    const maxMins =
      channel.max_duration_minutes != null && channel.max_duration_minutes > 0
        ? channel.max_duration_minutes
        : Number.POSITIVE_INFINITY;

    const slots = this.newestOnlyMode ? [] : scraperDb.getSlotsByChannelId(db, channel.id);

    const latestKnownTimestamp =
      !firstScrape ? scraperDb.getLatestReleaseTimestampForChannel(db, channel.name) : null;

    let inRange = 0;
    let newTasks = 0;
    for (const v of videos) {
      if (this.stopped) break;
      if (latestKnownTimestamp != null && v.releaseTimestamp != null && v.releaseTimestamp <= latestKnownTimestamp) continue;
      const durationMinutes = v.durationSeconds / 60;
      if (durationMinutes < minMins) continue;
      if (durationMinutes > maxMins) continue;

      if (slots.length > 0) {
        const uploadDayOfWeek =
          v.releaseTimestamp != null
            ? new Date(v.releaseTimestamp * 1000).getDay()
            : 0;
        const uploadTimeMinutes: number | null =
          v.releaseTimestamp != null
            ? (() => {
                const d = new Date(v.releaseTimestamp * 1000);
                return d.getHours() * 60 + d.getMinutes();
              })()
            : null;
        if (!scraperDb.isUploadInSlotWindow(slots, uploadDayOfWeek, uploadTimeMinutes)) continue;
      }
      inRange++;

      const videoUrl = `${YOUTUBE_VIDEO_PREFIX}${v.id}`;

      scraperDb.upsertVideoDetail(db, {
        video_url: videoUrl,
        channel_name: channel.name,
        video_title: v.title || null,
        video_duration: Math.round(v.durationSeconds),
        release_timestamp: v.releaseTimestamp ?? null,
      });

      const added = scraperDb.addDownloadTaskIfNotExists(db, {
        video_url: videoUrl,
        channel_id: channel.id,
      });
      if (added) newTasks++;
    }

    if (process.env.DEBUG_SCRAPER) {
      console.log(
        "[scraper] channel",
        channel.id,
        channel.name,
        "| videos listed:",
        videos.length,
        "| in duration range:",
        inRange,
        "| new download tasks:",
        newTasks,
        "(min/max mins:",
        minMins,
        "/",
        maxMins === Number.POSITIVE_INFINITY ? "∞" : maxMins,
        ")"
      );
    }
  }
}
