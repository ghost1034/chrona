import { describe, expect, it } from 'vitest'
import { normalizeRoute, routeFromNavigationEvent, routeReducer } from './navigation'

describe('renderer navigation', () => {
  it('uses typed targets with day and card context', () => {
    const target = { name: 'timeline', dayKey: '2026-07-21', cardId: 42 } as const
    expect(routeFromNavigationEvent({ target })).toEqual(target)
    expect(routeReducer({ name: 'today' }, { type: 'navigate', target })).toEqual(target)
  })

  it('retains legacy settings and onboarding event compatibility', () => {
    expect(routeFromNavigationEvent({ view: 'settings' })).toEqual({ name: 'settings', section: 'general' })
    expect(routeFromNavigationEvent({ view: 'onboarding' })).toEqual({ name: 'onboarding' })
  })

  it.each([
    [{ name: 'review', dayKey: '2026-07-21' }, { name: 'reflect', tab: 'review', dayKey: '2026-07-21' }],
    [{ name: 'journal', dayKey: '2026-07-21' }, { name: 'reflect', tab: 'journal', dayKey: '2026-07-21' }],
    [{ name: 'dashboard' }, { name: 'insights' }],
    [{ name: 'settings', section: 'timeline' }, { name: 'settings', section: 'categories' }],
    [{ name: 'settings', section: 'ai' }, { name: 'settings', section: 'intelligence' }],
    [{ name: 'settings', section: 'storage' }, { name: 'settings', section: 'data' }],
    [{ name: 'settings', section: 'integrations' }, { name: 'settings', section: 'data' }]
  ] as const)('normalizes legacy target %o', (legacy, expected) => {
    expect(normalizeRoute(legacy)).toEqual(expected)
  })
})
