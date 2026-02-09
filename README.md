# Chrona

*Derived from "khronos", a personification of time in Greek mythology*

[![Demo video](https://vumbnail.com/1163177906.jpg)](https://vimeo.com/1163177906)

I'm Ian Stewart, a high school senior. I built Chrona to answer a question I kept running into while balancing school, coding, and everything else: *"Where did my time just go?"* Calendars show what I planned. To-do lists show what I intended. But neither one tells me what I really did with my day. I wanted something that could reconstruct what actually happened.

## Inspiration

- **Time tracking tools already exist, but they all feel like filling out a form after the fact.**
    - You start a timer, forget to stop it, misfile a category, and at the end of the week you're staring at a spreadsheet that barely resembles what you actually did.
- **Even the better ones give you charts and totals, but...**
    - ...you can't click into a block and see what was on your screen at what time, you can't ask "what was I working on before that meeting?", and you can't layer your own judgment on top of what the tool recorded. The data is flat, static, and disconnected from the experience it's supposed to represent.
- **I wanted a personal time memory.**
    - Something that passively watches my screen, understands what I'm doing through AI, and builds a record of my day that I can search, explore, question, and actually interact with. A living reconstruction of reality.

## What I built

Chrona is a local-first, cross-platform Electron desktop app that turns passive screen captures into a structured timeline. It:

- **Captures screenshots on a configurable interval** and stores everything locally. Nothing leaves your machine until Gemini analysis.
- **Batches screenshots into compressed videos** and sends them to **Gemini's native multimodal video understanding** to generate time-aligned observations, then synthesizes those into structured timeline cards (title, category, summary, details, extracted sites).
- **Renders a "logical day" timeline (4 AM to 4 AM by default)** with smooth zoom, full-text search powered by SQLite FTS5, category/tag filters, and multi-format exports (Markdown, CSV, XLSX).
- **Includes a Review workflow** where you rate time blocks as focused, neutral, or distracted, with coverage tracking so you know what you've reflected on and what you haven't.
- **Provides an Ask chat** that answers natural-language questions based on your timeline data, with clickable source references that jump directly to the relevant cards. Every response is evidence-backed.
- **Offers a Dashboard** for trends and breakdowns across flexible ranges (today, last 7 days, last 30, or custom): tracked vs. untracked time, category distributions, daily totals, review coverage, and longest focus streaks.
- **Includes a Journal** with autosave and an optional "Draft with Gemini" feature that generates structured daily reflections grounded in your actual timeline.

## How I built it

Chrona's architecture is a pipeline with strict boundaries between capture, storage, analysis, and presentation:

1. **Capture (main process).** Electron's `desktopCapturer` API saves timestamped JPEGs locally on a configurable interval, with permission detection and automatic failure handling.
2. **Storage.** SQLite manages all persistent data (screenshots, batches, observations, timeline cards, review segments, journal entries) with FTS5 indexes for fast full-text search and a fallback path for environments where FTS5 isn't available.
3. **Analysis (Gemini 3 Preview or 2.5).** A batching engine groups screenshots by time window, compresses them into video, and sends them to **Gemini's native video understanding** to produce observations. Gemini then synthesizes observations into structured timeline cards with enforced JSON schemas and source IDs, keeping every output testable.
4. **Renderer UI.** A React frontend renders the timeline, search, review, dashboard, Ask chat, and journal. All communication with the main process flows through typed IPC channels for safety and maintainability.

## Challenges I faced

- **Performance at scale.**
    - Searching and filtering across days of timeline data gets expensive fast. I implemented SQLite FTS5 for near-instant full-text search and built a graceful fallback for systems without FTS5 support.
- **Time boundary design.**
    - A "day" that matches how people actually work (4 AM to 4 AM by default) introduced edge cases around DST transitions and cross-day grouping that required careful timestamp normalization.
- **Evidence-based AI outputs.**
    - The Ask chat and Journal draft features must reference real timeline cards. I enforce this through strict JSON output schemas, explicit source ID requirements in prompts, and validation in the rendering layer.
- **Capture reliability.**
    - Screen capture permissions (especially on macOS) can silently fail or get revoked. Chrona detects repeated failures and auto-disables recording to prevent runaway capture loops, with clear UI feedback to the user.
- **Media pipeline.**
    - Generating timelapse videos from screenshot sequences with ffmpeg and serving local media files securely to the renderer via a custom Electron protocol required careful path handling and security sandboxing.

## What I learned

- **Electron architecture demands discipline from the start.**
    - I learned how to architect an Electron app with a clean main/renderer split, typed IPC, and security-conscious media serving.
- **Designing an AI pipeline around a model that can hallucinate.**
    - I learned how to design a generative AI pipeline where every output is schema-validated, source-traced, and fails gracefully.
- **The importance of invisible infrastructure.**
    - I learned how much invisible details (batching strategy, time window logic, search indexing) determine whether an app *feels* instant or sluggish.

## What I'm most proud of

- **The grounding pipeline actually works.**
    - Chrona's Ask chat and Journal drafts enforce strict JSON schemas with source IDs, and the UI renders those as clickable links back to the exact timeline cards. There's no hand-waving. If Gemini says I spent an hour on differential equations, you can click through and verify it.
- **The architecture held up.**
    - I designed the pipeline (capture, storage, analysis, UI) early on, and even as features piled up (review coverage, dashboard aggregations, multi-day search, timelapse generation), adding new features never required rearchitecting what was already there.
- **It respects the user.**
    - Chrona is local-first by design. Screenshots never leave your machine until Gemini analysis, and even then you control the model, the batch size, and the storage limits. I'm proud that Chrona treats privacy as a default, not a premium feature.
