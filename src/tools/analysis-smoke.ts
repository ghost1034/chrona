import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../main/logger'
import { StorageService } from '../main/storage/storage'
import { AnalysisService } from '../main/analysis/analysis'
import { SettingsStore } from '../main/settings'
import { dayKeyFromUnixSeconds } from '../shared/time'
import { TimelapseService } from '../main/timelapse/timelapse'

async function main() {
  const baseDir =
    process.env.DAYFLOW_SMOKE_DIR ?? path.join(os.tmpdir(), `dayflow-analysis-smoke-${process.pid}`)

  const log = createLogger({ userDataPath: baseDir })
  const settings = new SettingsStore({ userDataPath: baseDir })
  if (process.env.DAYFLOW_SMOKE_TIMELAPSE) {
    await settings.update({ timelapsesEnabled: true })
  }
  const storage = new StorageService({ userDataPath: baseDir })
  await storage.init()

  // Create screenshots spanning exactly 30 minutes with maxGap=5m.
  // Then add a couple more screenshots that should form an incomplete trailing batch (and be dropped).
  const nowMs = Date.now()
  const startMs = nowMs - 2 * 60 * 60 * 1000

  const jpegBytes = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAgEAACAQQCAwAAAAAAAAAAAAABAgMABAURBhIhQWGB/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAXEQEBAQEAAAAAAAAAAAAAAAABABEh/9oADAMBAAIRAxEAPwCw7Dkq9ZfIPmP0wqQ6n3V9Wbqk1sW0x0j4m9J8B4w1Oq9gG7o1F1jL0b4WQq6yqJX/2Q==',
    'base64'
  )

  for (let i = 0; i <= 6; i++) {
    const t = startMs + i * 5 * 60 * 1000
    await storage.saveScreenshotJpeg({ capturedAtMs: t, jpegBytes })
  }
  // Two screenshots that should become a dropped trailing batch.
  await storage.saveScreenshotJpeg({ capturedAtMs: startMs + 1900 * 1000, jpegBytes })
  await storage.saveScreenshotJpeg({ capturedAtMs: startMs + 2200 * 1000, jpegBytes })

  const timelapse = new TimelapseService({
    storage,
    settings,
    log,
    events: { timelineUpdated: () => {} }
  })

  const analysis = new AnalysisService({
    storage,
    log,
    events: {
      analysisBatchUpdated: () => {},
      timelineUpdated: () => {}
    },
    settings,
    timelapse
  })

  const before = await storage.fetchUnprocessedScreenshots({
    sinceTs: Math.floor((nowMs - 24 * 60 * 60 * 1000) / 1000)
  })
  const res = await analysis.runTickNow()
  const after = await storage.fetchUnprocessedScreenshots({
    sinceTs: Math.floor((nowMs - 24 * 60 * 60 * 1000) / 1000)
  })
  const recent = await storage.fetchRecentBatches(10)

  const firstBatch = recent[recent.length - 1]
  const cards = firstBatch ? await storage.fetchCardsForDay(dayKeyFromUnixSeconds(firstBatch.batchStartTs)) : []

  if (process.env.DAYFLOW_SMOKE_TIMELAPSE) {
    await timelapse.waitForIdle()
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        baseDir,
        beforeUnprocessedCount: before.length,
        tick: res,
        afterUnprocessedCount: after.length,
        recentBatches: recent,
        cardsCount: cards.length
      },
      null,
      2
    )
  )

  await storage.close()
}

void main()
