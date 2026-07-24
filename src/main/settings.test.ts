import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('SettingsStore v12 migration', () => {
  it('defaults new installs to the system theme', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    const settings = await new SettingsStore({ userDataPath: directory }).getAll()
    expect(settings.version).toBe(12)
    expect(settings.themePreference).toBe('system')
    expect(settings.aiProvider).toBe('gemini')
    expect(settings.localBaseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(settings.localRequestTimeoutMs).toBe(300_000)
    expect(settings.localMaxAttempts).toBe(2)
    expect(settings.localVisionMaxImagesPerRequest).toBe(12)
  })

  it('migrates v10 settings and sanitizes an invalid theme', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({ version: 10, captureIntervalSeconds: 20, themePreference: 'sepia' }),
      'utf8'
    )

    const settings = await new SettingsStore({ userDataPath: directory }).getAll()
    expect(settings.version).toBe(12)
    expect(settings.captureIntervalSeconds).toBe(20)
    expect(settings.themePreference).toBe('system')
  })

  it('migrates v11 settings without changing Gemini defaults', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({ version: 11, geminiModel: 'gemini-test', geminiMaxAttempts: 7 }),
      'utf8'
    )
    const settings = await new SettingsStore({ userDataPath: directory }).getAll()
    expect(settings.version).toBe(12)
    expect(settings.aiProvider).toBe('gemini')
    expect(settings.geminiModel).toBe('gemini-test')
    expect(settings.geminiMaxAttempts).toBe(7)
  })

  it('recovers invalid providers and local URLs', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({ version: 12, aiProvider: 'other', localBaseUrl: 'https://example.com/v1' }),
      'utf8'
    )
    const settings = await new SettingsStore({ userDataPath: directory }).getAll()
    expect(settings.aiProvider).toBe('gemini')
    expect(settings.localBaseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('enforces loopback-only local URLs on update', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    const store = new SettingsStore({ userDataPath: directory })
    await expect(store.update({ localBaseUrl: 'http://192.168.1.2:11434/v1' })).rejects.toThrow(
      'loopback'
    )
    await expect(store.update({ localBaseUrl: 'http://user:pass@localhost:1234/v1' })).rejects.toThrow(
      'credentials'
    )
    await expect(store.update({ localBaseUrl: 'http://[::1]:1234/v1?x=1' })).rejects.toThrow(
      'query'
    )
    expect((await store.update({ localBaseUrl: 'http://localhost:1234/v1/' })).localBaseUrl).toBe(
      'http://localhost:1234/v1'
    )
  })
})
