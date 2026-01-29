import { app } from 'electron'
import type { Logger } from './logger'

export function applyAutoStart(enabled: boolean, log: Logger) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true
    })

    const state = app.getLoginItemSettings()
    log.info('autostart.applied', { enabled, openAtLogin: state.openAtLogin })
  } catch (e) {
    log.warn('autostart.failed', { message: e instanceof Error ? e.message : String(e) })
  }
}
