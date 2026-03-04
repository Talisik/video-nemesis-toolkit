# Intelligent YouTube Channel Scraping System

## Overview

This document describes the intelligent scheduling system that predicts optimal scraping times based on a channel's upload history, while gracefully handling offline scenarios (PC being off at scheduled scrape time).

## Architecture

The system consists of five main components:

### 1. **YouTubeSmartScheduler** (`intelligentScheduler.ts`)
Analyzes channel upload timestamps and predicts the next optimal scrape time using statistical analysis.

**Key Features:**
- **High-frequency detection**: Identifies news channels, bots that upload constantly
- **Session-based analysis**: Groups consecutive uploads and detects day-of-week patterns
- **Confidence scoring**: Provides a confidence value (0-1) for each prediction
- **Erratic detection**: Flags channels with unpredictable upload patterns
- **Outlier handling**: Caps extreme gaps to reduce impact of long breaks

**Branching Logic:**
```
IF median gap between videos < 3 hours:
  → HIGH FREQUENCY MODE
     Scrape every (median_gap × 4) hours
     Expected videos = calculated from gap
ELSE:
  → SESSION-BASED MODE
     Create sessions from consecutive videos
     Calculate gap between sessions
     Use EWMA weighting for recent patterns
     Predict next session time + 2-hour buffer
```

### 2. **IntelligentScheduleService** (`intelligentScheduleService.ts`)
Manages database operations and coordinates intelligent predictions with the scraper.

**Key Methods:**
- `updateChannelSchedule()` - Analyzes a channel and stores prediction
- `getChannelsDueForScrape()` - Gets channels ready to scrape now
- `getNextScheduledScrapeMs()` - Time until next scheduled scrape
- `handleOfflineScenario()` - **Critical for offline handling**
- `refreshAllSchedules()` - Batch update all predictions

**Offline Handling (`handleOfflineScenario`):**
When the app starts, it:
1. Detects channels that should have been scraped while offline
2. Applies **adaptive backoff** based on how overdue they are:
   - Most overdue (1st): Scrape in 2 minutes
   - Next batch (2-5): Stagger over 15 minutes  
   - Rest (6+): Spread over next 2 hours
3. Prevents system hammering from queuing everything immediately
4. Prioritizes high-value channels (confidence-weighted)

### 3. **Database Schema** (`schema.ts`)
New table: `intelligent_schedule`

```sql
CREATE TABLE intelligent_schedule (
  channel_id INTEGER PRIMARY KEY,
  next_scrape_time TEXT NOT NULL,           -- ISO datetime for next scrape
  pattern TEXT NOT NULL,                    -- Human-readable pattern ("Daily", "Every 3 days", etc)
  confidence REAL NOT NULL,                 -- 0-1 confidence in prediction
  expected_videos INTEGER NOT NULL,         -- Expected # of new videos
  is_erratic INTEGER NOT NULL,              -- Boolean: unpredictable pattern
  analysis_basis_count INTEGER NOT NULL DEFAULT 0,  -- # of videos analyzed
  updated_at TEXT NOT NULL,                 -- Last prediction update time
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
```

### 4. **Scraper Integration** (modified `workers/scraper-worker/index.ts`)

**Modified Methods:**
- `start()` - Now calls `handleOfflineScenario()` on startup
- `runScheduleLoop()` - Checks **both** intelligent schedule and traditional slots
- `getChannelsToScrape()` - **Prioritizes** intelligent schedule, falls back to slots
- `scrapeChannel()` - After gathering analysis videos, updates intelligent schedule

**Schedule Priority:**
```
1. Check intelligent_schedule for due channels
   └─ Filter out recently-scraped
   └─ If found, return those channels
2. Fallback to traditional slot/interval logic
   └─ Check day_of_week + time_minutes slots
   └─ Check interval-based due channels
3. Return all applicable channels
```

### 5. **Data Access Layer** (`data/intelligentSchedules.ts`)

Public methods for querying predictions:
- `getChannelSchedule()` - Single channel
- `getChannelSchedules()` - Multiple channels
- `getAllSchedules()` - All channels
- `getUpcomingScrapes()` - Next N hours
- `getOverdueScrapes()` - Missed predictions
- `getScheduleStats()` - Aggregate stats

## IPC Channels

New Electron IPC channels for the renderer:

```typescript
INTELLIGENT_SCHEDULE_GET          // Get prediction for one channel
INTELLIGENT_SCHEDULE_GET_UPCOMING // Get next 24 hours of scrapes
INTELLIGENT_SCHEDULE_GET_OVERDUE  // Get missed scrapes
INTELLIGENT_SCHEDULE_GET_STATS    // Get pattern stats (avg confidence, etc)
INTELLIGENT_SCHEDULE_REFRESH_ALL  // Force recompute all predictions
```

## Workflow: A Day in the Life

### Scenario 1: Normal Online Operation

```
1. App Starts
   → handleOfflineScenario() runs (finds nothing overdue)
   → runScheduleLoop() begins
   
2. Every ~minute (or on demand)
   → getChannelsDueForScrape() checks intelligent_schedule
   → "Gaming Channel" due now (predicted 3 hours after last vid)
   → Scraper fetches latest videos
   
3. Videos arrived for "Gaming Channel"
   → updateChannelSchedule("Gaming Channel")
   → Analyzes new timestamps
   → Predicts next scrape in 2.5 hours
   → Updates intelligent_schedule with new next_scrape_time
   
4. runScheduleLoop() calculates next wake-up
   → getNextScheduledScrapeMs() → "2.5 hours"
   → Sleeps 2.5 hours
   → Wakes up, repeats from step 2
```

### Scenario 2: PC Offline at Scheduled Time

```
Scheduled scrape for "News Channel": 14:00 (2 PM)
PC off from 13:30 to 19:30 (6 hours)

Upon Restart (19:30):
   → start() called
   → handleOfflineScenario() runs
   → Finds "News Channel" was due at 14:00 (5.5 hours ago!)
   
   Adaptive Backoff Applied:
   → "News Channel" (most overdue):
        next_scrape_time = NOW + 2 minutes
   → [If 4+ other channels also overdue, stagger them]
   
19:32: Scraper wakes up, scrapes "News Channel"
       Uploads found! Pattern updated.
       
If 10 channels were overdue:
   - Ch. 1: 19:32 (2 min)
   - Ch. 2: 19:37 (7 min)
   - Ch. 3: 19:42 (12 min)
   - Ch. 4-5: 19:47-19:52 (17-22 min)
   - Ch. 6-10: 19:52-20:02 (22-32 min)
```

### Scenario 3: Sync with Slot-Based Schedule

```
Channel has BOTH:
- Intelligent schedule: Next scrape in 3 days
- Slot-based: Every Monday at 10 AM (if overdue)

runScheduleLoop():
  1. Check intelligent → "3 days away"
  2. Check slots → "Monday 10 AM is NOW (past due)"
  3. Use MIN(3 days, now) → Scrape NOW
  4. After scrape, intelligent schedule is updated
```

## Integration Points

### Adding a New Channel

```
User creates channel → no analysis videos yet
→ updateChannelSchedule() finds < 3 videos
→ Sets fallback: "Analyzing..." pattern, scrape in 6 hours
→ First scrape collects history
→ updateChannelSchedule() now has data
→ Generates real prediction
```

### Periodically Refresh Predictions

```
// Can be called from IPC or as background task
INTELLIGENT_SCHEDULE_REFRESH_ALL
→ refreshAllSchedules()
→ Updates ALL channels with latest analysis
→ Useful after 1 week of history for each channel
```

### UI Display Example

```typescript
// Get upcoming scrapes for next 24 hours
const upcoming = await ipc.invoke(
  'toolkit:intelligentSchedule:getUpcoming',
  24
);

upcoming.forEach(schedule => {
  console.log(`${channel.name}: ${schedule.pattern}`);
  console.log(`  Next: ${schedule.next_scrape_time}`);
  console.log(`  Confidence: ${(schedule.confidence * 100).toFixed(0)}%`);
  console.log(`  Expected: ${schedule.expected_videos} videos`);
  console.log(`  Erratic: ${schedule.is_erratic ? 'Yes' : 'No'}`);
});
```

## Configuration

The intelligent scheduler works automatically with no required configuration. However, you can tune behavior:

### In `YouTubeSmartScheduler`:
```typescript
private readonly SESSION_THRESHOLD = 3;    // Hours between uploads for new session
private readonly MAX_HISTORY = 100;        // Max videos to analyze per channel
private readonly ALPHA = 0.4;              // EWMA weighting (higher = recent bias)
```

### In `IntelligentScheduleService`:
```typescript
// handleOfflineScenario() backoff timing
// Adjust if you want less/more aggressive staggering
2 minutes      // Most overdue
5 + index × 3  // Next batch (5, 8, 11, 14, 17...)
15 + (index-5) * 5  // Remaining (20, 25, 30...)
```

## Performance Considerations

- **Analysis**: Full analysis runs only:
  - After new videos arrive (on each scrape)
  - On manual `refreshAllSchedules()` call
  - Takes ~1ms per 50 videos = negligible

- **Database**: `intelligent_schedule` table is tiny (one row per channel)
  - Query to find due channels: O(num_channels)
  - Storage: ~500 bytes per channel

- **Offline Handling**: Runs once on app startup
  - Staggered scheduling prevents thundering herd

## Fallback Behavior

If anything goes wrong:
```
1. Insufficient data (< 3 videos) → Fallback schedule in 6 hours
2. Analysis error → Fallback schedule, still scrape on intervals
3. No intelligent schedule set → Use traditional slot/interval logic
4. No schedules at all (intelligent + slots) → No scraping (user can force runOnce)
```

## Future Enhancements

1. **Machine Learning**: Replace statistics with neural net for pattern recognition
2. **Custom backoff**: Let users set their preferred offline recovery strategy
3. **Batch optimization**: Predict when 5+ channels will be due, batch request
4. **Seasonal patterns**: Detect "channel goes dark in summer" etc.
5. **Collaborative filtering**: "Channels like this typically upload 2x/week"

---

**Last Updated**: March 4, 2026
**Version**: 1.0 (Initial intelligent scheduling implementation)
