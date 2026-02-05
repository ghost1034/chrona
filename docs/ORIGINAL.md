# Chrona Original Technical Documentation

---

## Table of Contents
- Repo layout
- Runtime architecture
- App lifecycle
    - Entrypoints and initialization
    - “Soft quit” (keeps background running)
    - Menu bar UI and actions
    - Deep links
- SQLite schema
- Recording pipeline (screenshots)
    - High-level flow
    - ScreenRecorder details
    - PauseManager vs “system pause”
- Storage: filesystem + database
    - On-disk locations
    - Screenshot persistence model
    - Storage limits and cleanup
- Key configuration knobs
- Analysis & AI pipeline (screenshots → observations → timeline cards)
    - Overview
- Analysis scheduling
    - Startup
    - Timer cadence
- Batching: screenshots → analysis_batches
    - Source set: “unprocessed screenshots”
    - Provider-dependent batching config
    - Batch construction rules
    - Batch persistence
- Batch processing: analysis_batches → observations → timeline_cards
    - Entry point
    - Step 1: screenshot transcription → observations
    - Step 2: “sliding window” card generation (last hour)
    - Step 3: replace cards atomically (soft-delete + insert)
    - Error path: “System/Error” cards
- Timelapse generation for cards
- Provider selection and implementations
    - Provider selection
    - GeminiDirectProvider (cloud)
    - OllamaProvider (local HTTP, multi-call)
    - ChatCLIProvider (local CLI, multi-call)
    - ChronaBackendProvider
- LLM call logging (debug + analytics)
- Notes / current quirks worth knowing
- Timeline UI, review, retry, export
- Timeline display model
    - Core UI view model: TimelineActivity
    - Day boundaries: “4 AM to 4 AM”
- Timeline screen: CanvasTimelineDataView
    - Data loading and refresh
    - Converting DB cards to Date (clock strings + 4 AM rollover)
    - Overlap mitigation (display-only)
    - Layout and UX details
- Right panel: selected activity vs day summary
    - Activity details: ActivityCard
- Retry workflow (failed batches)
- Timeline review workflow (focus/neutral/distracted)
    - Data model and persistence
    - What counts as “unreviewed”
    - Review UI: TimelineReviewOverlay
- Day summary (“Your day so far”)
- Export and copy
    - Copy a single day to clipboard
    - Export a date range to Markdown
- Summary rating + feedback modal (analytics)
- Configuration, onboarding, security, and journal reminders
- Configuration storage model
    - UserDefaults keys (selected)
- Keychain usage (secrets)
- Provider onboarding + switching
    - Onboarding provider selection
    - Provider setup wizard
    - Switching providers in Settings
- Journal reminders and badge flow
    - Scheduling model
    - Badge + navigation behavior
- Journal gating + onboarding
- Observability: crash reports + analytics

---

## Repo layout

- Xcode projects
    - Chrona/Chrona.xcodeproj (main app)
    - Chrona/Chrona.xcodeproj/AmiTime.xcodeproj (embedded/legacy-looking; not documented yet)
- App source
    - Chrona/Chrona/App/* (SwiftUI app entry + AppDelegate + shared app state)
    - Chrona/Chrona/Core/* (recording, analysis, AI providers, storage, etc.)
    - Chrona/Chrona/Views/* and Chrona/Chrona/Menu/* (SwiftUI UI and menu-bar UI)
    - Chrona/Chrona/System/* (Sparkle updates, launch-at-login, status bar controller, analytics helpers)
- Release/update infrastructure
    - docs/appcast.xml (Sparkle feed published at SUFeedURL)
    - scripts/* (DMG + appcast tooling)

---

## Runtime architecture

Chrona is effectively a single-process macOS app that behaves like a menu bar app with an optional main window:

- Main window: SwiftUI WindowGroup scene (Chrona/Chrona/App/ChronaApp.swift:79).
- Menu bar presence: NSStatusItem + popover (Chrona/Chrona/System/StatusBarController.swift:6) hosting SwiftUI (Chrona/Chrona/Menu/StatusMenuView.swift:5).
- Background behavior (“soft quit”): Cmd+Q and normal quit flows are intercepted; the app hides and removes its Dock presence instead of terminating (Chrona/Chrona/App/AppDelegate.swift:190).

---

## App lifecycle

### Entrypoints and initialization

- SwiftUI entrypoint: Chrona/Chrona/App/ChronaApp.swift:79
    - Chooses between main UI and onboarding via @AppStorage("didOnboard").
    - Shows a launch video overlay (VideoLaunchView) and optionally a journal onboarding overlay.
    - Adds app menu commands for:
        - “Reset Onboarding” (sets defaults then terminates)
        - Sparkle “Check for Updates…” and “View Release Notes” menu items.
- AppDelegate: Chrona/Chrona/App/AppDelegate.swift:14
    - Initializes analytics/crash reporting (PostHog + Sentry) from Info.plist keys.
    - Creates the menu bar controller: StatusBarController().
    - Bootstraps launch-at-login state: LaunchAtLoginManager.shared.bootstrapDefaultPreference().
    - Creates a deep-link router for chrona://… URLs.
    - Starts background jobs/services:
        - Analysis scheduler start (delayed): AnalysisManager.shared.startAnalysisJob() (details later)
        - Inactivity monitor: InactivityMonitor.shared.start() (Chrona/Chrona/App/InactivityMonitor.swift:5)
        - Notification service: NotificationService.shared.start() (not documented yet)

### “Soft quit” (keeps background running)

applicationShouldTerminate cancels termination unless an explicit flag is set:

- Default behavior: hide app + switch Dock policy to accessory (no Dock icon), keep running (Chrona/Chrona/App/AppDelegate.swift:190).
- Termination allowed when AppDelegate.allowTermination = true (used by “Quit Completely” and Sparkle install/relaunch flows).

### Menu bar UI and actions

- Status item icon reflects recording state (AppState.shared.isRecording), updated via Combine (Chrona/Chrona/System/StatusBarController.swift:6).
- Popover content: StatusMenuView (Chrona/Chrona/Menu/StatusMenuView.swift:5) exposes:
    - Pause/resume recording via PauseManager (Chrona/Chrona/App/PauseManager.swift:54)
    - Open main window (restores Dock icon depending on UserDefaults("showDockIcon"))
    - Open recordings folder (opens StorageManager.shared.recordingsRoot)
    - Check for updates (Sparkle interactive)
    - Quit completely (sets allowTermination then terminates)

### Deep links

CFBundleURLSchemes includes chrona (Chrona/Chrona/Info.plist:1). The router supports:

- chrona://start-recording (also start, resume)
- chrona://stop-recording (also stop, pause)

Implementation: Chrona/Chrona/App/AppDeepLinkRouter.swift:6

---

## SQLite schema

Set on open (not schema, but relevant): PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; (see Chrona/Chrona/Core/Recording/StorageManager.swift:402).

-- chunks: video recording segments (legacy/partial; screenshots are current)
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  file_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recording',
  is_deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status);
CREATE INDEX IF NOT EXISTS idx_chunks_start_ts ON chunks(start_ts);
CREATE INDEX IF NOT EXISTS idx_chunks_status_start_ts ON chunks(status, start_ts);

-- analysis_batches: groups chunks/screenshots for LLM processing
CREATE TABLE IF NOT EXISTS analysis_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_start_ts INTEGER NOT NULL,
  batch_end_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  llm_metadata TEXT,
  detailed_transcription TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_batches_status ON analysis_batches(status);

-- batch_chunks: join table (batch -> chunks)
CREATE TABLE IF NOT EXISTS batch_chunks (
  batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_chunks_chunk ON batch_chunks(chunk_id);

-- timeline_cards: activity summaries (soft-delete via is_deleted migration below)
CREATE TABLE IF NOT EXISTS timeline_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  start_ts INTEGER,
  end_ts INTEGER,
  day DATE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,
  detailed_summary TEXT,
  metadata TEXT,
  video_summary_url TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
CREATE INDEX IF NOT EXISTS idx_timeline_cards_start_ts ON timeline_cards(start_ts);
CREATE INDEX IF NOT EXISTS idx_timeline_cards_time_range ON timeline_cards(start_ts, end_ts);

-- timeline_review_ratings: time-based review segments
CREATE TABLE IF NOT EXISTS timeline_review_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  rating TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_ratings_time ON timeline_review_ratings(start_ts, end_ts);

-- observations: LLM transcription outputs
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
CREATE INDEX IF NOT EXISTS idx_observations_start_ts ON observations(start_ts);
CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);

-- screenshots: periodic screen captures
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  is_deleted INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at);

-- batch_screenshots: join table (batch -> screenshots)
CREATE TABLE IF NOT EXISTS batch_screenshots (
  batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, screenshot_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_screenshots_screenshot ON batch_screenshots(screenshot_id);

-- journal_entries: daily intentions/reflections/summaries
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,
  intentions TEXT,
  notes TEXT,
  goals TEXT,
  reflections TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_day ON journal_entries(day);
CREATE INDEX IF NOT EXISTS idx_journal_entries_status ON journal_entries(status);

-- llm_calls: request/response logging
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  batch_id INTEGER NULL,
  call_group_id TEXT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  model TEXT NULL,
  operation TEXT NOT NULL,
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

-- Migration applied if timeline_cards.is_deleted is missing (final state includes this column + partial indexes)
ALTER TABLE timeline_cards ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_start_ts
  ON timeline_cards(start_ts) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_batch
  ON timeline_cards(batch_id) WHERE is_deleted = 0;

---

## Recording pipeline (screenshots)

Despite earlier “video chunk” naming in parts of the code, current capture is implemented as periodic screenshots using ScreenCaptureKit.

### High-level flow

1. Permission gate: Screen recording permission is tested by calling SCShareableContent.excludingDesktopWindows(...) during app launch when onboarding is complete (Chrona/Chrona/App/
   AppDelegate.swift:60).
2. Recording state source of truth: AppState.shared.isRecording (Chrona/Chrona/App/AppState.swift:12).
3. Recorder observes state: ScreenRecorder subscribes to AppState.shared.$isRecording and starts/stops accordingly (Chrona/Chrona/Core/Recording/ScreenRecorder.swift:82).
4. Capture: uses SCScreenshotManager.captureImage(...) on a timer.
5. Persist: saves a .jpg file and inserts a DB row in screenshots.

### ScreenRecorder details

Source of truth: Chrona/Chrona/Core/Recording/ScreenRecorder.swift:82

- Timer interval:
    - ScreenshotConfig.interval reads UserDefaults("screenshotIntervalSeconds"), default 10.0 seconds.
- Image characteristics:
    - Captured using a SCContentFilter(display:excludingWindows:).
    - Scaled to ~1080p height while preserving aspect ratio.
    - Cursor included (config.showsCursor = true).
    - JPEG encode quality 0.85.
- Display selection:
    - Chooses display in this order: user-requested → “active display under mouse” → first available.
    - “Active display” is tracked by ActiveDisplayTracker (Chrona/Chrona/Core/Recording/ActiveDisplayTracker.swift:15), polling at 0.1 Hz by default (once per 10s), with debounce and hysteresis to avoid
      flapping near monitor edges.
- State machine:
    - idle → starting → capturing, with a special paused state for sleep/lock/screensaver automatic pausing.
- System events:
    - On sleep/lock/screensaver start: transition to paused (if recording was enabled) and stop capture.
    - On wake/unlock/screensaver stop: if still paused and AppState.shared.isRecording is still true, auto-resume after a short delay.

### PauseManager vs “system pause”

There are two conceptually different “pauses”:

- User pause: PauseManager.pause(...) sets AppState.shared.isRecording = false (turns off recording) and may schedule an automatic resume (Chrona/Chrona/App/PauseManager.swift:54).
- System pause: ScreenRecorder detects sleep/lock/screensaver and stops temporarily, but intends to resume automatically if the user still “wants recording” enabled (AppState.shared.isRecording == true).

---

## Storage: filesystem + database

### On-disk locations

Managed by StorageManager (Chrona/Chrona/Core/Recording/StorageManager.swift:361):

- Base directory: ~/Library/Application Support/Chrona/
- Recordings directory (currently used for screenshots): ~/Library/Application Support/Chrona/recordings/
- Database: ~/Library/Application Support/Chrona/chunks.sqlite

There’s explicit migration logic from a legacy sandbox container path:

- StoragePathMigrator (Chrona/Chrona/Utilities/StoragePathMigrator.swift:3)
- Additional DB path rewriting: migrateLegacyChunkPathsIfNeeded() inside StorageManager (used to rewrite file paths stored in DB)

### Screenshot persistence model

- Filename generation: nextScreenshotURL() uses timestamp yyyyMMdd_HHmmssSSS.jpg (Chrona/Chrona/Core/Recording/StorageManager.swift:907).
- DB insert on capture: saveScreenshot(url:capturedAt:) stores:
    - captured_at (unix seconds)
    - file_path (absolute path)
    - file_size (best-effort)
      (Chrona/Chrona/Core/Recording/StorageManager.swift:913)
- “Unprocessed screenshots” query exists for downstream batching/analysis:
    - fetchUnprocessedScreenshots(since:) returns screenshots not yet linked via batch_screenshots (Chrona/Chrona/Core/Recording/StorageManager.swift:935)
    - saveBatchWithScreenshots(startTs:endTs:screenshotIds:) links screenshots to an analysis_batches row (Chrona/Chrona/Core/Recording/StorageManager.swift:956)

### Storage limits and cleanup

- Limits stored in UserDefaults via StoragePreferences (Chrona/Chrona/Core/Recording/StoragePreferences.swift:1)
    - Default recordings limit: 10 GB
    - Default timelapses limit: 10 GB
- Purge behavior (recordings/screenshots):
    - Runs hourly on a scheduler inside StorageManager (not yet fully documented, but purge code is in performPurgeIfNeeded()).
    - If above limit, repeatedly selects the oldest screenshots (up to 500 per pass), marks them deleted in DB, then deletes the files (Chrona/Chrona/Core/Recording/StorageManager.swift:2865).
    - Also deletes “straggler” files on disk that are no longer referenced by active DB rows (cleanupRecordingStragglers() in the same region).
- Timelapses:
    - Stored under ~/Library/Application Support/Chrona/timelapses/ and purged separately by TimelapseStorageManager (Chrona/Chrona/Core/Recording/TimelapseStorageManager.swift:3).

---

## Key configuration knobs

- Recording enabled flag (persisted only after onboarding):
    - UserDefaults("isRecording") managed by AppState (Chrona/Chrona/App/AppState.swift:12)
- Screenshot interval:
    - UserDefaults("screenshotIntervalSeconds"), default 10 seconds (Chrona/Chrona/Core/Recording/ScreenRecorder.swift:16)
- Storage limits:
    - UserDefaults("storageLimitRecordingsBytes"), default 10 GB (Chrona/Chrona/Core/Recording/StoragePreferences.swift:1)
    - UserDefaults("storageLimitTimelapsesBytes"), default 10 GB (Chrona/Chrona/Core/Recording/StoragePreferences.swift:1)
- Sparkle updates (Info.plist):
    - Feed: SUFeedURL, key: SUPublicEDKey, auto-check/download flags (Chrona/Chrona/Info.plist:1)
- URL scheme:
    - chrona for deep links (Chrona/Chrona/Info.plist:1)

---

## Analysis & AI pipeline (screenshots → observations → timeline cards)

This section documents how Chrona turns periodic screenshots into timeline cards (and optional per-card timelapse videos).

### Overview

There are two layers:

1. AnalysisManager (Chrona/Chrona/Core/Analysis/AnalysisManager.swift) handles:
    - polling for new screenshots
    - grouping screenshots into analysis batches
    - creating analysis_batches DB rows
    - triggering per-batch LLM processing
    - generating timelapse videos for the resulting cards
2. LLMService (Chrona/Chrona/Core/AI/LLMService.swift) handles:
    - choosing the configured LLM provider
    - transcribing screenshots into “observations”
    - generating/replacing timeline cards using a sliding time window
    - creating “System/Error” cards on failure

---

## Analysis scheduling

### Startup

- App launch starts analysis after a short delay:
    - AppDelegate.setupGeminiAnalysis() calls AnalysisManager.shared.startAnalysisJob() after ~2 seconds (Chrona/Chrona/App/AppDelegate.swift:226).

### Timer cadence

- AnalysisManager runs a Timer every 60 seconds (checkInterval = 60) and also triggers an immediate run on start (Chrona/Chrona/Core/Analysis/AnalysisManager.swift:49).
- It processes only the last 24 hours of screenshots (maxLookback = 24h) to avoid unbounded backlog.

---

## Batching: screenshots → analysis_batches

### Source set: “unprocessed screenshots”

StorageManager.fetchUnprocessedScreenshots(since:) returns screenshots:

- captured within the lookback window
- not marked deleted
- not already linked into any batch (id NOT IN batch_screenshots)
  (Chrona/Chrona/Core/Recording/StorageManager.swift:935)

### Provider-dependent batching config

LLMService.batchingConfig controls:

- targetDuration (intended batch size)
- maxGap (maximum allowed time gap within a batch)

Current behavior:

- Gemini direct: 30 min batches, 5 min max gap (BatchingConfig.gemini)
- Everything else: 15 min batches, 2 min max gap (BatchingConfig.standard)
  (Chrona/Chrona/Core/AI/LLMService.swift:88, Chrona/Chrona/Core/AI/LLMProvider.swift:36)

### Batch construction rules

AnalysisManager.createScreenshotBatches:

- sorts screenshots by capturedAt
- starts a new batch when either:
    - the gap between consecutive screenshots exceeds maxGap, or
    - the batch would exceed targetDuration
- drops the most recent batch if it’s “incomplete” (duration < targetDuration) so the system waits for more screenshots before analyzing that trailing window
  (Chrona/Chrona/Core/Analysis/AnalysisManager.swift:536)

### Batch persistence

Each batch is saved as:

- one row in analysis_batches with batch_start_ts and batch_end_ts
- join rows in batch_screenshots
  (Chrona/Chrona/Core/Recording/StorageManager.swift:956)

---

## Batch processing: analysis_batches → observations → timeline_cards

### Entry point

For each persisted batch, AnalysisManager.queueGeminiRequest(batchId:):

- rejects empty batches (failed_empty)
- rejects batches shorter than 5 minutes (skipped_short)
- sets the batch status to processing
- calls LLMService.processBatch(batchId, ...)
  (Chrona/Chrona/Core/Analysis/AnalysisManager.swift:347)

### Step 1: screenshot transcription → observations

The provider interface is:

- transcribeScreenshots(_:batchStartTime:batchId:) -> ([Observation], LLMCall)
  (Chrona/Chrona/Core/AI/LLMProvider.swift:7)

LLMService.processBatch does:

1. Load screenshots for batch (StorageManager.screenshotsForBatch).
2. Call provider transcription.
3. Save observations into the observations table.
4. If transcription returns 0 observations, mark batch analyzed and stop.
   (Chrona/Chrona/Core/AI/LLMService.swift:117)

Observation schema

- stored in SQLite table observations with absolute start_ts/end_ts (unix seconds), plus optional metadata and llm_model
  (Chrona/Chrona/Core/Recording/StorageManager.swift:637)

### Step 2: “sliding window” card generation (last hour)

Instead of generating cards only from the current batch, LLMService uses a 1-hour window ending at the batch end time:

- currentTime = Date(batch_end_ts)
- oneHourAgo = currentTime - 3600

It then:

- fetches all observations overlapping that last-hour window: fetchObservationsByTimeRange(oneHourAgo..currentTime)
- fetches existing timeline cards overlapping that window (excluding category='System') for context: fetchTimelineCardsByTimeRange(oneHourAgo..currentTime)
- loads category descriptors for the prompt: CategoryStore.descriptorsForLLM()
- calls provider.generateActivityCards(observations: recentObservations, context: ActivityGenerationContext(...))
  (Chrona/Chrona/Core/AI/LLMService.swift:168)

### Step 3: replace cards atomically (soft-delete + insert)

New cards are written via:

StorageManager.replaceTimelineCardsInRange(from:to:with:batchId:)
(Chrona/Chrona/Core/Recording/StorageManager.swift:1808)

Important properties:

- “Replace” is implemented as:
    1. soft-delete overlapping cards (is_deleted = 1)
    2. insert new cards for the range
- It preserves “System” cards from other batches so error states don’t get erased by unrelated processing:
    - delete filter: (category != 'System' OR batch_id = currentBatchId)
- It returns any video_summary_url paths of cards being replaced so callers can delete the corresponding timelapse files from disk.

Clock-time resolution

- Providers emit card times as strings like "h:mm a".
- replaceTimelineCardsInRange resolves those clock-only times to real start_ts / end_ts by selecting the nearest of (previous day / same day / next day) around the window midpoint, and then fixing
  midnight-crossing if end < start.
- The stored day uses Chrona’s “4 AM boundary” (Date.getDayInfoFor4AMBoundary()), not midnight.
  (Chrona/Chrona/Core/Recording/StorageManager.swift:1890)

### Error path: “System/Error” cards

If any step throws, LLMService:

- sets batch status = failed with a human-readable reason
- creates a TimelineCardShell in category System, subcategory Error, spanning exactly the batch start/end clock times
- replaces cards only in that batch’s exact time range with the error card
  (Chrona/Chrona/Core/AI/LLMService.swift:260)

---

## Timelapse generation for cards

After LLMService returns inserted card IDs, AnalysisManager generates timelapse videos asynchronously:

For each inserted timeline_cards.id:

1. Load card timestamps (fetchTimelineCard(byId:) → includes startTs, endTs).
2. Fetch screenshots within [startTs, endTs].
3. Generate a timelapse video under ~/Library/Application Support/Chrona/timelapses/\<yyyy-mm-dd\>/ and name it using the card ID.
4. Write the resulting path into timeline_cards.video_summary_url.
   (Chrona/Chrona/Core/Analysis/AnalysisManager.swift:347)

Current settings in this path:

- fps: 2 and useCompressedTimeline: true, intended to produce ~20× realtime at 1× playback when screenshots are 10 seconds apart.

---

## Provider selection and implementations

### Provider selection

LLMService chooses a provider based on UserDefaults("llmProviderType") (JSON-encoded enum):

- .geminiDirect → GeminiDirectProvider (API key from Keychain key "gemini")
- .ollamaLocal(endpoint) → OllamaProvider
- .chatGPTClaude → ChatCLIProvider using chatCLIPreferredTool (codex or claude)
- .chronaBackend(endpoint) → ChronaBackendProvider (currently not implemented for core pipeline)
  (Chrona/Chrona/Core/AI/LLMService.swift:19, Chrona/Chrona/Core/AI/LLMProvider.swift:22)

### GeminiDirectProvider (cloud)

- Transcription strategy:
    - composites screenshots into an MP4 (1 fps, “compressed timeline”: 1 screenshot = 1 second)
    - uploads to Google’s Generative Language API
    - prompts Gemini to return JSON segments with MM:SS timestamps within the compressed video duration
    - expands timestamps back to real time using ScreenshotConfig.interval
      (Chrona/Chrona/Core/AI/GeminiDirectProvider.swift:2208, Chrona/Chrona/Core/Recording/ScreenRecorder.swift:16)
- Resilience:
    - retries with backoff based on error classification
    - model fallback order via GeminiModelPreference (e.g., “3 Flash → 2.5 Flash → Flash Lite”) when capacity-related HTTP codes occur
      (Chrona/Chrona/Core/AI/GeminiModelPreference.swift:33, Chrona/Chrona/Core/AI/GeminiDirectProvider.swift:12)
- Card generation:
    - prompt includes: observations (with absolute clock times), existing cards context, category constraints (including “idle” guidance), plus “appSites” domain extraction rules
    - validates coverage and duration rules; on validation failure it retries with an augmented prompt describing what broke

### OllamaProvider (local HTTP, multi-call)

- Transcription strategy:
    - samples ~15 evenly spaced screenshots
    - runs per-frame description calls
    - merges those into a small set of observation segments
      (Chrona/Chrona/Core/AI/OllamaProvider.swift:1366)
- Card generation:
    - builds a title+summary from observations, then merges with existing cards using heuristics and safety caps (e.g., avoid producing >60 minute cards)
- Local engine modes:
    - supports Ollama vs LM Studio vs “custom”, with optional bearer token for custom engines

### ChatCLIProvider (local CLI, multi-call)

- Uses installed codex or claude in a login shell environment (so it matches Terminal PATH/auth).
- Similar overall structure to Ollama:
    - sample screenshots → describe frames (with images) → merge to observations → generate cards
    - strict validation loop with prompt feedback on failure
- Designed to run “headless” and disables MCP servers for Codex via CLI flags.
  (Chrona/Chrona/Core/AI/ChatCLIProvider.swift:431, Chrona/Chrona/Core/AI/ChatCLIProvider.swift:1401)

### ChronaBackendProvider

- transcribeScreenshots / generateActivityCards are currently fatalError("... not implemented yet").
- generateText throws an explicit “not supported” error.
  (Chrona/Chrona/Core/AI/ChronaBackendProvider.swift:7)

---

## LLM call logging (debug + analytics)

Chrona has a dedicated request/response log table llm_calls in SQLite plus an analytics event stream.

- DB: llm_calls records provider/model/operation, latency, HTTP status, and (sanitized) request/response bodies/headers.
  (Chrona/Chrona/Core/Recording/StorageManager.swift:696)
- LLMLogger writes llm_calls rows and emits AnalyticsService.capture("llm_api_call", ...).
    - It redacts likely secret query params and removes auth headers before persisting.
      (Chrona/Chrona/Core/AI/LLMLogger.swift:1)

---

## Timeline UI, review, retry, export

This section documents how the SwiftUI UI reads timeline_cards and related tables, renders the timeline, and exposes review/export/debug workflows.

---

# Timeline display model

## Core UI view model: TimelineActivity

The timeline UI does not render StorageManager.TimelineCard directly; it converts DB cards into a UI-only model:

- TimelineActivity (Chrona/Chrona/Views/UI/TimelineDataModels.swift:12)
    - id: String (stable across refresh)
    - recordId: Int64? (timeline_cards.id)
    - batchId: Int64? (analysis batch for retry/debug)
    - startTime/endTime: Date
    - title/summary/detailedSummary/category/subcategory
    - distractions, videoSummaryURL, appSites

ID strategy:

- If recordId exists, id = "record:\<recordId\>".
- Otherwise, it hashes (batchId, start/end, title/category/subcategory) into a stable string to prevent SwiftUI diff churn.
  (Chrona/Chrona/Views/UI/TimelineDataModels.swift:28)

## Day boundaries: “4 AM to 4 AM”

The timeline UI is based on Chrona’s “logical day”:

- Grid baseline: 4 AM (CanvasConfig.startHour = 4) and runs through 4 AM next day (endHour = 28).
  (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:20)

DB cards store clock strings (start, end like "h:mm a") plus absolute timestamps (start_ts, end_ts). The timeline view primarily uses the clock strings and reconstructs Date values relative to a “timeline
day”.

---

# Timeline screen: CanvasTimelineDataView

## Data loading and refresh

CanvasTimelineDataView (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:54) loads cards for the selected timeline day and converts them to positioned UI cards:

1. Determine effective timeline date using timelineDisplayDate(from:now:) (handles 4 AM boundary for “today”).
2. Convert to a day key string yyyy-MM-dd.
3. Fetch DB cards: StorageManager.fetchTimelineCards(forDay:).
4. Convert to TimelineActivity instances (processTimelineCards).
5. Apply a display-only overlap mitigation (resolveOverlapsForDisplay).
6. Convert to CanvasPositionedActivity (y/height + favicon host normalization).
7. Publish to UI and post .timelineDataUpdated notification with dayString.
   (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:351)

Refresh triggers:

- On appear: loads once and starts a 60s refresh timer (loadActivities(animate:false) on tick).
- On app becoming active: refresh + restart timer.
- On selectedDate change.
- On refreshTrigger binding increments (used by parent views to force refresh).
  (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:136, Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:645)

## Converting DB cards to Date (clock strings + 4 AM rollover)

processTimelineCards parses clock-only strings (card.startTimestamp, card.endTimestamp) and anchors them to the timeline day’s midnight baseDate. It then adjusts:

- If parsed hour < 4, shift that time to the next day (so e.g. 1:30 AM belongs to the post-midnight tail of the 4 AM–4 AM window).
- If end < start after adjustments, shift end forward by 1 day (midnight crossing).
  (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:420)

## Overlap mitigation (display-only)

If upstream generation occasionally produces overlapping cards, the timeline view trims longer cards so shorter cards keep their full ranges:

- resolveOverlapsForDisplay compares overlaps pairwise, identifies “small vs big” by duration, and trims the big segment’s start/end to remove overlap.
- This does not write back to the DB; it’s strictly a rendering transform.
  (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:480)

## Layout and UX details

- The timeline scrolls to roughly “2 hours before now” when viewing Today (to keep “now” around ~80% down the viewport).
- A “current time” horizontal indicator is shown only when viewing Today; it “breathes” when AppState.isRecording is true.
- Cards include favicon hints derived from timeline_cards.metadata.appSites.primary/secondary:
    - raw values are preserved for pattern matching
    - hostnames are normalized for network fetch
    - rendering calls FaviconService.shared.fetchFavicon(...) in FaviconOrSparkleView.
      (Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:263, Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:840)

---

# Right panel: selected activity vs day summary

MainView shows either:

- an ActivityCard for a selected TimelineActivity, or
- a DaySummaryView when nothing is selected.
  (Chrona/Chrona/Views/UI/MainView/Layout.swift:430)

## Activity details: ActivityCard

ActivityCard (Chrona/Chrona/Views/UI/MainView/ActivityCard.swift:6) shows:

- Title + time range + category pill.
- Summary and (optional) “DETAILED SUMMARY”.
    - It renders text using AttributedString(markdown:, interpretedSyntax: .inlineOnlyPreservingWhitespace) (inline Markdown only).
- Optional timelapse thumbnail player (VideoThumbnailView) when videoSummaryURL exists.
- Category change UI via CategoryPickerOverlay (disabled for error cards).
- Retry controls for error cards (see below).

Category changes:

- UI updates optimistically in MainView.handleCategoryChange.
- Persistence happens off-main-thread by updating timeline_cards.category via StorageManager.updateTimelineCardCategory.
  (Chrona/Chrona/Views/UI/MainView/Actions.swift:5)

---

# Retry workflow (failed batches)

Failed analysis is surfaced as a timeline card titled "Processing failed" (created by LLMService).

Retry is coordinated by:

- RetryCoordinator (Chrona/Chrona/Views/UI/RetryCoordinator.swift:4)
    - Scans a day’s timeline cards for those with title == "Processing failed" and collects their batchIds.
    - Runs reprocessing sequentially with AnalysisManager.shared.reprocessBatch(...).
    - Tracks per-batch status for UI (“queued”, “transcribing”, “generating cards”, “done”, etc.).

UI integration:

- In ActivityCard, failed cards show a “Retry” button (or “Processing” pill if active).
- In CanvasActivityCard, failed cards can display the retry status line inline.
  (Chrona/Chrona/Views/UI/MainView/ActivityCard.swift:166, Chrona/Chrona/Views/UI/CanvasTimelineDataView.swift:292)

---

# Timeline review workflow (focus/neutral/distracted)

## Data model and persistence

Review ratings are stored independently of timeline cards in:

- SQLite table timeline_review_ratings(start_ts, end_ts, rating) (see schema in StorageManager.migrate()).
- The storage API:
    - fetchReviewRatingSegments(overlapping:startTs:endTs:)
    - applyReviewRating(startTs:endTs:rating:)
      (Chrona/Chrona/Core/Recording/StorageManager.swift:1135)

applyReviewRating behavior:

- Reads all rating segments that overlap the new [startTs, endTs) range.
- Deletes those overlapping segments.
- Re-inserts any “left” and “right” fragments of the previous segments that fall outside the new range.
- Inserts the new segment as its own row.
  This produces a non-overlapping, piecewise timeline of ratings (with no merge/coalesce step beyond fragmenting).
  (Chrona/Chrona/Core/Recording/StorageManager.swift:1155)

## What counts as “unreviewed”

A timeline card is considered reviewed if the union of rating segments covers at least a threshold fraction of its duration (default 0.8 / 80%).

Two places implement this logic:

- Badge count: StorageManager.fetchUnreviewedTimelineCardCount(forDay:coverageThreshold:) (Chrona/Chrona/Core/Recording/StorageManager.swift:1214)
- Review overlay selection: TimelineReviewOverlay.filterUnreviewedActivities(...) (Chrona/Chrona/Views/UI/TimelineReviewOverlay.swift:730)

Both:

- ignore cards where category == "System"
- compute overlap seconds between each card’s [start_ts, end_ts) and merged coverage segments for that day

## Review UI: TimelineReviewOverlay

TimelineReviewOverlay (Chrona/Chrona/Views/UI/TimelineReviewOverlay.swift:110) is a full-screen overlay opened from the timeline screen. It:

- Loads all cards for the selected day, converts them to TimelineActivity, filters out System cards.
- Loads rating segments for the day.
- Displays only activities with <80% rating coverage.
- Lets you apply ratings via:
    - swipe (drag)
    - trackpad gesture
    - keyboard shortcuts
    - buttons
- Each rating immediately writes a DB segment via StorageManager.applyReviewRating(...) and refreshes the day’s rating summary.
  (Chrona/Chrona/Views/UI/TimelineReviewOverlay.swift:567, Chrona/Chrona/Views/UI/TimelineReviewOverlay.swift:638)

---

# Day summary (“Your day so far”)

When no activity is selected, the right panel shows DaySummaryView (Chrona/Chrona/Views/Components/DaySummaryView.swift:10), which:

- Fetches timeline cards for the logical day and precomputes durations/statistics off the main thread.
- Computes a review summary snapshot by reading timeline_review_ratings segments for the day.
- Reacts to:
    - .timelineDataUpdated notifications (triggered by CanvasTimelineDataView after loading)
    - reviewRefreshToken changes (triggered when the review overlay is dismissed)
      (Chrona/Chrona/Views/Components/DaySummaryView.swift:188, Chrona/Chrona/Views/Components/DaySummaryView.swift:248)

---

# Export and copy

## Copy a single day to clipboard

- Triggered from the timeline footer button in MainView.
- Fetches StorageManager.fetchTimelineCards(forDay:).
- Formats using TimelineClipboardFormatter.makeClipboardText(for:cards:).
- Writes to NSPasteboard.general.
  (Chrona/Chrona/Views/UI/MainView/Actions.swift:78, Chrona/Chrona/Utilities/TimelineClipboardFormatter.swift:4)

The clipboard format includes:

- a header (“Chrona timeline · Today, …” or weekday)
- numbered entries with start – end — title
- optional Summary: and Details: blocks
- category as a metadata line
  (Chrona/Chrona/Utilities/TimelineClipboardFormatter.swift:4)

## Export a date range to Markdown

- UI lives in SettingsView under “Export timeline”.
- For each day in [startDate, endDate]:
    - fetch cards for yyyy-MM-dd
    - format section via TimelineClipboardFormatter.makeMarkdown(for:cards:)
- Joins days with --- and writes via NSSavePanel.
  (Chrona/Chrona/Views/UI/SettingsView.swift:1232, Chrona/Chrona/Utilities/TimelineClipboardFormatter.swift:53)

---

# Summary rating + feedback modal (analytics)

When an activity is selected, the right panel shows a small footer TimelineRateSummaryView with thumbs up/down (Chrona/Chrona/Views/UI/TimelineRateSummaryView.swift:13). Clicking opens
TimelineFeedbackModal (Chrona/Chrona/Views/UI/TimelineFeedbackModal.swift:15).

Current implementation records feedback via analytics events in MainView.handleTimelineRating / handleFeedbackSubmit and includes activity fields (including activity.summary and activity.detailedSummary) in the payload.
(Chrona/Chrona/Views/UI/MainView/Actions.swift:17)

---

## Configuration, onboarding, security, and journal reminders

This section covers how Chrona stores configuration (UserDefaults + Keychain), how provider onboarding/settings work, and how journal reminders + navigation behave.

---

# Configuration storage model

Chrona uses UserDefaults for non-secret preferences and macOS Keychain for secrets.

## UserDefaults keys (selected)

Onboarding + app state

- didOnboard (Bool): whether main onboarding is complete (Chrona/Chrona/App/ChronaApp.swift:87)
- onboardingStep (Int): current onboarding step index, migrated by OnboardingStepMigration (Chrona/Chrona/Views/Onboarding/OnboardingFlow.swift:249)
- isRecording (Bool): recording on/off, persisted only after onboarding via AppState.enablePersistence() (Chrona/Chrona/App/AppState.swift:12)
- showDockIcon (Bool): whether to show Dock icon when opening main app (Chrona/Chrona/Menu/StatusMenuView.swift:45, Chrona/Chrona/Views/UI/SettingsView.swift:130)
- lastRunBuild (String): used to detect app updates (Chrona/Chrona/App/AppDelegate.swift:76)

LLM provider selection

- selectedLLMProvider (String): UI-facing selection (gemini, ollama, chatgpt_claude, chrona) (Chrona/Chrona/Views/Onboarding/OnboardingLLMSelectionView.swift:16)
- llmProviderType (Data): JSON-encoded LLMProviderType enum; this is what LLMService actually uses (Chrona/Chrona/Core/AI/LLMService.swift:19)

Local AI config

- llmLocalEngine (String): ollama, lmstudio, or custom (Chrona/Chrona/Views/UI/SettingsView.swift:74)
- llmLocalBaseURL (String): base URL for local engine (Chrona/Chrona/Views/UI/SettingsView.swift:78)
- llmLocalModelId (String): model name/id used in prompts (Chrona/Chrona/Views/UI/SettingsView.swift:82)
- llmLocalAPIKey (String): optional bearer token for custom engine (stored in UserDefaults, not Keychain) (Chrona/Chrona/Views/UI/SettingsView.swift:96)

Screenshot cadence

- screenshotIntervalSeconds (Double): defaults to 10s (Chrona/Chrona/Core/Recording/ScreenRecorder.swift:16)

Storage limits

- storageLimitRecordingsBytes, storageLimitTimelapsesBytes (Int64) (Chrona/Chrona/Core/Recording/StoragePreferences.swift:5)

Journal + reminders

- isJournalUnlocked (Bool), hasCompletedJournalOnboarding (Bool) (Chrona/Chrona/Views/UI/JournalView.swift:19)
- Reminder settings:
    - journalRemindersEnabled
    - journalIntentionHour, journalIntentionMinute
    - journalReflectionHour, journalReflectionMinute
    - journalReminderWeekdays
      (Chrona/Chrona/Core/Notifications/NotificationPreferences.swift:13)

---

# Keychain usage (secrets)

KeychainManager stores secrets under service prefix com.teleportlabs.chrona.apikeys.\<provider\> (Chrona/Chrona/Core/Security/KeychainManager.swift:14).

Observed provider keys:

- "gemini": Gemini API key
- "chrona": Chrona backend token (used by LLMService, but backend provider is not implemented)
- "analyticsDistinctId": anonymous analytics ID used by PostHog wrapper
  (Chrona/Chrona/Core/AI/LLMService.swift:49, Chrona/Chrona/System/AnalyticsService.swift:70)

Note: KeychainManager.retrieve prints debug logs including key length/prefix (Chrona/Chrona/Core/Security/KeychainManager.swift:59).

---

# Provider onboarding + switching

There are two layers of provider choice:

1. Selection: selectedLLMProvider (string, UI choice)
2. Runtime provider: llmProviderType (encoded LLMProviderType, used by LLMService)

## Onboarding provider selection

OnboardingLLMSelectionView maps the selected provider string to LLMProviderType and writes both keys:

- "ollama" → .ollamaLocal() (default endpoint)
- "gemini" → .geminiDirect
- "chatgpt_claude" → .chatGPTClaude
- "chrona" → .chronaBackend() (UI currently commented out in selection cards)
  (Chrona/Chrona/Views/Onboarding/OnboardingLLMSelectionView.swift:258)

## Provider setup wizard

LLMProviderSetupView is used during onboarding (and also as “Edit configuration” in Settings). It:

- drives a provider-specific step list (ProviderSetupState.configureSteps)
- persists:
    - Gemini: stores API key in Keychain and stores GeminiModelPreference (Chrona/Chrona/Views/Onboarding/LLMProviderSetupView.swift:2003)
    - Local: writes llmProviderType = .ollamaLocal(endpoint: ...), plus local engine/model/base URL/api key (Chrona/Chrona/Views/Onboarding/LLMProviderSetupView.swift:730)
    - ChatCLI: detects CLI installs and stores a preferred tool in UserDefaults (via ProviderSetupState, plus ChatCLIProvider reads chatCLIPreferredTool) (Chrona/Chrona/Core/AI/LLMService.swift:58)

CLI detection strategy:

- runs codex --version / claude --version using a login shell (LoginShellRunner.run) to match Terminal PATH/config (Chrona/Chrona/Views/Onboarding/LLMProviderSetupView.swift:1951).

## Switching providers in Settings

SettingsView.completeProviderSwitch writes:

- llmProviderType (encoded)
- selectedLLMProvider (string)
  and then refreshes provider-specific UI state.
  (Chrona/Chrona/Views/UI/SettingsView.swift:1629)

---

# Journal reminders and badge flow

## Scheduling model

NotificationService schedules two recurring weekly notifications per selected weekday:

- “Set your intentions” at NotificationPreferences.intentionHour:intentionMinute
- “Time to reflect” at NotificationPreferences.reflectionHour:reflectionMinute
  Identifiers are journal.intentions.weekday.\<n\> and journal.reflections.weekday.\<n\>.
  (Chrona/Chrona/Core/Notifications/NotificationService.swift:48)

Scheduling always begins by cancelling all pending requests with identifiers prefixed journal..

Permissions:

- requested via UNUserNotificationCenter.requestAuthorization([.alert, .sound, .badge])
- permissionGranted is tracked as published state.
  (Chrona/Chrona/Core/Notifications/NotificationService.swift:39)

## Badge + navigation behavior

On notification tap (or foreground delivery), Chrona:

- sets Dock badge “1” via NotificationBadgeManager.showBadge()
- posts .navigateToJournal
- sets AppDelegate.pendingNavigationToJournal = true (used to skip the launch video on cold start)
- activates the app and brings a window forward
  (Chrona/Chrona/Core/Notifications/NotificationService.swift:158)

When the user navigates to the Journal tab, the badge is cleared:

- NotificationBadgeManager.clearBadge() is called on selectedIcon == .journal.
  (Chrona/Chrona/Views/UI/MainView/Layout.swift:70)

Journal reminder configuration UI:

- JournalRemindersView writes NotificationPreferences and calls NotificationService.requestPermission() + scheduleReminders().
  (Chrona/Chrona/Views/UI/JournalReminders.swift:131)

---

# Journal gating + onboarding

JournalView is gated behind an access code:

- user-entered code is lowercased, SHA256 hashed, and compared to a hard-coded hash.
- success sets @AppStorage("isJournalUnlocked") = true.
  (Chrona/Chrona/Views/UI/JournalView.swift:33)

Once unlocked:

- if hasCompletedJournalOnboarding is false, it shows a journal onboarding screen and plays a full-window onboarding video via JournalCoordinator.showOnboardingVideo (coordinator is injected from the app
  root).
- after video completion, hasCompletedJournalOnboarding is set true and the reminders sheet can be shown.
  (Chrona/Chrona/App/ChronaApp.swift:166, Chrona/Chrona/Views/UI/JournalView.swift:176)

---

# Observability: crash reports + analytics

- Sentry is optional: enabled only when SentryDSN is present; access is wrapped by SentryHelper.isEnabled to avoid calling Sentry before init.
  (Chrona/Chrona/App/AppDelegate.swift:35, Chrona/Chrona/Utilities/SentryHelper.swift:13)
- Analytics uses PostHog (opt-in default ON) and stores an anonymous distinct ID in Keychain.
  (Chrona/Chrona/System/AnalyticsService.swift:26)

Note: timeline feedback submission (TimelineFeedbackModal) is currently captured via analytics events that include the selected activity’s summary and detailedSummary in the payload (Chrona/Chrona/
Views/UI/MainView/Actions.swift:146).
