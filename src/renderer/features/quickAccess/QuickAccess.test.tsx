// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAccess } from './QuickAccess'

describe('QuickAccess', () => {
  beforeEach(() => {
    vi.useRealTimers()
    window.chrona = {
      searchTimeline: vi.fn(async () => ({
        hits: [{ card: { id: 7, batchId: null, startTs: 1_774_340_400, endTs: 1_774_342_200, dayKey: '2026-03-23', title: 'Design review', summary: null, detailedSummary: null, category: 'Work', subcategory: null, metadata: null, videoSummaryUrl: null }, rank: 1, snippet: null }],
        limit: 8,
        offset: 0,
        hasMore: false
      }))
    } as any
  })

  it('opens from the keyboard, searches after 150ms, executes a result, and restores focus', async () => {
    const user = userEvent.setup()
    const onJumpToCard = vi.fn()
    render(<><button>Origin</button><QuickAccess platform="darwin" dayKey="2026-03-23" nowTs={1_774_342_200} recording={false} onNavigate={vi.fn()} onToggleRecording={vi.fn(async () => undefined)} onJumpToCard={onJumpToCard} /></>)
    const origin = screen.getByRole('button', { name: 'Origin' })
    origin.focus()

    await user.keyboard('{Meta>}k{/Meta}')
    const input = screen.getByRole('textbox', { name: 'Quick access search' })
    expect(input).toHaveFocus()
    await user.type(input, 'design')
    expect(await screen.findByRole('option', { name: /Design review/ })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onJumpToCard).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
    await waitFor(() => expect(origin).toHaveFocus())
  })
})
