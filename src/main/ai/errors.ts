export class LocalRuntimeUnavailableError extends Error {
  readonly resumable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalRuntimeUnavailableError'
  }
}

export function isLocalRuntimeUnavailable(error: unknown): error is LocalRuntimeUnavailableError {
  return error instanceof LocalRuntimeUnavailableError
}
