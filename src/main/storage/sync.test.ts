import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageService, computeCardContentHash } from './storage'

async function makeStorage(): Promise<{ storage: StorageService; dir: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-sync-test-'))
  const storage = new StorageService({ userDataPath: dir })
  try {
    await storage.init()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('NODE_MODULE_VERSION') && msg.includes('better_sqlite3.node')) {
      // CI/dev environments sometimes run tests under a Node version that
      // doesn't match the prebuilt better-sqlite3 native module. Skip then.
      await fs.rm(dir, { recursive: true, force: true })
      return null
    }
    throw e
  }
  return { storage, dir }
}

async function insertCard(
  storage: StorageService,
  opts: { startTs: number; endTs: number; title: string; category?: string }
): Promise<number> {
  const batchId = await storage.createBatchWithScreenshots({
    startTs: opts.startTs,
    endTs: opts.endTs,
    screenshotIds: []
  })
  const { insertedCardIds } = await storage.replaceCardsInRange({
    fromTs: opts.startTs,
    toTs: opts.endTs,
    batchId,
    newCards: [
      {
        startTs: opts.startTs,
        endTs: opts.endTs,
        title: opts.title,
        summary: 'summary',
        category: opts.category ?? 'Work',
        subcategory: null,
        detailedSummary: 'details'
      }
    ]
  })
  return insertedCardIds[0]
}

async function syncEverything(storage: StorageService): Promise<void> {
  await storage.reconcileSyncState({ full: true })
  const cards = await storage.getCardsToSync(500)
  const deleted = await storage.getDeletedCardsToSync(500)
  await storage.markCardsSynced({
    synced: cards.map((c) => ({ cardId: c.cardId, contentHash: c.contentHash })),
    deletedCardIds: deleted
  })
}

describe('computeCardContentHash', () => {
  it('is stable and sensitive to each field', () => {
    const base = {
      title: 'Coding',
      summary: 'Worked on sync',
      detailedSummary: null,
      category: 'Work',
      subcategory: null,
      startTs: 1000,
      endTs: 2000
    }
    expect(computeCardContentHash(base)).toBe(computeCardContentHash({ ...base }))
    expect(computeCardContentHash({ ...base, category: 'Personal' })).not.toBe(
      computeCardContentHash(base)
    )
    expect(computeCardContentHash({ ...base, endTs: 2001 })).not.toBe(computeCardContentHash(base))
  })

  it('does not collide across field boundaries', () => {
    const a = computeCardContentHash({
      title: 'ab',
      summary: '',
      detailedSummary: null,
      category: 'Work',
      subcategory: null,
      startTs: 1,
      endTs: 2
    })
    const b = computeCardContentHash({
      title: 'a',
      summary: 'b',
      detailedSummary: null,
      category: 'Work',
      subcategory: null,
      startTs: 1,
      endTs: 2
    })
    expect(a).not.toBe(b)
  })
})

describe('StorageService sync tracking', () => {
  it('detects new cards and clears them after ack', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const cardId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Coding' })

      await storage.reconcileSyncState()
      const toSync = await storage.getCardsToSync(500)
      expect(toSync.map((c) => c.cardId)).toEqual([cardId])
      expect(toSync[0].title).toBe('Coding')
      expect(toSync[0].contentHash).toBe(
        computeCardContentHash({
          title: 'Coding',
          summary: 'summary',
          detailedSummary: 'details',
          category: 'Work',
          subcategory: null,
          startTs: 1000,
          endTs: 2000
        })
      )
      expect(await storage.countPendingSync()).toBe(1)

      await storage.markCardsSynced({
        synced: toSync.map((c) => ({ cardId: c.cardId, contentHash: c.contentHash })),
        deletedCardIds: []
      })
      expect(await storage.countPendingSync()).toBe(0)

      // Re-reconciling is a no-op for unchanged cards.
      await storage.reconcileSyncState({ full: true })
      expect(await storage.countPendingSync()).toBe(0)
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('catches in-place edits via full reconcile and targeted reconcile', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const cardId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Coding' })
      await syncEverything(storage)
      expect(await storage.countPendingSync()).toBe(0)

      // In-place category edit: incremental scan misses it (id <= last seen)...
      await storage.updateCardCategory({ cardId, category: 'Personal', subcategory: null })
      await storage.reconcileSyncState()
      expect(await storage.countPendingSync()).toBe(0)

      // ...the full scan catches it.
      await storage.reconcileSyncState({ full: true })
      const dirty = await storage.getCardsToSync(500)
      expect(dirty.map((c) => c.cardId)).toEqual([cardId])
      expect(dirty[0].category).toBe('Personal')

      await storage.markCardsSynced({
        synced: dirty.map((c) => ({ cardId: c.cardId, contentHash: c.contentHash })),
        deletedCardIds: []
      })

      // The targeted single-card reconcile (updateCardCategory hook) also works.
      await storage.updateCardCategory({ cardId, category: 'Work', subcategory: null })
      await storage.reconcileSyncCardById(cardId)
      const dirty2 = await storage.getCardsToSync(500)
      expect(dirty2.map((c) => c.cardId)).toEqual([cardId])
      expect(dirty2[0].category).toBe('Work')
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('handles replaceCardsInRange as delete-of-old + insert-of-new', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const oldId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'First pass' })
      await syncEverything(storage)

      // Re-analysis replaces the synced card with a new row (new local id).
      const newId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Second pass' })
      expect(newId).not.toBe(oldId)

      // Incremental reconcile sees both the new insert and the new soft-delete.
      await storage.reconcileSyncState()
      expect(await storage.getDeletedCardsToSync(500)).toEqual([oldId])
      const cards = await storage.getCardsToSync(500)
      expect(cards.map((c) => c.cardId)).toEqual([newId])

      await storage.markCardsSynced({
        synced: cards.map((c) => ({ cardId: c.cardId, contentHash: c.contentHash })),
        deletedCardIds: [oldId]
      })
      expect(await storage.countPendingSync()).toBe(0)
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never reports cards deleted before they were ever synced', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const ephemeralId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Draft' })
      // Replaced before any sync happened — the server never saw it.
      const finalId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Final' })

      await storage.reconcileSyncState()
      expect(await storage.getDeletedCardsToSync(500)).toEqual([])
      const cards = await storage.getCardsToSync(500)
      expect(cards.map((c) => c.cardId)).toEqual([finalId])
      expect(cards.map((c) => c.cardId)).not.toContain(ephemeralId)
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('resetSyncState forgets acks so everything re-syncs after re-pairing', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      const cardId = await insertCard(storage, { startTs: 1000, endTs: 2000, title: 'Coding' })
      await syncEverything(storage)
      expect(await storage.countPendingSync()).toBe(0)

      await storage.resetSyncState()
      const cards = await storage.getCardsToSync(500)
      expect(cards.map((c) => c.cardId)).toEqual([cardId])
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('round-trips sync_meta keys', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx
    try {
      expect(await storage.getSyncMeta('device_id')).toBeNull()
      await storage.setSyncMeta('device_id', 'abc-123')
      expect(await storage.getSyncMeta('device_id')).toBe('abc-123')
      await storage.setSyncMeta('device_id', 'def-456')
      expect(await storage.getSyncMeta('device_id')).toBe('def-456')
      await storage.setSyncMeta('device_id', null)
      expect(await storage.getSyncMeta('device_id')).toBeNull()
    } finally {
      await storage.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
