import { describe, expect, it, vi } from 'vitest'
import { LocalRuntimeUnavailableError } from '../ai/errors'
import { AnalysisService } from './analysis'

describe('AnalysisService local runtime availability', () => {
  it('restores a processing batch to pending and stops without creating an error card', async () => {
    const statuses: Array<{ status: string; reason?: string | null }> = []
    const replaceCardsInRange = vi.fn()
    const storage: any = {
      fetchNextBatchByStatus: vi.fn(async (status: string) =>
        status === 'pending'
          ? { id: 8, batchStartTs: 100, batchEndTs: 200, status: 'pending', reason: null }
          : null
      ),
      getBatchScreenshots: async () => [
        { id: 1, capturedAt: 100, filePath: 'one.jpg', fileSize: 1, isDeleted: 0 }
      ],
      setBatchStatus: async (entry: any) => statuses.push(entry),
      replaceCardsInRange
    }
    const events = { analysisBatchUpdated: vi.fn(), timelineUpdated: vi.fn() }
    const service = new AnalysisService({
      storage,
      settings: { getAll: async () => ({ captureIntervalSeconds: 10 }) } as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      events,
      timelapse: { deleteTimelapseFiles: vi.fn(), enqueueCardIds: vi.fn() } as any
    })
    ;(service as any).ai = {
      getProviderStatus: async () => ({ configured: true, provider: 'local' }),
      transcribeBatch: async () => {
        throw new LocalRuntimeUnavailableError('Could not connect to the local AI server')
      }
    }

    await (service as any).drainPendingBatches()

    expect(statuses.map((entry) => entry.status)).toEqual(['processing_transcribe', 'pending'])
    expect(statuses.at(-1)?.reason).toMatch(/Could not connect/)
    expect(replaceCardsInRange).not.toHaveBeenCalled()
    expect(events.analysisBatchUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchId: 8, status: 'pending' })
    )
  })
})
