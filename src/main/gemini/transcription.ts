import type { ObservationInsert } from '../storage/storage'

export type TranscriptionResult = {
  observations: ObservationInsert[]
  detailedTranscription?: string | null
  llmModel?: string | null
}

export function parseAndExpandTranscriptionJson(opts: {
  jsonText: string
  batchStartTs: number
  batchEndTs: number
  screenshotIntervalSeconds: number
  llmModel?: string | null
}): TranscriptionResult {
  const parsed = safeJsonParse(opts.jsonText)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON (expected object)')
  }

  const obs = (parsed as any).observations
  if (!Array.isArray(obs)) throw new Error('Invalid JSON: observations must be an array')

  const out: ObservationInsert[] = []
  for (const o of obs) {
    if (!o || typeof o !== 'object') continue
    const start = String((o as any).start ?? '')
    const end = String((o as any).end ?? '')
    const observation = String((o as any).observation ?? '').trim()
    if (!observation) continue

    const startSec = parseMMSS(start)
    const endSec = parseMMSS(end)
    if (startSec === null || endSec === null) continue

    const realStart = opts.batchStartTs + startSec * opts.screenshotIntervalSeconds
    const realEnd = opts.batchStartTs + endSec * opts.screenshotIntervalSeconds

    const clampedStart = clamp(realStart, opts.batchStartTs, opts.batchEndTs)
    const clampedEnd = clamp(realEnd, opts.batchStartTs, opts.batchEndTs)
    const startTs = Math.min(clampedStart, clampedEnd)
    const endTs = Math.max(clampedStart, clampedEnd)
    if (endTs <= startTs) continue

    const appSites = (o as any).appSites
    const metadata = appSites ? safeJsonStringify({ appSites }) : null

    out.push({
      startTs,
      endTs,
      observation,
      metadata,
      llmModel: opts.llmModel ?? null
    })
  }

  // Ensure monotonically non-decreasing start times.
  out.sort((a, b) => a.startTs - b.startTs)

  return {
    observations: out,
    detailedTranscription: typeof (parsed as any).detailedTranscription === 'string'
      ? (parsed as any).detailedTranscription
      : null,
    llmModel: opts.llmModel ?? null
  }
}

function parseMMSS(s: string): number | null {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(s.trim())
  if (!m) return null
  const mm = Number(m[1])
  const ss = Number(m[2])
  if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null
  if (ss < 0 || ss > 59) return null
  return mm * 60 + ss
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function safeJsonStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}
