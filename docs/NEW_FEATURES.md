# New Features (Dayflow Cross-Platform)

This document proposes new product capabilities to add beyond parity with the original Dayflow behavior.

Constraints to maintain (from `docs/NEW.md`):
- Electron app
- Capture via periodic screenshots
- Gemini only (no other model providers)
- No Journal feature

## Prioritization

- P0: privacy and trust improvements that reduce risk of always-on capture.
- P1: core productivity value (search, editing, notes) built on existing data.
- P2: integrations and optional advanced workflows.

## P0 Features (Privacy + Trust)

### 1) Privacy Zones (Redaction Before Save + Before Gemini)

What:
- Let users define rectangular redaction regions per display.
- Apply redaction to screenshots:
  - before writing to disk
  - before building MP4 for Gemini

Why:
- Always-on screenshots are extremely sensitive; privacy zones reduce risk materially.

Design:
- Settings UI:
  - pick display
  - draw rectangles
  - preview redaction
- Storage:
  - store zone definitions in `settings.json` or a small table
  - version zones by display ID + bounds

Implementation notes:
- Use canvas/image pipeline in main/worker to blur/solid-fill rectangles.
- Add a watermark-like debug overlay optionally for verifying zones.

Acceptance criteria:
- Redacted pixels are never written unredacted to disk.
- Redaction is applied deterministically across platforms.

Edge cases:
- Multi-monitor setups where display IDs change: allow zones to bind by display geometry fingerprint as a fallback.
- Retina/high-DPI scaling: zones must apply in pixel coordinates of the captured image.

### 2) App/Site Exclusion Rules (Auto-Pause Capture)

What:
- Rules like "Do not capture when password manager is focused" or "Do not capture these domains".

Why:
- Prevent capturing known-sensitive contexts.

Design options:
- OS-integrated active window/app detection (best-effort per OS).
- As a fallback, allow manual hotkey "Pause for 5/15/60 minutes".

Acceptance criteria:
- When an exclusion triggers, capture stops (system pause-like) without losing user intent state.

Notes:
- Domain detection from screenshots is non-trivial; treat domain-based exclusions as "best effort" unless an explicit browser integration is added.
- App-based exclusions are more reliable and should be the first implementation target.

### 3) Per-Range Delete/Redact (Right to Forget)

What:
- Select a time range and delete associated screenshots and derived artifacts (observations/timelapses).

Why:
- Users need control over mistakes and sensitive intervals.

Design:
- UI: "Delete 2:10 PM - 2:30 PM".
- Storage:
  - mark screenshots deleted + remove files
  - soft-delete cards in range (category System/Redacted card optional)
  - optionally remove observations in range

Acceptance criteria:
- Files are removed from disk and the timeline reflects the deletion.

Implementation notes:
- Consider adding a "Redacted" System card (optional) so the user sees the gap was intentional.
- Ensure purges and delete-range operations are idempotent.

### 4) Screenshot Viewer + Audit Trail (Evidence Mode)

What:
- A UI to browse screenshots associated with:
  - a card
  - a time range
  - a day

Why:
- Builds trust in the model outputs and makes it possible to correct mistakes safely.

Design:
- "Evidence" tab in card details:
  - thumbnail strip
  - click to open full-size
  - quick actions: delete screenshot, delete range, mark sensitive

Acceptance criteria:
- Viewing evidence does not require accessing the filesystem manually.
- Evidence mode clearly communicates privacy implications.

## P1 Features (Productivity on Top of Existing Data)

### 4) Full-Text Search + Filters

What:
- Search across card title/summary/details and (optionally) observations.
- Filters: category, date range, time-of-day, "has timelapse", "failed".

Implementation notes:
- Use SQLite FTS5 virtual table(s) if available in the shipped SQLite build; otherwise fall back to `LIKE` with indexes.

Acceptance criteria:
- Search returns results quickly across weeks of data.

Implementation details:
- FTS strategy:
  - `cards_fts(title, summary, detailed_summary, day)` and/or `observations_fts(observation, day)`.
  - maintain via triggers or explicit reindex on write.
- Provide a simple query language:
  - `cat:Work`, `day:2026-02-04`, `has:timelapse`, `status:failed`.

### 5) Manual Timeline Editing (Split/Merge/Adjust)

What:
- Allow user edits without fighting the analysis pipeline:
  - split a card
  - merge adjacent cards
  - adjust start/end bounds
  - lock a card so analysis replace-in-range will not overwrite it

Design:
- Add `is_user_locked` + `user_title/user_summary/...` columns (or a separate overrides table).

Acceptance criteria:
- Locked edits persist across future analysis updates.

Implementation details:
- Add an "overrides" layer rather than mutating model outputs directly:
  - store user edits separately and apply them in queries/rendering.
- Ensure replace-in-range respects locks:
  - do not delete locked cards
  - allow inserting new cards around locked segments

UX:
- Provide an "Edit" mode with:
  - drag handles for start/end
  - split button
  - merge adjacent button
  - lock toggle

### 6) Notes + Tags (Non-Journal, Card-Scoped)

What:
- Attach short notes/tags to cards for later search and export.

Why:
- Lightweight reflection without reintroducing a journal product.

Design:
- `card_notes` table keyed by `timeline_cards.id`.
- Include notes optionally in export.

Acceptance criteria:
- Notes are searchable and exportable.

Design notes:
- Keep notes scoped to cards (avoid daily freeform journaling).
- Tags should be small and consistent; consider tag suggestions based on repeated titles.

### 7) "Ask Dayflow" (Gemini Queries Over Existing Text Only)

What:
- Let users ask questions like:
  - "What did I do between 2 and 5?"
  - "Top distractions today"
  - "Summarize work blocks"

Privacy stance:
- By default, do not send screenshots.
- Use only existing cards/observations text, with clear UI disclosure.

Acceptance criteria:
- Queries are opt-in and clearly labeled about what data is sent.

Implementation details:
- Build a prompt that includes:
  - a time-bounded slice of cards + observations
  - explicit instruction: "Do not fabricate; cite which card/time ranges support claims."
- Add guardrails:
  - max window size for a single query
  - show a "data sent" preview
  - optionally redact app/site metadata

### 8) Reports: Daily/Weekly Rollups

What:
- Summaries derived from cards + review ratings:
  - category totals
  - focus coverage
  - streaks
  - top recurring titles

Acceptance criteria:
- Reports are computed locally; Gemini use is optional.

Report ideas:
- Category totals by day and by week.
- Focus coverage trends (from review segments).
- "Top contexts" (most common titles) with time totals.
- "Distraction hotspots" (time-of-day histogram for Distraction).

## P2 Features (Integrations + Advanced)

### 9) Backup/Restore + Data Vault Portability

What:
- Export/import an encrypted archive of:
  - SQLite DB
  - recordings + timelapses
  - settings (minus secrets)

Acceptance criteria:
- A user can move Dayflow to a new machine and keep history.

Implementation details:
- Provide export options:
  - DB only
  - DB + timelapses
  - full vault
- Encrypt archive with a user-provided passphrase (do not reuse Gemini key).

### 10) Multi-Profile (Work/Personal Vaults)

What:
- Separate data directories with independent retention and settings.

Acceptance criteria:
- Switching profiles is explicit and safe; no cross-contamination of screenshots.

Implementation details:
- Each profile maps to its own userData root (subdirectory) with separate DB and media.
- Gemini key can be shared or per-profile; default to per-profile.

### 11) Local Automation API

What:
- Optional local-only API (HTTP on localhost or a CLI) for:
  - start/stop
  - export
  - status

Security:
- Off by default; if enabled, require a local token.

Acceptance criteria:
- Automation cannot be used remotely without explicit configuration.

Implementation details:
- Prefer a CLI initially (lower security risk) with commands:
  - `dayflow status`, `dayflow start`, `dayflow stop`, `dayflow export --day 2026-02-04`.
- If HTTP is added:
  - bind only to 127.0.0.1
  - require a token
  - add rate limits

### 12) Optional Sync (Encrypted)

What:
- Sync cards/observations across devices, with optional screenshot sync.

Constraints:
- Must be end-to-end encrypted; default to syncing text only.

Acceptance criteria:
- Sync is opt-in, transparent, and does not break local-first behavior.

Design constraints:
- Must tolerate offline use.
- Conflict resolution must be deterministic (especially if user edits/locks are added).

## Suggested Roadmap (If We Implement Many of These)

1. P0: privacy zones + per-range delete/redact
2. P0/P1: evidence viewer + search
3. P1: manual editing + notes/tags
4. P1/P2: reports + ask-dayflow
5. P2: backup/restore, profiles, automation
6. P2: optional sync (last)
