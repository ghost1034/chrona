import type { ChronaApi } from '../main/preload'
import type { Settings } from '../shared/ipc'
import type { TimelineCardDTO } from '../shared/timeline'
import { dayKeyFromUnixSeconds, dayWindowForDayKey } from '../shared/time'

const categories = [
  { id: 'cat_work', name: 'Work', color: '#3f8f83', description: 'Professional and creative work.', order: 10 },
  { id: 'cat_personal', name: 'Personal', color: '#6b83a8', description: 'Life admin and personal projects.', order: 20 },
  { id: 'cat_distraction', name: 'Distraction', color: '#c47b51', description: 'Unplanned browsing and interruptions.', order: 30 },
  { id: 'cat_idle', name: 'Idle', color: '#9ba29d', description: 'Away or inactive.', locked: true, order: 40 }
]

const subcategories = [
  { id: 'sub_deep', categoryId: 'cat_work', name: 'Deep work', color: '#3f8f83', description: '', order: 10 },
  { id: 'sub_comms', categoryId: 'cat_work', name: 'Communication', color: '#69a89e', description: '', order: 20 }
]

let settings: Settings = {
  version: 11, appearanceMode: 'system', captureIntervalSeconds: 10, captureSelectedDisplayId: null,
  captureIncludeCursor: false, blurRegions: [], blurHotkey: 'CommandOrControl+Shift+B', categories, subcategories,
  analysisCheckIntervalSeconds: 60, analysisLookbackSeconds: 86400, analysisBatchTargetDurationSec: 1800,
  analysisBatchMaxGapSec: 300, analysisMinBatchDurationSec: 300, analysisCardWindowLookbackSec: 3600,
  storageLimitRecordingsBytes: 10 * 1024 ** 3, storageLimitTimelapsesBytes: 10 * 1024 ** 3,
  timelapsesEnabled: true, timelapseFps: 2, autoStartEnabled: false, timelinePxPerHour: 180,
  geminiModel: 'gemini-3.5-flash', geminiRequestTimeoutMs: 60000, geminiMaxAttempts: 3, geminiLogBodies: false,
  promptPreambleTranscribe: '', promptPreambleCards: '', promptPreambleAsk: '', promptPreambleJournalDraft: '',
  onboardingVersion: 1, onboardingCompleted: true, syncEnabled: false, syncEndpoint: '', syncIntervalSeconds: 300
}

let recording = true
let coverage: Record<number, number> = { 1: 1, 2: .4, 3: 0, 4: .9, 5: 0, 6: 1 }
const journals = new Map<string, any>()
const noopUnsubscribe = () => () => undefined

function cardsForDay(dayKey: string): TimelineCardDTO[] {
  const { startTs } = dayWindowForDayKey(dayKey)
  const card = (id: number, startHour: number, durationMinutes: number, title: string, category: string, summary: string, subcategory: string | null = null): TimelineCardDTO => ({
    id, batchId: 1, dayKey, startTs: startTs + startHour * 3600, endTs: startTs + startHour * 3600 + durationMinutes * 60,
    title, category, subcategory, summary, detailedSummary: `${summary} Chrona identified this as a continuous block from the active apps and sites.`,
    metadata: JSON.stringify({ apps: ['Chrona'], sites: id === 2 ? ['figma.com', 'notion.so'] : id === 5 ? ['news.ycombinator.com'] : [] }),
    videoSummaryUrl: id === 2 ? 'mock-timelapse.mp4' : null
  })
  return [
    card(1, 4.5, 42, 'Morning planning and inbox', 'Work', 'Reviewed priorities, cleared messages, and prepared the day.', 'Communication'),
    card(2, 5.35, 108, 'Chrona product redesign', 'Work', 'Refined the timeline information architecture and component system.', 'Deep work'),
    card(3, 7.3, 28, 'Lunch and a short walk', 'Personal', 'Stepped away for lunch and a neighborhood walk.'),
    card(4, 8.05, 76, 'Implementation and review', 'Work', 'Built responsive shell behavior and reviewed renderer changes.', 'Deep work'),
    card(5, 9.55, 24, 'News and social browsing', 'Distraction', 'Browsed technology news between work blocks.'),
    card(6, 10.15, 58, 'Project notes and handoff', 'Work', 'Documented decisions and prepared a concise implementation handoff.', 'Communication')
  ]
}

function captureState() {
  return { desiredRecordingEnabled: recording, isSystemPaused: false, intervalSeconds: settings.captureIntervalSeconds,
    selectedDisplayId: null, resolvedDisplayId: '1', lastCaptureTs: Math.floor(Date.now() / 1000) - 8, consecutiveFailures: 0, lastError: null }
}

export function installMockChrona(): void {
  if (window.chrona) return
  const api: Record<string, any> = {
    ping: async () => ({ ok: true, nowTs: Math.floor(Date.now() / 1000) }),
    getAutoStartEnabled: async () => ({ enabled: settings.autoStartEnabled }),
    setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
    getSetupStatus: async () => ({ platform: 'darwin', hasGeminiKey: true, captureAccess: { status: 'granted', message: null } }),
    getSettings: async () => settings,
    updateSettings: async (patch: Partial<Settings>) => (settings = { ...settings, ...patch, version: 11 }),
    getCategoryLibrary: async () => ({ categories, subcategories }),
    getCaptureState: async () => captureState(),
    setRecordingEnabled: async (enabled: boolean) => { recording = enabled; return captureState() },
    setCaptureInterval: async (intervalSeconds: number) => { settings.captureIntervalSeconds = intervalSeconds; return captureState() },
    setSelectedDisplay: async () => captureState(),
    listDisplays: async () => [{ id: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }],
    getTimelineDay: async (dayKey: string) => ({ dayKey, cards: cardsForDay(dayKey) }),
    getTimelineCardObservations: async (cardId: number) => ({ cardId, observations: [{ startTs: cardsForDay(dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000)))[0]!.startTs, endTs: cardsForDay(dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000)))[0]!.endTs, observation: 'Moved between design notes, implementation, and a short review pass.' }] }),
    searchTimeline: async (req: any) => { const cards = cardsForDay(dayKeyFromUnixSeconds(req.scope.endTs - 1)); const q = String(req.query || '').toLowerCase(); const hits = cards.filter((c) => !q || `${c.title} ${c.summary}`.toLowerCase().includes(q)).map((card) => ({ card, snippet: card.summary })); return { hits, limit: 200, offset: 0, hasMore: false } },
    updateTimelineCardCategory: async () => ({ ok: true }),
    getReviewDay: async (dayKey: string) => ({ dayKey, segments: [], coverageByCardId: coverage }),
    applyReviewRating: async (startTs: number) => { const match = cardsForDay(dayKeyFromUnixSeconds(startTs)).find((c) => c.startTs === startTs); if (match) coverage = { ...coverage, [match.id]: 1 }; return { ok: true } },
    getStorageUsage: async () => ({ recordingsBytes: 2.3 * 1024 ** 3, timelapsesBytes: .8 * 1024 ** 3, recordingsLimitBytes: 10 * 1024 ** 3, timelapsesLimitBytes: 10 * 1024 ** 3 }),
    getJournalDay: async (dayKey: string) => ({ dayKey, entry: journals.get(dayKey) ?? { dayKey, intentions: 'Finish the renderer redesign with a calm, focused interface.', notes: 'The timeline structure is working well. Keep the interactions direct and the hierarchy quiet.', reflections: '', summary: '', status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }),
    upsertJournalEntry: async (dayKey: string, patch: any) => { const entry = { ...(journals.get(dayKey) ?? { dayKey, status: 'draft' }), ...patch, updatedAt: new Date().toISOString() }; journals.set(dayKey, entry); return { entry } },
    deleteJournalEntry: async (dayKey: string) => { journals.delete(dayKey); return { ok: true } },
    draftJournalWithGemini: async () => ({ draft: { intentions: 'Protect the first focus block.', notes: 'Made steady progress on the redesign.', reflections: 'The simpler navigation reduced visual noise.', summary: 'A focused day spent shaping and implementing Chrona’s new interface.' } }),
    askChrona: async () => ({ answerMarkdown: 'You spent most of the tracked day on **Chrona product work**, with two sustained focus blocks and a short afternoon distraction.', sources: cardsForDay(dayKeyFromUnixSeconds(Math.floor(Date.now() / 1000))).slice(1, 4).map((c) => ({ cardId: c.id, dayKey: c.dayKey, startTs: c.startTs, endTs: c.endTs, title: c.title })), followUps: ['What were my longest focus blocks?', 'Summarize the afternoon.'] }),
    getDashboardStats: async (scope: any) => ({ scope, windowSeconds: scope.endTs - scope.startTs, trackedSeconds: 336 * 60, untrackedSeconds: 104 * 60, byCategorySeconds: [{ category: 'Work', seconds: 284 * 60 }, { category: 'Personal', seconds: 28 * 60 }, { category: 'Distraction', seconds: 24 * 60 }], byTitleSeconds: [{ title: 'Chrona product redesign', seconds: 108 * 60, category: 'Work' }, { title: 'Implementation and review', seconds: 76 * 60, category: 'Work' }, { title: 'Project notes and handoff', seconds: 58 * 60, category: 'Work' }], perDay: Array.from({ length: 7 }, (_, i) => ({ dayKey: dayKeyFromUnixSeconds(scope.startTs + i * 86400), trackedSeconds: (260 + i * 11) * 60, byCategorySeconds: { Work: (210 + i * 9) * 60, Personal: 30 * 60, Distraction: 20 * 60 } })), review: { trackedNonSystemSeconds: 336 * 60, coveredSeconds: 270 * 60, coverageFraction: .8, focusSeconds: 220 * 60, neutralSeconds: 35 * 60, distractedSeconds: 15 * 60, unreviewedCardCount: 2 }, blocks: { longestWorkBlockSeconds: 108 * 60 } }),
    listBlurRegions: async () => ({ regions: [] }), getSyncStatus: async () => ({ paired: false, enabled: false, endpoint: '', intervalSeconds: 300, deviceId: null, lastSyncAt: null, lastError: null, syncing: false }),
    runAnalysisTick: async () => ({ createdBatchIds: [], unprocessedCount: 0 }), testGeminiApiKey: async () => ({ ok: true, message: 'Connection verified' }), hasGeminiApiKey: async () => ({ hasApiKey: true }),
    resolveFileUrl: async () => ({ fileUrl: '' }), purgeStorageNow: async () => ({ ok: true }), setGeminiApiKey: async () => ({ ok: true }),
    copyDayToClipboard: async () => ({ ok: true }), saveMarkdownRange: async () => ({ ok: true, filePath: '/tmp/timeline.md' }), saveCsvRange: async () => ({ ok: true, filePath: '/tmp/timeline.csv' }), saveXlsxRange: async () => ({ ok: true, filePath: '/tmp/timeline.xlsx' }), copyJournalDayToClipboard: async () => ({ ok: true }), saveJournalMarkdownRange: async () => ({ ok: true, filePath: '/tmp/journal.md' }),
    onRecordingStateChanged: noopUnsubscribe, onCaptureError: noopUnsubscribe, onAnalysisBatchUpdated: noopUnsubscribe, onTimelineUpdated: noopUnsubscribe, onStorageUsageUpdated: noopUnsubscribe, onSyncStatusChanged: noopUnsubscribe, onBlurRegionsChanged: noopUnsubscribe, onNavigate: noopUnsubscribe
  }
  const fallback = async () => ({ ok: true })
  window.chrona = new Proxy(api, { get: (target, key) => target[String(key)] ?? fallback }) as ChronaApi
}
