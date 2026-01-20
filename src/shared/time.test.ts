import { describe, expect, test } from 'vitest'
import {
  dayKeyFromUnixSeconds,
  dayWindowForDayKey,
  formatClockAscii,
  localDateFromDayKeyAtHour
} from './time'

// These tests run with TZ=America/Los_Angeles via the npm test script.

describe('dayKeyFromUnixSeconds (4 AM boundary)', () => {
  test('times before 4 AM belong to previous day', () => {
    const d = new Date(2026, 0, 2, 3, 59, 0, 0)
    const ts = Math.floor(d.getTime() / 1000)
    expect(dayKeyFromUnixSeconds(ts)).toBe('2026-01-01')
  })

  test('times at/after 4 AM belong to same calendar day', () => {
    const d = new Date(2026, 0, 2, 4, 0, 0, 0)
    const ts = Math.floor(d.getTime() / 1000)
    expect(dayKeyFromUnixSeconds(ts)).toBe('2026-01-02')
  })
})

describe('dayWindowForDayKey', () => {
  test('window starts at local 4:00 and ends next day local 4:00', () => {
    const { startTs, endTs } = dayWindowForDayKey('2026-01-02')
    const start = new Date(startTs * 1000)
    const end = new Date(endTs * 1000)

    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(0)
    expect(start.getDate()).toBe(2)
    expect(start.getHours()).toBe(4)
    expect(start.getMinutes()).toBe(0)

    expect(end.getFullYear()).toBe(2026)
    expect(end.getMonth()).toBe(0)
    expect(end.getDate()).toBe(3)
    expect(end.getHours()).toBe(4)
    expect(end.getMinutes()).toBe(0)
  })

  test('DST day window is computed by calendar math', () => {
    // DST starts in America/Los_Angeles on 2026-03-08.
    // With a 4 AM boundary, the window still spans to next day 4 AM.
    const { startTs, endTs } = dayWindowForDayKey('2026-03-08')
    const start = new Date(startTs * 1000)
    const end = new Date(endTs * 1000)

    expect(start.getHours()).toBe(4)
    expect(end.getHours()).toBe(4)
    expect(end.getDate()).toBe(9)
  })
})

describe('formatClockAscii', () => {
  test('returns ASCII h:mm AM/PM', () => {
    const d = new Date(2026, 0, 2, 16, 5, 0, 0)
    const ts = Math.floor(d.getTime() / 1000)
    expect(formatClockAscii(ts)).toBe('4:05 PM')
  })
})

describe('localDateFromDayKeyAtHour', () => {
  test('parses dayKey into local date at hour', () => {
    const d = localDateFromDayKeyAtHour('2026-01-02', 4)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(2)
    expect(d.getHours()).toBe(4)
  })
})
