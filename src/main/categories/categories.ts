import crypto from 'node:crypto'
import type { SettingsStore } from '../settings'
import type { StorageService } from '../storage/storage'
import {
  assertValidCategoryName,
  assertValidColor,
  assertValidDescription,
  assertValidSubcategoryName,
  caseFold,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  type CategoryDefinition,
  type SubcategoryDefinition
} from '../../shared/categories'

export class CategoriesService {
  private readonly settings: SettingsStore
  private readonly storage: StorageService

  constructor(opts: { settings: SettingsStore; storage: StorageService }) {
    this.settings = opts.settings
    this.storage = opts.storage
  }

  async getAll(): Promise<{ categories: CategoryDefinition[]; subcategories: SubcategoryDefinition[] }> {
    const s = await this.settings.getAll()
    const categories = Array.isArray((s as any).categories) ? ((s as any).categories as any[]) : []
    const subcategories = Array.isArray((s as any).subcategories) ? ((s as any).subcategories as any[]) : []
    return {
      categories: categories.map(normalizeCategoryDef).filter(Boolean) as CategoryDefinition[],
      subcategories: subcategories.map(normalizeSubcategoryDef).filter(Boolean) as SubcategoryDefinition[]
    }
  }

  async createCategory(input: {
    name: string
    color: string
    description: string
  }): Promise<CategoryDefinition> {
    const name = normalizeName(input.name)
    const color = normalizeColor(input.color)
    const description = normalizeDescription(input.description)

    assertValidCategoryName(name)
    assertValidColor(color)
    assertValidDescription(description)

    const lib = await this.getAll()
    ensureUniqueCategoryName(lib.categories, name)

    const maxOrder = lib.categories.reduce((m, c) => Math.max(m, Number(c.order ?? 0) || 0), 0)

    const category: CategoryDefinition = {
      id: crypto.randomUUID(),
      name,
      color,
      description,
      locked: false,
      order: maxOrder + 10
    }

    await this.settings.update({ categories: [...lib.categories, category] } as any)
    return category
  }

  async updateCategory(input: {
    id: string
    patch: Partial<Pick<CategoryDefinition, 'name' | 'color' | 'description'>>
  }): Promise<CategoryDefinition> {
    const lib = await this.getAll()
    const idx = lib.categories.findIndex((c) => c.id === input.id)
    if (idx === -1) throw new Error('Category not found')

    const prev = lib.categories[idx]
    const locked = !!prev.locked

    const nextName = Object.prototype.hasOwnProperty.call(input.patch, 'name')
      ? normalizeName(input.patch.name)
      : prev.name
    const nextColor = Object.prototype.hasOwnProperty.call(input.patch, 'color')
      ? normalizeColor(input.patch.color)
      : prev.color
    const nextDescription = Object.prototype.hasOwnProperty.call(input.patch, 'description')
      ? normalizeDescription(input.patch.description)
      : prev.description

    if (locked && nextName !== prev.name) throw new Error('This category is locked and cannot be renamed')

    assertValidCategoryName(nextName)
    assertValidColor(nextColor)
    assertValidDescription(nextDescription)
    if (nextName !== prev.name) ensureUniqueCategoryName(lib.categories, nextName, prev.id)

    const next: CategoryDefinition = {
      ...prev,
      name: nextName,
      color: nextColor,
      description: nextDescription
    }

    if (nextName !== prev.name) {
      await this.storage.renameCategoryInCards({ fromCategory: prev.name, toCategory: nextName })
    }

    const categories = [...lib.categories]
    categories[idx] = next
    await this.settings.update({ categories } as any)

    return next
  }

  async deleteCategory(input: { id: string; reassignToCategoryId: string }): Promise<void> {
    const lib = await this.getAll()
    const cat = lib.categories.find((c) => c.id === input.id)
    if (!cat) throw new Error('Category not found')
    if (cat.locked) throw new Error('This category is locked and cannot be deleted')

    if (lib.categories.length < 2) {
      throw new Error('Cannot delete the last remaining category')
    }

    const to = lib.categories.find((c) => c.id === input.reassignToCategoryId)
    if (!to) throw new Error('Reassign-to category not found')
    if (to.id === cat.id) throw new Error('Reassign-to category must be different')

    await this.storage.reassignCategoryInCards({
      fromCategory: cat.name,
      toCategory: to.name,
      clearSubcategory: true
    })

    const categories = lib.categories.filter((c) => c.id !== cat.id)
    const subcategories = lib.subcategories.filter((s) => s.categoryId !== cat.id)
    await this.settings.update({ categories, subcategories } as any)
  }

  async createSubcategory(input: {
    categoryId: string
    name: string
    color: string
    description: string
  }): Promise<SubcategoryDefinition> {
    const name = normalizeName(input.name)
    const color = normalizeColor(input.color)
    const description = normalizeDescription(input.description)

    assertValidSubcategoryName(name)
    assertValidColor(color)
    assertValidDescription(description)

    const lib = await this.getAll()
    const parent = lib.categories.find((c) => c.id === input.categoryId)
    if (!parent) throw new Error('Category not found')

    ensureUniqueSubcategoryName(lib.subcategories, input.categoryId, name)

    const maxOrder = lib.subcategories
      .filter((s) => s.categoryId === input.categoryId)
      .reduce((m, s) => Math.max(m, Number(s.order ?? 0) || 0), 0)

    const subcategory: SubcategoryDefinition = {
      id: crypto.randomUUID(),
      categoryId: input.categoryId,
      name,
      color,
      description,
      order: maxOrder + 10
    }

    await this.settings.update({ subcategories: [...lib.subcategories, subcategory] } as any)
    return subcategory
  }

  async updateSubcategory(input: {
    id: string
    patch: Partial<Pick<SubcategoryDefinition, 'name' | 'color' | 'description'>>
  }): Promise<SubcategoryDefinition> {
    const lib = await this.getAll()
    const idx = lib.subcategories.findIndex((s) => s.id === input.id)
    if (idx === -1) throw new Error('Subcategory not found')

    const prev = lib.subcategories[idx]
    const parent = lib.categories.find((c) => c.id === prev.categoryId)
    if (!parent) throw new Error('Parent category not found')

    const nextName = Object.prototype.hasOwnProperty.call(input.patch, 'name')
      ? normalizeName(input.patch.name)
      : prev.name
    const nextColor = Object.prototype.hasOwnProperty.call(input.patch, 'color')
      ? normalizeColor(input.patch.color)
      : prev.color
    const nextDescription = Object.prototype.hasOwnProperty.call(input.patch, 'description')
      ? normalizeDescription(input.patch.description)
      : prev.description

    assertValidSubcategoryName(nextName)
    assertValidColor(nextColor)
    assertValidDescription(nextDescription)
    if (nextName !== prev.name) {
      ensureUniqueSubcategoryName(lib.subcategories, prev.categoryId, nextName, prev.id)
    }

    const next: SubcategoryDefinition = {
      ...prev,
      name: nextName,
      color: nextColor,
      description: nextDescription
    }

    if (nextName !== prev.name) {
      await this.storage.renameSubcategoryInCards({
        category: parent.name,
        fromSubcategory: prev.name,
        toSubcategory: nextName
      })
    }

    const subcategories = [...lib.subcategories]
    subcategories[idx] = next
    await this.settings.update({ subcategories } as any)

    return next
  }

  async deleteSubcategory(
    input:
      | { id: string; mode: 'clear' }
      | { id: string; mode: 'reassign'; reassignToSubcategoryId: string }
  ): Promise<void> {
    const lib = await this.getAll()
    const sub = lib.subcategories.find((s) => s.id === input.id)
    if (!sub) throw new Error('Subcategory not found')

    const parent = lib.categories.find((c) => c.id === sub.categoryId)
    if (!parent) throw new Error('Parent category not found')

    if (input.mode === 'reassign') {
      const to = lib.subcategories.find((s) => s.id === input.reassignToSubcategoryId)
      if (!to) throw new Error('Reassign-to subcategory not found')
      if (to.id === sub.id) throw new Error('Reassign-to subcategory must be different')
      if (to.categoryId !== sub.categoryId) {
        throw new Error('Reassign-to subcategory must be in the same category')
      }

      await this.storage.reassignSubcategoryInCards({
        category: parent.name,
        fromSubcategory: sub.name,
        toSubcategory: to.name
      })
    } else {
      await this.storage.clearSubcategoryInCards({ category: parent.name, subcategory: sub.name })
    }

    const subcategories = lib.subcategories.filter((s) => s.id !== sub.id)
    await this.settings.update({ subcategories } as any)
  }
}

function normalizeCategoryDef(raw: any): CategoryDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  const name = normalizeName(raw.name)
  const color = normalizeColor(raw.color)
  const description = normalizeDescription(raw.description)
  if (!id || !name || !color) return null
  return {
    id,
    name,
    color,
    description,
    locked: !!raw.locked,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : undefined
  }
}

function normalizeSubcategoryDef(raw: any): SubcategoryDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  const categoryId = String(raw.categoryId ?? '').trim()
  const name = normalizeName(raw.name)
  const color = normalizeColor(raw.color)
  const description = normalizeDescription(raw.description)
  if (!id || !categoryId || !name || !color) return null
  return {
    id,
    categoryId,
    name,
    color,
    description,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : undefined
  }
}

function ensureUniqueCategoryName(categories: CategoryDefinition[], name: string, excludeId?: string) {
  const wanted = caseFold(name)
  for (const c of categories) {
    if (excludeId && c.id === excludeId) continue
    if (caseFold(c.name) === wanted) throw new Error('Category name already exists')
  }
}

function ensureUniqueSubcategoryName(
  subcategories: SubcategoryDefinition[],
  categoryId: string,
  name: string,
  excludeId?: string
) {
  const wanted = caseFold(name)
  for (const s of subcategories) {
    if (s.categoryId !== categoryId) continue
    if (excludeId && s.id === excludeId) continue
    if (caseFold(s.name) === wanted) throw new Error('Subcategory name already exists in this category')
  }
}
