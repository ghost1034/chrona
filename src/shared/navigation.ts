export type SettingsSection =
  | 'general'
  | 'capture'
  | 'categories'
  | 'intelligence'
  | 'data'
  | 'advanced'

export type ReflectTab = 'review' | 'journal'

export type RendererRoute =
  | { name: 'today' }
  | { name: 'timeline'; dayKey?: string; cardId?: number }
  | { name: 'reflect'; tab: ReflectTab; dayKey?: string }
  | { name: 'insights' }
  | { name: 'ask' }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'onboarding' }

/** Targets accepted from current and older main processes, tray events, and deep links. */
export type LegacyNavigationTarget =
  | RendererRoute
  | { name: 'review'; dayKey?: string }
  | { name: 'journal'; dayKey?: string }
  | { name: 'dashboard' }
  | {
      name: 'settings'
      section?: SettingsSection | 'timeline' | 'ai' | 'storage' | 'integrations'
    }

export type NavigationTarget = LegacyNavigationTarget

// `view` remains optional for compatibility with events emitted by older main processes.
export type NavigationEventPayload = {
  target?: NavigationTarget
  view?: 'settings' | 'onboarding'
}

export type RouteAction = { type: 'navigate'; target: NavigationTarget }

export function normalizeSettingsSection(section?: string): SettingsSection {
  if (section === 'capture') return 'capture'
  if (section === 'timeline' || section === 'categories') return 'categories'
  if (section === 'ai' || section === 'intelligence') return 'intelligence'
  if (section === 'storage' || section === 'integrations' || section === 'data') return 'data'
  if (section === 'advanced') return 'advanced'
  return 'general'
}

export function normalizeRoute(target: NavigationTarget): RendererRoute {
  if (target.name === 'review') return { name: 'reflect', tab: 'review', dayKey: target.dayKey }
  if (target.name === 'journal') return { name: 'reflect', tab: 'journal', dayKey: target.dayKey }
  if (target.name === 'dashboard') return { name: 'insights' }
  if (target.name === 'settings') {
    return { name: 'settings', section: normalizeSettingsSection(target.section) }
  }
  return target
}

export function routeReducer(_route: RendererRoute, action: RouteAction): RendererRoute {
  return normalizeRoute(action.target)
}

export function routeFromNavigationEvent(payload: NavigationEventPayload): RendererRoute | null {
  if (payload.target) return normalizeRoute(payload.target)
  if (payload.view === 'settings') return { name: 'settings', section: 'general' }
  if (payload.view === 'onboarding') return { name: 'onboarding' }
  return null
}
