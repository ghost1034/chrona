import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageService, mergeIntervals, subtractIntervals } from './storage'

async function makeStorage(): Promise<{ storage: StorageService; dir: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-replace-test-'))
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

const T0 = 1_750_000_000

async function makeBatch(storage: StorageService, startTs: number, endTs: number): Promise<number> {
  return storage.createBatchWithScreenshots({ startTs, endTs, screenshotIds: [] })
}

async function insertCard(
  storage: StorageService,
  opts: { startTs: number; endTs: number; title: string; category?: string; batchId?: number }
): Promise<number> {
  const batchId = opts.batchId ?? (await makeBatch(storage, opts.startTs, opts.endTs))
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
        detailedSummary: null
      }
    ]
  })
  return insertedCardIds[0]
}

async function activeCards(
  storage: StorageService,
  startTs: number,
  endTs: number
): Promise<Array<{ id: number; startTs: number; endTs: number; title: string; category: string }>> {
  const rows = await storage.fetchCardsInRange({ startTs, endTs, includeSystem: true })
  return rows.map((r: any) => ({
    id: Number(r.id),
    startTs: Number(r.start_ts),
    endTs: Number(r.end_ts),
    title: String(r.title),
    category: String(r.category)
  }))
}

describe('interval helpers', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([])).toEqual([])
    expect(
      mergeIntervals([
        [10, 20],
        [15, 30],
        [40, 50]
      ])
    ).toEqual([
      [10, 30],
      [40, 50]
    ])
    expect(
      mergeIntervals([
        [40, 50],
        [10, 20],
        [20, 30]
      ])
    ).toEqual([
      [10, 30],
      [40, 50]
    ])
  })

  it('subtracts covered intervals from a span', () => {
    expect(subtractIntervals([0, 100], [])).toEqual([[0, 100]])
    expect(subtractIntervals([0, 100], [[0, 100]])).toEqual([])
    expect(subtractIntervals([0, 100], [[40, 60]])).toEqual([
      [0, 40],
      [60, 100]
    ])
    expect(subtractIntervals([0, 100], [[-50, 30]])).toEqual([[30, 100]])
    expect(subtractIntervals([0, 100], [[70, 150]])).toEqual([[0, 70]])
    expect(subtractIntervals([0, 100], [[200, 300]])).toEqual([[0, 100]])
  })
})

describe('replaceCardsInRange', () => {
  it('keeps existing cards in the window that no new card overlaps', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    const oldId = await insertCard(storage, {
      startTs: T0,
      endTs: T0 + 1800,
      title: 'Earlier work'
    })

    const batchId = await makeBatch(storage, T0 + 3000, T0 + 3600)
    const res = await storage.replaceCardsInRange({
      fromTs: T0,
      toTs: T0 + 3600,
      batchId,
      newCards: [
        {
          startTs: T0 + 3000,
          endTs: T0 + 3600,
          title: 'New activity',
          category: 'Work'
        }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 3600)
    expect(cards.map((c) => c.title).sort()).toEqual(['Earlier work', 'New activity'])
    expect(cards.find((c) => c.id === oldId)).toBeTruthy()
    expect(res.trimmedCardIds).toEqual([])

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('replaces existing cards fully covered by a new card', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    await insertCard(storage, { startTs: T0, endTs: T0 + 1800, title: 'Old card' })

    const batchId = await makeBatch(storage, T0, T0 + 1800)
    await storage.replaceCardsInRange({
      fromTs: T0,
      toTs: T0 + 1800,
      batchId,
      newCards: [
        { startTs: T0, endTs: T0 + 1800, title: 'Replacement', category: 'Work' }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 1800)
    expect(cards.map((c) => c.title)).toEqual(['Replacement'])

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('trims a partially-overlapped card instead of deleting it', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    // Card straddles the window start; new card covers only its tail.
    const oldId = await insertCard(storage, {
      startTs: T0,
      endTs: T0 + 5400,
      title: 'Straddler'
    })

    const batchId = await makeBatch(storage, T0 + 3600, T0 + 7200)
    const res = await storage.replaceCardsInRange({
      fromTs: T0 + 3600,
      toTs: T0 + 7200,
      batchId,
      newCards: [
        { startTs: T0 + 3600, endTs: T0 + 7200, title: 'Tail activity', category: 'Work' }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 7200)
    const straddler = cards.find((c) => c.id === oldId)
    expect(straddler).toBeTruthy()
    expect(straddler!.startTs).toBe(T0)
    expect(straddler!.endTs).toBe(T0 + 3600)
    expect(res.trimmedCardIds).toEqual([oldId])

    // No moment between T0 and T0+7200 is uncovered.
    const coveredUntil = cards
      .sort((a, b) => a.startTs - b.startTs)
      .reduce((cursor, c) => (c.startTs <= cursor ? Math.max(cursor, c.endTs) : cursor), T0)
    expect(coveredUntil).toBe(T0 + 7200)

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('splits a card in two when a new card lands in its middle', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    const oldId = await insertCard(storage, {
      startTs: T0,
      endTs: T0 + 3600,
      title: 'Long block'
    })

    const batchId = await makeBatch(storage, T0 + 1200, T0 + 2400)
    const res = await storage.replaceCardsInRange({
      fromTs: T0 + 1200,
      toTs: T0 + 2400,
      batchId,
      newCards: [
        { startTs: T0 + 1200, endTs: T0 + 2400, title: 'Interruption', category: 'Personal' }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 3600)
    const remnants = cards.filter((c) => c.title === 'Long block')
    expect(remnants).toHaveLength(2)
    expect(remnants.map((c) => [c.startTs, c.endTs]).sort((a, b) => a[0] - b[0])).toEqual([
      [T0, T0 + 1200],
      [T0 + 2400, T0 + 3600]
    ])
    expect(res.trimmedCardIds).toHaveLength(2)
    expect(res.trimmedCardIds).toContain(oldId)

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps even very short remnants of partially-overlapped cards', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    const oldId = await insertCard(storage, { startTs: T0, endTs: T0 + 1000, title: 'Old card' })

    const batchId = await makeBatch(storage, T0 + 30, T0 + 1000)
    await storage.replaceCardsInRange({
      fromTs: T0 + 30,
      toTs: T0 + 1000,
      batchId,
      newCards: [
        { startTs: T0 + 30, endTs: T0 + 1000, title: 'Near-total overlap', category: 'Work' }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 1000)
    const remnant = cards.find((c) => c.id === oldId)
    expect(remnant).toBeTruthy()
    expect(remnant!.startTs).toBe(T0)
    expect(remnant!.endTs).toBe(T0 + 30)
    expect(cards.map((c) => c.title).sort()).toEqual(['Near-total overlap', 'Old card'])

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removes only its own batch System cards and never trims System cards', async () => {
    const ctx = await makeStorage()
    if (!ctx) return
    const { storage, dir } = ctx

    const otherBatchId = await makeBatch(storage, T0, T0 + 600)
    await storage.replaceCardsInRange({
      fromTs: T0,
      toTs: T0 + 600,
      batchId: otherBatchId,
      newCards: [
        { startTs: T0, endTs: T0 + 600, title: 'Other batch error', category: 'System' }
      ]
    })

    const batchId = await makeBatch(storage, T0, T0 + 600)
    await storage.replaceCardsInRange({
      fromTs: T0,
      toTs: T0 + 600,
      batchId,
      newCards: [
        { startTs: T0, endTs: T0 + 600, title: 'My error', category: 'System' }
      ]
    })

    // Same-batch retry: old System card for this batch is removed, other kept.
    await storage.replaceCardsInRange({
      fromTs: T0,
      toTs: T0 + 600,
      batchId,
      newCards: [
        { startTs: T0, endTs: T0 + 600, title: 'Recovered work', category: 'Work' }
      ]
    })

    const cards = await activeCards(storage, T0, T0 + 600)
    expect(cards.map((c) => c.title).sort()).toEqual(['Other batch error', 'Recovered work'])

    await storage.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
