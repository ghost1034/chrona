export const CATEGORY_COLORS: Record<string, string> = {
  Work: 'rgba(59, 212, 178, 0.9)',
  Personal: 'rgba(99, 169, 255, 0.9)',
  Distraction: 'rgba(255, 122, 24, 0.9)',
  Idle: 'rgba(190, 200, 212, 0.55)',
  System: 'rgba(255, 180, 168, 0.75)',
  Untracked: 'rgba(255, 255, 255, 0.08)'
}

export function getCategoryColor(
  categoryRaw: string,
  overrides?: Record<string, string> | null
): string {
  const category = String(categoryRaw ?? '').trim()

  const override = overrides ? overrides[category] : null
  if (override && String(override).trim()) return String(override).trim()

  const known = CATEGORY_COLORS[category]
  if (known) return known

  // Stable fallback for custom/unknown categories.
  const h = stableHash(category)
  const hue = h % 360
  return `hsla(${hue}, 70%, 62%, 0.85)`
}

function stableHash(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
