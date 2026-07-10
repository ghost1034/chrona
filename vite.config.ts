import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  // In production we load the renderer via file://, so asset URLs must be relative.
  // (Vite defaults to absolute /assets/... which resolves to file:///assets/... and goes blank.)
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'src/renderer/index.html'),
        overlay: path.resolve(__dirname, 'src/renderer/overlay.html')
      }
    }
  }
}))
