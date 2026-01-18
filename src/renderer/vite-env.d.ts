/// <reference types="vite/client" />

import type { DayflowApi } from '../main/preload'

declare global {
  interface Window {
    dayflow: DayflowApi
  }
}

export {}
