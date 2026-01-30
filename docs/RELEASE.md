# Release Notes

This project uses Electron Builder for packaging.

## Local packaging

- Unpacked app (fast): `npm run pack`
- Platform build: `npm run dist:mac` or `npm run dist:win`

Artifacts are written to `release/`.

## Notes

- Native modules (`better-sqlite3`, `keytar`) require rebuilds; handled by `postinstall` via `electron-builder install-app-deps`.
- ffmpeg is bundled via `ffmpeg-static` for features that require video encoding.
