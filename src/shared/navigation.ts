export type SettingsSection =
  | 'general'
  | 'capture'
  | 'timeline'
  | 'ai'
  | 'storage'
  | 'integrations'
  | 'advanced'

export type RendererRoute =
  | { name: 'today' }
  | { name: 'timeline'; dayKey?: string; cardId?: number }
  | { name: 'review'; dayKey?: string }
  | { name: 'insights' }
  | { name: 'ask' }
  | { name: 'journal'; dayKey?: string }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'onboarding' }

export type NavigationTarget = RendererRoute

// `view` remains optional for compatibility with events emitted by older main processes.
export type NavigationEventPayload = {
  target?: NavigationTarget
  view?: 'settings' | 'onboarding'
}

export type RouteAction = { type: 'navigate'; target: NavigationTarget }

export function routeReducer(_route: RendererRoute, action: RouteAction): RendererRoute {
  return action.target
}

export function routeFromNavigationEvent(payload: NavigationEventPayload): RendererRoute | null {
  if (payload.target) return payload.target
  if (payload.view === 'settings') return { name: 'settings', section: 'general' }
  if (payload.view === 'onboarding') return { name: 'onboarding' }
  return null
}
