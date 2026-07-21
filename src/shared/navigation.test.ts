import { describe, expect, it } from 'vitest'
import { routeFromNavigationEvent, routeReducer } from './navigation'

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
})
