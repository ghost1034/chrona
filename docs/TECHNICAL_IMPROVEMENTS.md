# Technical Improvements (Dayflow Cross-Platform)

This document proposes engineering-focused improvements to the current cross-platform Dayflow implementation.

Scope: architecture, security, reliability, performance, storage, observability, and developer experience.
Non-goals: product expansion (see `docs/NEW_FEATURES.md`) and purely UX/flow changes (see `docs/FEATURE_IMPROVEMENTS.md`).

References:
- Behavioral contract and constraints: `docs/NEW.md`
- Original implementation notes (for parity context): `docs/ORIGINAL.md`

## Guiding Principles

- Privacy-first defaults: screenshots are sensitive; avoid network/telemetry beyond explicit Gemini calls.
- Main process responsiveness: capture + IPC must remain responsive even while analysis/timelapse work runs.
- Bounded resources: cap disk growth (already), cap DB/log growth, cap memory spikes, and avoid unbounded queues.
- Determinism + debuggability: same inputs should produce consistent outputs; failures should be diagnosable.
- Cross-platform correctness: feature behavior should be consistent across macOS/Windows (Linux optional).

## Current Baseline (Observed)

- Electron app with typed IPC (`src/shared/ipc.ts`), renderer UI in React (`src/renderer/App.tsx`).
- Storage: SQLite via `better-sqlite3` with WAL pragmas and a v1 schema (`src/main/storage/schema.ts`).
- Capture: periodic screenshots saved to `recordings/` and inserted into `screenshots`.
- Analysis: batches screenshots, transcribes via Gemini using a compressed MP4, then generates cards.
- Timelapses: ffmpeg-based encoding to MP4 per card, served to renderer via a custom file protocol.
- Retention: periodic purge for recordings + timelapses with usage reporting.

## Prioritization

- P0: security, data integrity, "won't break long-run", and main-thread responsiveness.
- P1: performance/cost efficiency and improved debuggability.
- P2: maintainability, polish, and future-proofing.

## P0 Improvements

### 1) Harden Renderer Security (Sandbox + CSP + Navigation Controls)

Problem:
- `sandbox: false` weakens Electron security boundaries.
- CSP is not guaranteed in production builds; navigation/open-window rules may be permissive by default.

Proposal:
- Enable renderer sandbox (`webPreferences.sandbox: true`) unless a specific dependency requires disabling it.
- Add a strict Content Security Policy for production builds.
- Block or tightly control:
  - `window.open`
  - navigation away from app origin
  - unexpected protocol loads

Implementation sketch:
- `src/main/window.ts`: set `sandbox: true` and ensure preload still works.
- `src/renderer/index.html`: add CSP meta tag for prod build; keep dev relaxed.
- `webContents.setWindowOpenHandler(...)`: deny by default, allow `https:` to open in external browser.
- `will-navigate` listener: prevent non-app navigation.

Acceptance criteria:
- App functions unchanged in dev + packaged builds.
- Attempts to open new windows are denied or delegated to `shell.openExternal`.
- CSP violations do not occur during normal operation.

Risks:
- Some libraries expect non-sandboxed renderer behavior; validate early.

### 2) Graceful Shutdown + Data Integrity

Problem:
- Long-running apps risk DB corruption or partial writes if services are not stopped and SQLite isn't closed cleanly.

Proposal:
- Add an orderly shutdown sequence:
  - stop capture scheduler
  - stop analysis scheduler/queue
  - stop retention timers
  - wait for in-flight DB queue tasks
  - close SQLite

Implementation sketch:
- Add a single `AppController` (or similar) that owns service lifecycle.
- Hook `app.on('before-quit')`, `app.on('will-quit')`, `process.on('SIGINT')` in dev.
- Ensure `StorageService.close()` drains pending work.

Acceptance criteria:
- Quit while encoding/transcribing does not crash.
- No partial DB transactions; no locked DB on next start.

### 3) Stuck Batch Recovery + Idempotent Analysis

Problem:
- If the app crashes mid-batch, `analysis_batches.status` can remain in a processing state and never recover.

Proposal:
- Add `updated_at` (or `status_updated_at`) and make state transitions update it.
- On startup, requeue batches that are "processing_*" and older than N minutes.

Implementation sketch:
- Schema migration v2:
  - add `updated_at` column to `analysis_batches`
  - backfill with `created_at`
- Update status setters to write `updated_at = CURRENT_TIMESTAMP`.
- Startup job: find stuck batches and move them to `pending` or the last safe stage.

Acceptance criteria:
- Killing the app during processing does not permanently stall analysis.
- A restarted app continues progressing without manual DB edits.

### 4) Move Heavy Work Off the Main Event Loop

Problem:
- MP4 creation + base64 encode + ffmpeg spawn orchestration can cause main-process hiccups.

Proposal:
- Use `worker_threads` or a child process for CPU/memory-heavy work:
  - Gemini preprocessing (video building, base64 conversion)
  - timelapse encoding orchestration

Implementation sketch:
- Introduce a "media worker": main process sends a job `{ type, inputPaths, outputPath, options }`.
- Worker reports progress and final status.

Acceptance criteria:
- UI remains responsive while a batch is processed and while timelapses are generated.
- Capture schedule does not drift significantly under load.

### 5) Robust Error Taxonomy + User-Safe Error Surfaces

Problem:
- Errors are currently mostly strings; renderer may not be able to distinguish permission issues vs transient network vs rate limits.

Proposal:
- Standardize errors as `{ domain, code, message, retryable, userActionHint }`.
- Keep raw stack traces out of renderer by default; expose them only in a debug bundle.

Implementation sketch:
- Create `src/main/errors.ts` with typed error helpers.
- Wrap IPC handlers to convert exceptions into structured responses.

Acceptance criteria:
- Renderer can show specific, actionable instructions (e.g., "enable Screen Recording permission").
- Retry UI knows when to offer "try again" vs "configure key".

## P1 Improvements

### 6) Reduce Gemini Memory/Cost Spikes (Avoid Full MP4 Base64 in Memory)

Problem:
- Reading MP4 into a Buffer and base64 encoding can be a large, spiky allocation.

Proposal options (choose based on Gemini API constraints):
- Preferred: use file upload APIs (if available) instead of inline base64.
- Fallback: clamp MP4 size aggressively:
  - lower resolution targetHeight
  - higher CRF
  - cap batch frame count by sampling (e.g., 1 frame per N screenshots) when batch is large
  - enforce max request size with a clear "failed_too_large" reason.

Acceptance criteria:
- Peak memory during transcription stays under a defined bound (e.g., < 500MB) on typical day workloads.
- Very large batches fail gracefully with actionable reason.

### 7) Strengthen Gemini Resilience (Better Retry + Backoff + Rate Limit Handling)

Problem:
- Current retry is exponential backoff but treats all failures similarly.

Proposal:
- Classify failures:
  - 4xx auth/config -> non-retryable
  - 429/rate limit -> retry with jitter + longer backoff
  - 5xx/transient -> retry quickly
  - timeouts -> retry with increased timeout once
- Record attempt-specific statuses in `llm_calls`.

Acceptance criteria:
- Fewer "false failures" during transient outages.
- Logs clearly show why a request failed and whether it was retried.

### 8) SQLite Query + Index Review (Scale to Long-Running Use)

Problem:
- Some queries will slow down with large screenshot volumes; missing indexes can become expensive.

Proposal:
- Review and optimize:
  - unprocessed screenshot selection (avoid `NOT IN` patterns)
  - range queries on `timeline_cards` and `observations`
- Add indexes as needed:
  - `timeline_cards(end_ts)` or composite `(start_ts,end_ts)` for overlap queries
  - `observations(start_ts)` if used frequently
- Periodically run `PRAGMA optimize`.

Acceptance criteria:
- Day load and analysis tick remain fast after weeks of data.

### 9) Bound DB/Log Growth (Retention for Debug Tables)

Problem:
- `llm_calls` and file logs can grow indefinitely.

Proposal:
- Add retention policies:
  - cap `llm_calls` by age (e.g., 14 days) or row count
  - rotate `logs/app.log` by size (keep last N files)
- Add a UI action "Clear debug logs".

Acceptance criteria:
- Disk usage remains bounded even with verbose debugging left on.

### 10) Concurrency Controls + Backpressure

Problem:
- Multiple pipelines (capture, analysis, timelapse, purge) can compete for IO/CPU.

Proposal:
- Enforce explicit concurrency limits:
  - analysis: 1 batch at a time (likely already)
  - timelapse: 1-2 encodes at a time
  - purge: do not run while encoding; or run with reduced IO concurrency

Acceptance criteria:
- No "thundering herd" of ffmpeg processes.
- Capture doesn't starve due to background work.

## P2 Improvements

### 11) Runtime Input Validation for IPC

Problem:
- TypeScript types are compile-time; runtime IPC payloads are untrusted.

Proposal:
- Validate IPC inputs using a small schema library (e.g., zod) or hand-rolled guards.

Acceptance criteria:
- Malformed renderer requests cannot crash the main process.

### 12) Improve Settings Persistence + Migration Story

Problem:
- `settings.json` uses `version: 4` but migrations are implicit merges.

Proposal:
- Add explicit migrations:
  - validate types and clamp ranges
  - log when a migration occurs
- Consider splitting secrets vs non-secrets clearly.

Acceptance criteria:
- Corrupted or older settings recover safely with minimal surprises.

### 13) Developer Tooling: Integration Tests + CI Gates

Problem:
- CI currently builds packages but may not run unit/type checks.

Proposal:
- Add CI steps:
  - `npm run typecheck`
  - `npm test`
  - optional: lint
- Add integration tests for:
  - batching rules
  - 4AM day boundary (DST)
  - replace-in-range
  - review segment coverage

Acceptance criteria:
- Regressions are caught before packaging.

### 14) Observability: "Debug Bundle" Generator (Sanitized)

Problem:
- Troubleshooting often requires many separate logs/DB snippets.

Proposal:
- Add a one-click export of a sanitized debug bundle:
  - app version, OS, settings (redacted), capture state
  - recent `analysis_batches`, recent `llm_calls` (redacted, bodies optional)
  - optionally a small sample of card rows

Acceptance criteria:
- Users can report issues without sharing screenshots or secrets.

### 15) Refactor Renderer for Maintainability

Problem:
- `src/renderer/App.tsx` is very large; changes become risky.

Proposal:
- Split into:
  - `TimelineView`, `ReviewView`, `SidePanel`, `SettingsPanel`
  - shared hooks: `useTimeline(dayKey)`, `useCaptureState()`, `useStorageUsage()`

Acceptance criteria:
- No functional changes; code becomes easier to extend.

## Suggested Execution Order

1. P0: security hardening (sandbox/CSP/navigation)
2. P0: graceful shutdown + stuck batch recovery
3. P0/P1: move heavy work to worker + add concurrency limits
4. P1: Gemini memory/cost controls
5. P1/P2: DB/log retention + IPC runtime validation
6. P2: CI/test improvements + renderer refactor
