# Dayflow Cross-Platform Acceptance Criteria

This file defines what "done" means for each phase and the overall product, based on the invariants in `docs/NEW.md` and the phase plan in `docs/PLAN.md`.

---

## Non-negotiable constraints

- Electron app (cross-platform desktop).
- Periodic screenshots captured via `desktopCapturer`.
- Gemini only.
- No Journal feature (no UI, reminders, gating, or DB tables).
- Preserve behavioral invariants:
  - 60s analysis cadence, 24h lookback
  - Gemini batching defaults: target 30m, max gap 5m, drop trailing incomplete batch
  - Sliding 1-hour window for card generation
  - 4 AM to 4 AM logical day boundary
  - Failure creates a System/Error card spanning the batch
  - Retry workflow for failed batches
  - Export/copy to Markdown-ish text

---

## Phase 0 acceptance (Project decisions)

- `docs/DECISIONS.md` exists and records initial decisions with clear status (decided/proposed/deferred).
- `docs/ACCEPTANCE.md` exists and defines measurable criteria for MVP and later parity features.

---

## MVP acceptance (usable app; target = Phases 1-8)

App shell
- App runs in dev and as a packaged build.
- Tray/menu bar exists with: start/stop (or pause/resume), open window, open recordings folder, quit.
- Closing the window keeps the app running; explicit quit exits.
- Single-instance behavior is enforced.

Capture
- Default screenshot interval is 10s and is configurable.
- Screenshots are saved under `userData/recordings/screenshots/YYYY-MM-DD/` and recorded in SQLite.
- Capture is drift-correct (cadence is based on intended schedule, not completion time).
- Pause model is implemented:
  - user intent state (desiredRecordingEnabled)
  - system pause state (sleep/lock/suspend) that does not change user intent
- Multi-monitor selection works:
  - user-selected display OR fallback to active display under cursor
  - hysteresis/debounce prevents rapid flapping

Storage
- SQLite schema exists (journal-free) with tables: screenshots, analysis_batches, batch_screenshots, observations, timeline_cards, timeline_review_ratings, llm_calls.
- SQLite pragmas are set (WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON).
- DB stores file paths as relative paths under `userData`.

Batching + analysis scheduling
- Analysis tick runs every 60s.
- Only screenshots in the last 24h are considered for batching.
- Batching algorithm matches the spec:
  - targetDuration=30m, maxGap=5m
  - drop the most recent batch if duration < targetDuration
  - empty -> failed_empty, duration < 5m -> skipped_short

Gemini pipeline
- Transcription step converts batch screenshots to observations and persists them.
- Card generation step uses sliding window:
  - windowEnd = batch_end_ts
  - windowStart = windowEnd - 3600
  - uses observations in the window plus existing non-System cards in the window for context
- Replace-in-range is atomic:
  - soft-delete overlaps
  - preserve unrelated System cards
  - insert new cards with canonical start_ts/end_ts and derived display strings
- On any failure, batch status is set to failed and a System/Error card titled "Processing failed" spans the batch range.
- `llm_calls` logging is present with redaction and truncated bodies by default.

Timeline UI + export
- Timeline view displays a 4 AM to 4 AM grid and positions cards by start_ts/end_ts.
- Day selection uses the 4 AM boundary to define "Today".
- Card details panel shows title, time range, category, summary, detailed summary.
- Category change persists via IPC.
- Copy day to clipboard and export date range to a Markdown file are implemented.

Out of MVP scope (explicit)
- Timelapse generation/playback.
- Review overlay workflow (focus/neutral/distracted).
- Storage retention limits + purge UI (unless pulled in earlier intentionally).
- Deep links / protocol handler.

---

## Parity acceptance (full fidelity; target = Phases 9-13)

Review workflow
- Review overlay exists and only shows cards with < 80% rating coverage (excluding System cards).
- Ratings are stored as non-overlapping segments via delete-overlaps + fragment reinsertion.
- Coverage computation is correct across overlaps and day boundaries.

Retention + cleanup
- Hourly purge enforces configurable storage limits for screenshots and timelapses.
- Purge marks DB rows deleted and removes files.
- Straggler cleanup removes files not referenced by any active DB rows.

Timelapses (optional feature, if enabled)
- Timelapse videos are generated per card in a worker process and stored under `userData/timelapses/YYYY-MM-DD/<cardId>.mp4`.
- Replaced cards' old timelapses are cleaned up.
- UI can play a card's timelapse when present.

Deep links + OS integration
- Protocol handler supports at least:
  - dayflow://start-recording
  - dayflow://stop-recording
- Deep links work when app is running and on cold start.

Packaging + QA
- Signed/notarized (where required) packaged builds for the chosen OS targets.
- Regression checklist exists and is run for each release.
