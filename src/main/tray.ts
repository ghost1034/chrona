import { Menu, Tray, nativeImage } from 'electron'
import type { CaptureState } from '../shared/ipc'

export function createTray(opts: {
  getCaptureState: () => CaptureState
  onToggleRecording: (enabled: boolean) => void
  onOpenRecordingsFolder: () => void
  onOpenSettings: () => void
  onOpenBlurOverlay: () => void
  onOpenSetup: () => void
  onOpen: () => void
  onQuit: () => void
}): { tray: Tray; updateMenu: () => void } {
  const trayIcon = getChronaTrayIcon()
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true)
  const tray = new Tray(trayIcon)
  tray.setToolTip('Chrona')

  const updateMenu = () => {
    const state = opts.getCaptureState()
    tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(state, opts)))
  }

  updateMenu()
  tray.on('double-click', () => opts.onOpen())
  tray.on('click', () => opts.onOpen())

  return { tray, updateMenu }
}

function buildTemplate(
  state: CaptureState,
  opts: {
    onToggleRecording: (enabled: boolean) => void
    onOpenRecordingsFolder: () => void
    onOpenSettings: () => void
    onOpenBlurOverlay: () => void
    onOpenSetup: () => void
    onOpen: () => void
    onQuit: () => void
  }
): Electron.MenuItemConstructorOptions[] {
  const recordingLabel = state.desiredRecordingEnabled ? 'Stop Recording' : 'Start Recording'
  const statusLabel = state.isSystemPaused
    ? 'Status: System paused'
    : state.desiredRecordingEnabled
      ? 'Status: Recording'
      : 'Status: Idle'

  return [
    {
      label: 'Setup…',
      click: () => opts.onOpenSetup()
    },
    { type: 'separator' },
    {
      label: recordingLabel,
      click: () => opts.onToggleRecording(!state.desiredRecordingEnabled)
    },
    {
      label: statusLabel,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Chrona',
      click: () => opts.onOpen()
    },
    {
      label: 'Settings…',
      click: () => opts.onOpenSettings()
    },
    {
      label: 'Blur an Area…',
      click: () => opts.onOpenBlurOverlay()
    },
    {
      label: 'Open Recordings Folder',
      click: () => opts.onOpenRecordingsFolder()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => opts.onQuit()
    }
  ]
}

function getChronaTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round"><path d="M23.8 7.2A11.2 11.2 0 1 0 25.7 21" stroke-width="3"/><path d="M16 16 23.7 10.8" stroke-width="2.4"/></g><circle cx="16" cy="16" r="1.6" fill="#000"/></svg>`
  const icon = nativeImage.createFromBuffer(Buffer.from(svg))
  if (!icon.isEmpty()) return icon.resize({ width: process.platform === 'darwin' ? 18 : 20 })

  // Construction must remain safe even if a platform build cannot decode SVG.
  return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAQklEQVQ4T2NkwA/+//8/DAwMDAwM/4GBgYGJgYHhP4YBqIYgYtQGQwYqgQmGJQxGgQAAO0cG9tK3QnAAAAAElFTkSuQmCC')
}
