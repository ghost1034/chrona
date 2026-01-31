import fs from 'node:fs/promises'
import path from 'node:path'
import type { Settings } from '../shared/ipc'

const DEFAULT_SETTINGS: Settings = {
  version: 4,
  captureIntervalSeconds: 10,
  storageLimitRecordingsBytes: 10 * 1024 * 1024 * 1024,
  storageLimitTimelapsesBytes: 10 * 1024 * 1024 * 1024,
  timelapsesEnabled: false,
  timelapseFps: 2,
  autoStartEnabled: false,
  timelinePxPerHour: 600
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
        parsed?.version !== 4
      )
        return DEFAULT_SETTINGS

      return { ...DEFAULT_SETTINGS, ...parsed, version: 4 }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  async update(patch: Partial<Omit<Settings, 'version'>>): Promise<Settings> {
    const current = await this.getAll()
    const next: Settings = {
      ...current,
      ...patch,
      version: 4
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
