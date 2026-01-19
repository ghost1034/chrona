# Dayflow Cross-Platform Decisions

This file records project-level decisions for the cross-platform Dayflow reimplementation described in `docs/NEW.md` and planned in `docs/PLAN.md`.

Format:
- Each decision has an ID so we can reference it in PRs and discussions.
- Status is one of: decided, proposed, deferred.

---

## D-001: Supported OS targets (V1)

- Status: decided
- Decision: Support macOS and Windows for V1. Linux is deferred.
- Rationale: matches the largest desktop user bases and keeps native dependency/packaging risk manageable (SQLite, keytar, optional ffmpeg).

## D-002: Desktop framework

- Status: decided
- Decision: Electron (main + renderer) with TypeScript.
- Rationale: explicit hard constraint in `docs/NEW.md`.

## D-003: Renderer UI stack

- Status: decided
- Decision: React + Vite + TypeScript.
- Rationale: fast iteration, strong ecosystem, simple packaging; aligns with `docs/PLAN.md` recommendation.

## D-004: IPC boundary

- Status: decided
- Decision: Renderer never accesses SQLite directly; all persistence and privileged operations go through typed IPC (`ipcMain.handle`) owned by the main process.
- Rationale: reduces corruption risk, centralizes transactions and migrations, and simplifies security review.

## D-005: LLM provider scope

- Status: decided
- Decision: Gemini only. No local models, no GPT/Claude.
- Rationale: explicit hard constraint in `docs/NEW.md` and `docs/PLAN.md`.

## D-006: Journal feature scope

- Status: decided
- Decision: No Journal feature (no UI, no reminders, no gating, no journal tables).
- Rationale: explicit hard constraint in `docs/NEW.md` and `docs/PLAN.md`.

## D-007: Storage root + paths

- Status: decided
- Decision: All app data lives under Electron `app.getPath('userData')`. Store screenshot and timelapse paths in SQLite as relative paths under `userData`.
- Rationale: cross-platform portability; makes future path migrations and backups safer.

## D-008: SQLite binding

- Status: decided
- Decision: Use `better-sqlite3` in the main process behind a serialized access layer.
- Rationale: simple transactions and predictable performance; aligns with `docs/PLAN.md` recommendation.

## D-009: SQLite safety defaults

- Status: decided
- Decision: Apply pragmas: WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON.
- Rationale: matches the original app's intent while adding foreign key enforcement.

## D-010: Recording capture API

- Status: decided
- Decision: Capture periodic screenshots via Electron `desktopCapturer` (not OS-native APIs).
- Rationale: explicit hard constraint in `docs/NEW.md`.

## D-011: Privacy posture

- Status: decided
- Decision:
  - Treat screenshots and derived text as sensitive local data.
  - No analytics by default.
  - No network calls other than Gemini API requests.
  - Do not fetch favicons by default; only behind an explicit opt-in.
- Rationale: screenshots can contain highly sensitive content; match `docs/NEW.md` security guidance.

## D-012: API key storage

- Status: decided
- Decision: Store the Gemini API key in the OS credential store via `keytar`.
- Rationale: cross-platform secure storage; aligns with `docs/NEW.md`.

## D-013: LLM request/response logging

- Status: decided
- Decision:
  - Persist `llm_calls` rows for debugging.
  - Always redact Authorization headers and likely API key material.
  - Default to truncating bodies; allow an explicit "include bodies" debug mode.
- Rationale: keeps debugging useful without routinely storing large or highly sensitive payloads.

## D-014: Update mechanism

- Status: deferred
- Decision: Defer auto-update until after MVP; ship manual downloads for early builds.
- Rationale: reduces scope and platform-specific signing/update complexity early.

## D-015: Timelapse implementation

- Status: proposed
- Decision: Use ffmpeg in a worker process for timelapse rendering; prefer bundling via `ffmpeg-static` or platform-specific app-bundled binaries.
- Rationale: aligns with `docs/PLAN.md`; needs a packaging/licensing review before locking.
