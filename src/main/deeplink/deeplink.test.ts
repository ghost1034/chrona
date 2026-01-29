import { describe, expect, test } from 'vitest'
import { extractDeepLinksFromArgv, parseDayflowDeepLink } from './deeplink'

describe('parseDayflowDeepLink', () => {
  test('parses host form', () => {
    expect(parseDayflowDeepLink('dayflow://start-recording')).toBe('start-recording')
  })

  test('parses path form', () => {
    expect(parseDayflowDeepLink('dayflow:///stop-recording')).toBe('stop-recording')
  })

  test('rejects other protocols', () => {
    expect(parseDayflowDeepLink('https://start-recording')).toBe(null)
  })
})

describe('extractDeepLinksFromArgv', () => {
  test('filters argv', () => {
    expect(extractDeepLinksFromArgv(['--foo', 'dayflow://start-recording'])).toEqual([
      'dayflow://start-recording'
    ])
  })
})
