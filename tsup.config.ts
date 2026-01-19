import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main/app.ts', 'src/main/preload.ts'],
  outDir: 'dist/main',
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  external: ['electron']
})
