export type CategoryId = string
export type SubcategoryId = string

export type CategoryDefinition = {
  id: CategoryId
  name: string
  color: string
  description: string
  locked?: boolean
  order?: number
}

export type SubcategoryDefinition = {
  id: SubcategoryId
  categoryId: CategoryId
  name: string
  color: string
  description: string
  order?: number
}

export function normalizeName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ')
}

export function normalizeDescription(raw: unknown): string {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim()
}

export function normalizeColor(raw: unknown): string {
  // Accept any CSS-compatible color string. We keep this permissive,
  // since we only use it as a UI display hint.
  return String(raw ?? '').trim()
}

export function caseFold(s: string): string {
  return String(s ?? '').trim().toLowerCase()
}

export function assertValidCategoryName(name: string) {
  const n = normalizeName(name)
  if (!n) throw new Error('Category name is required')
  if (n.length > 48) throw new Error('Category name is too long')
}

export function assertValidSubcategoryName(name: string) {
  const n = normalizeName(name)
  if (!n) throw new Error('Subcategory name is required')
  if (n.length > 48) throw new Error('Subcategory name is too long')
}

export function assertValidColor(color: string) {
  const c = normalizeColor(color)
  if (!c) throw new Error('Color is required')
  if (c.length > 64) throw new Error('Color is too long')
}

export function assertValidDescription(desc: string) {
  const d = normalizeDescription(desc)
  if (d.length > 240) throw new Error('Description is too long')
}
