import keytar from 'keytar'

const SERVICE = 'com.chrona'
const ACCOUNT = 'local_ai_bearer_token'

export async function setLocalBearerToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Bearer token is empty')
  await keytar.setPassword(SERVICE, ACCOUNT, trimmed)
}

export async function getLocalBearerToken(): Promise<string | null> {
  const token = await keytar.getPassword(SERVICE, ACCOUNT)
  return token?.trim() || null
}

export async function clearLocalBearerToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT)
}
