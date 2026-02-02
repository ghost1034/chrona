import { describe, expect, test } from 'vitest'
import { extractDeepLinksFromArgv, parseChronaDeepLink } from './deeplink'

describe('parseChronaDeepLink', () => {
  test('parses host form', () => {
    expect(parseChronaDeepLink('chrona://start-recording')).toBe('start-recording')
  })

  test('parses path form', () => {
    expect(parseChronaDeepLink('chrona:///stop-recording')).toBe('stop-recording')
  })

  test('rejects other protocols', () => {
    expect(parseChronaDeepLink('https://start-recording')).toBe(null)
  })
})

describe('extractDeepLinksFromArgv', () => {
  test('filters argv', () => {
    expect(extractDeepLinksFromArgv(['--foo', 'chrona://start-recording'])).toEqual([
      'chrona://start-recording'
    ])
  })
})
