import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageService } from './storage'

describe('StorageService journal', () => {
  it('upserts and preserves unspecified fields', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-journal-test-'))
    const storage = new StorageService({ userDataPath: dir })
    try {
      try {
        await storage.init()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('NODE_MODULE_VERSION') && msg.includes('better_sqlite3.node')) {
          // CI/dev environments sometimes run tests under a Node version that
          // doesn't match the prebuilt better-sqlite3 native module.
          // Skip this test in that case.
          return
        }
        throw e
      }

      const dayKey = '2026-02-06'
      const first = await storage.upsertJournalEntry({ dayKey, patch: { intentions: 'Ship journal' } })
      expect(first.dayKey).toBe(dayKey)
      expect(first.intentions).toBe('Ship journal')
      expect(first.notes).toBeNull()
      expect(first.status).toBe('draft')

      const second = await storage.upsertJournalEntry({ dayKey, patch: { notes: 'Did implementation' } })
      expect(second.intentions).toBe('Ship journal')
      expect(second.notes).toBe('Did implementation')
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
