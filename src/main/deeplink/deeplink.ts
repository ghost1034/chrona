import type { Logger } from '../logger'

export type DeepLinkAction = 'start-recording' | 'stop-recording' | 'pause-recording' | 'resume-recording'

export function parseDayflowDeepLink(urlString: string): DeepLinkAction | null {
  let u: URL
  try {
    u = new URL(urlString)
  } catch {
    return null
  }

  if (u.protocol !== 'dayflow:') return null

  // dayflow://start-recording -> host=start-recording
  // dayflow://start-recording/ -> host=start-recording pathname=/
  // dayflow:///start-recording -> host='' pathname=/start-recording
  const raw = `${u.host}${u.pathname}`
  const path = raw.replace(/^\/+/, '').replace(/\/+$/, '')

  switch (path) {
    case 'start-recording':
      return 'start-recording'
    case 'stop-recording':
      return 'stop-recording'
    case 'pause-recording':
      return 'pause-recording'
    case 'resume-recording':
      return 'resume-recording'
    default:
      return null
  }
}

export function extractDeepLinksFromArgv(argv: string[]): string[] {
  return argv.filter((a) => typeof a === 'string' && a.startsWith('dayflow://'))
}

export class DeepLinkService {
  private readonly log: Logger
  private readonly onAction: (action: DeepLinkAction) => void

  constructor(opts: { log: Logger; onAction: (action: DeepLinkAction) => void }) {
    this.log = opts.log
    this.onAction = opts.onAction
  }

  handleUrl(urlString: string): boolean {
    const action = parseDayflowDeepLink(urlString)
    if (!action) return false
    this.log.info('deeplink.action', { action })
    this.onAction(action)
    return true
  }
}
