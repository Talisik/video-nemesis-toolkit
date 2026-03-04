import type Database from "better-sqlite3";
import { YouTubeSmartScheduler, type ScrapePlan } from "./intelligentScheduler.js";

export interface IntelligentScheduleRow {
  channel_id: number;
  next_scrape_time: string;
  pattern: string;
  confidence: number;
  expected_videos: number;
  is_erratic: number;
  analysis_basis_count: number;
  updated_at: string;
}

/**
 * Service to manage channel scraping predictions using intelligent analysis.
 * Handles offline scenarios by checking for missed scrapes on app startup.
 */
export class IntelligentScheduleService {
  private scheduler = new YouTubeSmartScheduler();

  /**
   * Analyze raw timestamps and return a prediction plan.
   * Useful for quick preview without saving to DB.
   */
  public analyzeTimestamps(unixTimestamps: number[]): ScrapePlan {
    return this.scheduler.analyze(unixTimestamps);
  }

  /**
   * Analyze a channel's upload history and update its intelligent schedule.
   * Called when adding a channel or periodically to refresh predictions.
   */
  public updateChannelSchedule(db: Database.Database, channelId: number): boolean {
    try {
      // Fetch all release timestamps for this channel from analysis videos
      const stmt = db.prepare(`
        SELECT release_timestamp 
        FROM channel_analysis_videos 
        WHERE channel_id = ? 
        ORDER BY release_timestamp ASC
      `);
      const rows = stmt.all(channelId) as { release_timestamp: number }[];

      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] updateChannelSchedule channel=${channelId} found ${rows.length} analysis videos`);

      if (rows.length < 3) {
        // Insufficient data - set conservative fallback
        if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] insufficient data, setting fallback`);
        this.setFallbackSchedule(db, channelId);
        return false;
      }

      const timestamps = rows.map(r => r.release_timestamp);
      const plan = this.scheduler.analyze(timestamps);
      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] scheduler plan:`, plan);

      // Store the prediction
      const updateStmt = db.prepare(`
        INSERT INTO intelligent_schedule 
        (channel_id, next_scrape_time, pattern, confidence, expected_videos, is_erratic, analysis_basis_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          next_scrape_time = excluded.next_scrape_time,
          pattern = excluded.pattern,
          confidence = excluded.confidence,
          expected_videos = excluded.expected_videos,
          is_erratic = excluded.is_erratic,
          analysis_basis_count = excluded.analysis_basis_count,
          updated_at = excluded.updated_at
      `);

      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] inserting into intelligent_schedule: channel=${channelId} nextScrapeTime=${plan.nextScrapeTime.toISOString()} pattern=${plan.pattern} confidence=${plan.confidence} expectedVideos=${plan.expectedVideos} isErratic=${plan.isErratic} analysisBasisCount=${timestamps.length}`);

      updateStmt.run(
        channelId,
        plan.nextScrapeTime.toISOString(),
        plan.pattern,
        plan.confidence,
        plan.expectedVideos,
        plan.isErratic ? 1 : 0,
        timestamps.length,
        new Date().toISOString()
      );

      if (process.env.DEBUG_SCHEDULE) console.log(`[DEBUG_SCHEDULE] insertion complete`);

      return true;
    } catch (error) {
      console.error(`[intelligent-schedule] Error analyzing channel ${channelId}:`, error);
      this.setFallbackSchedule(db, channelId);
      return false;
    }
  }

  /**
   * Get next channels due for scraping based on intelligent schedule.
   * Takes into account that app may have been offline and checks for overdue scrapes.
   */
  public getChannelsDueForScrape(db: Database.Database): number[] {
    const now = new Date();
    const nowISO = now.toISOString();

    try {
      const stmt = db.prepare(`
        SELECT c.id, c.last_scraped_at, ischd.next_scrape_time, ischd.confidence
        FROM channels c
        LEFT JOIN intelligent_schedule ischd ON c.id = ischd.channel_id
        WHERE c.active = 1
          AND ischd.next_scrape_time IS NOT NULL
          AND ischd.next_scrape_time <= ?
        ORDER BY ischd.next_scrape_time ASC, ischd.confidence DESC
      `);

      const rows = stmt.all(nowISO) as {
        id: number;
        last_scraped_at: string | null;
        next_scrape_time: string;
        confidence: number;
      }[];

      return rows.map(r => r.id);
    } catch (error) {
      console.error("[intelligent-schedule] Error getting due channels:", error);
      return [];
    }
  }

  /**
   * Get the earliest next scrape time across all channels.
   * Used by scheduler to know when to wake up next.
   */
  public getNextScheduledScrapeMs(db: Database.Database): number | null {
    try {
      const stmt = db.prepare(`
        SELECT next_scrape_time
        FROM intelligent_schedule
        WHERE next_scrape_time IS NOT NULL
        ORDER BY next_scrape_time ASC
        LIMIT 1
      `);

      const row = stmt.get() as { next_scrape_time: string } | undefined;
      if (!row) return null;

      const nextTime = new Date(row.next_scrape_time);
      const now = new Date();
      const diffMs = nextTime.getTime() - now.getTime();

      return Math.max(0, diffMs);
    } catch (error) {
      console.error("[intelligent-schedule] Error getting next schedule:", error);
      return null;
    }
  }

  /**
   * Called on app startup to detect and handle missed scrapes.
   * If a channel was due while app was offline, apply adaptive backoff.
   */
  public handleOfflineScenario(db: Database.Database): void {
    try {
      // Find channels that were due but not recently scraped
      const now = new Date();
      const nowISO = now.toISOString();

      const overdueStmt = db.prepare(`
        SELECT c.id, c.last_scraped_at, ischd.next_scrape_time
        FROM channels c
        JOIN intelligent_schedule ischd ON c.id = ischd.channel_id
        WHERE c.active = 1
          AND ischd.next_scrape_time < ?
          AND (c.last_scraped_at IS NULL 
               OR datetime(c.last_scraped_at) < datetime(ischd.next_scrape_time))
        ORDER BY ischd.next_scrape_time DESC
      `);

      const overdue = overdueStmt.all(nowISO) as {
        id: number;
        last_scraped_at: string | null;
        next_scrape_time: string;
      }[];

      if (overdue.length > 0) {
        console.log(`[intelligent-schedule] Found ${overdue.length} overdue channels after offline period`);

        // Apply adaptive backoff: schedule immediate scrape for the most overdue
        // Others get scheduled progressively to avoid hammering the system
        const updateStmt = db.prepare(`
          UPDATE intelligent_schedule 
          SET next_scrape_time = ? 
          WHERE channel_id = ?
        `);

        overdue.forEach((ch, index) => {
          let nextScrape: Date;
          if (index === 0) {
            // Most overdue: scrape in 2 minutes
            nextScrape = new Date(now.getTime() + 2 * 60 * 1000);
          } else if (index < 5) {
            // Next batch: within 15 minutes
            nextScrape = new Date(now.getTime() + (5 + index * 3) * 60 * 1000);
          } else {
            // Rest: stagger over next 2 hours
            const offset = 15 + (index - 5) * 5;
            nextScrape = new Date(now.getTime() + Math.min(120, offset) * 60 * 1000);
          }

          updateStmt.run(nextScrape.toISOString(), ch.id);
        });

        console.log("[intelligent-schedule] Applied offline backoff scheduling");
      }
    } catch (error) {
      console.error("[intelligent-schedule] Error handling offline scenario:", error);
    }
  }

  /**
   * Get prediction data for a specific channel.
   */
  public getChannelSchedule(db: Database.Database, channelId: number): IntelligentScheduleRow | null {
    try {
      const stmt = db.prepare(`
        SELECT * FROM intelligent_schedule WHERE channel_id = ?
      `);
      return stmt.get(channelId) as IntelligentScheduleRow | undefined ?? null;
    } catch (error) {
      console.error("[intelligent-schedule] Error getting channel schedule:", error);
      return null;
    }
  }

  /**
   * Refresh predictions for all active channels with analysis videos.
   * Can be expensive, so run sparingly or in background.
   */
  public refreshAllSchedules(db: Database.Database): number {
    try {
      // Get all channels with analysis videos
      const stmt = db.prepare(`
        SELECT DISTINCT channel_id FROM channel_analysis_videos
      `);
      const channels = stmt.all() as { channel_id: number }[];

      let updated = 0;
      for (const ch of channels) {
        if (this.updateChannelSchedule(db, ch.channel_id)) {
          updated++;
        }
      }

      return updated;
    } catch (error) {
      console.error("[intelligent-schedule] Error refreshing all schedules:", error);
      return 0;
    }
  }

  /**
   * Manually set a channel to fallback schedule (6 hours from now).
   */
  private setFallbackSchedule(db: Database.Database, channelId: number): void {
    try {
      const nextScrape = new Date();
      nextScrape.setHours(nextScrape.getHours() + 6);

      const stmt = db.prepare(`
        INSERT INTO intelligent_schedule 
        (channel_id, next_scrape_time, pattern, confidence, expected_videos, is_erratic, analysis_basis_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          next_scrape_time = excluded.next_scrape_time,
          pattern = excluded.pattern,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `);

      stmt.run(
        channelId,
        nextScrape.toISOString(),
        "Insufficient data",
        0,
        1,
        1,
        0,
        new Date().toISOString()
      );
    } catch (error) {
      console.error(`[intelligent-schedule] Error setting fallback for channel ${channelId}:`, error);
    }
  }
}
