# Testing Guide

This document explains how to run Dayflow locally and how to test each phase/commit incrementally.

Related docs:
- `docs/ACCEPTANCE.md` (what "done" means)
- `docs/QA_CHECKLIST.md` (manual regression checklist)
- `docs/RELEASE.md` (packaging)

---

## Prerequisites

Required for all platforms:
- Node.js + npm (this repo currently uses npm scripts).
- Git.

Recommended:
- ffmpeg available on PATH for dev runs (packaged builds will try to use bundled `ffmpeg-static`).
- A Gemini API key (optional if using mock mode).

macOS notes:
- Screen recording permission must be granted to capture screenshots.
- Deep links via `dayflow://...` are most reliable from packaged builds.

Windows notes:
- Multi-monitor capture works via Electron `desktopCapturer`, but you should test on at least one multi-monitor setup.

---

## Getting oriented (where does Dayflow store data?)

Dayflow stores everything under Electron `app.getPath('userData')`:
- SQLite DB: `db/dayflow.sqlite`
- Screenshots: `recordings/screenshots/YYYY-MM-DD/*.jpg`
- Timelapses: `timelapses/YYYY-MM-DD/<cardId>.mp4`
- Logs: `logs/app.log`

How to find the exact `userData` path on your machine:
- Start the app; it logs `app.paths` to console and writes to `logs/app.log`.

Resetting state between tests:
- Quit Dayflow.
- Delete the entire `userData` directory (recommended when switching commits to avoid schema/behavior drift).

---

## Running the app (development)

From the repo root:

1) Install dependencies (also rebuilds native modules via `postinstall`):
   - `npm install`

2) Run in development mode:
   - `npm run dev`

What you should see:
- A window opens.
- A tray icon appears.
- Closing the window hides it (app stays running).
- Quit from tray exits.

Common dev environment variables:
- `DAYFLOW_DEV_SERVER_URL=http://localhost:5173` (used by the dev script internally)
- `DAYFLOW_GEMINI_API_KEY=...` (Gemini key fallback)
- `DAYFLOW_GEMINI_MOCK=1` (bypass real Gemini calls)
- `FFMPEG_PATH=/path/to/ffmpeg` (override ffmpeg binary)

---

## Running checks (fast feedback)

- Typecheck:
  - `npm run typecheck`

- Unit tests:
  - `npm test`

- Build (main + renderer):
  - `npm run build`

- DB smoke test (creates a temp userData dir and exercises storage APIs):
  - `npm run db:smoke`

- Analysis smoke test (creates synthetic screenshots and runs batching + pipeline):
  - `DAYFLOW_GEMINI_MOCK=1 npm run analysis:smoke`
  - Optional (tries timelapse generation; best with real screenshots):
    - `DAYFLOW_GEMINI_MOCK=1 DAYFLOW_SMOKE_TIMELAPSE=1 npm run analysis:smoke`

---

## Using the app for manual testing

### 1) Capture

- Start/stop recording:
  - Use the Tray menu or the Capture panel.
- Verify screenshots are written:
  - Click "Open recordings" and confirm `recordings/screenshots/...` fills with JPGs.
- Pause semantics:
  - Put the machine to sleep and wake it; capture should pause during sleep.
  - Stop/start should not get stuck.

### 2) Analysis pipeline

- Batching + scheduling:
  - Batches are created from unprocessed screenshots (24h lookback) and only when a full target batch exists.
  - You can force a tick from the UI ("Run analysis tick").
- Gemini:
  - In real mode: set your key in the UI or export `DAYFLOW_GEMINI_API_KEY`.
  - In mock mode: set `DAYFLOW_GEMINI_MOCK=1` before starting the app.

### 3) Timeline

- Switch to Timeline view.
- Verify 4 AM boundary:
  - The visible day runs from 4:00 AM to next day 4:00 AM (local time).
- Click cards to open details.
- Change category/subcategory and confirm it persists (reload the day).

### 4) Review

- Switch to Review view.
- Cards appear only when rating coverage is < 80%.
- Rate a card (Focus/Neutral/Distracted) and confirm it disappears once covered.

### 5) Export

- Click "Copy" and paste into a text editor.
- Click "Export" and choose a file; verify the Markdown output.

### 6) Storage + retention

- Storage section shows usage for recordings and timelapses.
- Change limits and click "Save limits".
- Click "Purge now" and verify:
  - Screenshot count decreases.
  - Disk usage decreases.
  - App remains stable.

### 7) Timelapses (optional)

- Enable "Generate timelapses".
- After cards are generated, select a card; if it has `video_summary_url`, a video player appears.

Notes:
- Timelapse encoding requires ffmpeg; packaged builds try to use bundled ffmpeg.
- Timelapses are best tested with real screenshots (the smoke tests use a tiny synthetic JPEG).

### 8) Deep links + auto-start

Deep links (app running):
- Use a second instance to send args:
  - `npx electron . "dayflow://start-recording"`
  - `npx electron . "dayflow://stop-recording"`

Deep links (packaged build):
- Install/run a packaged build (see Phase 13 section below).
- On macOS you can then try:
  - `open "dayflow://start-recording"`

Auto-start:
- Toggle "Launch at login".
- On next login, confirm the app starts (platform-specific behavior).

---

## Incremental testing by commit (phase-by-phase)

You said you made one commit per phase. The safe loop for each commit is:

1) Checkout the commit.
2) `npm install` (native modules are rebuilt; do this after switching commits).
3) Clear `userData` (recommended) so old DB/schema doesn’t influence behavior.
4) `npm run typecheck && npm test`.
5) `npm run dev` and do the phase’s manual checks.

Suggested phase checks:

Phase 1 (App shell)
- Dev app launches, tray exists, close hides, quit exits.
- Preload IPC works (UI can call a simple IPC method).

Phase 2 (SQLite + filesystem)
- DB created under `userData/db/dayflow.sqlite`.
- `npm run db:smoke` passes.

Phase 3 (Time model)
- `npm test` covers 4 AM boundary and DST handling.

Phase 4 (Capture)
- Start recording and confirm screenshots land on disk + in DB.
- Suspend/resume does not spam errors.

Phase 5 (Batching + scheduler)
- `DAYFLOW_GEMINI_MOCK=1 npm run analysis:smoke` creates batches.
- Verify trailing incomplete batch is dropped.

Phase 6 (Transcribe -> observations)
- With `DAYFLOW_GEMINI_MOCK=1`, a batch reaches `transcribed`.
- With real key, verify `llm_calls` rows are created and API key is not logged.

Phase 7 (Observations -> cards)
- With `DAYFLOW_GEMINI_MOCK=1`, a batch reaches `analyzed` and inserts cards.
- Force an error (e.g. unset key and disable mock) and confirm a System/Error card appears.

Phase 8 (Timeline UI + export)
- Timeline renders cards correctly for the day.
- Copy + export work.

Phase 9 (Review)
- Review list filters by <80% coverage and rating writes segments.

Phase 10 (Retention)
- Purge now works and usage updates.

Phase 11 (Timelapses)
- Enable timelapses and verify videos appear for cards (using real screenshots).

Phase 12 (Deep links + auto-start)
- Deep links toggle recording when running.
- Auto-start toggle persists.

Phase 13 (Packaging)
- `npm run pack` produces an unpacked app under `release/`.
- Packaged build launches and behaves like dev.

---

## Packaging smoke (Phase 13)

Unpacked build:
- `npm run pack`
- Launch the output in `release/` and verify:
  - tray behavior
  - capture permissions + capture
  - deep links (if protocol registration succeeds on your OS)

Signed/notarized builds are out of scope for local testing unless you configure certificates.
