import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_BLUR_HOTKEY, isValidNormalizedRect } from '../shared/blurRegions'
import type { BlurRegion } from '../shared/blurRegions'
import type { Settings } from '../shared/ipc'

const DEFAULT_SETTINGS: Settings = {
  version: 12,
  themePreference: 'system',
  captureIntervalSeconds: 10,
  captureSelectedDisplayId: null,
  captureIncludeCursor: false,

  blurRegions: [],
  blurHotkey: DEFAULT_BLUR_HOTKEY,

  categories: [
    {
      id: 'cat_work',
      name: 'Work',
      color: '#3BD4B2',
      description: 'Work tasks and professional activities.',
      order: 10
    },
    {
      id: 'cat_personal',
      name: 'Personal',
      color: '#63A9FF',
      description: 'Personal tasks, errands, and life admin.',
      order: 20
    },
    {
      id: 'cat_distraction',
      name: 'Distraction',
      color: '#FF7A18',
      description: 'Low-value time, distraction, or unplanned browsing.',
      order: 30
    },
    {
      id: 'cat_idle',
      name: 'Idle',
      color: '#BEC8D4',
      description: 'Inactivity (away, locked, or no visible interaction).',
      locked: true,
      order: 40
    }
  ],
  subcategories: [],

  analysisCheckIntervalSeconds: 60,
  analysisLookbackSeconds: 24 * 60 * 60,
  analysisBatchTargetDurationSec: 30 * 60,
  analysisBatchMaxGapSec: 5 * 60,
  analysisMinBatchDurationSec: 5 * 60,
  analysisCardWindowLookbackSec: 60 * 60,

  storageLimitRecordingsBytes: 10 * 1024 * 1024 * 1024,
  storageLimitTimelapsesBytes: 10 * 1024 * 1024 * 1024,
  timelapsesEnabled: true,
  timelapseFps: 2,
  autoStartEnabled: false,
  timelinePxPerHour: 600,

  geminiModel: 'gemini-3.5-flash',
  geminiRequestTimeoutMs: 60_000,
  geminiMaxAttempts: 3,
  geminiLogBodies: false,

  aiProvider: 'gemini',
  localBaseUrl: 'http://127.0.0.1:11434/v1',
  localVisionModel: '',
  localTextModel: '',
  localRequestTimeoutMs: 300_000,
  localMaxAttempts: 2,
  localLogBodies: false,
  localVisionMaxImagesPerRequest: 12,

  promptPreambleTranscribe: '',
  promptPreambleCards: '',
  promptPreambleAsk: '',
  promptPreambleJournalDraft: '',

  onboardingVersion: 1,
  onboardingCompleted: false,

  demoTimeOffsetSeconds: null,
  demoCardsHidden: false,

  syncEnabled: false,
  // Empty means CPAAutomation's production API (DEFAULT_SYNC_ENDPOINT);
  // hand-edit settings.json to point at a dev server instead.
  syncEndpoint: '',
  syncIntervalSeconds: 300
}

// Drops malformed entries individually so one corrupted region can never
// disable redaction of the others.
function sanitizeBlurRegions(value: unknown): BlurRegion[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is BlurRegion =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as any).id === 'string' &&
      typeof (r as any).displayId === 'string' &&
      isValidNormalizedRect((r as any).rect)
  )
}

export class SettingsStore {
  private readonly filePath: string

  constructor(opts: { userDataPath: string }) {
    this.filePath = path.join(opts.userDataPath, 'settings.json')
  }

  async getAll(): Promise<Settings> {
    const raw = await this.readFileIfExists()
    if (!raw) return DEFAULT_SETTINGS

    try {
      const parsed = JSON.parse(raw) as any

      // Allow older settings versions by merging them forward.
      if (
        parsed?.version !== 1 &&
        parsed?.version !== 2 &&
        parsed?.version !== 3 &&
       parsed?.version !== 4 &&
       parsed?.version !== 5 &&
        parsed?.version !== 6 &&
        parsed?.version !== 7 &&
        parsed?.version !== 8 &&
        parsed?.version !== 9 &&
        parsed?.version !== 10 &&
        parsed?.version !== 11 &&
        parsed?.version !== 12
      ) {
        return DEFAULT_SETTINGS
      }

      // Migration: do not force onboarding UI for existing users.
      const fromExistingUser = parsed?.version <= 5
      const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed, version: 12 }
      if (!['system', 'light', 'dark'].includes(String(parsed?.themePreference ?? ''))) {
        merged.themePreference = 'system'
      }
      if (fromExistingUser && typeof (parsed as any).onboardingCompleted !== 'boolean') {
        merged.onboardingCompleted = true
      }
      if (fromExistingUser && typeof (parsed as any).onboardingVersion !== 'number') {
        merged.onboardingVersion = 1
      }

      merged.blurRegions = sanitizeBlurRegions(merged.blurRegions)
      if (typeof merged.blurHotkey !== 'string') merged.blurHotkey = DEFAULT_BLUR_HOTKEY
      if (merged.aiProvider !== 'gemini' && merged.aiProvider !== 'local') {
        merged.aiProvider = 'gemini'
      }
      try {
        merged.localBaseUrl = normalizeLoopbackBaseUrl(merged.localBaseUrl)
      } catch {
        merged.localBaseUrl = DEFAULT_SETTINGS.localBaseUrl
      }

      return merged
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  async update(patch: Partial<Omit<Settings, 'version'>>): Promise<Settings> {
    const current = await this.getAll()
    const next: Settings = {
      ...current,
      ...patch,
      version: 12
    }

    if (patch.localBaseUrl !== undefined) {
      next.localBaseUrl = normalizeLoopbackBaseUrl(patch.localBaseUrl)
    }
    if (next.aiProvider !== 'gemini' && next.aiProvider !== 'local') next.aiProvider = 'gemini'

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  }

  private async readFileIfExists(): Promise<string | null> {
    try {
      return await fs.readFile(this.filePath, 'utf8')
    } catch {
      return null
    }
  }
}

export function normalizeLoopbackBaseUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('Local server URL is required')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Local server URL is invalid')
  }
  if (url.protocol !== 'http:') throw new Error('Local server URL must use http://')
  if (url.username || url.password) throw new Error('Local server URL cannot contain credentials')
  if (url.search || url.hash) throw new Error('Local server URL cannot contain a query or fragment')

  const host = url.hostname.toLowerCase()
  const isLoopback =
    host === 'localhost' ||
    host === '::1' || host === '[::1]' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(host) && host.split('.').slice(1).every((part) => Number(part) <= 255)
  if (!isLoopback) throw new Error('Local server URL must use a loopback host')

  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1'
  return url.toString().replace(/\/$/, '')
}
