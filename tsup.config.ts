import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/main/app.ts', 'src/main/preload.ts'],
    outDir: 'dist/main',
    format: ['cjs'],
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    clean: true,
    dts: false,
    splitting: false,
    // sharp resolves its platform-specific native binary relative to its own
    // package. Bundling it also rewrites import.meta.url in sharp's ESM entry
    // point to undefined in this CommonJS output, which crashes Electron before
    // app startup. Keep the runtime package intact instead.
    external: ['electron', 'exceljs', 'sharp']
  },
  {
    entry: ['src/tools/db-smoke.ts'],
    outDir: 'dist/tools',
    format: ['cjs'],
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false
  },
  {
    entry: ['src/tools/analysis-smoke.ts'],
    outDir: 'dist/tools',
    format: ['cjs'],
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false
  }
])
