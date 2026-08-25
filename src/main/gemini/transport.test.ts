import { describe, expect, it } from 'vitest'
import { buildGeminiRequest, CPAAUTOMATION_GEMINI_PATH } from './request'

describe('buildGeminiRequest', () => {
  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { temperature: 0.2 }
  }

  it('uses CPAAutomation whenever a linked-device token is present', () => {
    const request = buildGeminiRequest({
      model: 'gemini-test',
      requestBody,
      deviceToken: ' chrona_dev_secret ',
      cpaautomationEndpoint: 'https://cpa.example.test/',
      apiKey: 'personal-key-must-not-be-used'
    })

    expect(request.source).toBe('cpaautomation')
    expect(request.url).toBe(`https://cpa.example.test${CPAAUTOMATION_GEMINI_PATH}`)
    expect(request.headers.Authorization).toBe('Bearer chrona_dev_secret')
    expect(request.url).not.toContain('personal-key-must-not-be-used')
    expect(JSON.parse(request.body)).toEqual({ model: 'gemini-test', ...requestBody })
  })

  it('falls back to the personal key when the device is not linked', () => {
    const request = buildGeminiRequest({
      model: 'gemini-test',
      requestBody,
      apiKey: 'personal key'
    })

    expect(request.source).toBe('api_key')
    expect(request.url).toContain('generativelanguage.googleapis.com')
    expect(request.url).toContain('key=personal%20key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(JSON.parse(request.body)).toEqual(requestBody)
  })

  it('requires either a linked account or a personal key', () => {
    expect(() =>
      buildGeminiRequest({ model: 'gemini-test', requestBody })
    ).toThrow(/link CPAAutomation or add a Gemini API key/)
  })
})
