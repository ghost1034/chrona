import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/update'
import type { Logger } from './logger'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 10 * 1000

export class UpdaterService {
  private readonly updater: typeof autoUpdater
  private state: UpdateState
  private started = false
  private checking = false
  private initialCheckTimer: NodeJS.Timeout | null = null
  private checkInterval: NodeJS.Timeout | null = null

  constructor(
    private readonly opts: {
      isPackaged: boolean
      currentVersion: string
      log: Logger
      events: { updateStateChanged: (state: UpdateState) => void }
      onBeforeInstall: () => void
      updater?: typeof autoUpdater
    }
  ) {
    this.updater = opts.updater ?? autoUpdater
    this.state = {
      supported: opts.isPackaged,
      status: opts.isPackaged ? 'idle' : 'disabled',
      currentVersion: opts.currentVersion,
      availableVersion: null,
      downloadPercent: null,
      message: opts.isPackaged ? null : 'Updates are only available in an installed build.',
      checkedAt: null
    }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  start(): void {
    if (this.started || !this.state.supported) return
    this.started = true

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.allowPrerelease = false
    this.updater.logger = {
      debug: (message) => this.opts.log.debug('updater.client', { message: String(message) }),
      info: (message) => this.opts.log.info('updater.client', { message: String(message) }),
      warn: (message) => this.opts.log.warn('updater.client', { message: String(message) }),
      error: (message) => this.opts.log.error('updater.client', { message: String(message) })
    }

    this.updater.on('checking-for-update', () => {
      this.setState({ status: 'checking', message: null, downloadPercent: null })
    })
    this.updater.on('update-available', (info) => {
      this.opts.log.info('updater.available', { version: info.version })
      this.setState({
        status: 'available',
        availableVersion: info.version,
        downloadPercent: 0,
        message: null,
        checkedAt: new Date().toISOString()
      })
      void this.downloadUpdate()
    })
    this.updater.on('update-not-available', (info) => {
      this.opts.log.info('updater.notAvailable', { version: info.version })
      this.setState({
        status: 'up-to-date',
        availableVersion: null,
        downloadPercent: null,
        message: null,
        checkedAt: new Date().toISOString()
      })
    })
    this.updater.on('download-progress', (progress) => this.onDownloadProgress(progress))
    this.updater.on('update-downloaded', (info) => this.onUpdateDownloaded(info))
    this.updater.on('error', (error) => this.onError(error))

    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null
      void this.checkNow()
    }, INITIAL_CHECK_DELAY_MS)
    this.initialCheckTimer.unref()

    this.checkInterval = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS)
    this.checkInterval.unref()
  }

  async checkNow(): Promise<UpdateState> {
    if (
      !this.state.supported ||
      this.checking ||
      this.state.status === 'downloading' ||
      this.state.status === 'downloaded'
    ) {
      return this.getState()
    }

    this.checking = true
    this.setState({ status: 'checking', message: null, downloadPercent: null })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.onError(error)
    } finally {
      this.checking = false
    }
    return this.getState()
  }

  installDownloadedUpdate(): boolean {
    if (this.state.status !== 'downloaded') return false
    this.opts.log.info('updater.install', { version: this.state.availableVersion })
    this.opts.onBeforeInstall()
    this.updater.quitAndInstall(false, true)
    return true
  }

  private async downloadUpdate(): Promise<void> {
    if (this.state.status !== 'available') return
    this.setState({ status: 'downloading', downloadPercent: 0, message: null })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.onError(error)
    }
  }

  private onDownloadProgress(progress: ProgressInfo): void {
    this.setState({
      status: 'downloading',
      downloadPercent: Math.max(0, Math.min(100, progress.percent)),
      message: null
    })
  }

  private onUpdateDownloaded(info: UpdateInfo): void {
    this.opts.log.info('updater.downloaded', { version: info.version })
    this.setState({
      status: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
      message: null
    })
  }

  private onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.opts.log.error('updater.error', { message })
    this.setState({ status: 'error', downloadPercent: null, message })
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.opts.events.updateStateChanged(this.getState())
  }
}
