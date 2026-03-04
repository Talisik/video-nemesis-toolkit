import Database from "better-sqlite3";

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
 * Get intelligent schedule for a specific channel.
 */
export function getChannelSchedule(
  db: Database.Database,
  channelId: number
): IntelligentScheduleRow | null {
  try {
    const stmt = db.prepare(`
      SELECT * FROM intelligent_schedule WHERE channel_id = ?
    `);
    return (stmt.get(channelId) as IntelligentScheduleRow | undefined) ?? null;
  } catch (error) {
    console.error(`[intelligent-schedule-data] Error getting schedule for channel ${channelId}:`, error);
    return null;
  }
}

/**
 * Get intelligent schedules for multiple channels.
 */
export function getChannelSchedules(
  db: Database.Database,
  channelIds: number[]
): IntelligentScheduleRow[] {
  if (channelIds.length === 0) return [];
  try {
    const placeholders = channelIds.map(() => "?").join(",");
    const stmt = db.prepare(`
      SELECT * FROM intelligent_schedule WHERE channel_id IN (${placeholders})
      ORDER BY next_scrape_time ASC
    `);
    return stmt.all(...channelIds) as IntelligentScheduleRow[];
  } catch (error) {
    console.error("[intelligent-schedule-data] Error getting schedules:", error);
    return [];
  }
}

/**
 * Get all intelligent schedules ordered by next scrape time.
 */
export function getAllSchedules(db: Database.Database): IntelligentScheduleRow[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM intelligent_schedule
      ORDER BY next_scrape_time ASC
    `);
    return stmt.all() as IntelligentScheduleRow[];
  } catch (error) {
    console.error("[intelligent-schedule-data] Error getting all schedules:", error);
    return [];
  }
}

/**
 * Get upcoming scrapes (channels due within the next N hours).
 */
export function getUpcomingScrapes(
  db: Database.Database,
  hoursAhead: number = 24
): IntelligentScheduleRow[] {
  try {
    const futureTime = new Date();
    futureTime.setHours(futureTime.getHours() + hoursAhead);
    const stmt = db.prepare(`
      SELECT * FROM intelligent_schedule
      WHERE next_scrape_time > datetime('now')
        AND next_scrape_time <= ?
      ORDER BY next_scrape_time ASC
    `);
    return stmt.all(futureTime.toISOString()) as IntelligentScheduleRow[];
  } catch (error) {
    console.error("[intelligent-schedule-data] Error getting upcoming scrapes:", error);
    return [];
  }
}

/**
 * Get overdue scrapes (channels that should have been scraped but weren't).
 */
export function getOverdueScrapes(db: Database.Database): IntelligentScheduleRow[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM intelligent_schedule
      WHERE next_scrape_time < datetime('now')
      ORDER BY next_scrape_time ASC
    `);
    return stmt.all() as IntelligentScheduleRow[];
  } catch (error) {
    console.error("[intelligent-schedule-data] Error getting overdue scrapes:", error);
    return [];
  }
}

/**
 * Get schedule statistics: average confidence, erratic count, etc.
 */
export function getScheduleStats(db: Database.Database): {
  total: number;
  avgConfidence: number;
  erraticCount: number;
  avgExpectedVideos: number;
} {
  try {
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total,
        ROUND(AVG(confidence), 2) as avg_confidence,
        SUM(CASE WHEN is_erratic = 1 THEN 1 ELSE 0 END) as erratic_count,
        ROUND(AVG(expected_videos), 1) as avg_expected_videos
      FROM intelligent_schedule
    `);
    const result = stmt.get() as {
      total: number;
      avg_confidence: number;
      erratic_count: number;
      avg_expected_videos: number;
    };
    return {
      total: result.total,
      avgConfidence: result.avg_confidence ?? 0,
      erraticCount: result.erratic_count ?? 0,
      avgExpectedVideos: result.avg_expected_videos ?? 0,
    };
  } catch (error) {
    console.error("[intelligent-schedule-data] Error getting stats:", error);
    return { total: 0, avgConfidence: 0, erraticCount: 0, avgExpectedVideos: 0 };
  }
}
