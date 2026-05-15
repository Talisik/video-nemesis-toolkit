import { spawn } from "node:child_process";
import { openDb } from "../../db.js";
import type Database from "better-sqlite3";
import type { ChannelRow } from "../../types/index.js";
import * as scraperDb from "./db.js";
import * as channelAnalysisVideosData from "../../data/channelAnalysisVideos.js";


import { listChannelVideos } from "./scrape.js";
import type { ProcessRegistry } from "./scrape.js";
import { IntelligentScheduleService } from "./intelligentScheduleService.js";

const DEFAULT_YT_DLP = "yt-dlp";
const YOUTUBE_VIDEO_PREFIX = "https://www.youtube.com/watch?v=";
const DEFAULT_CHANNEL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
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
  /**
   * Called after each runOnce() (schedule loop or tick). Use to e.g. push download queue to renderer.
   * When channelId is provided, the run was explicitly targeted at that channel; when undefined, the
   * run was schedule-driven/global.
   */
  onRunComplete?: (channelId?: number) => void;
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
  private onRunComplete: ((channelId?: number) => void) | undefined;
  private onStatusChange: ((event: ScraperStatusEvent) => void) | undefined;
  private newestOnlyMode: boolean;
  private newestFirstRunCount: number;
  private newestSubsequentLimit: number;
  private intelligentScheduler: IntelligentScheduleService;
  private activeProcesses: ProcessRegistry = new Set();
  private abortController: AbortController | null = null;
  private isRunning = false;

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
    this.abortController?.abort();
    this.abortController = null;
    for (const proc of this.activeProcesses) {
      if (process.platform === "win32" && proc.pid !== undefined) {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", detached: true }).unref();
        } catch {
          proc.kill();
        }
      } else {
        proc.kill("SIGKILL");
      }
    }
    this.activeProcesses.clear();
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
          if (process.env.DEBUG_SCRAPER) console.log("[scraper] no schedules (intelligent or slot-based); schedule loop idle (not stopping so on-demand runOnce still works)");
          this.onStatusChange?.({ phase: "idle" });
          return;
        }
        if (nextMs <= 0) {
          setImmediate(() => { if (!this.stopped) this.runScheduleLoop(); });
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
    if (this.isRunning) {
      if (process.env.DEBUG_SCRAPER) {
        console.log(
          "[scraper] runOnce skipped: a previous run is still in progress",
        );
      }
      return { scrapedCount: 0, errors: [], message: "Already running" };
    }
    this.isRunning = true;

    // When targeting a specific channel, clear the stopped flag so an on-demand
    // scrape works even if the schedule loop previously stopped itself (e.g. no
    // channels existed at app start).
    if (channelId !== undefined) this.stopped = false;
    const ac = new AbortController();
    this.abortController = ac;
    this.onStatusChange?.({ phase: "running" });
    const db = this.db ?? openDb(this.dbPath);
    const errors: ScrapeChannelError[] = [];
    let scrapedCount = 0;
    let totalNewVideos = 0;

    try {
      const channels = await this.getChannelsToScrape(db, channelId);
      if (channelId !== undefined && channels.length === 0) {
        return {
          scrapedCount: 0,
          errors: [],
          message: `Cooldown: this channel was scraped within the last ${Math.round(
            this.channelCheckIntervalMs / 60000,
          )} minutes`,
        };
      }

      if (process.env.DEBUG_SCRAPER !== undefined) {
        console.log("[scraper] runOnce: channels to scrape =", channels.length, channelId !== undefined ? `(channelId=${channelId})` : "(schedule mode)");
        channels.forEach((c) => console.log("[scraper]   -", c.id, c.name, c.url));
      }

      for (const channel of channels) {
        if (this.stopped) break;
        const result = await this.scrapeChannel(db, channel, ac.signal);
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

      this.onRunComplete?.(channelId);
      this.onStatusChange?.({ phase: scrapedCount > 0 ? "finished" : "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[scraper] runOnce unexpected error:", err);
      errors.push({ channelId: channelId ?? -1, channelName: "unknown", phase: "internal", source: "internal", message });
      this.onStatusChange?.({ phase: "idle" });
    } finally {
      if (this.abortController === ac) this.abortController = null;
      if (this.db === null) db.close();
      this.isRunning = false;
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
      // Manual/on-demand scrapes should still respect the per-channel cooldown
      // to prevent repeated clicks from spawning unnecessary yt-dlp scans.
      if (this.wasScrapedRecently(c)) {
        if (process.env.DEBUG_SCRAPER) {
          console.log(
            "[scraper] channel skipped: scraped recently (within",
            this.channelCheckIntervalMs,
            "ms)",
          );
        }
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
    },
    signal?: AbortSignal,
  ): Promise<ScrapeChannelError | number> {
    const channelUrl = channel.url.trim().endsWith("/videos")
      ? channel.url
      : `${channel.url.replace(/\/$/, "")}/videos`;

    // Important: analysis videos can exist before the channel's first real scrape
    // (e.g. subscribe flow saved analysis seeds, but initial scrape was queued/skipped).
    // Only use analysis timestamp cutoff after at least one completed scrape.
    const hasPersistedDownloadRows =
      scraperDb.hasAnyPersistedChannelDownloadRows(db, channel.id);
    const hasCompletedScrapeBefore =
      Boolean(channel.last_scraped_at) && hasPersistedDownloadRows;
    const latestAnalyzedTimestamp = hasCompletedScrapeBefore
      ? channelAnalysisVideosData.getLatestTimestampForChannel(db, channel.id)
      : null;
    const firstScrape = !hasCompletedScrapeBefore;

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

    const recentKnownIds = latestAnalyzedTimestamp !== null
      ? new Set(channelAnalysisVideosData.getRecentVideoIdsForChannel(db, channel.id, 50))
      : new Set<string>();

    const runQuickScan = async (limit?: number) => {
      return await listChannelVideos(this.ytDlpPath, channelUrl, {
        ...(limit !== undefined && { maxVideos: limit }),
        ...(maxVideos !== undefined && limit === undefined && { maxVideos }),
        ...(latestAnalyzedTimestamp !== null && { dateAfter: latestAnalyzedTimestamp }),
        ...(signal !== undefined && { signal }),
        fullMetadata: false,
        registry: this.activeProcesses,
      });
    };

    let quickVideos;
    try {
      // Optimization: on subsequent scrapes, start with a smaller scan window.
      // If we don't see a known video ID inside that window, retry with a bigger cap.
      const SMALL_SCAN_LIMIT = firstScrape ? undefined : 60;
      quickVideos = await runQuickScan(SMALL_SCAN_LIMIT);
      const sawKnownId =
        recentKnownIds.size > 0 && quickVideos.some((v) => recentKnownIds.has(v.id));
      const likelyTruncated = SMALL_SCAN_LIMIT !== undefined && quickVideos.length >= SMALL_SCAN_LIMIT;
      if (!firstScrape && !sawKnownId && likelyTruncated) {
        if (process.env.DEBUG_SCRAPER) {
          console.log(
            `[scraper] PASS 1 small scan didn't reach known IDs; retrying with a larger cap`,
          );
        }
        quickVideos = await runQuickScan(200);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[scraper] yt-dlp PASS 1 (flat-playlist) failed for channel ${channel.id}:`,
        err,
      );
      return {
        channelId: channel.id,
        channelName: channel.name,
        phase: "flat-playlist" as const,
        source: "yt-dlp" as const,
        message,
      };
    }

    // ===== Identify new videos =====
    const hasCutoff = latestAnalyzedTimestamp != null;
    const validQuickTimestamps = quickVideos.filter(
      (v) => v.releaseTimestamp != null && Number.isFinite(v.releaseTimestamp),
    );
    const dateOnlyQuickCount = validQuickTimestamps.filter((v) => {
      const d = new Date((v.releaseTimestamp as number) * 1000);
      return (
        d.getUTCHours() === 0 &&
        d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0
      );
    }).length;
    const quickScanLikelyDateOnly =
      hasCutoff &&
      validQuickTimestamps.length > 0 &&
      dateOnlyQuickCount / validQuickTimestamps.length >= 0.6;

    const newVideoIds = new Set<string>();
    let reachedKnownVideo = false;

    for (const video of quickVideos) {
      if (reachedKnownVideo) break; // Stop once we hit a video we've seen

      // ID-based cutoff: if we see a video ID we've already stored, we can stop immediately
      // even if timestamps are date-only/unreliable.
      if (recentKnownIds.size > 0 && recentKnownIds.has(video.id)) {
        reachedKnownVideo = true;
        break;
      }
      
      if (
        latestAnalyzedTimestamp != null &&
        video.releaseTimestamp != null &&
        !quickScanLikelyDateOnly
      ) {
        if (video.releaseTimestamp <= latestAnalyzedTimestamp) {
          reachedKnownVideo = true;
          break; // This and all older videos are already known
        }
      }
      newVideoIds.add(video.id);
    }

    let fallbackFullMetadataVideos: typeof quickVideos | null = null;
    if (
      !firstScrape &&
      newVideoIds.size === 0 &&
      quickScanLikelyDateOnly &&
      latestAnalyzedTimestamp != null
    ) {
      const SAME_DAY_PROBE_LIMIT = 15;
      if (process.env.DEBUG_SCRAPER) {
        console.log(
          `[scraper] quick scan appears date-only; probing latest ${SAME_DAY_PROBE_LIMIT} videos with full metadata`,
        );
      }
      try {
        fallbackFullMetadataVideos = await listChannelVideos(
          this.ytDlpPath,
          channelUrl,
          {
            fullMetadata: true,
            maxVideos: SAME_DAY_PROBE_LIMIT,
            registry: this.activeProcesses,
            ...(signal !== undefined && { signal }),
          },
        );

        for (const v of fallbackFullMetadataVideos) {
          if (
            v.releaseTimestamp != null &&
            Number.isFinite(v.releaseTimestamp) &&
            v.releaseTimestamp > latestAnalyzedTimestamp
          ) {
            newVideoIds.add(v.id);
          }
        }
      } catch (err) {
        console.error(
          `[scraper] same-day full-metadata probe failed for channel ${channel.id}:`,
          err,
        );
      }
    }

    if (process.env.DEBUG_SCRAPER) {
      console.log(
        `[scraper] found ${newVideoIds.size} new videos (out of ${quickVideos.length} in quick scan)`
      );
    }

    // ===== PASS 2: Fetch accurate timestamps for NEW videos only =====
    let videosWithAccurateTimestamps: typeof quickVideos = [];

    const CATCHUP_THRESHOLD = 5;
    const CATCHUP_BATCH_SIZE = 5;
    const isCatchup = !firstScrape && newVideoIds.size > CATCHUP_THRESHOLD;

    if (newVideoIds.size > 0) {
      if (process.env.DEBUG_SCRAPER) {
        console.log(
          "[scraper] PASS 2 (full metadata): fetching accurate timestamps for",
          newVideoIds.size,
          "new videos...",
          isCatchup ? `(catch-up mode: batches of ${CATCHUP_BATCH_SIZE})` : "(normal mode)"
        );
      }

      if (fallbackFullMetadataVideos) {
        videosWithAccurateTimestamps = fallbackFullMetadataVideos.filter((v) =>
          newVideoIds.has(v.id),
        );
      } else if (!isCatchup) {
        // Normal path: first scrape or small number of new videos — fetch all at once
        try {
          // IMPORTANT: Do NOT apply dateAfter filtering here.
          // Some videos (live/premiere) may have missing/odd timestamps, and dateAfter
          // would filter them out even though their IDs are new (PASS 1 already decided).
          // Instead, fetch a small window and filter by ID.
          const PASS2_WINDOW = Math.max(newVideoIds.size + 5, 60);
          const fullMetadataVideos = await listChannelVideos(this.ytDlpPath, channelUrl, {
            fullMetadata: true,
            maxVideos: PASS2_WINDOW,
            registry: this.activeProcesses,
          });
          videosWithAccurateTimestamps = fullMetadataVideos.filter((v) => newVideoIds.has(v.id));
        } catch (err) {
          console.error(`[scraper] failed to fetch full metadata for channel ${channel.id}:`, err);
          videosWithAccurateTimestamps = quickVideos.filter((v) => newVideoIds.has(v.id));
        }
      } else {
        // Catch-up path: too many new videos, batch PASS 2 to keep memory flat
        const newVideoIdArray = [...newVideoIds];
        for (let i = 0; i < newVideoIdArray.length; i += CATCHUP_BATCH_SIZE) {
          if (this.stopped) break;
          const batchIds = new Set(newVideoIdArray.slice(i, i + CATCHUP_BATCH_SIZE));
          if (process.env.DEBUG_SCRAPER) {
            console.log(`[scraper] PASS 2 catch-up batch ${Math.floor(i / CATCHUP_BATCH_SIZE) + 1}/${Math.ceil(newVideoIdArray.length / CATCHUP_BATCH_SIZE)}`);
          }
          try {
            const PASS2_WINDOW = Math.max(batchIds.size + 5, 60);
            const batchVideos = await listChannelVideos(this.ytDlpPath, channelUrl, {
              fullMetadata: true,
              maxVideos: PASS2_WINDOW,
              registry: this.activeProcesses,
            });
            videosWithAccurateTimestamps.push(...batchVideos.filter((v) => batchIds.has(v.id)));
          } catch (err) {
            console.error(`[scraper] PASS 2 catch-up batch failed for channel ${channel.id}:`, err);
            // Fallback: use PASS 1 date-only timestamps for this batch
            videosWithAccurateTimestamps.push(...quickVideos.filter((v) => batchIds.has(v.id)));
          }
          // Give GC a chance to reclaim the batch's memory before next batch
          await new Promise<void>((r) => setTimeout(r, 500));
        }
      }

      if (process.env.DEBUG_SCRAPER) {
        console.log(`[scraper] retrieved accurate timestamps for ${videosWithAccurateTimestamps.length} new videos`);
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
    }

    // Always update the intelligent schedule after a scrape so next_scrape_time
    // is pushed forward even when no new videos were found. Without this, a
    // zero-result scrape leaves next_scrape_time in the past and the channel
    // gets re-scraped immediately on every loop iteration.
    this.intelligentScheduler.updateChannelSchedule(db, channel.id);

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

    console.log(`[scraper] Nemesis finished scraping "${channel.name}" - found ${newTasks} new videos`);

    return newTasks;
  }
}
