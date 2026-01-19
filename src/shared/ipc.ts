export type AppPingResponse = {
  ok: true
  nowTs: number
}

export type Settings = {
  version: 1
  captureIntervalSeconds: number
}

export type IpcContract = {
  'app:ping': {
    req: void
    res: AppPingResponse
  }
  'settings:getAll': {
    req: void
    res: Settings
  }
  'settings:update': {
    req: Partial<Omit<Settings, 'version'>>
    res: Settings
  }
}

export const IPC_CHANNELS = {
  appPing: 'app:ping',
  settingsGetAll: 'settings:getAll',
  settingsUpdate: 'settings:update'
} as const

export type IpcChannel = IpcContractKey
type IpcContractKey = keyof IpcContract
