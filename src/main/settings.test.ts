import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('SettingsStore v11 migration', () => {
  it('defaults new installs to the system theme', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    tempDirectories.push(directory)
    const settings = await new SettingsStore({ userDataPath: directory }).getAll()
    expect(settings.version).toBe(11)
    expect(settings.themePreference).toBe('system')
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
    expect(settings.version).toBe(11)
    expect(settings.captureIntervalSeconds).toBe(20)
    expect(settings.themePreference).toBe('system')
  })
})
