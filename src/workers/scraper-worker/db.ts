import Database from "better-sqlite3";
import * as channelsData from "../../data/channels.js";
import * as channelSlotsData from "../../data/channelSlots.js";
import * as downloadHistoryData from "../../data/downloadHistory.js";
import * as videoDetailsData from "../../data/videoDetails.js";
import * as downloadTasksData from "../../data/downloadTasks.js";
import type { ChannelRow, VideoDetailRow } from "../../types/index.js";

export function getActiveChannels(db: Database.Database): ChannelRow[] {
  return channelsData.listChannels(db, true);
}

export function getChannelById(
  db: Database.Database,
  id: number
): ChannelRow | null {
  return channelsData.getChannelById(db, id);
}

export function getChannelsByIds(
  db: Database.Database,
  ids: number[],
  activeOnly = true
): ChannelRow[] {
  return channelsData.getChannelsByIds(db, ids, activeOnly);
}

export function updateChannelLastScraped(
  db: Database.Database,
  channelId: number,
  isoDate: string
): void {
  channelsData.updateChannelLastScraped(db, channelId, isoDate);
}

/**
 * Channel IDs that have at least one channel_slot due now (current time within [start_time, end_time]).
 */
export function getDueChannelIds(
  db: Database.Database,
  day: number,
  currentTimeMinutes: number,
  windowMinutes: number
): number[] {
  return channelSlotsData.getDueChannelIds(
    db,
    day,
    currentTimeMinutes,
    windowMinutes
  );
}

/**
 * Channel IDs that have at least one slot past due (previous occurrence after last_scraped_at).
 */
export function getPastDueChannelIds(
  db: Database.Database,
  asOf: Date
): number[] {
  return channelSlotsData.getPastDueChannelIds(db, asOf);
}

/** Whether there are any channel_slots (slot-driven mode exists). */
export function hasAnySchedules(db: Database.Database): boolean {
  return channelSlotsData.hasAnyChannelSlots(db);
}

/**
 * Milliseconds from fromDate until the next slot start (any channel_slot).
 * Returns null if no slots. Used for schedule-based sleep.
 */
export function getNextSlotStartMs(
  db: Database.Database,
  fromDate: Date
): number | null {
  return channelSlotsData.getNextSlotStartMs(db, fromDate);
}

/** Slots for a channel (day_of_week + time_minutes; no upload-window filter). */
export function getSlotsByChannelId(
  db: Database.Database,
  channelId: number
): { id: number; channel_id: number; day_of_week: number; time_minutes: number }[] {
  return channelSlotsData.listSlotsByChannelId(db, channelId);
}

/** Delete consumed run_at rows for channels that just ran. */
export function deleteConsumedRunAts(
  db: Database.Database,
  channelIds: number[],
  beforeOrAt: Date
): void {
  channelSlotsData.deleteConsumedRunAts(db, channelIds, beforeOrAt);
}


/** Latest release_timestamp in video_details for a channel (by name). Null if none. */
export function getLatestReleaseTimestampForChannel(
  db: Database.Database,
  channelName: string
): number | null {
  return videoDetailsData.getLatestReleaseTimestamp(db, channelName);
}

export function upsertVideoDetail(
  db: Database.Database,
  row: Omit<VideoDetailRow, "updated_at" | "created_at">
): void {
  videoDetailsData.upsertVideoDetail(db, row);
}

export function addDownloadTaskIfNotExists(
  db: Database.Database,
  params: { video_url: string; channel_id: number }
): boolean {
  if (downloadTasksData.hasTaskForVideoUrl(db, params.video_url)) {
    return false;
  }
  if (downloadHistoryData.hasHistoryForVideoUrl(db, params.video_url)) {
    return false;
  }
  downloadTasksData.addDownloadTask(db, {
    video_url: params.video_url,
    channel_id: params.channel_id,
  });
  return true;
}
