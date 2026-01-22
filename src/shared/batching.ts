export type ScreenshotForBatching = {
  id: number
  capturedAt: number
}

export type ScreenshotBatch = {
  startTs: number
  endTs: number
  screenshotIds: number[]
}

export type BatchingConfig = {
  targetDurationSec: number
  maxGapSec: number
}

export function createScreenshotBatches(
  screenshots: ScreenshotForBatching[],
  cfg: BatchingConfig
): ScreenshotBatch[] {
  if (screenshots.length === 0) return []

  const sorted = [...screenshots].sort((a, b) => a.capturedAt - b.capturedAt)
  const batches: ScreenshotBatch[] = []

  let cur: ScreenshotBatch | null = null
  let prevTs: number | null = null

  for (const s of sorted) {
    if (!cur) {
      cur = {
        startTs: s.capturedAt,
        endTs: s.capturedAt,
        screenshotIds: [s.id]
      }
      prevTs = s.capturedAt
      continue
    }

    const gap = prevTs === null ? 0 : s.capturedAt - prevTs
    const durationIfAdded = s.capturedAt - cur.startTs

    if (gap > cfg.maxGapSec || durationIfAdded > cfg.targetDurationSec) {
      batches.push(cur)
      cur = {
        startTs: s.capturedAt,
        endTs: s.capturedAt,
        screenshotIds: [s.id]
      }
      prevTs = s.capturedAt
      continue
    }

    cur.endTs = s.capturedAt
    cur.screenshotIds.push(s.id)
    prevTs = s.capturedAt
  }

  if (cur) batches.push(cur)

  // Drop trailing incomplete batch so we wait for more screenshots.
  const last = batches[batches.length - 1]
  if (last && last.endTs - last.startTs < cfg.targetDurationSec) {
    batches.pop()
  }

  return batches
}
