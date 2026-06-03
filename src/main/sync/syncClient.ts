/**
 * Thin fetch wrapper for the CPAAutomation Chrona sync endpoints
 * (backend/routes/chrona_sync.py). Retry/backoff policy lives in SyncService;
 * this client just makes single attempts and raises typed errors.
 */

export class SyncHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
  }
}

export type SyncCardPayload = {
  source_card_id: number
  content_hash: string
  title: string
  summary: string | null
  detailed_summary: string | null
  category: string
  subcategory: string | null
  start_ts: number
  end_ts: number
  day_key: string
  is_deleted: boolean
  source_created_at: string | null
}

export type PairResult = {
  deviceId: string
  deviceToken: string
  displayName: string
}

export type PushCardsResult = {
  accepted: number
  skippedUnchanged: number
}

export function normalizeEndpoint(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Sync server URL must start with http:// or https://')
  }
  return trimmed
}

export class SyncClient {
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(opts: { endpoint: string; timeoutMs?: number }) {
    this.endpoint = normalizeEndpoint(opts.endpoint)
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  async pair(opts: {
    code: string
    platform: string
    appVersion: string
  }): Promise<PairResult> {
    const res = await this.request('POST', '/api/chrona/sync/pair', {
      body: {
        code: opts.code.trim().toUpperCase(),
        platform: opts.platform,
        app_version: opts.appVersion
      }
    })
    return {
      deviceId: String(res.device_id),
      deviceToken: String(res.device_token),
      displayName: String(res.display_name)
    }
  }

  async pushCards(opts: {
    token: string
    cards: SyncCardPayload[]
    deletedSourceCardIds: number[]
  }): Promise<PushCardsResult> {
    const res = await this.request('POST', '/api/chrona/sync/cards', {
      token: opts.token,
      body: {
        cards: opts.cards,
        deleted_source_card_ids: opts.deletedSourceCardIds
      }
    })
    return {
      accepted: Number(res.accepted ?? 0),
      skippedUnchanged: Number(res.skipped_unchanged ?? 0)
    }
  }

  async ping(opts: { token: string }): Promise<void> {
    await this.request('GET', '/api/chrona/sync/ping', { token: opts.token })
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown }
  ): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const headers: Record<string, string> = {}
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
      if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`

      const res = await fetch(`${this.endpoint}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal
      })

      if (!res.ok) {
        throw new SyncHttpError(res.status, await extractErrorMessage(res))
      }

      return await res.json()
    } catch (e) {
      if (e instanceof SyncHttpError) throw e
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`Sync request timed out after ${this.timeoutMs}ms`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  // FastAPI errors are {"detail": "..."}.
  try {
    const data = (await res.json()) as any
    if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail
  } catch {
    // fall through
  }
  return `Sync server returned HTTP ${res.status}`
}
