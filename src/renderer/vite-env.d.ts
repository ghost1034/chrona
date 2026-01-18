/// <reference types="vite/client" />

import type { ChronaApi } from '../main/preload'

declare global {
  interface Window {
    chrona: ChronaApi
  }
}

export {}
