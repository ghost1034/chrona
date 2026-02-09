import fs from 'node:fs/promises'
import path from 'node:path'
import type { Settings } from '../shared/ipc'

const DEFAULT_SETTINGS: Settings = {
  version: 8,
  captureIntervalSeconds: 10,
  captureSelectedDisplayId: null,
  captureIncludeCursor: false,

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

  geminiModel: 'gemini-3-flash-preview',
  geminiRequestTimeoutMs: 60_000,
  geminiMaxAttempts: 3,
  geminiLogBodies: false,

  promptPreambleTranscribe: '',
  promptPreambleCards: '',
  promptPreambleAsk: '',
  promptPreambleJournalDraft: '',

  onboardingVersion: 1,
  onboardingCompleted: false
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
        parsed?.version !== 8
      ) {
        return DEFAULT_SETTINGS
      }

      // Migration: do not force onboarding UI for existing users.
      const fromExistingUser = parsed?.version <= 5
      const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed, version: 8 }
      if (fromExistingUser && typeof (parsed as any).onboardingCompleted !== 'boolean') {
        merged.onboardingCompleted = true
      }
      if (fromExistingUser && typeof (parsed as any).onboardingVersion !== 'number') {
        merged.onboardingVersion = 1
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
      version: 8
    }

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
