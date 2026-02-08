export function parseAppSitesFromMetadata(metadata: string | null): {
  primary: string | null
  secondary: string | null
} {
  if (!metadata) return { primary: null, secondary: null }
  const parsed = safeJsonParse(metadata)
  if (!parsed || typeof parsed !== 'object') return { primary: null, secondary: null }
  const appSites = (parsed as any).appSites
  if (!appSites || typeof appSites !== 'object') return { primary: null, secondary: null }
  const primary = normalizeNullableString((appSites as any).primary)
  const secondary = normalizeNullableString((appSites as any).secondary)
  return { primary, secondary }
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
