# QA Checklist

Manual regression checklist for Dayflow cross-platform.

## Install + launch

- Install / run from a packaged build.
- App opens window, tray appears, close hides, quit exits.
- Single instance: launching twice focuses existing instance.

## Permissions

- macOS: Screen Recording permission prompt flow is clear and capture works after granting.
- Windows: capture works without extra prompts (or errors are actionable).

## Capture

- Start/stop from tray and from UI.
- Interval changes apply.
- Multi-monitor: pick a display; auto mode follows cursor with hysteresis.
- System pause: sleep/lock pauses capture; resume continues without flipping user intent.

## Analysis + timeline

- Batching: only last 24h; creates 30m batches; drops trailing incomplete.
- Scheduler ticks every 60s.
- Failures create a System/Error card spanning the batch range.
- Retry (when implemented) behaves correctly.

## Timeline UI

- Day selector respects 4 AM boundary.
- Cards render in correct vertical positions.
- Details panel updates category/subcategory.

## Review

- Review mode shows only non-System cards under 80% coverage.
- Rating writes segments and cards disappear once covered.

## Export

- Copy day writes expected text to clipboard.
- Export writes a Markdown file.

## Storage + retention

- Usage numbers update.
- Purge now reduces disk usage.
- Hourly purge maintains under configured limits.
- Straggler cleanup removes unreferenced files.

## Timelapses (if enabled)

- Enabling timelapses does not crash the app.
- New cards eventually get a playable MP4.
- Replacing cards cleans up old timelapse files.

## Deep links + auto-start

- Deep links toggle recording when app is running.
- Deep links work on cold start.
- Launch-at-login toggle persists and behaves correctly.

## Long-run

- Run for 8+ hours: no runaway disk growth; analysis keeps up; app remains responsive.
