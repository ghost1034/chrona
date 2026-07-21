// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { App } from './App'
import { installMockChrona } from './mockChrona'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
  delete (window as any).chrona
  installMockChrona()
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('redesigned application shell', () => {
  it('has no detectable accessibility violations in the default Timeline state', async () => {
    const { container } = render(<App />)
    await screen.findByText('Tracked time')
    expect((await axe(container)).violations).toEqual([])
  })

  it('exposes the four primary destinations and integrates Review into Timeline', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('button', { name: /^Timeline$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Insights/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Ask$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Journal/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Review$/i }))
    expect(await screen.findByText('Daily review queue')).toBeInTheDocument()
    expect(screen.getByText(/activities remaining/i)).toBeInTheDocument()
  })

  it('opens compact timeline filters and applies a category filter', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Tracked time')

    await user.click(screen.getByRole('button', { name: /^Filters/i }))
    expect(screen.getByRole('dialog', { name: 'Timeline filters' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(screen.getByText(/4 activities/)).toBeInTheDocument())
  })

  it('persists and resolves a dark appearance choice', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Settings/i }))
    await user.click(await screen.findByRole('button', { name: 'Dark' }))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
  })
})
