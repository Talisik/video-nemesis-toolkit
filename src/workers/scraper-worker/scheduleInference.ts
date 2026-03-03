import type { ScrapedVideo } from "./scrape.js";
import { listChannelVideos } from "./scrape.js";

const DEFAULT_YT_DLP = "yt-dlp";
/** Initial analysis: fetch 20 videos for "add channel" flow; saved to channel_analysis_videos and used to compute interval. */
const INITIAL_ANALYSIS_VIDEOS = 20;

/** Max videos to fetch when only previewing (e.g. user clicks Analyze but doesn't add yet). Can be larger for better preview. */
const DEFAULT_MAX_VIDEOS = 100;

/**
 * Schedule inference basis (how we choose day, time, and number of slots):
 *
 * - Source of time: For schedule inference we call listChannelVideos with fullMetadata: true (no
 *   --flat-playlist), so yt-dlp fetches each video's metadata and we get the real upload date/time.
 *   We set timeIsExact: true. Regular scrape still uses flat-playlist (date-only) for speed.
 * - Day: From timestamp in local time. 0=Sun..6=Sat.
 * - Time: Rounded to the hour (real upload hour when fullMetadata).
 * - Weekly pattern: We bucket by (day_of_week, hour). Any bucket with ≥ REGULAR_THRESHOLD_RATIO
 *   of uploads is a "regular" slot.
 * - Interval patterns: Gaps between consecutive uploads (by date) support every 1–4 days, weekly, every 2 weeks.
 * - High-frequency: Last N videos span < 3 days → suggest every day at peak "hours" (same caveat: date-only).
 */

/** Bucket size in minutes when clustering upload times. 60 = same hour counts as same slot. */
const BUCKET_MINUTES = 60;

/** Minimum share of uploads in a (day, hour) bucket to consider the channel "regular" for that slot. */
const REGULAR_THRESHOLD_RATIO = 0.22;

/** Lower threshold when we detect an interval (e.g. every 2 days) so we suggest all active days. */
const INTERVAL_SLOT_THRESHOLD_RATIO = 0.10;

/** For time-only (high-frequency) mode: minimum share in an hour bucket to suggest that time. Lowered so we can suggest up to 12 hours. */
const HIGH_FREQ_HOUR_THRESHOLD_RATIO = 0.02;

/** If last N videos span fewer than this many days, use time-of-day-only inference (every day at peak hours). */
const MIN_SPAN_DAYS = 3;

/** Minimum number of videos with valid release timestamps to infer anything. */
const MIN_VIDEOS_FOR_INFERENCE = 5;

/** Max suggested slots for weekly/interval patterns (allows many timeslots per channel, e.g. Mon/Wed/Fri 18:00). */
const MAX_SUGGESTED_SLOTS = 14;

/** Min share of upload gaps in a single interval bucket (days) to label "every N days". */
const INTERVAL_DETECT_MIN_RATIO = 0.35;

/** Interval buckets we detect: 1, 2, 3, 4, 7, 14 days (e.g. every 2 weeks). */
const INTERVAL_DAYS_BUCKETS = [1, 2, 3, 4, 7, 14] as const;

/** Max peak hours to suggest per day for high-frequency channels (e.g. news). Each hour runs every day. */
const MAX_PEAK_HOURS_HIGH_FREQ = 12;

/** Max total slots in high-frequency mode (7 days × up to MAX_PEAK_HOURS_HIGH_FREQ). */
const MAX_SLOTS_HIGH_FREQ = 7 * MAX_PEAK_HOURS_HIGH_FREQ;

export interface SuggestedSlot {
  day_of_week: number;
  time_minutes: number;
  /** Approximate share of uploads in this window (0–1). */
  share: number;
}

export interface ScheduleInferenceResult {
  /** True if at least one slot met the regularity threshold. */
  regular: boolean;
  /** Suggested (day_of_week, time_minutes) slots, ordered by share descending. */
  suggestedSlots: SuggestedSlot[];
  /** Human-readable message (e.g. "Uploads often on Tue ~18:00" or "Uploads are irregular"). */
  message: string;
  /** Number of videos that had a valid release timestamp. */
  videoCount: number;
  /** Total videos fetched (may be less if channel has fewer). */
  totalFetched: number;
  /** Detected upload interval in days (e.g. 2 = every 2 days, 14 = every 2 weeks). Omitted if not detected. */
  intervalDays?: number;
  /** Why we suggested these run times (e.g. "Wed 8:00: 12 of 50 uploads (24%) in that hour, local time."). Shown in UI. */
  basis?: string;
  /** Why we did or didn't detect an interval (e.g. "40% of gaps between uploads were ~14 days → every 2 weeks." or "Gaps varied a lot (7–60 days); no regular interval."). */
  intervalBasis?: string;
  /** False when using channel listing: we only have upload *date* (yt-dlp gives midnight UTC per day), so the suggested hour is not the real upload time — it's just midnight UTC in your timezone. */
  timeIsExact?: boolean;
  /** When adding via auto-detect, store in channel_intervals (not channel_slots). This is the suggested interval in minutes (e.g. 120 = every 2 hours). */
  suggestedIntervalMinutes?: number;
  /** Videos used for inference (id, durationSeconds, title, releaseTimestamp). Save to channel_analysis_videos when adding channel. */
  analysisVideos?: { id: string; durationSeconds: number; title: string; releaseTimestamp: number }[];
  /** Error message if fetch or inference failed. */
  error?: string;
}

/**
 * Normalize channel URL to /videos form for yt-dlp playlist listing.
 */
function toChannelVideosUrl(url: string): string {
  const u = url.trim();
  if (u.endsWith("/videos")) return u;
  return `${u.replace(/\/$/, "")}/videos`;
}

/**
 * Map Unix timestamp to local (day_of_week, time_minutes).
 * day_of_week: 0=Sunday, 1=Monday, ... 6=Saturday.
 * time_minutes: 0–1439 (minutes since midnight).
 */
function timestampToLocalSlot(unixSeconds: number): { day_of_week: number; time_minutes: number } {
  const d = new Date(unixSeconds * 1000);
  const day_of_week = d.getDay();
  const time_minutes = d.getHours() * 60 + d.getMinutes();
  return { day_of_week, time_minutes };
}

/**
 * Bucket time_minutes into BUCKET_MINUTES so that e.g. 18:00 and 18:30 fall in same bucket.
 */
function bucketTime(timeMinutes: number): number {
  return Math.floor(timeMinutes / BUCKET_MINUTES) * BUCKET_MINUTES;
}

const SECONDS_PER_DAY = 24 * 3600;

/**
 * Map a gap (days) into a strict bucket. Gaps outside these ranges are null (irregular).
 * Supports: 1, 2, 3, 4, 7, 14 days (every 2 weeks).
 */
function gapToStrictBucket(gapDays: number): number | null {
  if (gapDays < 0.5) return null;
  if (gapDays < 1.5) return 1;
  if (gapDays < 2.5) return 2;
  if (gapDays < 3.5) return 3;
  if (gapDays < 4.5) return 4;
  if (gapDays < 10.5) return 7;
  if (gapDays < 21) return 14; // every 2 weeks
  return null;
}

/** Result of interval detection: best N days and human-readable basis. */
function detectIntervalWithBasis(timestamps: number[]): {
  intervalDays: number | undefined;
  intervalBasis: string;
} {
  const noBasis = (reason: string) => ({ intervalDays: undefined as number | undefined, intervalBasis: reason });
  if (timestamps.length < 4) return noBasis("Not enough uploads to detect interval.");
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapDays = (sorted[i]! - sorted[i - 1]!) / SECONDS_PER_DAY;
    gaps.push(gapDays);
  }
  const total = gaps.length;
  const meanGap = gaps.reduce((a, b) => a + b, 0) / total;

  const bucketCount = new Map<number, number>();
  for (const g of gaps) {
    const b = gapToStrictBucket(g);
    if (b != null) bucketCount.set(b, (bucketCount.get(b) ?? 0) + 1);
  }

  const bucketLabels: Record<number, string> = {
    1: "about 1 day",
    2: "about 2 days",
    3: "about 3 days",
    4: "about 4 days",
    7: "about 1 week",
    14: "about 2 weeks",
  };

  let bestInterval: number | undefined;
  let bestCount = 0;
  for (const [days, count] of bucketCount) {
    if (count < total * INTERVAL_DETECT_MIN_RATIO || count <= bestCount) continue;
    if (meanGap < 0.5 * days || meanGap > 2.5 * days) continue;
    bestCount = count;
    bestInterval = days;
  }

  if (bestInterval != null) {
    const pct = Math.round((bestCount / total) * 100);
    return {
      intervalDays: bestInterval,
      intervalBasis: `${pct}% of gaps between uploads were ${bucketLabels[bestInterval] ?? `${bestInterval} days`} apart → every ${bestInterval === 1 ? "day" : bestInterval === 7 ? "week" : bestInterval === 14 ? "2 weeks" : `${bestInterval} days`}.`,
    };
  }

  const inBuckets = Array.from(bucketCount.entries()).reduce((s, [d, c]) => s + c, 0);
  const irregularCount = total - inBuckets;
  if (irregularCount >= total * 0.5) {
    const minG = Math.min(...gaps);
    const maxG = Math.max(...gaps);
    return noBasis(
      `Gaps between uploads varied a lot (${minG.toFixed(0)}–${maxG.toFixed(0)} days). No regular interval — use "check every N days" manually (e.g. every 2 weeks).`
    );
  }
  return noBasis(
    `Gaps between uploads didn’t match a clear pattern (every 1–4 days, weekly, or every 2 weeks). Consider setting an interval manually (e.g. every 2 weeks).`
  );
}

/** Max suggested check interval: 1 week. */
const MINUTES_PER_WEEK = 7 * 24 * 60;

const INTERVAL_DAYS_TO_MINUTES: Record<number, number> = {
  1: 60,
  2: 720,
  3: 1440,
  4: 1440,
  7: MINUTES_PER_WEEK,
  14: MINUTES_PER_WEEK,
};

/**
 * Compute suggested scrape interval in minutes from upload timestamps (Unix seconds).
 * Used when recomputing from channel_analysis_videos. Returns null if too few points.
 */
export function computeIntervalMinutesFromTimestamps(timestamps: number[]): number | null {
  if (timestamps.length < 4) return null;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const spanDays = (sorted[sorted.length - 1]! - sorted[0]!) / SECONDS_PER_DAY;
  if (spanDays < MIN_SPAN_DAYS) return 120;
  const { intervalDays } = detectIntervalWithBasis(timestamps);
  if (intervalDays != null && INTERVAL_DAYS_TO_MINUTES[intervalDays] != null)
    return INTERVAL_DAYS_TO_MINUTES[intervalDays];
  return 1440;
}

/**
 * Infer upload schedule from the last N videos of a channel.
 * Uses local timezone. Marks channel as irregular if no (day, hour) bucket has enough concentration.
 */
export async function inferScheduleFromChannelUrl(
  channelUrl: string,
  options?: {
    ytDlpPath?: string;
    maxVideos?: number;
    timeoutMs?: number;
  }
): Promise<ScheduleInferenceResult> {
  const ytDlpPath = options?.ytDlpPath ?? DEFAULT_YT_DLP;
  const maxVideos = options?.maxVideos ?? DEFAULT_MAX_VIDEOS;
  const url = toChannelVideosUrl(channelUrl);

  let videos: ScrapedVideo[];
  try {
    videos = await listChannelVideos(ytDlpPath, url, {
      maxVideos,
      timeoutMs: options?.timeoutMs ?? 600_000,
      fullMetadata: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      regular: false,
      suggestedSlots: [],
      message: "Could not fetch channel videos.",
      videoCount: 0,
      totalFetched: 0,
      error: message,
    };
  }

  const withTimestamp = videos.filter((v) => v.releaseTimestamp != null && v.releaseTimestamp > 0);
  const totalFetched = videos.length;
  const videoCount = withTimestamp.length;

  const analysisVideos = withTimestamp.map((v) => ({
    id: v.id,
    durationSeconds: v.durationSeconds,
    title: v.title,
    releaseTimestamp: v.releaseTimestamp!,
  }));

  if (videoCount < MIN_VIDEOS_FOR_INFERENCE) {
    return {
      regular: false,
      suggestedSlots: [],
      message:
        videoCount === 0
          ? "No upload times found in the last videos (or channel has no videos). Add run times manually."
          : `Only ${videoCount} video(s) with dates; need at least ${MIN_VIDEOS_FOR_INFERENCE} to detect a pattern. Add run times manually.`,
      videoCount,
      totalFetched,
      ...(analysisVideos.length > 0 && { analysisVideos }),
    };
  }

  const timestamps = withTimestamp.map((v) => v.releaseTimestamp!);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const spanDays = (maxTs - minTs) / (24 * 3600);

  // High-frequency: last N videos span only a few days → infer time-of-day only, suggest every day at peak hours
  if (spanDays < MIN_SPAN_DAYS) {
    return inferHighFrequencySlots(withTimestamp, videoCount, totalFetched, analysisVideos);
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Detect interval (every 2 days, 4 days, 2 weeks, etc.) and build basis text
  const { intervalDays, intervalBasis } = detectIntervalWithBasis(timestamps);

  // Weekly pattern: bucket by (day_of_week, hour)
  const bucketCount = new Map<string, number>();
  for (const v of withTimestamp) {
    const slot = timestampToLocalSlot(v.releaseTimestamp!);
    const key = `${slot.day_of_week}:${bucketTime(slot.time_minutes)}`;
    bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
  }

  const entries: { day_of_week: number; time_minutes: number; count: number }[] = [];
  for (const [key, count] of bucketCount) {
    const parts = key.split(":");
    const dow = Number(parts[0] ?? 0);
    const mins = Number(parts[1] ?? 0);
    entries.push({ day_of_week: dow, time_minutes: mins, count });
  }
  entries.sort((a, b) => b.count - a.count);

  // Use lower threshold when we detected an interval so we suggest all active days (many timeslots)
  const thresholdRatio = intervalDays != null ? INTERVAL_SLOT_THRESHOLD_RATIO : REGULAR_THRESHOLD_RATIO;
  const threshold = Math.ceil(videoCount * thresholdRatio);
  const suggestedSlots: SuggestedSlot[] = [];
  for (let i = 0; i < entries.length && suggestedSlots.length < MAX_SUGGESTED_SLOTS; i++) {
    const e = entries[i];
    if (e == null) break;
    if (e.count >= threshold) {
      suggestedSlots.push({
        day_of_week: e.day_of_week,
        time_minutes: e.time_minutes,
        share: e.count / videoCount,
      });
    }
  }

  const regular = suggestedSlots.length > 0;
  let message: string;
  let basis: string | undefined;
  if (regular) {
    const parts = suggestedSlots.map((s) => {
      const h = Math.floor(s.time_minutes / 60);
      const m = s.time_minutes % 60;
      const t = `${h}:${String(m).padStart(2, "0")}`;
      return `${dayNames[s.day_of_week]} ~${t}`;
    });
    const intervalPhrase =
      intervalDays != null
        ? `Uploads about every ${intervalDays === 1 ? "day" : intervalDays === 7 ? "week" : intervalDays === 14 ? "2 weeks" : `${intervalDays} days`}; `
        : "";
    message = `${intervalPhrase}Suggested run times: ${parts.join(", ")}.`;

    // Basis: we use fullMetadata so timestamp is real upload time (not date-only)
    const basisParts = suggestedSlots.map((s) => {
      const h = Math.floor(s.time_minutes / 60);
      const m = s.time_minutes % 60;
      const t = `${h}:${String(m).padStart(2, "0")}`;
      const count = Math.round(s.share * videoCount);
      const pct = Math.round(s.share * 100);
      return `${dayNames[s.day_of_week]} ${t}: ${count} of ${videoCount} uploads (${pct}%) in that hour`;
    });
    basis = `Based on last ${videoCount} videos (real upload time, your local timezone): ${basisParts.join("; ")}.`;
  } else {
    message =
      "Uploads don’t follow a clear weekly pattern (irregular schedule). Add run times manually (e.g. daily at a fixed time) or leave empty and add slots later.";
    basis = intervalBasis;
  }

  const suggestedIntervalMinutes = regular
    ? (intervalDays != null && INTERVAL_DAYS_TO_MINUTES[intervalDays] != null
        ? Math.min(INTERVAL_DAYS_TO_MINUTES[intervalDays], MINUTES_PER_WEEK)
        : 720)
    : undefined;
  return {
    regular,
    suggestedSlots,
    message,
    videoCount,
    totalFetched,
    ...(intervalDays != null && { intervalDays }),
    ...(basis != null && { basis }),
    intervalBasis,
    timeIsExact: true,
    ...(suggestedIntervalMinutes != null && { suggestedIntervalMinutes }),
    analysisVideos,
  };
}

/**
 * When the last N videos span < MIN_SPAN_DAYS, treat as high-frequency (daily/multiple per day).
 * Cluster by time-of-day only; suggest that run time on every day of the week so we don't miss uploads.
 */
function inferHighFrequencySlots(
  withTimestamp: ScrapedVideo[],
  videoCount: number,
  totalFetched: number,
  analysisVideos: { id: string; durationSeconds: number; title: string; releaseTimestamp: number }[]
): ScheduleInferenceResult {
  const hourCount = new Map<number, number>();
  for (const v of withTimestamp) {
    const slot = timestampToLocalSlot(v.releaseTimestamp!);
    const bucket = bucketTime(slot.time_minutes);
    hourCount.set(bucket, (hourCount.get(bucket) ?? 0) + 1);
  }

  const hourEntries = Array.from(hourCount.entries())
    .map(([time_minutes, count]) => ({ time_minutes, count }))
    .sort((a, b) => b.count - a.count);

  const hourThreshold = Math.max(2, Math.ceil(videoCount * HIGH_FREQ_HOUR_THRESHOLD_RATIO));
  const peakHours: number[] = [];
  for (let i = 0; i < hourEntries.length && peakHours.length < MAX_PEAK_HOURS_HIGH_FREQ; i++) {
    const e = hourEntries[i];
    if (e == null) break;
    if (e.count >= hourThreshold) peakHours.push(e.time_minutes);
  }

  const suggestedSlots: SuggestedSlot[] = [];
  for (let day = 0; day < 7 && suggestedSlots.length < MAX_SLOTS_HIGH_FREQ; day++) {
    for (const time_minutes of peakHours) {
      if (suggestedSlots.length >= MAX_SLOTS_HIGH_FREQ) break;
      suggestedSlots.push({
        day_of_week: day,
        time_minutes,
        share: (hourCount.get(time_minutes) ?? 0) / videoCount,
      });
    }
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const timeStr = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  };
  const peakTimesStr = [...new Set(peakHours)].sort((a, b) => a - b).map(timeStr).join(", ");
  const spanDaysVal = (Math.max(...withTimestamp.map((v) => v.releaseTimestamp!)) - Math.min(...withTimestamp.map((v) => v.releaseTimestamp!))) / (24 * 3600);
  const spanDaysStr = spanDaysVal.toFixed(1);
  const message =
    peakHours.length > 0
      ? `Channel uploads very frequently (last ${videoCount} videos span ~${spanDaysStr} days). Suggested run times: every day at ~${peakTimesStr}.`
      : "Channel uploads very frequently but no clear time-of-day pattern. Add run times manually (e.g. several times per day).";

  const basis =
    peakHours.length > 0
      ? `Based on last ${videoCount} videos (real upload time) over ~${spanDaysStr} days: top upload hours are ${peakTimesStr}. Auto-add will use an interval (e.g. every 2 hours) instead of many slots.`
      : undefined;

  const suggestedIntervalMinutes = peakHours.length > 0 ? 120 : undefined;
  return {
    regular: suggestedSlots.length > 0,
    suggestedSlots,
    message,
    videoCount,
    totalFetched,
    ...(basis != null && { basis }),
    timeIsExact: true,
    ...(suggestedIntervalMinutes != null && { suggestedIntervalMinutes }),
    analysisVideos,
  };
}
