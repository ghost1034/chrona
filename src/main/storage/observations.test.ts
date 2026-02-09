import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageService } from './storage'

describe('StorageService observations', () => {
  it('fetchObservationsInRange returns overlapping observations in order', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-observations-test-'))
    const storage = new StorageService({ userDataPath: dir })
    try {
      try {
        await storage.init()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('NODE_MODULE_VERSION') && msg.includes('better_sqlite3.node')) {
          return
        }
        throw e
      }

      const screenshotId = await storage.insertScreenshotRow({
        capturedAtSec: 1_000,
        relPath: 'recordings/screenshots/2026-02-08/1000.jpg',
        fileSize: 123
      })

      const batchId = await storage.createBatchWithScreenshots({
        startTs: 1_000,
        endTs: 1_100,
        screenshotIds: [screenshotId]
      })

      await storage.insertObservations(batchId, [
        { startTs: 900, endTs: 950, observation: 'outside_before' },
        { startTs: 1_005, endTs: 1_010, observation: 'inside_1' },
        { startTs: 1_020, endTs: 1_030, observation: 'inside_2' },
        { startTs: 1_050, endTs: 1_200, observation: 'overlaps_end' },
        { startTs: 1_200, endTs: 1_210, observation: 'outside_after' }
      ])

      const res = await storage.fetchObservationsInRange({ startTs: 1_000, endTs: 1_100 })
      expect(res.map((o) => o.observation)).toEqual(['inside_1', 'inside_2', 'overlaps_end'])
      expect(res.map((o) => o.startTs)).toEqual([1_005, 1_020, 1_050])
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
