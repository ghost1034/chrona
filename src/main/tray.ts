import { Menu, Tray, nativeImage } from 'electron'
import type { CaptureState } from '../shared/ipc'

export function createTray(opts: {
  getCaptureState: () => CaptureState
  onToggleRecording: (enabled: boolean) => void
  onOpenRecordingsFolder: () => void
  onOpenSettings: () => void
  onOpen: () => void
  onQuit: () => void
}): { tray: Tray; updateMenu: () => void } {
  const tray = new Tray(getFallbackIcon())
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

function getFallbackIcon() {
  // Phase 1: ship a minimal embedded image so Tray construction never fails.
  // Later phases should replace this with a proper per-OS tray icon asset.
  const tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAQklEQVQ4T2NkwA/+//8/DAwMDAwM/4GBgYGJgYHhP4YBqIYgYtQGQwYqgQmGJQxGgQAAO0cG9tK3QnAAAAAElFTkSuQmCC'

  return nativeImage.createFromDataURL(`data:image/png;base64,${tinyPngBase64}`)
}
