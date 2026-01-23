import keytar from 'keytar'

const SERVICE = 'com.chrona'
const ACCOUNT = 'gemini_api_key'

export async function setGeminiApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('API key is empty')
  await keytar.setPassword(SERVICE, ACCOUNT, trimmed)
}

export async function getGeminiApiKey(): Promise<string | null> {
  const fromKeychain = await keytar.getPassword(SERVICE, ACCOUNT)
  if (fromKeychain && fromKeychain.trim()) return fromKeychain.trim()

  const env = process.env.CHRONA_GEMINI_API_KEY
  if (env && env.trim()) return env.trim()
  return null
}
