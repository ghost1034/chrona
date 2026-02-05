# Chrona Cross-Platform Description

This document describes a clean, cross‑platform reimplementation of Chrona that preserves the *behavioral* outputs of the current macOS app (screen → observations → timeline cards + review + export + retry + timelapse), while intentionally **not** copying macOS‑specific quirks or questionable practices.

## Constraints (from requirements)

- **Desktop app framework:** Electron.
- **Capture API:** `desktopCapturer` (periodic screenshots).
- **LLM:** **Gemini only** (no local models; no GPT; no Claude).
- **No Journal feature:** no journal UI, no journal reminders, no journal gating, no journal tables.
- **Match functionality:** timeline generation, review workflow, retry workflow, export/copy, storage retention, timelapses (optional but supported), tray/menu‑bar behavior, deep links.

---

## 1) Product Behavior Overview

### What the app does
1. **Records screen context** as periodic screenshots (default every 10s).
2. **Persists** screenshots to disk + metadata to SQLite.
3. **Batches** unprocessed screenshots into time windows (Gemini tuned).
4. **Calls Gemini** to:
   - transcribe screenshots into **observations** (timestamped),
   - generate **timeline cards** (activities) using a **sliding 1‑hour window** for stability.
5. **Renders a timeline UI** (4 AM → 4 AM logical day) with category editing, right‑panel detail, day summary, and review overlay.
6. **Generates timelapse clips** for cards (derived from screenshots).
7. **Supports retry** for failed batches and **export/copy** to Markdown.

### Key invariants to preserve
- **Batching rules:** Gemini batching defaults to *target 30m*, *max gap 5m*, drop trailing incomplete batch.
- **Analysis cadence:** check every 60s; look back 24h.
- **Card generation:** generate cards from **last hour of observations**, replace overlapping cards atomically.
- **Day boundary:** timeline day is **4 AM to 4 AM** in local timezone.
- **Error surfacing:** failures produce a **System/Error** card spanning that batch.
- **Review model:** independent rating segments (focus/neutral/distracted) stored by time range; “reviewed” means coverage ≥ 80%.

---

## 2) Architecture

### Process model
- **Main process (Node/Electron):**
  - Capture scheduler (screenshots via `desktopCapturer`)
  - Storage service (SQLite + filesystem)
  - Analysis scheduler + batch queue
  - Gemini client + request logging
  - Timelapse worker orchestration
  - Tray/menu bar + deep link routing
  - IPC API (typed)
- **Renderer process (UI):**
  - Timeline UI, review overlay, settings, export flows, debug log copy
- **Worker(s):**
  - Timelapse rendering (ffmpeg spawn)
  - Optional: heavy image/video preprocessing for Gemini (to keep main responsive)

### Recommended repo layout (TypeScript)

/src
/main
app.ts
ipc.ts
tray.ts
deeplinks.ts
capture/
analysis/
storage/
gemini/
timelapse/
/renderer
ui/
state/
pages/
/shared
types.ts
schema.ts
time.ts
### IPC design goals
- **No direct DB access from renderer.**
- **Typed request/response** IPC (e.g., `ipcMain.handle(...)`) + event streams (e.g., “recordingStateChanged”).
- **Backpressure-aware** for timeline updates (debounce refreshes; emit day keys).

---

## 3) Storage Design

### On-disk layout
Use Electron’s `app.getPath('userData')` as the root (portable across OSes).

\<userData\>/
db/chrona.sqlite
recordings/screenshots/YYYY-MM-DD/\<timestamp\>.jpg
timelapses/YYYY-MM-DD/\<timeline_card_id\>.mp4
logs/app.log (optional)

### SQLite pragmas (safe defaults)
- `journal_mode = WAL`
- `synchronous = NORMAL`
- `busy_timeout = 5000`
- `foreign_keys = ON`

### Schema (journal-free)
This mirrors the macOS data model *without* journal tables. Prefer storing **relative file paths** (safer for migrations) and a stable `userDataRoot` resolution in code.

```sql
-- screenshots: periodic screen captures
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,              -- unix seconds
  file_path TEXT NOT NULL,                   -- relative path under userData
  file_size INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at);

-- analysis_batches: groups screenshots for Gemini processing
CREATE TABLE IF NOT EXISTS analysis_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_start_ts INTEGER NOT NULL,
  batch_end_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|processing|analyzed|failed|skipped_*
  reason TEXT,
  llm_metadata TEXT,
  detailed_transcription TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_batches_status ON analysis_batches(status);

-- batch_screenshots: join table (batch -> screenshots)
CREATE TABLE IF NOT EXISTS batch_screenshots (
  batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, screenshot_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_screenshots_screenshot ON batch_screenshots(screenshot_id);

-- observations: Gemini transcription output
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  observation TEXT NOT NULL,
  metadata TEXT,
  llm_model TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_observations_batch_id ON observations(batch_id);
CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);

-- timeline_cards: activity summaries
CREATE TABLE IF NOT EXISTS timeline_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
  start TEXT NOT NULL,                       -- display clock string "h:mm a" (optional)
  end TEXT NOT NULL,                         -- display clock string "h:mm a" (optional)
  start_ts INTEGER NOT NULL,                 -- canonical
  end_ts INTEGER NOT NULL,                   -- canonical
  day DATE NOT NULL,                         -- yyyy-mm-dd with 4AM boundary
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,
  detailed_summary TEXT,
  metadata TEXT,                             -- JSON: {distractions?, appSites?}
  video_summary_url TEXT,                    -- relative path under userData (optional)
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_start_ts
  ON timeline_cards(start_ts) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_batch
  ON timeline_cards(batch_id) WHERE is_deleted = 0;

-- timeline_review_ratings: time-based review segments
CREATE TABLE IF NOT EXISTS timeline_review_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  rating TEXT NOT NULL CHECK(rating IN ('focus','neutral','distracted'))
);
CREATE INDEX IF NOT EXISTS idx_review_ratings_time ON timeline_review_ratings(start_ts, end_ts);

-- llm_calls: request/response logging for debugging (sanitized)
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  batch_id INTEGER NULL,
  call_group_id TEXT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,                    -- always "gemini"
  model TEXT NULL,
  operation TEXT NOT NULL,                   -- "transcribe"|"generate_cards"|...
  status TEXT NOT NULL CHECK(status IN ('success','failure')),
  latency_ms INTEGER NULL,
  http_status INTEGER NULL,
  request_method TEXT NULL,
  request_url TEXT NULL,
  request_headers TEXT NULL,
  request_body TEXT NULL,
  response_headers TEXT NULL,
  response_body TEXT NULL,
  error_domain TEXT NULL,
  error_code INTEGER NULL,
  error_message TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_group ON llm_calls(call_group_id, attempt);
CREATE INDEX IF NOT EXISTS idx_llm_calls_batch ON llm_calls(batch_id);
```

### Category model

Persist categories as JSON in a small settings table or a single JSON file in \<userData\>/settings.json. Default set:

- Work
- Personal
- Distraction
- Idle (system, special rule: “use when idle for most of the period”)

Keep category IDs stable (UUID) to make prompt constraints reliable.

---

## 4) Capture Pipeline (desktopCapturer)

### Goals

- Periodic screenshots at a configurable interval (default 10s).
- Choose display based on:
    1. user-selected display, else
    2. active display under cursor, with debounce/hysteresis to avoid flapping.
- Handle OS sleep/lock gracefully (“system pause”).
- Keep capture work efficient and non-blocking.

### Implementation outline

- Capture loop runs in main process:
    - setInterval or a drift-correcting scheduler to avoid timer accumulation.
    - On each tick:
        1. Determine target display ID
        2. Call desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
        3. Pick matching source.display_id
        4. Convert source.thumbnail → JPEG bytes
        5. Write file + insert DB row

### Screenshot format + scaling

- Target roughly 1080p height to control storage and Gemini cost.
- Use thumbnailSize and/or post-resize using nativeImage.resize(...).
- JPEG quality ~0.85 (tunable).

### Cursor inclusion (optional)

Electron thumbnails typically don’t include the cursor consistently. To approximate the macOS behavior:

- Capture cursor position via screen.getCursorScreenPoint().
- Map cursor point into display-relative coordinates and draw a cursor glyph onto the image before JPEG encoding.
- Make this a toggle (“Include cursor in captures”).

### Permission + failure modes

- macOS: screen capture requires Screen Recording permission. Detect failure by:
    - getSources throws, or
    - thumbnails are empty/black repeatedly.
      Show a blocking onboarding step explaining how to enable permission.
- Windows/Linux: screen capture generally works; still handle “no sources” and transient failures.

### Pause model (user pause vs system pause)

Track two states:

- desiredRecordingEnabled (user intent)
- isSystemPaused (sleep/lock/suspend)

Rules:

- User pause sets desiredRecordingEnabled = false.
- Lock/suspend sets isSystemPaused = true and stops capture, but does not change user intent.
- Resume/unlock clears system pause and restarts capture if desiredRecordingEnabled is true.

Electron hooks:

- powerMonitor.on('suspend'|'resume')
- powerMonitor.on('lock-screen'|'unlock-screen') (where supported)

### Active display tracking

- Poll cursor position at ~0.1 Hz (every 10s) or on each capture tick.
- Apply hysteresis: don’t switch displays unless cursor remains on a new display for N seconds (e.g., 3–5s).

---

## 5) Storage Retention & Cleanup

### Storage limits

- Default recordings limit: 10 GB
- Default timelapses limit: 10 GB
- Expose settings + “Purge now” button.

### Purge strategy

Run hourly:

1. Compute total bytes for active screenshot files.
2. If above limit, delete oldest screenshots in bounded batches (e.g., 500 per pass):
    - Mark DB rows is_deleted = 1
    - Delete files on disk
3. “Stragglers” cleanup:
    - Scan recordings directory for files not referenced by any non-deleted DB row and delete them.

Same for timelapses (separate directory and accounting).

---

## 6) Analysis Scheduling & Batching

### Scheduler cadence

- Every 60s, run analysis tick.
- Only consider last 24h of screenshots (bounded backlog).

### “Unprocessed screenshots”

Definition: screenshots that are:

- within lookback window,
- not deleted,
- not already linked in batch_screenshots.

### Batch construction (Gemini)

Config:

- targetDuration = 30m
- maxGap = 5m

Algorithm:

- Sort screenshots by captured_at
- Build batches by appending while:
    - gap ≤ maxGap, and
    - batch duration ≤ targetDuration
- Drop the most recent batch if its duration < targetDuration (“incomplete tail”)

Persist:

- Insert row into analysis_batches (start/end)
- Insert join rows into batch_screenshots

Skip rules (match behavior):

- Empty → failed_empty
- Duration < 5m → skipped_short

---

## 7) Gemini Pipeline (Screenshots → Observations → Timeline Cards)

### Core idea

Use Gemini in two steps:

1. Transcribe the screenshot sequence into timestamped observations.
2. Generate timeline cards from a sliding last-hour window of observations for smoother updates.

### Step 1: Transcription (screenshots → observations)

Preferred approach (matches existing behavior conceptually): build a “compressed timeline” video:

- 1 fps video where each frame corresponds to one screenshot.
- Upload video to Gemini.
- Ask for JSON observations with timestamps in video time (MM:SS).
- Expand timestamps back to real time using screenshotIntervalSeconds.

#### Transcription prompt contract (example)

Input:

- Video file (compressed timeline)
- Config: screenshotIntervalSeconds
  Output JSON:

{
  "observations": [
    {
      "start": "00:00",
      "end": "00:12",
      "observation": "User is editing code in VS Code and referencing documentation in a browser tab.",
      "appSites": { "primary": "github.com", "secondary": "developer.mozilla.org" }
    }
  ]
}

Expansion:

- realStartTs = batchStartTs + parse(start) * screenshotIntervalSeconds
- realEndTs   = batchStartTs + parse(end)   * screenshotIntervalSeconds
- Clamp to [batchStartTs, batchEndTs]

Persist each observation in observations.

#### Resilience

- Retry with exponential backoff on transient HTTP errors.
- Model fallback within Gemini (e.g., prefer a fast model; fallback to a more capable one on repeated failures).
- Hard cap on attempts per batch; on failure create System/Error card.

### Step 2: Card generation (observations → cards) with sliding window

For each processed batch, define:

- currentTime = batch_end_ts
- windowStart = currentTime - 3600 (last hour)

Load:

- All observations overlapping [windowStart, currentTime]
- Existing non-System cards overlapping that window (context)
- Category descriptors (including Idle guidance)

Ask Gemini for timeline cards.

#### Card output contract

{
  "cards": [
    {
      "startTime": "2:10 PM",
      "endTime": "2:35 PM",
      "category": "Work",
      "subcategory": "Coding",
      "title": "Implementing capture scheduler",
      "summary": "Worked on the screenshot capture loop and error handling.",
      "detailedSummary": "Adjusted drift correction, added system pause logic, and tested multi-monitor selection.",
      "appSites": { "primary": "github.com", "secondary": "docs.google.com" },
      "distractions": []
    }
  ]
}

### Step 3: Atomic replace in DB (soft-delete + insert)

Implement replaceTimelineCardsInRange(fromTs, toTs, newCards, batchId):

1. Soft-delete overlapping cards where:
    - is_deleted = 0, and
    - (category != 'System' OR batch_id = currentBatchId) (preserve unrelated System cards)
2. Insert new cards (populate start_ts/end_ts/day/metadata).
3. Return prior video_summary_urls for deleted cards so timelapses can be removed.

Better practice vs macOS: treat start_ts/end_ts as canonical; derive start/end display strings at insert time (local tz). Avoid storing “clock-only” strings as the source of truth.

### Error path: System/Error card

On any failure:

- Set batch status = failed
- Insert a single card:
    - category = 'System'
    - subcategory = 'Error'
    - title = 'Processing failed'
    - spans the batch time range
- Replace cards only within that batch range (so the failure is visible and retryable)

---

## 8) Timelapse Generation (per card)

### Behavior

After card insertion, generate a timelapse video for each card:

1. Query card [start_ts, end_ts]
2. Load screenshots in that interval
3. Create MP4 in timelapses/YYYY-MM-DD/\<cardId\>.mp4
4. Update timeline_cards.video_summary_url

Suggested settings (align with current intent):

- output fps: 2
- “compressed timeline” assumption: with 10s screenshots, 2 fps yields ~20× time compression at 1× playback.

### Implementation

- Use a worker that spawns ffmpeg (bundled or user-provided).
- Build a concat list file to preserve correct frame timing even if some screenshots are missing.

---

## 9) UI/UX Spec (Electron Renderer)

### App shell

- Tray/menu-bar app with optional main window.
- Closing the window keeps the app running (standard cross-platform behavior); explicit “Quit” exits.

Tray menu items:

- Start/Stop Recording (or Pause/Resume)
- Open Chrona
- Open Recordings Folder
- Settings
- Quit

### Main window navigation (journal removed)

Tabs/pages:

- Timeline (primary)
- Review (overlay entry from Timeline is fine)
- Settings
- Feedback / Debug (optional but matches current “bug report” utility intent)

### Timeline view

- Day selector based on 4 AM boundary:
    - “Today” is the day whose window contains now in [4:00, 28:00)
- Vertical timeline grid 4 AM → 4 AM
- Cards positioned by start_ts/end_ts
- Current time indicator when viewing Today
- Selecting a card opens right panel:
    - title, time range, category pill, summary, detailed summary
    - timelapse preview if available
    - category change dropdown

Overlap handling:

- Prefer preventing overlaps in generation via validation.
- If overlaps exist, apply a display-only overlap mitigation (trim larger cards) without mutating DB.

### Review overlay (focus/neutral/distracted)

- Load cards for the day (exclude System)
- Load rating segments for the day
- Compute coverage per card; show only those < 80% covered
- Interactions:
    - drag gesture, keyboard shortcuts, buttons
- Persist via applyReviewRating(startTs, endTs, rating):
    - delete overlaps, reinsert left/right fragments, insert new segment
    - recommended improvement: coalesce adjacent segments of same rating to reduce fragmentation

### Day summary panel

When no card is selected:

- total time per category
- reviewed vs unreviewed count
- optional “your day so far” textual summary (computed locally from cards; no extra LLM calls unless explicitly triggered)

### Export & copy

- Copy a day to clipboard (Markdown-ish text)
- Export date range to Markdown file (save dialog)
- Formatting matches current outputs:
    - day header
    - numbered entries with time range — title
    - optional Summary / Details blocks
    - category metadata line

### Debug logs (privacy-safe)

Provide “Copy debug logs” that includes:

- recent timeline cards (metadata redacted if needed)
- recent analysis batches
- recent llm_calls (sanitized; no API keys; optionally omit response bodies unless user opts in)

---

## 10) Deep Links / Automation

Register protocol chrona://:

- chrona://start-recording
- chrona://stop-recording
- chrona://pause-recording (optional)
- chrona://resume-recording (optional)

Route in main process and call capture state transitions.

---

## 11) Security & Privacy

### Sensitive data

- Screenshots are inherently sensitive. Treat the app as a “local vault” by default.

### API key storage

- Store Gemini API key in OS credential store via keytar:
    - macOS Keychain
    - Windows Credential Manager
    - Linux Secret Service

### Network minimization

- Only Gemini calls are required.
- Do not fetch favicons by default (leaks browsing domains). If enabled, clearly label it.

### LLM logging hygiene

- Always redact:
    - Authorization headers
    - API keys in URLs or JSON
- Default to storing:
    - request metadata + prompt hashes
    - truncated bodies (or opt-in full bodies)

### No analytics by default

- Avoid sending user content (summaries, screenshots) to any analytics provider.
- If telemetry is ever added, make it opt-in and content-free.

---

## 12) Validation & Quality

### Deterministic validators (before inserting cards)

- No cards outside [windowStart, currentTime] (allow small tolerance)
- end_ts > start_ts
- Category ∈ allowed categories
- Total coverage is “reasonable” (warn if large uncovered gaps)
- Min/max card duration constraints (e.g., ≥ 2m, ≤ 2h) with exceptions for Idle

### Testing strategy

- Unit tests:
    - 4 AM boundary day key
    - batching algorithm (gap + duration + incomplete tail)
    - replaceTimelineCardsInRange correctness
    - review segment fragmentation/coalescing
- Integration tests (headless):
    - DB migrations + inserts
    - Gemini client request construction (mock HTTP)
- Manual QA:
    - multi-monitor display switching
    - suspend/resume correctness
    - long-run storage purge

---

## 13) Suggested “MVP → Full Fidelity” Phases

1. MVP
    - screenshot capture + DB
    - batching + Gemini transcription + card generation
    - timeline UI + export
2. Fidelity
    - retry workflow + System/Error cards
    - review overlay + day summary
    - storage limits + purge
3. Polish
    - timelapse generation
    - deep links + tray UX
    - debug log copy, robust redaction

---

## 14) Explicit Non‑Goals (per requirements)

- No journal tables, UI, reminders, onboarding gates, or notification flows for journaling.
- No alternative model providers or local inference engines.
- No copying macOS-specific lifecycle hacks; use conventional tray-window semantics cross-platform.

---

## 15) Concrete Module Design (Main Process)

### 15.1 `StorageService`
Responsibilities:
- Own the SQLite connection pool and migrations.
- Provide transactional helpers used by analysis/card replacement.
- Provide filesystem path resolution (`userData` root + relative paths).

Key APIs (sync or async; prefer async wrappers around serialized DB queue):
- `init()` → open DB, apply migrations, set pragmas
- `insertScreenshot({ capturedAt, relPath, fileSize }) -> screenshotId`
- `fetchUnprocessedScreenshots({ sinceTs }) -> ScreenshotRow[]`
- `createBatchWithScreenshots({ startTs, endTs, screenshotIds }) -> batchId`
- `getBatchScreenshots(batchId) -> ScreenshotRow[]`
- `insertObservations(batchId, observations[])`
- `fetchObservationsInRange(startTs, endTs) -> ObservationRow[]`
- `fetchCardsInRange(startTs, endTs, { includeSystem }) -> TimelineCardRow[]`
- `replaceCardsInRange({ fromTs, toTs, batchId, newCards }) -> { insertedCardIds, removedVideoPaths }`
- `setBatchStatus(batchId, status, reason?)`
- `applyReviewRatingSegment({ startTs, endTs, rating })`
- `fetchReviewSegments({ dayKey })`
- `fetchCardsForDay({ dayKey })`
- `updateCardCategory({ cardId, category, subcategory? })`
- `markScreenshotsDeletedByIds(ids[])`
- `purgeStragglers()` (recordings + timelapses)

Data conventions:
- Store `file_path` and `video_summary_url` as **relative** paths under `userData`.
- Treat `start_ts/end_ts` as canonical for cards; `start/end` are just cached display strings.

---

### 15.2 `CaptureService` (desktopCapturer)
Responsibilities:
- Maintain recording state and schedule screenshot captures.
- Select target display (user-selected or active-under-cursor).
- Persist capture results (file + DB insert).
- Emit state changes to renderer via IPC events.

Internal state:
- `desiredRecordingEnabled: boolean`
- `isSystemPaused: boolean`
- `captureIntervalSeconds: number` (default 10)
- `selectedDisplayId?: string`
- `lastCaptureAtTs?: number`

Important behaviors:
- Drift-correct scheduler (avoid interval drift):
  - Track next scheduled ts; after capture completes, schedule next based on intended cadence (not completion time).
- Failure handling:
  - If capture fails repeatedly, surface a UI banner and stop recording (or keep trying with backoff).

---

### 15.3 `AnalysisService`
Responsibilities:
- Run periodic analysis tick (every 60s).
- Batch unprocessed screenshots using Gemini config.
- Enqueue batch processing with a concurrency limit (recommend 1 at a time).
- Trigger timelapse generation after inserting cards.

Batch states (suggested):
- `pending`, `processing_transcribe`, `processing_generate_cards`, `analyzed`,
- `failed`, `failed_empty`,
- `skipped_short`

Core loop:
1. `tick()`:
   - gather unprocessed screenshots (last 24h)
   - create batches (drop incomplete tail)
   - enqueue new batchIds
2. worker processes a batchId:
   - status → `processing_transcribe`
   - call `GeminiService.transcribeBatch(batchId)`
   - persist observations
   - if no observations: status → `analyzed` and stop
   - status → `processing_generate_cards`
   - call `GeminiService.generateCards(windowEnd=batchEndTs)`
   - validate + replace cards
   - status → `analyzed`
   - enqueue timelapse jobs for inserted cards

---

### 15.4 `GeminiService` (Gemini only)
Responsibilities:
- Own Gemini API client, model selection, retries, and sanitizing logs.
- Provide two operations:
  1) `transcribeScreenshots(batchId) -> observations[]`
  2) `generateActivityCards(windowStartTs, windowEndTs) -> cards[]`

Configuration:
- `apiKey` from OS keychain (`keytar`)
- `preferredModels` ordered list (fast → capable)
- max attempts per operation (e.g., 3)
- request timeouts and backoff policy

Logging:
- Write `llm_calls` rows with redacted headers.
- Default to truncating request/response bodies unless “Verbose debug logging” is enabled.

---

### 15.5 `TimelapseService`
Responsibilities:
- Build per-card mp4s from screenshots.
- Manage timelapse storage size limit and cleanup.
- Run work off the main thread (worker thread or child process).

Inputs:
- cardId, `start_ts/end_ts`, screenshot paths
Output:
- mp4 relative path, persisted back into `timeline_cards.video_summary_url`

---

## 16) IPC API (Renderer ↔ Main) — Proposed Contract

### 16.1 Channels (request/response)
Recording & capture:
- `capture:getState -> { desiredRecordingEnabled, isSystemPaused, intervalSeconds, selectedDisplayId }`
- `capture:setEnabled({ enabled: boolean }) -> void`
- `capture:setInterval({ intervalSeconds: number }) -> void`
- `capture:setSelectedDisplay({ displayId?: string }) -> void`
- `capture:listDisplays -> { id, name, bounds }[]`

Timeline:
- `timeline:getDay({ dayKey }) -> { cards, reviewSummary }`
- `timeline:getRange({ startTs, endTs }) -> { cards }`
- `timeline:updateCardCategory({ cardId, category, subcategory? }) -> void`
- `timeline:exportMarkdown({ startDayKey, endDayKey }) -> { markdown: string }`

Review:
- `review:applyRating({ startTs, endTs, rating }) -> void`
- `review:getDay({ dayKey }) -> { segments, coverageByCardId }`

Analysis / retry:
- `analysis:getRecentBatches({ limit }) -> BatchRow[]`
- `analysis:retryBatch({ batchId }) -> void`
- `analysis:getBatchDetails({ batchId }) -> { batch, screenshots, observations, llmCalls }`

Settings:
- `settings:getAll -> Settings`
- `settings:update({ patch }) -> Settings`

Debug:
- `debug:copyLogs({ includeBodies?: boolean }) -> { text }`
- `debug:openRecordingsFolder -> void`

### 16.2 Events (main → renderer)
- `event:recordingStateChanged`
- `event:captureError({ message, code? })`
- `event:timelineUpdated({ dayKey })` (emit after replace)
- `event:analysisBatchUpdated({ batchId, status, reason? })`
- `event:storageUsageUpdated({ recordingsBytes, timelapsesBytes })`

---

## 17) Time & “4 AM boundary” (Canonical Rules)

### 17.1 Day key
Define `dayKey(ts)`:
- Convert `ts` to local time.
- Subtract 4 hours.
- Take calendar date → `YYYY-MM-DD`.

This makes `[4:00, 28:00)` belong to one logical day.

### 17.2 Timeline display
- Grid start: 4:00
- Grid end: 28:00
- When viewing “Today”, choose the dayKey containing `now` by the rule above.

---

## 18) Replace-in-range Algorithm (Recommended Implementation)

Inputs:
- `[fromTs, toTs]` (sliding window)
- `newCards[]` with canonical `start_ts/end_ts` and metadata JSON
- `batchId`

Transaction:
1. Fetch existing overlapping cards where `is_deleted = 0` and `start_ts < toTs AND end_ts > fromTs`
2. Soft-delete those cards where:
   - `category != 'System'` OR (`category == 'System' AND batch_id == batchId`)
3. Insert new cards:
   - set `day = dayKey(midpointTs)` or `dayKey(start_ts)` (choose one; be consistent)
   - set `start/end` display strings derived from local time format `h:mm a`
4. Return removed `video_summary_url` of deleted cards (for cleanup)

Do not:
- Attempt to “resolve” timestamps from clock-only strings.
- Store ambiguous times without `start_ts/end_ts`.

---

## 19) Gemini Prompting (Detailed)

### 19.1 Transcription prompt (video → observations JSON)
System instruction (high level):
- You are producing *time-aligned*, factual observations about what is visible.
- Avoid speculation; keep concise; prefer app/site identification when clear.
- Return valid JSON only.

User content:
- Provide:
  - batch start time (local), interval seconds, and rules for expanding timestamps.
  - ask for segments with `start`/`end` in `MM:SS` (video time).
  - ask for optional `appSites` extraction.

Output schema:
```json
{
  "observations": [
    {
      "start": "MM:SS",
      "end": "MM:SS",
      "observation": "string",
      "appSites": { "primary": "string|null", "secondary": "string|null" }
    }
  ]
}
```

Validation rules:

- timestamps within video duration
- non-empty observation text
- segments monotonically non-decreasing and end >= start

### 19.2 Card generation prompt (observations + context → cards JSON)

Inputs:

- Observations (with canonical local clock strings + canonical unix)
- Existing cards overlapping window (excluding System) for continuity
- Categories (Work/Personal/Distraction/Idle) + per-category guidance
- “Idle rule”: use Idle when user appears inactive for more than half of the period

Output schema:

{
  "cards": [
    {
      "startTs": 0,
      "endTs": 0,
      "category": "Work|Personal|Distraction|Idle|System",
      "subcategory": "string",
      "title": "string",
      "summary": "string",
      "detailedSummary": "string",
      "appSites": { "primary": "string|null", "secondary": "string|null" },
      "distractions": [
        { "startTs": 0, "endTs": 0, "title": "string", "summary": "string" }
      ]
    }
  ]
}

Recommendation: have Gemini return canonical startTs/endTs directly to avoid clock parsing errors. If Gemini sometimes outputs clock strings, normalize in a post-processor and retry once.

Card validators (reject + retry with “fix JSON” instruction):

- Window bounds: allow small tolerance, clamp if needed
- endTs > startTs
- No future times beyond windowEndTs
- Category in allowed set
- Coverage sanity (warn if huge holes, but don’t necessarily fail)

---

## 20) Retry Workflow (Failed Batches)

UI behavior:

- A failed batch produces a System/Error card titled “Processing failed”.
- Selecting it shows:
    - reason
    - “Retry” button
    - per-stage progress (transcribing/generating cards)

Implementation:

- analysis:retryBatch(batchId):
    - set status back to pending (or a dedicated retrying)
    - clear prior observations for that batch (optional; or keep for debugging)
    - re-run transcription + card generation
    - replace cards in the batch’s time range if it remains a System/Error-only range

---

## 21) Settings (Minimum Set)

Recording:

- Screenshot interval seconds (default 10)
- Selected display (auto / specific)
- Include cursor overlay (optional)

Storage:

- Recordings limit bytes (default 10 GB)
- Timelapses limit bytes (default 10 GB)
- “Purge now”

Gemini:

- API key (stored via keytar)
- Preferred model (dropdown)
- Debug logging level (off / metadata only / include bodies)

Timeline:

- Categories editor (Work/Personal/Distraction + details; Idle locked)

---

## 22) Packaging & Cross‑Platform Notes

Build:

- electron-builder or electron-forge with per-OS signing/notarization.

OS integrations:

- macOS: screen recording permission messaging + notarization
- Windows: optional auto-start via registry/startup folder (if desired)
- Linux: desktop files, optional autostart .desktop

Do not replicate Sparkle; use:

- electron-builder autoUpdater (Squirrel/NSIS) or a custom update service later.

---

## 23) “Don’t copy bad practices” — Explicit Choices

- Do not send activity summaries or detailed summaries to analytics.
- Do not store API keys in plain JSON/UserDefaults; use OS credential store.
- Do not treat clock strings as canonical time; always store unix timestamps.
- Do not fetch network resources (favicons) without opt-in.
- Do not run heavy video encoding in the UI thread or main event loop.
