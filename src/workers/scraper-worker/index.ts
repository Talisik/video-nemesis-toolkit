import { openDb } from "../../db.js";
import type Database from "better-sqlite3";
import type { ChannelRow } from "../../types/index.js";
import * as scraperDb from "./db.js";
import * as channelAnalysisVideosData from "../../data/channelAnalysisVideos.js";


import { listChannelVideos } from "./scrape.js";
import { IntelligentScheduleService } from "./intelligentScheduleService.js";

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

export interface ScrapeChannelError {
  channelId: number;
  channelName: string;
  /** Which phase of the scrape failed: flat-playlist (PASS 1, channel skipped), full-metadata (PASS 2, fell back to date-only), or internal (DB / unexpected). */
  phase: "flat-playlist" | "full-metadata" | "internal";
  /** What caused the error: "yt-dlp" for yt-dlp process failures, "internal" for DB / app errors. */
  source: "yt-dlp" | "internal";
  message: string;
}

export interface ScrapeRunResult {
  /** Number of channels successfully scraped. */
  scrapedCount: number;
  /** yt-dlp or internal errors encountered per channel. */
  errors: ScrapeChannelError[];
  /** Human-readable summary message (e.g. when no new videos were found). */
  message?: string;
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
  private pausedScheduleIds = new Set<number>();
  private onRunComplete: (() => void) | undefined;
  private onStatusChange: ((event: ScraperStatusEvent) => void) | undefined;
  private newestOnlyMode: boolean;
  private newestFirstRunCount: number;
  private newestSubsequentLimit: number;
  private intelligentScheduler: IntelligentScheduleService;

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
    this.intelligentScheduler = new IntelligentScheduleService();
  }

  start(scheduleId?: number): void {
    if (scheduleId !== undefined) {
      this.pausedScheduleIds.delete(scheduleId);
      if (process.env.DEBUG_SCRAPER) console.log("[scraper] resumed schedule", scheduleId);
      return;
    }
    if (this.timerId !== null || this.scheduleTimeoutId !== null) return;
    this.stopped = false;
    
    // Handle offline scenario: check for missed scrapes and adjust scheduling
    const db = openDb(this.dbPath);
    this.intelligentScheduler.handleOfflineScenario(db);
    db.close();
    
    if (this.pollIntervalMs !== undefined && this.pollIntervalMs > 0) {
      this.db = openDb(this.dbPath);
      this.timerId = setInterval(() => this.tick(), this.pollIntervalMs);
    } else {
      this.runScheduleLoop();
    }
  }

  stop(scheduleId?: number): void {
    if (scheduleId !== undefined) {
      this.pausedScheduleIds.add(scheduleId);
      if (process.env.DEBUG_SCRAPER) console.log("[scraper] paused schedule", scheduleId);
      return;
    }
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
   * Run once, then sleep until the next scheduled scrape (intelligent or slot-based).
   * Handles offline scenarios and prioritizes intelligent schedule predictions.
   */
  private runScheduleLoop = (): void => {
    if (this.stopped) return;
    this.runOnce()
      .then(() => {
        if (this.stopped) return;
        const db = openDb(this.dbPath);
        
        // Get next wake time from intelligent schedule
        const intelligentMs = this.intelligentScheduler.getNextScheduledScrapeMs(db);
        
        // Get next wake time from traditional slot/interval schedule (fallback)
        const slotMs = scraperDb.getNextSlotStartMs(db, new Date());
        
        // Use whichever comes first, or null if neither has schedules
        let nextMs: number | null = null;
        if (intelligentMs !== null && slotMs !== null) {
          nextMs = Math.min(intelligentMs, slotMs);
        } else if (intelligentMs !== null) {
          nextMs = intelligentMs;
        } else if (slotMs !== null) {
          nextMs = slotMs;
        }
        
        db.close();
        
        if (nextMs === null) {
          if (process.env.DEBUG_SCRAPER) console.log("[scraper] no schedules (intelligent or slot-based); stopping schedule loop");
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
  async runOnce(channelId?: number): Promise<ScrapeRunResult> {
    this.onStatusChange?.({ phase: "running" });
    const db = this.db ?? openDb(this.dbPath);
    const errors: ScrapeChannelError[] = [];
    let scrapedCount = 0;
    let totalNewVideos = 0;

    try {
      const channels = await this.getChannelsToScrape(db, channelId);

      if (process.env.DEBUG_SCRAPER !== undefined) {
        console.log("[scraper] runOnce: channels to scrape =", channels.length, channelId !== undefined ? `(channelId=${channelId})` : "(schedule mode)");
        channels.forEach((c) => console.log("[scraper]   -", c.id, c.name, c.url));
      }

      for (const channel of channels) {
        if (this.stopped) break;
        const result = await this.scrapeChannel(db, channel);
        if (typeof result === "number") {
          scrapedCount++;
          totalNewVideos += result;
          scraperDb.updateChannelLastScraped(db, channel.id, new Date().toISOString());
        } else {
          errors.push(result);
        }
      }

      if (channelId === undefined && scrapedCount > 0) {
        const failedIds = new Set(errors.map((e) => e.channelId));
        const succeededIds = channels.filter((c) => !failedIds.has(c.id)).map((c) => c.id);
        if (succeededIds.length > 0) {
          scraperDb.deleteConsumedRunAts(db, succeededIds, new Date());
        }
      }

      this.onRunComplete?.();
      this.onStatusChange?.({ phase: scrapedCount > 0 ? "finished" : "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[scraper] runOnce unexpected error:", err);
      errors.push({ channelId: channelId ?? -1, channelName: "unknown", phase: "internal", source: "internal", message });
      this.onStatusChange?.({ phase: "idle" });
    } finally {
      if (this.db === null) db.close();
    }

    const result: ScrapeRunResult = { scrapedCount, errors };
    if (scrapedCount > 0 && totalNewVideos === 0) {
      result.message = "No new videos found";
    }
    return result;
  }

  /** Resolve channels to scrape: prioritize intelligent schedule, fallback to slot/interval schedule. */
  private getChannelsToScrape(
    db: Database.Database,
    channelId?: number
  ): Promise<ChannelRow[]> {
    if (channelId !== undefined) {
      const c = scraperDb.getChannelById(db, channelId);
      if (process.env.DEBUG_SCRAPER) {
        console.log("[scraper] getChannelsToScrape(channelId):", c ? `found id=${c.id} active=${c.active} last_scraped=${c.last_scraped_at ?? "never"}` : "channel not found");
      }
      if (!c || !c.active || this.pausedScheduleIds.has(c.schedule_id)) return Promise.resolve([]);
      if (this.wasScrapedRecently(c)) {
        if (process.env.DEBUG_SCRAPER) console.log("[scraper] channel skipped: scraped recently (within", this.channelCheckIntervalMs, "ms)");
        return Promise.resolve([]);
      }
      return Promise.resolve([c]);
    }

    // First try intelligent schedule for channels with analysis data
    const intelligentDueIds = this.intelligentScheduler.getChannelsDueForScrape(db);
    if (intelligentDueIds.length > 0) {
      if (process.env.DEBUG_SCRAPER) {
        console.log("[scraper] found", intelligentDueIds.length, "channels due by intelligent schedule:", intelligentDueIds);
      }
      const channels = scraperDb.getChannelsByIds(db, intelligentDueIds, true);
      const filtered = channels.filter((c) => !this.pausedScheduleIds.has(c.schedule_id) && !this.wasScrapedRecently(c));
      if (filtered.length > 0) {
        return Promise.resolve(filtered);
      }
    }

    // Fallback to traditional slot/interval schedule
    if (!scraperDb.hasAnySchedules(db)) {
      if (process.env.DEBUG_SCRAPER) console.log("[scraper] no schedules in DB; no channels to scrape (schedule mode)");
      return Promise.resolve([]);
    }
    const now = new Date();
    const day = now.getDay();
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
      console.log("[scraper] slot-based schedule check: day=", day, "timeMinutes=", currentTimeMinutes, "dueNowIds=", dueNowIds, "pastDueIds=", pastDueIds, "allIds=", allIds);
    }
    if (allIds.length === 0) return Promise.resolve([]);
    const channels = scraperDb.getChannelsByIds(db, allIds, true);
    const slotDueIds = new Set([...dueNowIds, ...pastDueIds]);
    const filtered = channels.filter((c) => {
      if (this.pausedScheduleIds.has(c.schedule_id)) return false;
      if (slotDueIds.has(c.id)) return true;
      return !this.wasScrapedRecently(c);
    });
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
      first_scrape_limit?: number | null;
    }
  ): Promise<ScrapeChannelError | number> {
    const channelUrl = channel.url.trim().endsWith("/videos")
      ? channel.url
      : `${channel.url.replace(/\/$/, "")}/videos`;

    const latestAnalyzedTimestamp = channelAnalysisVideosData.getLatestTimestampForChannel(db, channel.id);
    const firstScrape = latestAnalyzedTimestamp === null;

    const cutoffStr = latestAnalyzedTimestamp !== null
      ? new Date(latestAnalyzedTimestamp * 1000).toISOString()
      : "no cutoff (first scrape)";
    console.log(`[scraper] Nemesis is scraping "${channel.name}" for videos uploaded until ${cutoffStr}`);

    const maxVideos = this.newestOnlyMode
      ? (firstScrape ? this.newestFirstRunCount : this.newestSubsequentLimit)
      : (firstScrape
          ? (channel.first_scrape_limit ?? 50)
          : undefined);

    // ===== PASS 1: Quick flat-playlist scan to find new videos =====
    if (process.env.DEBUG_SCRAPER) {
      console.log(
        "[scraper] PASS 1 (flat-playlist): fetching quick video list for channel",
        channel.id,
        channel.name,
        maxVideos != null ? ` (latest ${maxVideos})` : "",
        "..."
      );
    }

    let quickVideos;
    try {
      quickVideos = await listChannelVideos(this.ytDlpPath, channelUrl, {
        ...(maxVideos !== undefined && { maxVideos }),
        ...(latestAnalyzedTimestamp !== null && { dateAfter: latestAnalyzedTimestamp }),
        fullMetadata: false, // Fast scan, timestamps are date-only
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scraper] yt-dlp PASS 1 (flat-playlist) failed for channel ${channel.id}:`, err);
      return { channelId: channel.id, channelName: channel.name, phase: "flat-playlist" as const, source: "yt-dlp" as const, message };
    }

    // ===== Identify new videos =====
    const newVideoIds = new Set<string>();
    let reachedKnownVideo = false;

    for (const video of quickVideos) {
      if (reachedKnownVideo) break; // Stop once we hit a video we've seen
      
      if (latestAnalyzedTimestamp != null && video.releaseTimestamp != null) {
        if (video.releaseTimestamp <= latestAnalyzedTimestamp) {
          reachedKnownVideo = true;
          break; // This and all older videos are already known
        }
      }
      newVideoIds.add(video.id);
    }

    if (process.env.DEBUG_SCRAPER) {
      console.log(
        `[scraper] found ${newVideoIds.size} new videos (out of ${quickVideos.length} in quick scan)`
      );
    }

    // ===== PASS 2: Fetch accurate timestamps for NEW videos only =====
    let videosWithAccurateTimestamps: typeof quickVideos = [];

    if (newVideoIds.size > 0) {
      if (process.env.DEBUG_SCRAPER) {
        console.log(
          "[scraper] PASS 2 (full metadata): fetching accurate timestamps for",
          newVideoIds.size,
          "new videos..."
        );
      }

      try {
        const fullMetadataVideos = await listChannelVideos(this.ytDlpPath, channelUrl, {
          fullMetadata: true, // Get exact upload timestamps
          maxVideos: newVideoIds.size + 5, // Fetch a few extra to ensure we catch all new ones
          ...(latestAnalyzedTimestamp !== null && { dateAfter: latestAnalyzedTimestamp }),
        });

        // Filter to only the new videos with accurate timestamps
        videosWithAccurateTimestamps = fullMetadataVideos.filter((v) => newVideoIds.has(v.id));

        if (process.env.DEBUG_SCRAPER) {
          console.log(
            `[scraper] retrieved accurate timestamps for ${videosWithAccurateTimestamps.length} new videos`
          );
        }
      } catch (err) {
        console.error(
          `[scraper] failed to fetch full metadata for channel ${channel.id}:`,
          err
        );
        // Fallback: use the quick videos (with date-only timestamps)
        videosWithAccurateTimestamps = quickVideos.filter((v) => newVideoIds.has(v.id));
      }
    }

    // ===== Process videos: duration filter, slot filter, queue downloads =====
    const minMins = channel.min_duration_minutes ?? 0;
    const maxMins =
      channel.max_duration_minutes != null && channel.max_duration_minutes > 0
        ? channel.max_duration_minutes
        : Number.POSITIVE_INFINITY;

    let inRange = 0;
    let newTasks = 0;
    const analysisInputs: Parameters<typeof channelAnalysisVideosData.upsert>[2] = [];

    for (const v of videosWithAccurateTimestamps) {
      if (this.stopped) break;

      const durationMinutes = v.durationSeconds / 60;
      if (durationMinutes < minMins) continue;
      if (durationMinutes > maxMins) continue;

      inRange++;

      const videoUrl = `${YOUTUBE_VIDEO_PREFIX}${v.id}`;

      const added = scraperDb.addDownloadTaskIfNotExists(db, {
        video_url: videoUrl,
        channel_id: channel.id,
      });

      if (!added) break; // Reached a video already scraped; all older videos are known

      scraperDb.upsertVideoDetail(db, {
        video_url: videoUrl,
        channel_name: channel.name,
        video_title: v.title || null,
        video_duration: Math.round(v.durationSeconds),
        release_timestamp: v.releaseTimestamp ?? null,
      });

      newTasks++;
      const nowSeconds = Math.floor(Date.now() / 1000);
      analysisInputs.push({
        id: v.id,
        durationSeconds: v.durationSeconds ?? 0,
        title: v.title ?? "",
        releaseTimestamp:
          v.releaseTimestamp != null && Number.isFinite(v.releaseTimestamp)
            ? v.releaseTimestamp
            : nowSeconds,
      });
    }

    // ===== Save timestamps for intelligent scheduler analysis =====
    if (analysisInputs.length > 0) {
      channelAnalysisVideosData.upsert(db, channel.id, analysisInputs);
      channelAnalysisVideosData.capPerChannel(db, channel.id);

      // Update intelligent schedule with improved data
      this.intelligentScheduler.updateChannelSchedule(db, channel.id);
    }

    if (process.env.DEBUG_SCRAPER) {
      console.log(
        "[scraper] channel",
        channel.id,
        channel.name,
        "| quick scan:",
        quickVideos.length,
        "| new videos:",
        newVideoIds.size,
        "| accurate timestamps:",
        videosWithAccurateTimestamps.length,
        "| in range:",
        inRange,
        "| queued:",
        newTasks,
        "(mins:",
        minMins,
        "-",
        maxMins === Number.POSITIVE_INFINITY ? "∞" : maxMins,
        ")"
      );
    }

    return newTasks;
  }
}
