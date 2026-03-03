import type Database from "better-sqlite3";
import { IpcChannels } from "../types/enum/ipcChannels_enum.js";
import * as channelsData from "../data/channels.js";
import { inferScheduleFromChannelUrl } from "../workers/scraper-worker/scheduleInference.js";
import * as schedulesData from "../data/schedules.js";
import * as channelSlotsData from "../data/channelSlots.js";
import * as channelIntervalsData from "../data/channelIntervals.js";
import * as channelAnalysisVideosData from "../data/channelAnalysisVideos.js";
import { computeIntervalMinutesFromTimestamps } from "../workers/scraper-worker/scheduleInference.js";
import * as videoDetailsData from "../data/videoDetails.js";
import * as downloadHistoryData from "../data/downloadHistory.js";
import * as downloadTasksData from "../data/downloadTasks.js";
import { DownloadTaskStatus } from "../types/enum/downloadTaskStatus.js";
import type { IpcBridgeOptions } from "./types.js";
import type { ScheduleRow } from "../types/index.js";

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
      return schedulesData.listSchedules(db);
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
    [IpcChannels.CHANNEL_SLOTS_GET_NEXT_RUN]: async () => {
      const now = new Date();
      const slotNext = channelSlotsData.getNextRunAt(now, db);
      const intervalMs = channelIntervalsData.getNextIntervalDueMs(db, now);
      let nextRunAt: string | null = null;
      if (slotNext != null) nextRunAt = slotNext.toISOString();
      if (intervalMs != null) {
        const intervalAt = new Date(Date.now() + intervalMs).toISOString();
        if (nextRunAt == null || intervalMs <= 0 || intervalAt < nextRunAt) nextRunAt = intervalAt;
      }
      return { nextRunAt };
    },
    [IpcChannels.CHANNEL_ANALYZE_SCHEDULE]: async (_event, ...args) => {
      const channelUrl = (args[0] as string)?.trim();
      if (!channelUrl) {
        return {
          regular: false,
          suggestedSlots: [],
          message: "No channel URL provided.",
          videoCount: 0,
          totalFetched: 0,
          error: "Missing channel URL",
        };
      }
      const opts = (args[1] as { maxVideos?: number } | undefined) ?? {};
      const ytDlpPath = ctx.options?.ytDlpPath ?? "yt-dlp";
      const inferOpts: { ytDlpPath?: string; maxVideos?: number; timeoutMs?: number } = { ytDlpPath };
      if (opts.maxVideos != null) inferOpts.maxVideos = opts.maxVideos;
      return inferScheduleFromChannelUrl(channelUrl, inferOpts);
    },
    [IpcChannels.CHANNEL_ANALYSIS_VIDEOS_SAVE]: async (_event, ...args) => {
      const channelId = args[0] as number;
      const videos = args[1] as { id: string; durationSeconds?: number; title?: string; releaseTimestamp: number }[];
      if (!Array.isArray(videos)) return undefined;
      channelAnalysisVideosData.upsert(db, channelId, videos.map((v) => ({
        id: v.id,
        durationSeconds: v.durationSeconds ?? 0,
        title: v.title ?? "",
        releaseTimestamp: v.releaseTimestamp,
      })));
      return undefined;
    },
    [IpcChannels.CHANNEL_ANALYSIS_RECOMPUTE_INTERVAL]: async (_event, ...args) => {
      const channelId = args[0] as number;
      channelAnalysisVideosData.capPerChannel(db, channelId);
      const timestamps = channelAnalysisVideosData.getTimestampsForChannel(db, channelId);
      const intervalMinutes = computeIntervalMinutesFromTimestamps(timestamps);
      if (intervalMinutes != null) channelIntervalsData.set(db, channelId, intervalMinutes);
      return intervalMinutes;
    },
    [IpcChannels.CHANNEL_INTERVAL_GET]: async (_event, ...args) => {
      const channelId = args[0] as number;
      return channelIntervalsData.getByChannelId(db, channelId);
    },
    [IpcChannels.CHANNEL_INTERVAL_SET]: async (_event, ...args) => {
      const channelId = args[0] as number;
      const intervalMinutes = args[1] as number;
      return channelIntervalsData.set(db, channelId, intervalMinutes);
    },
    [IpcChannels.CHANNEL_INTERVAL_REMOVE]: async (_event, ...args) => {
      const channelId = args[0] as number;
      channelIntervalsData.remove(db, channelId);
      return undefined;
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
