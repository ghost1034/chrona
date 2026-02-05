# Feature Improvements (Dayflow Cross-Platform)

This document proposes improvements to existing Dayflow features (parity features already implemented): capture, analysis, timeline UI, review, export, retry, retention, timelapses, tray, and deep links.

Scope: better UX, clearer workflows, and higher user trust without expanding the product surface area.
Non-goals: new major capabilities (see `docs/NEW_FEATURES.md`).

## Principles

- Make failures actionable ("what happened", "what can I do", "retry").
- Keep the app transparent about privacy (what gets stored, what is sent to Gemini).
- Prefer fast, keyboard-friendly flows.

## UX Baseline (Observed)

- Timeline + Review are implemented and usable.
- Capture controls and settings currently live largely in the "empty selection" side panel.
- Debug tooling exists via a few IPC helpers (run analysis tick, recent batches), but isn't a coherent workflow.
- Timelapse playback works via `dayflow-media://` URLs, but status/repair actions are limited.

## Design Conventions (Recommended)

- "One primary action" per panel (avoid multiple competing "Save" buttons).
- Prefer optimistic UI updates with eventual consistency (and clear error recovery).
- Every background job should have a visible state: queued -> running -> succeeded/failed.
- "Privacy labels" on anything that can leak data (Gemini calls, optional network fetches).

## P0 Improvements

### 1) Retry Workflow: First-Class, Visible, and Informative

Current behavior:
- Failures surface as a System card ("Processing failed"), but the retry experience is minimal.

Improvements:
- Add a retry panel for failed batches:
  - show stage (transcribe vs generate)
  - show last error reason
  - show last attempt time + attempt count
  - "Retry" and "Retry all failures for this day" actions
- Add a "stuck processing" indicator with a "recover" action (ties to technical stuck-batch recovery).

Acceptance criteria:
- A user can reliably recover from transient failures without restarting the app.

Implementation notes:
- Add an IPC endpoint for retrying a specific batch and for listing failures by day.
- Add a small batch details endpoint (status, reason, last update time, last LLM call summary) so the UI can be helpful without exposing raw content.

### 2) Capture Permission & Diagnostics Flow

Problem:
- Capture failures on macOS are often permission-related; users need guidance.

Improvements:
- Add an onboarding/diagnostics page:
  - "Test capture" preview frame
  - detect black/empty captures
  - one-click "Open system settings" to the correct pane (best-effort)
- Differentiate "permission" vs "transient" errors.

Acceptance criteria:
- A user who has not granted permission can self-serve resolution.

Implementation notes:
- Add a "Capture diagnostics" screen that can be reached from:
  - first run
  - a persistent banner when capture is failing
  - tray menu
- Show:
  - last successful capture time
  - failure count and last error
  - a "Preview" frame (not saved) with a "Looks good" confirmation.

### 3) Storage UI: Make Retention Understandable

Improvements:
- Display breakdown:
  - screenshots count + size
  - timelapse count + size
  - "last purge" time and result
- Purge UX:
  - "dry run" preview (how many files will be removed)
  - clear confirmation for large purges

Acceptance criteria:
- Users trust that purges are safe and predictable.

Implementation notes:
- Add a "last purge" timestamp and last purge summary to settings.
- Add a "why did storage jump" hint: show how many screenshots were captured in the last hour/day.

### 4) Make Capture State Trustworthy (Explicit Pause/Resume + Timers)

Problem:
- Users need confidence about whether the app is actually recording and why it may stop.

Improvements:
- Distinguish:
  - Recording (user intent ON)
  - Paused (user intent OFF)
  - System paused (sleep/lock)
  - Error paused (capture failing/backoff)
- Add "Pause for" presets: 5m / 15m / 1h / until tomorrow.
- Display a "next capture in Xs" indicator when recording.

Acceptance criteria:
- Users can always answer: "Am I recording? If not, why not?" within 5 seconds.

## P1 Improvements

### 5) Timeline Readability & Interaction

Improvements:
- Category color system (consistent, accessible): Work/Personal/Distraction/Idle/System.
- Better tiny-card rendering:
  - hover/tooltip already exists; add keyboard focus behavior
  - improved selection affordances
- "Now" quality-of-life:
  - optional auto-scroll-to-now for Today
  - show an "out of view" indicator when now line is above/below viewport

Acceptance criteria:
- Timeline is readable at multiple zoom levels and usable without a mouse.

Implementation notes:
- Improve overlap mitigation in renderer to match the original's intent (trim longer segments so smaller segments remain intact).
- Add a subtle background shading for hours with no data (helps users spot gaps without implying "Idle").

### 6) Card Details: Make Evidence and Metadata Useful (Without New Concepts)

Improvements:
- Details panel additions:
  - show the batch ID and processing status
  - show app/site hints parsed from metadata when present
  - "Copy card" and "Copy debug info" actions

Acceptance criteria:
- A user can understand why a card exists and what it was based on.

Implementation notes:
- Add a "Batch" block with:
  - batch time range
  - status
  - retry button if failed
- Add a "Copy" dropdown:
  - Copy card markdown
  - Copy card JSON
  - Copy debug snippet (no secrets)

### 7) Review Workflow Speed

Improvements:
- Keyboard shortcuts:
  - next/prev unreviewed
  - focus/neutral/distracted hotkeys
- Visible progress:
  - coverage bar and remaining count
- Optional coalescing of adjacent same-rating segments (reduces fragmentation).

Acceptance criteria:
- Rating a day's cards is fast and can be done entirely with keyboard.

Implementation notes:
- Make the review list navigable with arrow keys and focus rings.
- Persist a "coverage threshold" setting (default 80%) for power users.

### 8) Export Improvements (Without Changing Format)

Improvements:
- Export options:
  - include/exclude System cards
  - include/exclude Details
  - include review stats summary at top (optional)
- Export preview before saving.

Acceptance criteria:
- Users can export clean reports suitable for sharing.

Implementation notes:
- Add presets:
  - Today
  - Yesterday
  - Last 7 days
  - Custom range
- Support saving directly to a chosen folder with remembered last path.

### 9) Analysis Transparency (Non-Debug Users)

Problem:
- Users currently get little feedback on whether analysis is working or backlogged.

Improvements:
- Add a small, non-intrusive "Analysis" status line:
  - last run time
  - queue size
  - last successful batch window
- Add "Recent batches" list with:
  - status
  - reason on failure
  - retry action

Acceptance criteria:
- Users can tell if Dayflow is "keeping up" without opening dev tools.

## P2 Improvements

### 10) Settings Organization

Improvements:
- Split settings into sections:
  - Capture
  - Analysis (Gemini)
  - Storage
  - Advanced/Debug
- Make debug settings explicit about privacy (e.g., "store request/response bodies" toggle).

Acceptance criteria:
- Users can find settings quickly and understand privacy impact.

Implementation notes:
- Move capture/storage/gemini settings out of the timeline side panel into a dedicated Settings view.
- Keep the side panel focused on card details and "today" quick controls.

### 11) Tray/Menu Bar Polish

Improvements:
- Real tray icons per state (recording/paused/error/idle) on macOS and Windows.
- Add quick actions:
  - pause/resume (if supported)
  - open "Today"
  - run analysis tick (debug-only)

Acceptance criteria:
- Tray reflects the real state and provides the most common actions.

Implementation notes:
- Add a "Pause for" submenu.
- Add a "Show status" disabled menu item with last capture time.

### 12) Timelapse UX

Improvements:
- Indicate timelapse generation status (queued/encoding/ready/failed).
- Provide a "Regenerate timelapse" action for a card.
- Handle missing video file gracefully with a repair action.

Acceptance criteria:
- Timelapses feel reliable and self-healing.

Implementation notes:
- If the file is missing, show a "Repair" button that re-enqueues encoding.
- Add a setting for timelapse quality presets (fast vs high quality).

### 13) Accessibility and Input Quality

Improvements:
- Ensure all interactive cards are keyboard-focusable with visible focus.
- Improve color contrast for text and category indicators.
- Add ARIA labels for icon-only buttons.

Acceptance criteria:
- Timeline and review can be used with keyboard only.
