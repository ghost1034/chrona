import keytar from 'keytar'

// Device token lives in the OS keychain (mirrors gemini/keychain.ts), never in
// settings.json — that file is plaintext on disk.
const SERVICE = 'com.chrona'
const ACCOUNT = 'cpaautomation_device_token'

export async function setDeviceToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Device token is empty')
  await keytar.setPassword(SERVICE, ACCOUNT, trimmed)
}

export async function getDeviceToken(): Promise<string | null> {
  const fromKeychain = await keytar.getPassword(SERVICE, ACCOUNT)
  if (fromKeychain && fromKeychain.trim()) return fromKeychain.trim()
  return null
}

export async function deleteDeviceToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT)
}
