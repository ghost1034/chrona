# Repository Guidelines

## Project Structure & Module Organization

Chrona is an Electron, React, and TypeScript desktop app. Keep process-specific code separated:

- `src/main/`: Electron lifecycle, capture, storage, analysis, Gemini/local AI, sync, and IPC handlers.
- `src/renderer/`: React views, components, feature modules, styles, and UI test fixtures.
- `src/shared/`: typed IPC contracts and domain utilities used across processes.
- `src/tools/`: database and analysis smoke-test entry points.
- `public/assets/` and `scripts/`: shipped artwork and icon-generation tooling.

Generated output belongs in `dist/`, `release/`, or `.cache/`; do not commit it. Place tests beside the code they cover as `*.test.ts` or `*.test.tsx`.

## Build, Test, and Development Commands

- `npm install`: install dependencies and rebuild Electron native modules.
- `npm run dev`: run Vite, watch the main-process bundle, and launch Electron.
- `npm test`: run the Vitest suite once with the required Los Angeles timezone.
- `npm run test:watch`: run Vitest interactively while developing.
- `npm run typecheck`: validate strict TypeScript without emitting files.
- `npm run build`: generate icons and build both main and renderer bundles.
- `npm run db:smoke` / `npm run analysis:smoke`: build and exercise the storage or analysis pipeline.
- `npm run pack`: create an unpacked local application; use `dist:mac` or `dist:win` for installers.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, no semicolons, trailing commas in multiline structures, and explicit types at process or IPC boundaries. Use `PascalCase` for React components and classes, `camelCase` for functions and variables, and descriptive lower-camel module names such as `deviceToken.ts`. Keep shared contracts in `src/shared/` instead of duplicating types. No formatter or linter is configured, so match neighboring code and rely on `npm run typecheck`.

## Testing Guidelines

Vitest is the test framework; renderer tests use Testing Library and jsdom where needed. Add focused regression tests alongside every behavior change, including boundary cases for time, storage, and IPC. There is no numeric coverage threshold. Before opening a PR, run `npm test`, `npm run typecheck`, and the relevant smoke command.

## Commit & Pull Request Guidelines

History uses short, scoped subjects such as `Chrona: Startup race fix` and `Timeline: fix day-boundary updates`. Follow `Area: concise imperative summary`, and keep commits focused. PRs should explain user-visible impact, implementation risks, and verification performed; link relevant issues and include screenshots or recordings for UI changes. Never commit `.env` files, API keys, screenshots, local databases, or generated packages.
