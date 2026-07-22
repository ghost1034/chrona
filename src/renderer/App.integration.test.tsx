// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createChronaFixture } from './testing/fixtures'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  globalThis.ResizeObserver = class { observe() {}; unobserve() {}; disconnect() {} }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('redesigned application workflows', () => {
  it('navigates, switches timeline search to compact results, jumps, and edits the inspector', async () => {
    const user = userEvent.setup()
    const api = createChronaFixture('populated')
    const updateCardCategory = vi.fn(async () => ({ ok: true as const }))
    api.updateTimelineCardCategory = updateCardCategory
    window.chrona = api
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Capture is healthy' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Timeline' }))
    const search = await screen.findByPlaceholderText('Search timeline…')
    await user.type(search, 'Plan')
    const result = (await screen.findAllByRole('button', { name: /Plan project milestones/ }))[0]!
    expect(document.querySelector('.timelineGrid')).not.toBeInTheDocument()
    await user.click(result)
    expect(search).toHaveValue('')

    const inspector = screen.getByLabelText('Activity inspector')
    expect(within(inspector).getByText('Plan project milestones')).toBeInTheDocument()
    await user.selectOptions(within(inspector).getByLabelText('Category'), 'Communication')
    expect(updateCardCategory).toHaveBeenCalledWith(expect.objectContaining({ cardId: 1, category: 'Communication' }))
  })

  it('supports review rating shortcuts and journal autosave without losing the selected day', async () => {
    const user = userEvent.setup()
    const api = createChronaFixture('populated')
    const applyRating = vi.fn(async () => ({ ok: true as const }))
    const upsertJournal = vi.fn(async (dayKey: string, patch: any) => ({ entry: { dayKey, intentions: String(patch.intentions ?? ''), notes: '', reflections: '', summary: '', status: 'draft' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }))
    api.applyReviewRating = applyRating
    api.upsertJournalEntry = upsertJournal
    window.chrona = api
    render(<App />)

    await screen.findByRole('heading', { name: 'Capture is healthy' })
    await user.click(screen.getByRole('button', { name: 'Reflect' }))
    expect(await screen.findByText('How focused was this activity?')).toBeInTheDocument()
    await user.keyboard('1')
    expect(applyRating).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 'focus')

    await user.click(screen.getByRole('tab', { name: 'Journal' }))
    const intentions = await screen.findByPlaceholderText('What do you want to accomplish?')
    await user.type(intentions, ' Ship it.')
    await waitFor(() => expect(upsertJournal).toHaveBeenCalled(), { timeout: 1600 })
    expect((screen.getByLabelText('Selected date') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows permission guidance and requires confirmation before purging media', async () => {
    const user = userEvent.setup()
    const api = createChronaFixture('permission-denied')
    const purgeStorage = vi.fn(async () => ({ ok: true as const, deletedScreenshotCount: 1, deletedTimelapseCount: 1, freedRecordingsBytes: 100, freedTimelapsesBytes: 100, recordingsBytes: 0, timelapsesBytes: 0 }))
    api.purgeStorageNow = purgeStorage
    window.chrona = api
    render(<App />)

    await screen.findByRole('heading', { name: 'Capture is off' })
    await user.click(screen.getByRole('button', { name: 'Help & setup' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    expect((await screen.findAllByText(/macOS Screen Recording permission/)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Status: missing/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(await screen.findByRole('button', { name: 'Data & Sync' }))
    await user.click(screen.getByRole('button', { name: 'Purge now' }))
    expect(purgeStorage).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Purge media now?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Purge media' }))
    expect(purgeStorage).toHaveBeenCalledTimes(1)
  })

  it('opens concealed demo controls and makes hidden cards and statistics appear empty', async () => {
    const user = userEvent.setup()
    const api = createChronaFixture('populated')
    let hidden = false
    const updateSettings = vi.fn(async (patch: any) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'demoCardsHidden')) hidden = !!patch.demoCardsHidden
      return { demoCardsHidden: hidden, demoTimeOffsetSeconds: null } as any
    })
    api.updateSettings = updateSettings
    api.getDashboardStats = vi.fn(async (scope: any) => hidden
      ? {
          scope,
          windowSeconds: scope.endTs - scope.startTs,
          trackedSeconds: 0,
          untrackedSeconds: scope.endTs - scope.startTs,
          byCategorySeconds: [],
          byTitleSeconds: [],
          perDay: [],
          review: { trackedNonSystemSeconds: 0, coveredSeconds: 0, coverageFraction: 0, focusSeconds: 0, neutralSeconds: 0, distractedSeconds: 0, unreviewedCardCount: 0 },
          blocks: { longestWorkBlockSeconds: 0 }
        }
      : createChronaFixture('populated').getDashboardStats(scope))
    window.chrona = api
    render(<App />)

    expect(await screen.findByText('Plan project milestones')).toBeInTheDocument()
    await user.keyboard('{Meta>}{Shift>}d{/Shift}{/Meta}')
    const dialog = screen.getByRole('dialog', { name: 'Demo controls' })
    await user.click(within(dialog).getByLabelText('Hide all timeline cards'))
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ demoCardsHidden: true }))
    await waitFor(() => expect(screen.queryByText('Plan project milestones')).not.toBeInTheDocument())
    const trackedMetric = screen.getByText('Tracked time').closest('article')
    expect(trackedMetric).not.toBeNull()
    expect(within(trackedMetric!).getByText('0m')).toBeInTheDocument()

    await user.keyboard('{Meta>}{Shift>}h{/Shift}{/Meta}')
    expect(await screen.findByText('Plan project milestones')).toBeInTheDocument()
    expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ demoCardsHidden: false }))
  })
})
