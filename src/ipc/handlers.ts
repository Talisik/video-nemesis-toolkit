import type Database from "better-sqlite3";
import { IpcChannels } from "../types/enum/ipcChannels_enum.js";
import * as channelsData from "../data/channels.js";
import { listChannelVideos, fetchChannelDetails } from "../workers/scraper-worker/scrape.js";
import * as schedulesData from "../data/schedules.js";
import * as channelSlotsData from "../data/channelSlots.js";

import * as channelAnalysisVideosData from "../data/channelAnalysisVideos.js";

import * as videoDetailsData from "../data/videoDetails.js";
import * as downloadHistoryData from "../data/downloadHistory.js";
import * as downloadTasksData from "../data/downloadTasks.js";
import * as intelligentSchedulesData from "../data/intelligentSchedules.js";
import { DownloadTaskStatus } from "../types/enum/downloadTaskStatus.js";
import type { IpcBridgeOptions } from "./types.js";
import type { ScheduleRow } from "../types/index.js";
import { IntelligentScheduleService } from "../workers/scraper-worker/intelligentScheduleService.js";

function jsonArr(v: string[] | string): string {
  if (typeof v === "string") return v;
  return JSON.stringify(Array.isArray(v) ? v : []);
}

export interface HandlerContext {
  db: Database.Database;
  options: IpcBridgeOptions;
  getDownloadWorker: () => { start(): void; stop(): void } | null;
  getDownloadWorkerRunning: () => boolean;
  setDownloadWorkerRunning: (running: boolean) => void;
  getScraper: () => {
    start(): void;
    stop(): void;
    runOnce(channelId?: number): Promise<void>;
  } | null;
}

function createHandlers(ctx: HandlerContext): Record<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> {
  const { db, getDownloadWorker, getScraper, getDownloadWorkerRunning, setDownloadWorkerRunning } = ctx;

  return {
    [IpcChannels.CHANNELS_LIST]: async (_event, ...args) => {
      const activeOnly = args[0] as boolean | undefined;
      const scheduleId = args[1] as number | undefined;
      return channelsData.listChannels(db, activeOnly, scheduleId);
    },
    [IpcChannels.CHANNELS_GET]: async (_event, ...args) => {
      const id = args[0] as number;
      return channelsData.getChannelById(db, id);
    },
    [IpcChannels.CHANNELS_CREATE]: async (_event, ...args) => {
      const payload = args[0] as {
        schedule_id: number;
        url: string;
        name: string;
        all_words?: string[] | string;
        any_words?: string[] | string;
        none_words?: string[] | string;
        min_duration_minutes?: number | null;
        max_duration_minutes?: number | null;
        download_format?: string;
        download_subtitles?: number;
        download_thumbnails?: number;
        first_scrape_limit?: number | null;
        active?: number;
      };
      return channelsData.createChannel(db, {
        schedule_id: payload.schedule_id,
        url: payload.url,
        name: payload.name,
        all_words: jsonArr(payload.all_words ?? []),
        any_words: jsonArr(payload.any_words ?? []),
        none_words: jsonArr(payload.none_words ?? []),
        min_duration_minutes: payload.min_duration_minutes ?? null,
        max_duration_minutes: payload.max_duration_minutes ?? null,
        download_format: payload.download_format ?? "mp4",
        download_subtitles: payload.download_subtitles ?? 0,
        download_thumbnails: payload.download_thumbnails ?? 0,
        last_scraped_at: null,
        first_scrape_limit: payload.first_scrape_limit ?? null,
        active: payload.active ?? 1,
      });
    },
    [IpcChannels.CHANNELS_UPDATE]: async (_event, ...args) => {
      const id = args[0] as number;
      const updates = args[1] as Partial<{
        url: string;
        name: string;
        all_words: string[] | string;
        any_words: string[] | string;
        none_words: string[] | string;
        min_duration_minutes: number | null;
        max_duration_minutes: number | null;
        download_format: string;
        download_subtitles: number;
        download_thumbnails: number;
        first_scrape_limit: number | null;
        active: number;
      }>;
      const mapped: Parameters<typeof channelsData.updateChannel>[2] = {};
      if (updates?.url !== undefined) mapped.url = updates.url;
      if (updates?.name !== undefined) mapped.name = updates.name;
      if (updates?.all_words !== undefined) mapped.all_words = jsonArr(updates.all_words);
      if (updates?.any_words !== undefined) mapped.any_words = jsonArr(updates.any_words);
      if (updates?.none_words !== undefined) mapped.none_words = jsonArr(updates.none_words);
      if (updates?.min_duration_minutes !== undefined) mapped.min_duration_minutes = updates.min_duration_minutes;
      if (updates?.max_duration_minutes !== undefined) mapped.max_duration_minutes = updates.max_duration_minutes;
      if (updates?.download_format !== undefined) mapped.download_format = updates.download_format;
      if (updates?.download_subtitles !== undefined) mapped.download_subtitles = updates.download_subtitles;
      if (updates?.download_thumbnails !== undefined) mapped.download_thumbnails = updates.download_thumbnails;
      if (updates?.first_scrape_limit !== undefined) mapped.first_scrape_limit = updates.first_scrape_limit;
      if (updates?.active !== undefined) mapped.active = updates.active;
      if (Object.keys(mapped).length > 0) channelsData.updateChannel(db, id, mapped);
      return channelsData.getChannelById(db, id);
    },
    [IpcChannels.CHANNELS_DELETE]: async (_event, ...args) => {
      const id = args[0] as number;
      channelsData.deleteChannel(db, id);
      return undefined;
    },
    [IpcChannels.CHANNELS_SET_ACTIVE]: async (_event, ...args) => {
      const id = args[0] as number;
      const active = args[1] as boolean;
      channelsData.setChannelActive(db, id, active);
      return undefined;
    },

    [IpcChannels.SCHEDULES_LIST]: async () => {
      return schedulesData.listSchedulesWithNextScrape(db);
    },
    [IpcChannels.SCHEDULES_GET]: async (_event, ...args) => {
      const id = args[0] as number;
      return schedulesData.getScheduleById(db, id);
    },
    [IpcChannels.SCHEDULES_CREATE]: async (_event, ...args) => {
      const payload = args[0] as { name?: string | null };
      return schedulesData.createSchedule(db, {
        name: payload.name ?? null,
      });
    },
    [IpcChannels.SCHEDULES_UPDATE]: async (_event, ...args) => {
      const id = args[0] as number;
      const updates = args[1] as Partial<Pick<ScheduleRow, "name">>;
      schedulesData.updateSchedule(db, id, updates ?? {});
      return schedulesData.getScheduleById(db, id);
    },
    [IpcChannels.SCHEDULES_DELETE]: async (_event, ...args) => {
      const id = args[0] as number;
      schedulesData.deleteSchedule(db, id);
      return undefined;
    },

    [IpcChannels.CHANNEL_SLOTS_LIST]: async (_event, ...args) => {
      const channelId = args[0] as number;
      return channelSlotsData.listSlotsByChannelId(db, channelId);
    },
    [IpcChannels.CHANNEL_SLOTS_REPLACE]: async (_event, ...args) => {
      const channelId = args[0] as number;
      const slots = args[1] as { day_of_week: number; time_minutes: number }[];
      channelSlotsData.replaceSlotsForChannel(
        db,
        channelId,
        Array.isArray(slots) ? slots : []
      );
      return channelSlotsData.listSlotsByChannelId(db, channelId);
    },
    [IpcChannels.CHANNEL_SLOTS_ADD]: async (_event, ...args) => {
      const channelId = args[0] as number;
      const dayOfWeek = args[1] as number;
      const timeMinutes = args[2] as number;
      return channelSlotsData.addSlot(db, channelId, dayOfWeek, timeMinutes);
    },
    [IpcChannels.CHANNEL_SLOTS_GET_NEXT_RUN]: async (_event, ...args) => {
      const fromDate = args[0] ? new Date(args[0] as string | number) : new Date();
      
      // Check both manual slots and intelligent schedule
      const nextRun = channelSlotsData.getNextRunAt(fromDate, db);
      const nextRunSlots = nextRun ? nextRun.getTime() : Infinity;
      
      // Also check intelligent schedules for next scrape
      const intelligentUpcoming = intelligentSchedulesData.getUpcomingScrapes(db, 24 * 365); // 1 year ahead
      if (process.env.DEBUG_SCHEDULE) {
        console.log(`[DEBUG_SCHEDULE] getUpcomingScrapes returned ${intelligentUpcoming.length} schedules`);
        if (intelligentUpcoming.length > 0) {
          console.log(`[DEBUG_SCHEDULE]   first schedule:`, intelligentUpcoming[0]);
        }
      }
      const nextIntelligenScrape = intelligentUpcoming[0]
        ? new Date(intelligentUpcoming[0].next_scrape_time).getTime()
        : Infinity;
      
      if (process.env.DEBUG_SCHEDULE) {
        const slotsStr = nextRunSlots === Infinity ? 'none' : new Date(nextRunSlots).toISOString();
        const smartStr = nextIntelligenScrape === Infinity ? 'none' : new Date(nextIntelligenScrape).toISOString();
        console.log('[DEBUG_SCHEDULE] CHANNEL_SLOTS_GET_NEXT_RUN: slots=', slotsStr, ' intelligent=', smartStr);
      }
      
      // Return whichever is sooner
      if (nextRunSlots <= nextIntelligenScrape && nextRun) {
        return nextRun.toISOString();
      } else if (nextIntelligenScrape < Infinity) {
        return new Date(nextIntelligenScrape).toISOString();
      }
      return null;
    },
    [IpcChannels.CHANNEL_ANALYZE_SCHEDULE]: async (_event, ...args) => {
      const channelUrl = (args[0] as string)?.trim();
      if (!channelUrl) {
        return {
          intelligentPrediction: null,
          suggestedSlots: [],
          message: "No channel URL provided.",
          videoCount: 0,
          error: "Missing channel URL",
        };
      }
      
      try {
        const ytDlpPath = ctx.options?.ytDlpPath ?? "yt-dlp";
        const channelVideosUrl = channelUrl.trim().endsWith("/videos")
          ? channelUrl
          : `${channelUrl.replace(/\/$/, "")}/videos`;
        
        // Fetch with flat-playlist for quick analysis
        const quickVideos = await listChannelVideos(ytDlpPath, channelVideosUrl, {
          fullMetadata: false, // Fast: flat-playlist with approximate timestamps
          maxVideos: 50,
        });
        
        // Extract timestamps for analysis
        let timestamps = quickVideos
          .filter(v => v.releaseTimestamp != null && Number.isFinite(v.releaseTimestamp))
          .map(v => v.releaseTimestamp as number);

        // Detect date-only timestamps (flat-playlist / approximate_date returns midnight UTC)
        const dateOnlyCount = quickVideos.reduce((s, v) => {
          if (!v.releaseTimestamp) return s;
          const d = new Date(v.releaseTimestamp * 1000);
          return s + (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? 1 : 0);
        }, 0);

        // If majority of timestamps are date-only, fetch accurate timestamps (slower)
        if (timestamps.length > 0 && dateOnlyCount / timestamps.length >= 0.6) {
          if (process.env.DEBUG_SCHEDULE) console.log('[DEBUG_SCHEDULE] Detected date-only timestamps; fetching accurate timestamps (fullMetadata)');
          try {
            const accurate = await listChannelVideos(ytDlpPath, channelVideosUrl, { fullMetadata: true, maxVideos: 10 });
            timestamps = accurate
              .filter(v => v.releaseTimestamp != null && Number.isFinite(v.releaseTimestamp))
              .map(v => v.releaseTimestamp as number);
            if (process.env.DEBUG_SCHEDULE) console.log('[DEBUG_SCHEDULE] Fetched accurate timestamps count=', timestamps.length);
          } catch (err) {
            if (process.env.DEBUG_SCHEDULE) console.error('[DEBUG_SCHEDULE] failed to fetch accurate timestamps', err);
          }
        }
        
        let intelligentPrediction = null;
        let suggestedSlots: { day_of_week: number; time_minutes: number }[] = [];
        
        if (timestamps.length >= 3) {
          // Get intelligent prediction
          const intelligentScheduler = new IntelligentScheduleService();
          const plan = intelligentScheduler.analyzeTimestamps(timestamps);
          if (process.env.DEBUG_SCHEDULE) {
            try {
              console.log('[DEBUG_SCHEDULE] quickVideos parsed timestamps:');
              quickVideos.forEach(v => {
                const ts = v.releaseTimestamp as number | undefined;
                if (!ts) return console.log(`[DEBUG_SCHEDULE] id=${v.id} no timestamp`);
                const utc = new Date(ts * 1000).toISOString();
                const local = new Date(ts * 1000).toString();
                const isDateOnlyUtcMidnight = new Date(ts * 1000).getUTCHours() === 0 && new Date(ts * 1000).getUTCMinutes() === 0;
                console.log(`[DEBUG_SCHEDULE] id=${v.id} ts=${ts} utc=${utc} local=${local} dateOnlyUtcMidnight=${isDateOnlyUtcMidnight}`);
              });
              console.log('[DEBUG_SCHEDULE] intelligent scheduler plan:', plan);
            } catch (e) {
              console.error('[DEBUG_SCHEDULE] failed to print debug info', e);
            }
          }
          intelligentPrediction = {
            nextScrapeTime: plan.nextScrapeTime.toISOString(),
            pattern: plan.pattern,
            confidence: plan.confidence,
            expectedVideos: plan.expectedVideos,
            isErratic: plan.isErratic,
          };
          
          // Extract suggested slots for manual mode
          const dayTimeMap = new Map<number, number[]>();
          
          timestamps.forEach(ts => {
            const date = new Date(ts * 1000);
            const dayOfWeek = date.getUTCDay();
            const timeMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
            
            if (!dayTimeMap.has(dayOfWeek)) {
              dayTimeMap.set(dayOfWeek, []);
            }
            dayTimeMap.get(dayOfWeek)!.push(timeMinutes);
          });
          
          // For each day with uploads, calculate median time
          dayTimeMap.forEach((times, dayOfWeek) => {
            const sorted = times.sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)]!;
            suggestedSlots.push({ day_of_week: dayOfWeek, time_minutes: Math.round(median) });
          });
          
          suggestedSlots.sort((a, b) => a.day_of_week - b.day_of_week);
        }
        
        return {
          intelligentPrediction,
          suggestedSlots,
          videoCount: quickVideos.length,
          message: timestamps.length < 3 ? "Not enough videos to generate schedule" : "Schedule analysis complete",
        };
      } catch (err) {
        return {
          intelligentPrediction: null,
          suggestedSlots: [],
          videoCount: 0,
          error: `Failed to analyze channel: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    [IpcChannels.CHANNEL_ANALYSIS_VIDEOS_SAVE]: async (_event, ...args) => {
      const channelId = args[0] as number;
      const videos = args[1] as { id: string; durationSeconds?: number; title?: string; releaseTimestamp: number }[];
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] CHANNEL_ANALYSIS_VIDEOS_SAVE called: args.length=${args.length} channelId=${channelId} videos=${videos ? videos.length : 'null'}`);
      if (process.env.DEBUG_SCHEDULE && videos) console.log(`[DEBUG_SCHEDULE] videos array:`, videos.slice(0, 2));
      if (!Array.isArray(videos)) {
        if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] videos not an array, returning`);
        return undefined;
      }
      channelAnalysisVideosData.upsert(db, channelId, videos.map((v) => ({
        id: v.id,
        durationSeconds: v.durationSeconds ?? 0,
        title: v.title ?? "",
        releaseTimestamp: v.releaseTimestamp,
      })));
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] upserted ${videos.length} videos to channel_analysis_videos`);
      // After saving analysis videos, update intelligent schedule
      const scheduler = new IntelligentScheduleService();
      const success = scheduler.updateChannelSchedule(db, channelId);
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] updateChannelSchedule channel=${channelId} success=${success}`);
      // Return the newly created schedule
      const schedule = intelligentSchedulesData.getChannelSchedule(db, channelId);
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] returned schedule:`, schedule);
      return schedule;
    },

    [IpcChannels.CHANNEL_FETCH_ACCURATE_TIMESTAMPS]: async (_event, ...args) => {
      const channelUrl = (args[0] as string)?.trim();
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] CHANNEL_FETCH_ACCURATE_TIMESTAMPS called with url=${channelUrl}`);
      if (!channelUrl) {
        return {
          videos: [],
          error: "Missing channel URL",
        };
      }
      try {
        const ytDlpPath = ctx.options?.ytDlpPath ?? "yt-dlp";
        const channelVideosUrl = channelUrl.endsWith("/videos")
          ? channelUrl
          : `${channelUrl.replace(/\/$/, "")}/videos`;
        
        if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] fetching with fullMetadata=true from url=${channelVideosUrl}`);
        // Fetch with full metadata (accurate timestamps, no flat-playlist)
        // Limit to 10 videos to avoid long yt-dlp fetch times
        const accurateVideos = await listChannelVideos(ytDlpPath, channelVideosUrl, {
          fullMetadata: true,
          maxVideos: 10,
          timeoutMs: 300_000, // 5 minutes
        });
        
        if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] CHANNEL_FETCH_ACCURATE_TIMESTAMPS fetched ${accurateVideos.length} videos`);
        
        const result = {
          videos: accurateVideos.map(v => ({
            id: v.id,
            durationSeconds: v.durationSeconds,
            title: v.title,
            releaseTimestamp: v.releaseTimestamp,
          })),
          error: undefined,
        };
        if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] returning ${result.videos.length} videos`);
        return result;
      } catch (err) {
        if (process.env.DEBUG_SCHEDULE) console.error(`[DEBUG_SCHEDULE] CHANNEL_FETCH_ACCURATE_TIMESTAMPS error:`, err instanceof Error ? err.message : err);
        return {
          videos: [],
          error: `Failed to fetch accurate timestamps: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    [IpcChannels.DOWNLOAD_TASKS_LIST]: async (_event, ...args) => {
      const status = args[0] as string | undefined;
      return downloadTasksData.listDownloadTasks(db, status);
    },
    [IpcChannels.DOWNLOAD_TASKS_ADD]: async (_event, ...args) => {
      const params = args[0] as { video_url: string; channel_id: number };
      return downloadTasksData.addDownloadTask(db, { video_url: params.video_url, channel_id: params.channel_id });
    },
    [IpcChannels.DOWNLOAD_TASKS_GET]: async (_event, ...args) => {
      const id = args[0] as number;
      return downloadTasksData.getDownloadTaskById(db, id);
    },
    [IpcChannels.DOWNLOAD_TASK_MARK_FINISHED]: async (_event, ...args) => {
      const id = args[0] as number;
      downloadTasksData.setTaskStatus(db, id, DownloadTaskStatus.DOWNLOADED);
      return downloadTasksData.getDownloadTaskById(db, id);
    },

    [IpcChannels.DOWNLOAD_HISTORY_LIST]: async (_event, ...args) => {
      const filters = args[0] as downloadHistoryData.DownloadHistoryListFilters | undefined;
      return downloadHistoryData.listDownloadHistory(db, filters);
    },

    [IpcChannels.VIDEO_DETAILS_LIST]: async (_event, ...args) => {
      const channelName = args[0] as string | undefined;
      return videoDetailsData.listVideoDetails(db, channelName);
    },
    [IpcChannels.VIDEO_DETAILS_GET]: async (_event, ...args) => {
      const videoUrl = args[0] as string;
      return videoDetailsData.getVideoDetailByUrl(db, videoUrl);
    },

    [IpcChannels.SCRAPER_START]: async () => {
      const s = getScraper();
      if (s) s.start();
      return undefined;
    },
    [IpcChannels.SCRAPER_STOP]: async () => {
      const s = getScraper();
      if (s) s.stop();
      return undefined;
    },
    [IpcChannels.SCRAPER_RUN_ONCE]: async (_event, ...args) => {
      const channelId = args[0] as number | undefined;
      const s = getScraper();
      if (s) await s.runOnce(channelId);
      return undefined;
    },

    [IpcChannels.DOWNLOAD_WORKER_START]: async () => {
      const worker = getDownloadWorker();
      if (worker) {
        worker.start();
        setDownloadWorkerRunning(true);
      }
      return undefined;
    },
    [IpcChannels.DOWNLOAD_WORKER_STOP]: async () => {
      const worker = getDownloadWorker();
      if (worker) {
        worker.stop();
        setDownloadWorkerRunning(false);
      }
      return undefined;
    },
    [IpcChannels.DOWNLOAD_WORKER_GET_STATUS]: async () => {
      return { running: getDownloadWorkerRunning() };
    },

    [IpcChannels.INTELLIGENT_SCHEDULE_GET]: async (_event, ...args) => {
      const channelId = args[0] as number;
      return intelligentSchedulesData.getChannelSchedule(db, channelId);
    },

    [IpcChannels.INTELLIGENT_SCHEDULE_GET_UPCOMING]: async (_event, ...args) => {
      const hoursAhead = (args[0] as number | undefined) ?? 24;
      return intelligentSchedulesData.getUpcomingScrapes(db, hoursAhead);
    },

    [IpcChannels.INTELLIGENT_SCHEDULE_GET_OVERDUE]: async () => {
      return intelligentSchedulesData.getOverdueScrapes(db);
    },

    [IpcChannels.INTELLIGENT_SCHEDULE_GET_STATS]: async () => {
      return intelligentSchedulesData.getScheduleStats(db);
    },

    [IpcChannels.INTELLIGENT_SCHEDULE_REFRESH_ALL]: async () => {
      const scheduler = new IntelligentScheduleService();
      const updated = scheduler.refreshAllSchedules(db);
      return { updated };
    },

    [IpcChannels.CHANNEL_FETCH_DETAILS]: async (_event, ...args) => {
      const channelUrl = (args[0] as string)?.trim();
      const opts = args[1] as { maxVideoCount?: number } | undefined;
      if (!channelUrl) {
        return { error: "Missing channel URL" };
      }
      try {
        const ytDlpPath = ctx.options?.ytDlpPath ?? "yt-dlp";
        return await fetchChannelDetails(ytDlpPath, channelUrl,
          opts?.maxVideoCount != null ? { maxVideoCount: opts.maxVideoCount } : undefined,
        );
      } catch (err) {
        return {
          error: `Failed to fetch channel details: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    [IpcChannels.PROCESS_LOAD]: async () => {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
        cpu: { user: cpu.user, system: cpu.system },
      };
    },
  };
}

export function createIpcHandlers(ctx: HandlerContext): Record<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> {
  return createHandlers(ctx);
}
