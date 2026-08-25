import type { SettingsStore } from '../settings'
import { getDeviceToken } from '../sync/deviceToken'
import { getGeminiApiKey } from './keychain'
import { buildGeminiRequest, type GeminiAccessSource, type GeminiRequest } from './request'

export type { GeminiAccessSource } from './request'

export async function resolveGeminiRequest(opts: {
  settings: SettingsStore | null
  model: string
  requestBody: Record<string, unknown>
  apiKeyOverride?: string | null
}): Promise<GeminiRequest> {
  // An explicit override is only used by "Test key" and must actually test
  // that key, even if the device is paired.
  if (opts.apiKeyOverride !== undefined) {
    return buildGeminiRequest({
      model: opts.model,
      requestBody: opts.requestBody,
      apiKey: opts.apiKeyOverride
    })
  }

  const deviceToken = await getDeviceToken()
  if (deviceToken) {
    const settings = opts.settings ? await opts.settings.getAll() : null
    return buildGeminiRequest({
      model: opts.model,
      requestBody: opts.requestBody,
      deviceToken,
      cpaautomationEndpoint: settings?.syncEndpoint
    })
  }

  return buildGeminiRequest({
    model: opts.model,
    requestBody: opts.requestBody,
    apiKey: await getGeminiApiKey()
  })
}

export async function getGeminiAccessStatus(): Promise<{
  available: boolean
  source: GeminiAccessSource | null
  hasApiKey: boolean
}> {
  const deviceToken = await getDeviceToken()
  const apiKey = await getGeminiApiKey()
  return {
    available: !!deviceToken || !!apiKey,
    source: deviceToken ? 'cpaautomation' : apiKey ? 'api_key' : null,
    hasApiKey: !!apiKey
  }
}
