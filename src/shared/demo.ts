export function effectiveNowTs(realNowTs: number, offsetSeconds: number | null | undefined): number {
  const real = Math.floor(Number(realNowTs))
  if (!Number.isFinite(real)) throw new Error('Invalid real time')

  if (offsetSeconds === null || offsetSeconds === undefined) return real
  const offset = Math.floor(Number(offsetSeconds))
  return Number.isFinite(offset) ? real + offset : real
}

export function applyDemoCardVisibility<T>(items: readonly T[], hidden: boolean): T[] {
  return hidden ? [] : [...items]
}
