import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('SettingsStore version 11 migration', () => {
  it('defaults new installs to system appearance and 180px/hour', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    dirs.push(dir)
    const settings = await new SettingsStore({ userDataPath: dir }).getAll()
    expect(settings.version).toBe(11)
    expect(settings.appearanceMode).toBe('system')
    expect(settings.timelinePxPerHour).toBe(180)
  })

  it('moves only the legacy version-10 default zoom to 180px/hour', async () => {
    const legacyDefaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    const customDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-settings-'))
    dirs.push(legacyDefaultDir, customDir)
    await fs.writeFile(path.join(legacyDefaultDir, 'settings.json'), JSON.stringify({ version: 10, timelinePxPerHour: 600 }))
    await fs.writeFile(path.join(customDir, 'settings.json'), JSON.stringify({ version: 10, timelinePxPerHour: 420 }))

    expect((await new SettingsStore({ userDataPath: legacyDefaultDir }).getAll()).timelinePxPerHour).toBe(180)
    expect((await new SettingsStore({ userDataPath: customDir }).getAll()).timelinePxPerHour).toBe(420)
  })
})
