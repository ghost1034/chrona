# Dayflow Cross-Platform Build Plan

This plan translates the *behavioral contract* of the original macOS Dayflow app (`docs/ORIGINAL.md`) into the cross‑platform Electron reimplementation described in `docs/NEW.md`.

**Hard constraints (must-haves):**
- Electron desktop app
- Capture via `desktopCapturer` periodic screenshots
- Gemini only (no GPT/Claude/local models)
- No Journal feature (no UI, reminders, gating, or DB tables)
- Preserve: batching + 60s cadence + 24h lookback + sliding 1‑hour window card generation + 4 AM day boundary + retry + export/copy + optional timelapses + tray behavior + deep links

---

## Phase 0 — Project Decisions & Acceptance Criteria

**Goal:** lock scope and “done” definitions so engineering choices don’t drift.

**Deliverables**
- `docs/DECISIONS.md` (or similar): supported OSes, minimum Electron version, release strategy, storage/privacy stance.
- `docs/ACCEPTANCE.md`: feature checklist aligned to `docs/NEW.md` invariants.

**Key decisions to make**
- OS targets for V1 (recommend: macOS + Windows; Linux optional).
- UI stack for renderer (recommend: React + Vite + TypeScript).
- SQLite binding (recommend: `better-sqlite3` for simplicity/transactions; validate packaging story).
- Video/timelapse tooling (recommend: `ffmpeg` bundled via `ffmpeg-static` or app-bundled binaries; confirm licensing/packaging).
- Update mechanism (optional): Electron auto-updater vs manual download; defer if not needed for MVP.

**Exit criteria**
- A written MVP definition that matches `docs/NEW.md` sections 1–7 and 9 (minus timelapse).

---

## Phase 1 — Repo Scaffolding & App Shell

**Goal:** running Electron app with clean separation of main/renderer/shared and a typed IPC foundation.

**Deliverables**
- Electron app boots in dev + packaged build runs locally.
- Main process: `app` lifecycle, single-instance guard, tray/window semantics (“close hides, quit exits”).
- Typed IPC contract skeleton (channels stubbed; no DB calls from renderer).

**Work items**
- Initialize TypeScript monorepo-ish layout:
  - `src/main/*`, `src/renderer/*`, `src/shared/*`
- Implement `ipcMain.handle` request/response wrappers + event emitters.
- Basic settings storage: `settings.json` under `app.getPath('userData')`.
- Logging: app log file + structured console logs (no PII by default).

**Exit criteria**
- `npm run dev` opens window; tray menu works; renderer can call a trivial IPC method.

---

## Phase 2 — Storage Foundation (SQLite + Filesystem)

**Goal:** stable data model and persistence that matches the cross-platform schema in `docs/NEW.md` (journal-free).

**Deliverables**
- SQLite schema + migrations for:
  - `screenshots`, `analysis_batches`, `batch_screenshots`
  - `observations`, `timeline_cards`, `timeline_review_ratings`
  - `llm_calls`
- StorageService with transactional helpers and path management rooted at `userData`.

**Work items**
- Implement DB open with pragmas (WAL, synchronous=NORMAL, busy_timeout, foreign_keys=ON).
- Implement filesystem layout:
  - `db/dayflow.sqlite`
  - `recordings/screenshots/YYYY-MM-DD/<timestamp>.jpg`
  - `timelapses/YYYY-MM-DD/<cardId>.mp4` (reserved for later)
- Implement core queries needed for later phases:
  - insert screenshot row + file write
  - fetch unprocessed screenshots (24h lookback, not deleted, not in join table)
  - insert batch + join rows
  - insert observations
  - replace cards in range (soft-delete + insert) preserving unrelated `System` cards
  - apply review rating segments (fragment/reinsert)

**Exit criteria**
- A minimal node-only smoke script (or hidden dev command) can write/read the DB and validate schema.

---

## Phase 3 — Time Model & “4 AM Boundary” Utilities

**Goal:** enforce the same “logical day” behavior as the original app and the new spec.

**Deliverables**
- Shared time utilities:
  - `dayKey(ts)` = local time minus 4 hours, formatted `YYYY-MM-DD`
  - day window for UI: `[4:00, 28:00)` local time
- Card display formatting derives from canonical `start_ts/end_ts` (avoid clock-string ambiguity).

**Work items**
- Implement timezone-safe conversion and formatting helpers.
- Define invariants for all DB writes:
  - `start_ts/end_ts` required for timeline cards.
  - derive `start/end` display strings on insert/update.

**Exit criteria**
- Unit tests cover: day boundary around midnight + DST + 4 AM cutoff.

---

## Phase 4 — Capture Pipeline (desktopCapturer)

**Goal:** cross-platform screenshot capture loop that records to disk + DB and supports pause semantics.

**Deliverables**
- CaptureService in main process:
  - interval capture (default 10s) with drift correction
  - selected display handling (user selection + cursor-based fallback with hysteresis)
  - pause model: `desiredRecordingEnabled` vs `isSystemPaused`
  - robust error surface (permission / transient failures)
- Tray actions wired:
  - start/stop (or pause/resume)
  - open main window
  - open recordings folder

**Work items**
- `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` and source selection by `display_id`.
- JPEG encoding + scaling to control storage/Gemini costs (target ~1080p height).
- System pause hooks via `powerMonitor` events (`suspend/resume`, `lock-screen/unlock-screen` where supported).
- Optional: cursor overlay toggle (draw cursor glyph into image).

**Exit criteria**
- When enabled, screenshots land in `recordings/screenshots/*` and rows appear in `screenshots`.
- Pause and system suspend/resume behave as specified in `docs/NEW.md`.

---

## Phase 5 — Batching + Analysis Scheduler

**Goal:** produce `analysis_batches` deterministically from unprocessed screenshots with the same rules as the original.

**Deliverables**
- AnalysisScheduler running every 60s:
  - look back 24h only
  - find “unprocessed screenshots”
  - create Gemini-tuned batches: target 30m, max gap 5m
  - drop incomplete trailing batch
  - mark skip/failure cases (`failed_empty`, `skipped_short`)
- Batch queue with concurrency limits and per-batch status transitions.

**Work items**
- Implement batching algorithm (gap + duration + incomplete tail) exactly once in shared code + tests.
- Persist batches and join rows transactionally.
- Implement batch status machine in DB.

**Exit criteria**
- Given a synthetic set of screenshots, batches match expected boundaries and are persisted correctly.

---

## Phase 6 — Gemini Integration (Transcribe → Observations)

**Goal:** convert batches of screenshots into timestamped observations using Gemini only, with privacy-safe call logging.

**Deliverables**
- GeminiService:
  - API key storage via `keytar`
  - retry/backoff and timeouts
  - sanitized `llm_calls` logging (redact Authorization/API keys; truncate bodies by default)
- Transcription implementation:
  - build 1 fps “compressed timeline” video from screenshots in a batch
  - send to Gemini; receive JSON observations with `MM:SS` timestamps
  - expand timestamps into real `start_ts/end_ts` using `screenshotIntervalSeconds`
  - persist to `observations`

**Work items**
- Implement video builder (likely `ffmpeg`):
  - deterministic frame ordering
  - robust to missing screenshots
- Implement strict JSON parsing + schema validation; fail batch with reason on invalid output.

**Exit criteria**
- For a real batch, observations are inserted and batch status transitions to “transcribed” (or equivalent).

---

## Phase 7 — Gemini Integration (Observations → Timeline Cards)

**Goal:** generate timeline cards using the sliding 1‑hour window rule and replace cards atomically.

**Deliverables**
- Card generation step:
  - window end = `batch_end_ts`
  - window start = `batch_end_ts - 3600`
  - load observations overlapping window
  - load existing non-System cards overlapping window for context
  - generate cards via Gemini with category constraints
- Replace-in-range transaction:
  - soft-delete overlaps (preserving unrelated `System` cards)
  - insert new cards with canonical timestamps + derived display strings + `dayKey`
- Error path:
  - on failure, mark batch failed and insert a `System/Error` card spanning batch range.

**Work items**
- Implement deterministic validators before insert:
  - no inverted ranges, reasonable duration, allowed categories, overlaps policy.
- Implement `analysis:retryBatch` mechanics (re-run transcribe/generate, cleanly).

**Exit criteria**
- Timeline cards appear for the correct dayKey and update smoothly across batches.

---

## Phase 8 — Renderer UI: Timeline, Details Panel, Export/Copy

**Goal:** feature-complete “read” experience for the timeline with export/copy parity.

**Deliverables**
- Timeline page:
  - day selector (4 AM boundary “Today”)
  - vertical timeline grid 4 AM→4 AM
  - cards positioned by `start_ts/end_ts`
  - overlap mitigation display-only (no DB mutation)
- Right panel:
  - selected card details + timelapse preview placeholder
  - category change dropdown (writes via IPC)
- Export/copy:
  - copy day to clipboard (Markdown-ish format)
  - export date range to Markdown file

**Work items**
- Renderer state management (query by dayKey; subscribe to `event:timelineUpdated`).
- Implement Markdown formatter consistent with original shape (header + numbered entries + optional blocks).

**Exit criteria**
- A user can browse days, inspect cards, and export a range without touching the DB directly.

---

## Phase 9 — Review Workflow (Focus/Neutral/Distracted)

**Goal:** parity with original review overlay: segment-based ratings and “unreviewed if <80% covered”.

**Deliverables**
- Review overlay UI:
  - loads cards excluding System
  - shows only cards with <80% rating coverage
  - persists rating segments via `applyReviewRating`
- Review summary for day:
  - reviewed vs unreviewed count
  - optional per-category time rollups

**Work items**
- Implement coverage computation (merge rating segments, compute overlap seconds).
- (Optional improvement) coalesce adjacent same-rating segments to reduce fragmentation.

**Exit criteria**
- Rating segments persist and coverage thresholds behave identically for edge cases (overlaps, fragments).

---

## Phase 10 — Retention, Cleanup, and Storage UI

**Goal:** enforce storage limits and provide user controls, matching behaviors from original/new docs.

**Deliverables**
- Hourly purge job:
  - screenshots: enforce limit (default 10 GB), delete oldest in bounded batches, mark `is_deleted`, remove files
  - straggler cleanup (files not referenced by active DB rows)
- Same for timelapses (separate accounting).
- Settings UI:
  - limits + “Purge now”
  - display capture settings (interval, selected display, cursor toggle)

**Exit criteria**
- Long-running app keeps disk usage within configured bounds.

---

## Phase 11 — Timelapse Generation (Optional, Full Fidelity)

**Goal:** generate per-card MP4 summaries from screenshots and attach to cards.

**Deliverables**
- TimelapseService (worker thread / child process):
  - builds per-card MP4 from screenshots in `[start_ts, end_ts]`
  - stores at `timelapses/YYYY-MM-DD/<cardId>.mp4`
  - updates `timeline_cards.video_summary_url`
- UI playback in details panel.

**Work items**
- ffmpeg concat list generation and frame timing strategy.
- Cleanup of old timelapses and of replaced cards’ `video_summary_url` targets.

**Exit criteria**
- New cards eventually gain timelapses; replacing cards cleans up old videos.

---

## Phase 12 — Deep Links, Auto-Start, and OS Integration

**Goal:** make the app feel native enough on each platform and preserve automation hooks.

**Deliverables**
- Protocol handler: `dayflow://start-recording`, `dayflow://stop-recording` (+ optional pause/resume).
- Auto-start option (platform-specific) with clear UX.
- “Open recordings folder” implemented cross-platform.

**Exit criteria**
- Deep links toggle recording state reliably when app is running (and handle cold start).

---

## Phase 13 — Packaging, Releases, and QA

**Goal:** shippable installers with a regression checklist for long-running correctness.

**Deliverables**
- Packaged builds for target OSes, including native deps (`better-sqlite3`, `keytar`, ffmpeg strategy).
- QA checklist (manual):
  - multi-monitor switching
  - suspend/resume correctness
  - macOS screen recording permission UX
  - long-run (8h+) stability and purge
- Automated tests:
  - unit: dayKey, batching, replace-in-range, review coverage
  - integration: DB migrations; Gemini request construction (HTTP mocked)

**Exit criteria**
- A non-dev user can install, record, see timeline, review, export, and recover from failures via retry.

---

## Suggested Milestones

- **MVP (usable):** Phases 1–8 (capture → Gemini → cards → timeline → export).
- **Fidelity (parity):** + Phase 9–10 (review + retention + purge UI).
- **Polish (near-original feel):** + Phase 11–13 (timelapses + deep links + packaging/QA).
