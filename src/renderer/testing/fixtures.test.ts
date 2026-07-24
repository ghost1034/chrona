import { describe, expect, it } from 'vitest'
import { createChronaFixture, type FixtureScenario } from './fixtures'

const scenarios: FixtureScenario[] = ['populated', 'empty', 'loading', 'permission-denied', 'ai-missing', 'paused', 'error', 'large-history']

describe('renderer IPC fixtures', () => {
  it.each(scenarios.filter((scenario) => scenario !== 'loading'))('provides deterministic %s state', async (scenario) => {
    const api = createChronaFixture(scenario)
    const [capture, setup] = await Promise.all([api.getCaptureState(), api.getSetupStatus()])
    expect(capture.intervalSeconds).toBe(30)
    expect(setup.platform).toBe('darwin')
    if (scenario === 'permission-denied') expect(setup.captureAccess.status).toBe('denied')
    if (scenario === 'ai-missing') expect(setup.hasGeminiKey).toBe(false)
    if (scenario === 'ai-missing') expect(setup.aiConfigured).toBe(false)
    if (scenario === 'paused') expect(capture.isSystemPaused).toBe(true)
    if (scenario === 'error') expect(capture.lastError).toMatch(/permission/i)
  })

  it('caps quick-access timeline results at eight', async () => {
    const api = createChronaFixture('large-history')
    const result = await api.searchTimeline({ query: 'work', scope: { startTs: 0, endTs: Number.MAX_SAFE_INTEGER }, limit: 8 })
    expect(result.hits).toHaveLength(8)
    expect(result.hasMore).toBe(false)
  })
})
