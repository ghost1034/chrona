import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { autoUpdater as AutoUpdater } from 'electron-updater'
import type { Logger } from './logger'
import { UpdaterService } from './updater'

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

function createFakeUpdater() {
  const emitter = new EventEmitter()
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    logger: null,
    checkForUpdates: vi.fn(async () => {
      emitter.emit('checking-for-update')
      emitter.emit('update-available', { version: '1.2.3' })
      return null
    }),
    downloadUpdate: vi.fn(async () => {
      emitter.emit('download-progress', { percent: 42 })
      emitter.emit('update-downloaded', { version: '1.2.3' })
      return []
    }),
    quitAndInstall: vi.fn()
  })
  return updater as unknown as typeof AutoUpdater
}

describe('UpdaterService', () => {
  it('checks, downloads, reports progress, and installs a packaged update', async () => {
    const updater = createFakeUpdater()
    const states: string[] = []
    const beforeInstall = vi.fn()
    const service = new UpdaterService({
      isPackaged: true,
      currentVersion: '1.0.0',
      log: silentLog,
      events: { updateStateChanged: (state) => states.push(state.status) },
      onBeforeInstall: beforeInstall,
      updater
    })

    service.start()
    const state = await service.checkNow()

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(states).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']))
    expect(state).toMatchObject({
      status: 'downloaded',
      currentVersion: '1.0.0',
      availableVersion: '1.2.3',
      downloadPercent: 100
    })

    expect(service.installDownloadedUpdate()).toBe(true)
    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('stays disabled in development builds', async () => {
    const updater = createFakeUpdater()
    const service = new UpdaterService({
      isPackaged: false,
      currentVersion: '0.0.0',
      log: silentLog,
      events: { updateStateChanged: () => undefined },
      onBeforeInstall: () => undefined,
      updater
    })

    service.start()
    const state = await service.checkNow()

    expect(state.status).toBe('disabled')
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})
