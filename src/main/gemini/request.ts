import { DEFAULT_SYNC_ENDPOINT } from '../../shared/sync'

export const CPAAUTOMATION_GEMINI_PATH = '/api/chrona/gemini/generate-content'

export type GeminiAccessSource = 'cpaautomation' | 'api_key'

export type GeminiRequest = {
  source: GeminiAccessSource
  url: string
  headers: Record<string, string>
  body: string
}

/** CPAAutomation takes precedence whenever a linked-device token is present. */
export function buildGeminiRequest(opts: {
  model: string
  requestBody: Record<string, unknown>
  deviceToken?: string | null
  cpaautomationEndpoint?: string | null
  apiKey?: string | null
}): GeminiRequest {
  const deviceToken = opts.deviceToken?.trim() || null
  if (deviceToken) {
    const endpoint = (opts.cpaautomationEndpoint?.trim() || DEFAULT_SYNC_ENDPOINT).replace(/\/+$/, '')
    return {
      source: 'cpaautomation',
      url: `${endpoint}${CPAAUTOMATION_GEMINI_PATH}`,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${deviceToken}`
      },
      body: JSON.stringify({ model: opts.model, ...opts.requestBody })
    }
  }

  const apiKey = opts.apiKey?.trim() || null
  if (!apiKey) {
    throw new Error(
      'Gemini access is not configured (link CPAAutomation or add a Gemini API key)'
    )
  }

  return {
    source: 'api_key',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.requestBody)
  }
}
