export class LocalRuntimeUnavailableError extends Error {
  readonly resumable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalRuntimeUnavailableError'
  }
}

export type CoverageInterval = { startTs: number; endTs: number }

export class IncompleteLocalCardCoverageError extends Error {
  readonly resumable = true

  constructor(readonly uncoveredIntervals: CoverageInterval[]) {
    const uncoveredSeconds = uncoveredIntervals.reduce(
      (total, interval) => total + Math.max(0, interval.endTs - interval.startTs),
      0
    )
    super(`Local card generation left ${uncoveredSeconds}s of observed activity uncovered`)
    this.name = 'IncompleteLocalCardCoverageError'
  }
}

export function isLocalRuntimeUnavailable(error: unknown): error is LocalRuntimeUnavailableError {
  return error instanceof LocalRuntimeUnavailableError
}

export function isIncompleteLocalCardCoverage(
  error: unknown
): error is IncompleteLocalCardCoverageError {
  return error instanceof IncompleteLocalCardCoverageError
}
