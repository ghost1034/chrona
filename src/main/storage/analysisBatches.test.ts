import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StorageService } from './storage'

async function makeStorage(): Promise<{ storage: StorageService; dir: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-analysis-batches-test-'))
  const storage = new StorageService({ userDataPath: dir })
  try {
    await storage.init()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('NODE_MODULE_VERSION') && message.includes('better_sqlite3.node')) {
      await fs.rm(dir, { recursive: true, force: true })
      return null
    }
    throw error
  }
  return { storage, dir }
}

describe('StorageService analysis batch claims', () => {
  it('atomically claims oldest pending batches before oldest transcribed batches', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const first = await storage.createBatchWithScreenshots({ startTs: 100, endTs: 200, screenshotIds: [] })
      const transcribed = await storage.createBatchWithScreenshots({ startTs: 200, endTs: 300, screenshotIds: [] })
      const second = await storage.createBatchWithScreenshots({ startTs: 300, endTs: 400, screenshotIds: [] })
      await storage.setBatchStatus({ batchId: transcribed, status: 'transcribed' })

      await expect(storage.claimNextAnalysisBatch()).resolves.toMatchObject({
        batch: { id: first, status: 'processing_transcribe' },
        resumeStatus: 'pending'
      })
      await expect(storage.claimNextAnalysisBatch()).resolves.toMatchObject({
        batch: { id: second, status: 'processing_transcribe' },
        resumeStatus: 'pending'
      })
      await expect(storage.claimNextAnalysisBatch()).resolves.toMatchObject({
        batch: { id: transcribed, status: 'processing_generate_cards' },
        resumeStatus: 'transcribed'
      })
      await expect(storage.claimNextAnalysisBatch()).resolves.toBeNull()
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('recovers interrupted transcription and card-generation phases', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const transcription = await storage.createBatchWithScreenshots({ startTs: 100, endTs: 200, screenshotIds: [] })
      const cards = await storage.createBatchWithScreenshots({ startTs: 200, endTs: 300, screenshotIds: [] })
      await storage.setBatchStatus({ batchId: transcription, status: 'processing_transcribe', reason: 'old' })
      await storage.setBatchStatus({ batchId: cards, status: 'processing_generate_cards', reason: 'old' })

      await expect(storage.recoverInterruptedAnalysisBatches()).resolves.toEqual({
        pendingBatchIds: [transcription],
        transcribedBatchIds: [cards]
      })
      await expect(storage.getBatch(transcription)).resolves.toMatchObject({ status: 'pending', reason: null })
      await expect(storage.getBatch(cards)).resolves.toMatchObject({ status: 'transcribed', reason: null })
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
