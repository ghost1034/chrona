import { Menu, Tray, nativeImage } from 'electron'

export function createTray(opts: {
  onOpen: () => void
  onQuit: () => void
}): Tray {
  const tray = new Tray(getFallbackIcon())
  tray.setToolTip('Dayflow')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Dayflow',
      click: () => opts.onOpen()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => opts.onQuit()
    }
  ])

  tray.setContextMenu(menu)
  tray.on('double-click', () => opts.onOpen())
  tray.on('click', () => opts.onOpen())

  return tray
}

function getFallbackIcon() {
  // Phase 1: ship a minimal embedded image so Tray construction never fails.
  // Later phases should replace this with a proper per-OS tray icon asset.
  const tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAQklEQVQ4T2NkwA/+//8/DAwMDAwM/4GBgYGJgYHhP4YBqIYgYtQGQwYqgQmGJQxGgQAAO0cG9tK3QnAAAAAElFTkSuQmCC'

  return nativeImage.createFromDataURL(`data:image/png;base64,${tinyPngBase64}`)
}
