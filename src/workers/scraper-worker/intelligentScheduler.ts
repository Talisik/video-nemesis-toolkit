import * as ss from 'simple-statistics';
import { 
  addHours, 
  setHours, 
  setMinutes, 
  setSeconds,
  isAfter,
  differenceInHours
} from 'date-fns';

export interface ScrapePlan {
  nextScrapeTime: Date;
  pattern: string;
  confidence: number;
  expectedVideos: number;
  isErratic: boolean;
}

/**
 * Intelligent scheduler that analyzes upload timestamps and predicts optimal scrape times.
 * Handles high-frequency uploaders (news), regular uploaders, and erratic patterns.
 */
export class YouTubeSmartScheduler {
  private readonly SESSION_THRESHOLD = 3; // Hours between uploads to consider separate sessions
  private readonly MAX_HISTORY = 100;
  private readonly ALPHA = 0.4; // Exponential weighting for recent data

  /**
   * Analyzes channel video timestamps and predicts the next optimal scrape time.
   * @param unixTimestamps - Array of Unix timestamps (seconds or milliseconds)
   * @returns ScrapePlan with next scrape time, pattern, and metadata
   */
  public analyze(unixTimestamps: number[]): ScrapePlan {
    // 1. Normalize and Limit to MAX_HISTORY latest
    const timestamps = unixTimestamps
      .slice(0, this.MAX_HISTORY)
      .map(t => t < 10000000000 ? t * 1000 : t)
      .sort((a, b) => a - b);

    if (timestamps.length < 3) return this.fallback();

    const dates = timestamps.map(t => new Date(t));
    const lastVideo = dates[dates.length - 1]!;
    const historySpanHours = differenceInHours(lastVideo, dates[0]!);

    // 2. INTERVAL ANALYSIS
    // Create sessions (group uploads within SESSION_THRESHOLD hours) and
    // compute gaps between session starts. This prevents multiple uploads
    // on the same day from making per-video median gaps very small and
    // incorrectly classifying the channel as high-frequency.
    const sessions = this.createSessions(dates);
    const sessionIntervals: number[] = [];
    for (let i = 1; i < sessions.length; i++) {
      sessionIntervals.push(differenceInHours(sessions[i]!.start, sessions[i - 1]!.start));
    }
    const medianSessionGap = sessionIntervals.length > 0 ? ss.median(sessionIntervals) : undefined;

    // Fallback to per-video raw intervals only if sessions couldn't be formed
    const rawIntervals: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      rawIntervals.push((dates[i]!.getTime() - dates[i - 1]!.getTime()) / (1000 * 60 * 60));
    }
    const medianRawGap = rawIntervals.length > 0 ? ss.median(rawIntervals) : Infinity;

    // Compute intra-session intervals (gaps between videos inside the same session)
    const intraSessionIntervals: number[] = [];
    for (const s of sessions) {
      if (!s.dates || s.dates.length < 2) continue;
      for (let i = 1; i < s.dates.length; i++) {
        intraSessionIntervals.push((s.dates[i]!.getTime() - s.dates[i - 1]!.getTime()) / (1000 * 60 * 60));
      }
    }
    const medianIntraSessionGap = intraSessionIntervals.length > 0 ? ss.median(intraSessionIntervals) : undefined;

    // 3. BRANCHING LOGIC: High Frequency vs Session Based

    // --- BRANCH A: HIGH FREQUENCY (News / Bots) ---
    // If median gap between videos is less than SESSION_THRESHOLD hours
    // Use median gap between sessions where available; otherwise fall back
    // to per-video median. This avoids classifying channels with many
    // uploads on the same day (but infrequent sessions) as high-frequency.
    const medianGapForDecision = medianSessionGap ?? medianRawGap;

    // Detect dense sessions (many uploads close together). If sessions contain many
    // videos with short intra-session gaps, treat as high-frequency and poll every 2 hours.
    const medianSessionSize = Math.round(ss.median(sessions.map(s => s.count)));
    const denseSessionDetected = medianIntraSessionGap != null && medianIntraSessionGap < 1 && medianSessionSize >= 3;

    if (medianGapForDecision < this.SESSION_THRESHOLD || denseSessionDetected) {
      // If dense session detected, prefer a 2-hour poll interval to catch bursts.
      const pollInterval = denseSessionDetected ? 2 : Math.max(1.5, medianGapForDecision * 4);
      const nextScrape = addHours(lastVideo!, pollInterval);

      const expectedNumberOfVideos = denseSessionDetected
        ? Math.min(dates.length, medianSessionSize * 1)
        : Math.min(dates.length, Math.round(pollInterval / (medianRawGap || 1)));

      return {
        nextScrapeTime: isAfter(new Date(), nextScrape) ? addHours(new Date(), 1) : nextScrape,
        pattern: denseSessionDetected
          ? `High Frequency (Every ~${pollInterval.toFixed(1)} hrs)`
          : `High Frequency (Every ~${pollInterval.toFixed(1)} hrs)`,
        confidence: denseSessionDetected ? 0.9 : 0.8,
        expectedVideos: expectedNumberOfVideos,
        isErratic: rawIntervals.length > 1 ? ss.standardDeviation(rawIntervals) / ss.mean(rawIntervals) > 1.5 : false
      };
    }

    // --- BRANCH B: SESSION BASED (Standard YouTubers) ---
    const intervals: number[] = [];
    for (let i = 1; i < sessions.length; i++) {
      intervals.push(differenceInHours(sessions[i]!.start, sessions[i - 1]!.start));
    }

    // If only one session detected (initial burst)
    if (intervals.length === 0) {
      return {
        nextScrapeTime: addHours(new Date(), 4),
        pattern: "Initial Burst Detected",
        confidence: 0.2,
        expectedVideos: sessions[0]!.count,
        isErratic: true
      };
    }

    const cleanIntervals = this.capOutliers(intervals);
    const weightedGap = this.calculateEWMA(cleanIntervals);
    const expectedVolume = Math.round(ss.median(sessions.map(s => s.count)));

    // Calculate most common hour for uploads
    const hours = sessions.slice(-15).map(s => s.start.getHours());
    const commonHour = ss.mode(hours);

    // Calculate Confidence based on consistency (coefficient of variation)
    const recentGaps = cleanIntervals.slice(-10);
    const cv = ss.standardDeviation(recentGaps) / ss.mean(recentGaps);
    let confidence = Math.max(0, 1 - cv);

    // Schedule next scrape: predict session time based on pattern + add 2 hour buffer
    const lastSessionDate = sessions[sessions.length - 1]!.start;
    let predictedTime = addHours(lastSessionDate, weightedGap);

    let nextScrape = addHours(predictedTime, 2);

    // Adaptive Backoff: if prediction is in the past, use fallback with increasing intervals
    const now = new Date();
    if (isAfter(now, nextScrape)) {
      const hoursSinceLast = differenceInHours(now, lastVideo!);
      const backoff = Math.min(48, Math.max(4, hoursSinceLast / 12));
      nextScrape = addHours(now, backoff);
    }

    return {
      nextScrapeTime: nextScrape,
      pattern: this.formatPattern(weightedGap, expectedVolume, confidence < 0.45, predictedTime),
      confidence: parseFloat(confidence.toFixed(2)),
      expectedVideos: expectedVolume,
      isErratic: confidence < 0.45
    };
  }

  /**
   * Group consecutive videos within SESSION_THRESHOLD into sessions.
   * Useful for detecting daily upload batches vs scattered uploads.
   */
  private createSessions(dates: Date[]): { start: Date; count: number; dates: Date[] }[] {
    const sessions: { start: Date; count: number; dates: Date[] }[] = [];
    dates.forEach((date, i) => {
      if (i === 0 || differenceInHours(date, dates[i - 1]!) > this.SESSION_THRESHOLD) {
        sessions.push({ start: date, count: 1, dates: [date] });
      } else {
        const last = sessions[sessions.length - 1]!;
        last.count++;
        last.dates.push(date);
      }
    });
    return sessions;
  }

  /**
   * Cap outlier intervals at 90th percentile to reduce impact of long breaks/hiatuses.
   */
  private capOutliers(intervals: number[]): number[] {
    if (intervals.length < 5) return intervals;
    const q90 = ss.quantile(intervals, 0.9);
    return intervals.map(v => v > q90 ? q90 : v);
  }

  /**
   * Exponential Weighted Moving Average: weight recent intervals more heavily.
   */
  private calculateEWMA(data: number[]): number {
    let ema = data[0]!;
    for (let i = 1; i < data.length; i++) {
      ema = (data[i]! * this.ALPHA) + (ema * (1 - this.ALPHA));
    }
    return ema;
  }

  /**
   * Format upload pattern into human-readable description.
   */
  private formatPattern(hours: number, batch: number, erratic: boolean, predictedTime: Date): string {
    const batchText = batch > 1 ? `batch of ${batch}` : "1 video";
    if (erratic) return `Erratic Uploader — ~${hours.toFixed(1)}h avg (${batchText})`;
    return `Every ${hours.toFixed(1)} hours (${batchText})`;
  }

  /**
   * Fallback for insufficient data or errors.
   */
  private fallback(): ScrapePlan {
    return {
      nextScrapeTime: addHours(new Date(), 6),
      pattern: "Analyzing...",
      confidence: 0,
      expectedVideos: 1,
      isErratic: true
    };
  }
}
