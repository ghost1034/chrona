export const LOGICAL_DAY_START_HOUR = 4

export function dayKeyFromUnixSeconds(ts: number): string {
  const d = new Date(ts * 1000)
  const adjusted = new Date(d.getTime() - LOGICAL_DAY_START_HOUR * 60 * 60 * 1000)
  return formatYYYYMMDDLocal(adjusted)
}

export function dayWindowForDayKey(dayKey: string): {
  startTs: number
  endTs: number
} {
  const start = localDateFromDayKeyAtHour(dayKey, LOGICAL_DAY_START_HOUR)

  // Use calendar math (not + 24h) to be DST-safe.
  const next = new Date(start)
  next.setDate(next.getDate() + 1)
  const end = new Date(
    next.getFullYear(),
    next.getMonth(),
    next.getDate(),
    LOGICAL_DAY_START_HOUR,
    0,
    0,
    0
  )

  return {
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000)
  }
}

export function dayWindowForUnixSeconds(ts: number): {
  dayKey: string
  startTs: number
  endTs: number
} {
  const dayKey = dayKeyFromUnixSeconds(ts)
  const w = dayWindowForDayKey(dayKey)
  return { dayKey, ...w }
}

export function formatClockAscii(ts: number): string {
  const d = new Date(ts * 1000)
  const h = d.getHours()
  const m = d.getMinutes()

  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad2(m)} ${ampm}`
}

export function formatYYYYMMDDLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function localDateFromDayKeyAtHour(dayKey: string, hour: number): Date {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dayKey)
  if (!m) throw new Error(`Invalid dayKey: ${dayKey}`)

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  return new Date(year, month - 1, day, hour, 0, 0, 0)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
