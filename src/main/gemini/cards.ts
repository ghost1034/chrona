export type CardGenerationCard = {
  startTs: number
  endTs: number
  category: string
  subcategory?: string | null
  title: string
  summary?: string | null
  detailedSummary?: string | null
  appSites?: { primary?: string | null; secondary?: string | null } | null
  metadata?: string | null
}

export type CardGenerationResult = {
  cards: CardGenerationCard[]
}

export const DEFAULT_CATEGORIES = ['Work', 'Personal', 'Distraction', 'Idle'] as const

export function parseAndValidateCardsJson(opts: {
  jsonText: string
  windowStartTs: number
  windowEndTs: number
  allowedCategories?: readonly string[]
}): CardGenerationResult {
  const parsed = safeJsonParse(opts.jsonText)
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON (expected object)')

  const cards = (parsed as any).cards
  if (!Array.isArray(cards)) throw new Error('Invalid JSON: cards must be an array')

  const allowed = new Set(opts.allowedCategories ?? DEFAULT_CATEGORIES)
  const out: CardGenerationCard[] = []

  for (const c of cards) {
    if (!c || typeof c !== 'object') continue

    const startTs = Number((c as any).startTs)
    const endTs = Number((c as any).endTs)
    const category = String((c as any).category ?? '').trim()
    const title = String((c as any).title ?? '').trim()

    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) continue
    if (!title) continue
    if (!allowed.has(category)) continue

    const s = Math.min(startTs, endTs)
    const e = Math.max(startTs, endTs)
    if (e <= s) continue

    // Keep only cards that intersect the requested window.
    // (Cards may extend outside the window for continuity, but must overlap it.)
    if (e <= opts.windowStartTs || s >= opts.windowEndTs) continue

    const subcategory = (c as any).subcategory
    const summary = (c as any).summary
    const detailedSummary = (c as any).detailedSummary

    const appSites = (c as any).appSites
    const appSitesNormalized =
      appSites && typeof appSites === 'object'
        ? {
            primary: normalizeNullableString((appSites as any).primary),
            secondary: normalizeNullableString((appSites as any).secondary)
          }
        : null

    const metadata = appSitesNormalized ? safeJsonStringify({ appSites: appSitesNormalized }) : null

    out.push({
      startTs: s,
      endTs: e,
      category,
      subcategory: normalizeNullableString(subcategory),
      title,
      summary: normalizeNullableString(summary),
      detailedSummary: normalizeNullableString(detailedSummary),
      appSites: appSitesNormalized,
      metadata
    })
  }

  out.sort((a, b) => a.startTs - b.startTs)
  return { cards: out }
}

export function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  if (m) return m[1].trim()
  return s
}

function normalizeNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function safeJsonStringify(v: unknown): string | null {
  if (v === null || v === undefined) return null
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}
