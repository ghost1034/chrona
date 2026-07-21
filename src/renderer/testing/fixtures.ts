import type { ChronaApi } from '../../main/preload'
import type { TimelineCardDTO } from '../../shared/timeline'
import { dayKeyFromUnixSeconds, dayWindowForDayKey } from '../../shared/time'

export type FixtureScenario =
  | 'populated'
  | 'empty'
  | 'loading'
  | 'permission-denied'
  | 'ai-missing'
  | 'paused'
  | 'error'
  | 'large-history'

const categories = [
  { id: 'work', name: 'Work', color: '#246BCE', description: 'Focused work', order: 0 },
  { id: 'communication', name: 'Communication', color: '#7C5DB3', description: 'Messages and meetings', order: 1 },
  { id: 'personal', name: 'Personal', color: '#287A52', description: 'Personal activity', order: 2 },
  { id: 'system', name: 'System', color: '#66707A', description: 'System activity', locked: true, order: 3 }
]

function cardsForDay(dayKey: string, count: number): TimelineCardDTO[] {
  const { startTs } = dayWindowForDayKey(dayKey)
  const titles = ['Plan project milestones', 'Design review', 'Write implementation notes', 'Team conversation', 'Research capture APIs', 'Refine launch checklist']
  return Array.from({ length: count }, (_, index) => {
    const start = startTs + 5 * 3600 + index * 2700
    const category = index % 4 === 3 ? 'Communication' : 'Work'
    return {
      id: index + 1,
      batchId: index + 10,
      startTs: start,
      endTs: start + 2100,
      dayKey,
      title: titles[index % titles.length]!,
      summary: 'A concise local-first record of the work completed during this interval.',
      detailedSummary: index % 2 ? 'Evidence was summarized from visible application activity.' : null,
      category,
      subcategory: category === 'Work' ? 'Project' : 'Meetings',
      metadata: JSON.stringify({ primary: index % 2 ? 'Figma' : 'Visual Studio Code' }),
      videoSummaryUrl: index % 3 === 0 ? `timelapses/${dayKey}-${index}.mp4` : null
    }
  })
}

export function createChronaFixture(scenario: FixtureScenario): ChronaApi {
  const today = dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))
  const cardCount = scenario === 'empty' ? 0 : scenario === 'large-history' ? 120 : 8
  const cards = cardsForDay(today, cardCount)
  const denied = scenario === 'permission-denied'
  const hasKey = scenario !== 'ai-missing'
  const paused = scenario === 'paused'
  const captureError = scenario === 'error' ? 'Screen capture stopped after repeated permission failures.' : null
  const never = new Promise<never>(() => {})
  const noopSubscription = () => () => undefined

  const handlers: Partial<Record<keyof ChronaApi, (...args: any[]) => any>> = {
    getCaptureState: () => scenario === 'loading' ? never : Promise.resolve({
      desiredRecordingEnabled: !denied,
      isSystemPaused: paused,
      intervalSeconds: 30,
      selectedDisplayId: 'display-1',
      resolvedDisplayId: 'display-1',
      lastCaptureTs: cards.at(-1)?.endTs ?? null,
      consecutiveFailures: captureError ? 3 : 0,
      lastError: captureError
    }),
    listDisplays: async () => [{ id: 'display-1', bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2 }],
    getSetupStatus: async () => ({ platform: 'darwin', hasGeminiKey: hasKey, captureAccess: { status: denied ? 'denied' : 'granted', message: denied ? 'Screen Recording access is required.' : null } }),
    getSettings: async () => ({ themePreference: 'system', categories, subcategories: [], timelapsesEnabled: true, timelapseFps: 2, timelinePxPerHour: 120, onboardingCompleted: true }),
    getCategoryLibrary: async () => ({ categories, subcategories: [] }),
    getAutoStartEnabled: async () => ({ enabled: true }),
    getStorageUsage: async () => ({ recordingsBytes: 2_400_000_000, timelapsesBytes: 780_000_000, recordingsLimitBytes: 10_737_418_240, timelapsesLimitBytes: 10_737_418_240 }),
    getTimelineDay: async (dayKey: string) => ({ dayKey, cards: dayKey === today ? cards : [] }),
    searchTimeline: async (request: any) => {
      const query = String(request.query ?? '').toLowerCase()
      const hits = cards.filter((card) => `${card.title} ${card.summary} ${card.category}`.toLowerCase().includes(query)).slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 50)).map((card) => ({ card, rank: 1, snippet: card.summary }))
      return { hits, limit: request.limit ?? 50, offset: request.offset ?? 0, hasMore: false }
    },
    getTimelineCardObservations: async (cardId: number) => ({ observations: [{ startTs: cards.find((card) => card.id === cardId)?.startTs ?? 0, endTs: cards.find((card) => card.id === cardId)?.endTs ?? 0, observation: 'Worked steadily in the primary application with one short context switch.' }] }),
    getReviewDay: async () => ({ segments: [], coverageByCardId: Object.fromEntries(cards.map((card, index) => [card.id, index < 2 ? .9 : .25])) }),
    applyReviewRating: async () => ({ ok: true }),
    getJournalDay: async (dayKey: string) => ({ entry: cardCount ? { dayKey, intentions: 'Finish the redesign foundation.', notes: 'The keyboard flow is becoming clearer.', reflections: '', summary: '', status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : null }),
    getDashboardStats: async (scope: any) => ({
      scope, windowSeconds: scope.endTs - scope.startTs, trackedSeconds: cardCount * 2100, untrackedSeconds: 0,
      byCategorySeconds: [{ category: 'Work', seconds: Math.round(cardCount * 1700) }, { category: 'Communication', seconds: Math.round(cardCount * 400) }],
      byTitleSeconds: cards.slice(0, 8).map((card) => ({ title: card.title, category: card.category, seconds: card.endTs - card.startTs })),
      perDay: [{ dayKey: today, trackedSeconds: cardCount * 2100, byCategorySeconds: { Work: cardCount * 1700, Communication: cardCount * 400 } }],
      review: { trackedNonSystemSeconds: cardCount * 2100, coveredSeconds: cardCount * 900, coverageFraction: cardCount ? .43 : 0, focusSeconds: cardCount * 600, neutralSeconds: cardCount * 200, distractedSeconds: cardCount * 100, unreviewedCardCount: Math.max(0, cardCount - 2) },
      blocks: { longestWorkBlockSeconds: cardCount ? 5400 : 0 }
    }),
    getSyncStatus: async () => ({ enabled: false, paired: false, deviceId: null, endpoint: '', lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextSyncAt: null, inFlight: false }),
    listBlurRegions: async () => ({ regions: [], hotkey: 'CommandOrControl+Shift+B' }),
    setRecordingEnabled: async (enabled: boolean) => ({ desiredRecordingEnabled: enabled, isSystemPaused: false, intervalSeconds: 30, selectedDisplayId: 'display-1', resolvedDisplayId: 'display-1', lastCaptureTs: null, consecutiveFailures: 0, lastError: null }),
    updateSettings: async () => ({ ok: true }),
    onRecordingStateChanged: noopSubscription,
    onCaptureError: noopSubscription,
    onAnalysisBatchUpdated: noopSubscription,
    onTimelineUpdated: noopSubscription,
    onStorageUsageUpdated: noopSubscription,
    onSyncStatusChanged: noopSubscription,
    onBlurRegionsChanged: noopSubscription,
    onNavigate: noopSubscription
  }

  return new Proxy(handlers, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target]
      return async () => ({ ok: true })
    }
  }) as ChronaApi
}

export function installFixtureFromUrl() {
  if (window.chrona) return
  const scenario = new URLSearchParams(window.location.search).get('fixture') as FixtureScenario | null
  if (!scenario) return
  window.chrona = createChronaFixture(scenario)
}
