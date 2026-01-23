import { describe, expect, test } from 'vitest'
import { parseAndExpandTranscriptionJson } from './transcription'

describe('parseAndExpandTranscriptionJson', () => {
  test('expands MM:SS into real timestamps', () => {
    const res = parseAndExpandTranscriptionJson({
      jsonText: JSON.stringify({
        observations: [
          {
            start: '00:00',
            end: '00:02',
            observation: 'User is coding.',
            appSites: { primary: 'github.com', secondary: null }
          }
        ]
      }),
      batchStartTs: 1000,
      batchEndTs: 2000,
      screenshotIntervalSeconds: 10,
      llmModel: 'test'
    })

    expect(res.observations).toHaveLength(1)
    expect(res.observations[0].startTs).toBe(1000)
    expect(res.observations[0].endTs).toBe(1020)
    expect(res.observations[0].llmModel).toBe('test')
    expect(res.observations[0].metadata).toContain('github.com')
  })

  test('clamps out-of-range times to batch window', () => {
    const res = parseAndExpandTranscriptionJson({
      jsonText: JSON.stringify({
        observations: [
          { start: '00:00', end: '99:59', observation: 'Long' }
        ]
      }),
      batchStartTs: 1000,
      batchEndTs: 1100,
      screenshotIntervalSeconds: 10
    })
    expect(res.observations).toHaveLength(1)
    expect(res.observations[0].endTs).toBe(1100)
  })

  test('accepts JSON wrapped in code fences when caller strips them', () => {
    const json = '```json\n{"observations":[{"start":"00:00","end":"00:01","observation":"X"}]}\n```'
    // Caller strips code fences; parser should still work with the stripped content.
    const stripped = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    const res = parseAndExpandTranscriptionJson({
      jsonText: stripped,
      batchStartTs: 100,
      batchEndTs: 200,
      screenshotIntervalSeconds: 10
    })
    expect(res.observations).toHaveLength(1)
  })
})
