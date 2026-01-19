import os from 'node:os'
import path from 'node:path'
import { StorageService } from '../main/storage/storage'

async function main() {
  const baseDir =
    process.env.CHRONA_SMOKE_DIR ?? path.join(os.tmpdir(), `chrona-smoke-${process.pid}`)

  const storage = new StorageService({ userDataPath: baseDir })
  await storage.init()

  const nowMs = Date.now()
  const jpegBytes = Buffer.from(
    // 1x1 JPEG
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAgEAACAQQCAwAAAAAAAAAAAAABAgMABAURBhIhQWGB/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAXEQEBAQEAAAAAAAAAAAAAAAABABEh/9oADAMBAAIRAxEAPwCw7Dkq9ZfIPmP0wqQ6n3V9Wbqk1sW0x0j4m9J8B4w1Oq9gG7o1F1jL0b4WQq6yqJX/2Q==',
    'base64'
  )

  const { screenshotId } = await storage.saveScreenshotJpeg({ capturedAtMs: nowMs, jpegBytes })

  const capturedAtSec = Math.floor(nowMs / 1000)

  const beforeBatch = await storage.fetchUnprocessedScreenshots({ sinceTs: capturedAtSec - 5 })

  const batchId = await storage.createBatchWithScreenshots({
    startTs: capturedAtSec,
    endTs: capturedAtSec + 600,
    screenshotIds: [screenshotId]
  })

  const afterBatch = await storage.fetchUnprocessedScreenshots({ sinceTs: capturedAtSec - 5 })
  await storage.setBatchStatus({ batchId, status: 'processing', reason: null })

  await storage.insertObservations(batchId, [
    {
      startTs: capturedAtSec,
      endTs: capturedAtSec + 60,
      observation: 'Smoke test observation',
      metadata: null,
      llmModel: 'smoke'
    }
  ])

  const replaceRes = await storage.replaceCardsInRange({
    fromTs: capturedAtSec,
    toTs: capturedAtSec + 3600,
    batchId,
    newCards: [
      {
        startTs: capturedAtSec,
        endTs: capturedAtSec + 300,
        category: 'Work',
        subcategory: 'Smoke',
        title: 'DB smoke test',
        summary: 'Inserted a synthetic card via StorageService.',
        detailedSummary: null,
        metadata: JSON.stringify({ source: 'db-smoke' })
      }
    ]
  })

  await storage.applyReviewRatingSegment({
    startTs: capturedAtSec,
    endTs: capturedAtSec + 120,
    rating: 'focus'
  })

  const dayKey = new Date(nowMs - 4 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cards = await storage.fetchCardsForDay(dayKey)
  const ratings = await storage.fetchReviewSegmentsInRange({
    startTs: capturedAtSec - 3600,
    endTs: capturedAtSec + 3600
  })

  const batch = await storage.getBatch(batchId)
  const batchScreens = await storage.getBatchScreenshots(batchId)

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        baseDir,
        screenshotId,
        beforeBatchCount: beforeBatch.length,
        afterBatchCount: afterBatch.length,
        batch,
        batchScreensCount: batchScreens.length,
        insertedCardIds: replaceRes.insertedCardIds,
        removedVideoPaths: replaceRes.removedVideoPaths,
        cardsCount: cards.length,
        ratingsCount: ratings.length
      },
      null,
      2
    )
  )

  await storage.close()
}

void main()
