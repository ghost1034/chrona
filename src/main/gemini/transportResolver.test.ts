import { beforeEach, describe, expect, it, vi } from 'vitest'

const keychain = vi.hoisted(() => ({
  getDeviceToken: vi.fn<() => Promise<string | null>>(),
  getGeminiApiKey: vi.fn<() => Promise<string | null>>()
}))

vi.mock('../sync/deviceToken', () => ({ getDeviceToken: keychain.getDeviceToken }))
vi.mock('./keychain', () => ({ getGeminiApiKey: keychain.getGeminiApiKey }))

import { resolveGeminiRequest } from './transport'

describe('resolveGeminiRequest', () => {
  beforeEach(() => {
    keychain.getDeviceToken.mockReset()
    keychain.getGeminiApiKey.mockReset()
  })

  it('does not read or use a personal key when CPAAutomation is linked', async () => {
    keychain.getDeviceToken.mockResolvedValue('chrona_dev_linked')

    const request = await resolveGeminiRequest({
      settings: {
        getAll: async () => ({ syncEndpoint: 'https://linked.example.test' })
      } as any,
      model: 'gemini-test',
      requestBody: { contents: [] }
    })

    expect(request.source).toBe('cpaautomation')
    expect(request.headers.Authorization).toBe('Bearer chrona_dev_linked')
    expect(keychain.getGeminiApiKey).not.toHaveBeenCalled()
  })

  it('uses the personal key fallback when CPAAutomation is not linked', async () => {
    keychain.getDeviceToken.mockResolvedValue(null)
    keychain.getGeminiApiKey.mockResolvedValue('personal-key')

    const request = await resolveGeminiRequest({
      settings: null,
      model: 'gemini-test',
      requestBody: { contents: [] }
    })

    expect(request.source).toBe('api_key')
    expect(request.url).toContain('key=personal-key')
  })
})
