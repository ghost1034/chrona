import path from 'node:path'
import { protocol } from 'electron'

import type { Logger } from './logger'

export const CHRONA_MEDIA_SCHEME = 'chrona-media'

export function registerChronaMediaScheme(): void {
  // Must be called before app is ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CHRONA_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

export function registerChronaMediaProtocol(opts: {
  userDataPath: string
  log: Logger
}): void {
  protocol.registerFileProtocol(CHRONA_MEDIA_SCHEME, (request, callback) => {
    try {
      const u = new URL(request.url)

      // We generate URLs in the form: chrona-media:///timelapses/YYYY-MM-DD/<id>.mp4
      // but Chromium sometimes requests them as: chrona-media://timelapses/YYYY-MM-DD/<id>.mp4
      // (treating the first path segment as the host). Accept both.
      const hostPart = u.host ? decodeURIComponent(u.host) : ''
      const pathPart = u.pathname ? decodeURIComponent(u.pathname) : ''
      const combined = hostPart
        ? `${hostPart}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`
        : pathPart
      const rel = combined.startsWith('/') ? combined.slice(1) : combined

      // Tighten access: only allow reads under userData/timelapses.
      const normRel = rel.replaceAll('\\\\', '/').replaceAll('\\', '/')
      if (!normRel.startsWith('timelapses/')) {
        callback({ error: -10 })
        return
      }

      const abs = path.resolve(opts.userDataPath, normRel)
      const check = path.relative(opts.userDataPath, abs)
      if (check.startsWith('..') || path.isAbsolute(check)) {
        callback({ error: -10 })
        return
      }

      callback({ path: abs })
    } catch (e) {
      opts.log.warn('media.protocolError', {
        url: request.url,
        message: e instanceof Error ? e.message : String(e)
      })
      callback({ error: -10 })
    }
  })
}

export function toChronaMediaUrl(relPath: string): string {
  const clean = relPath.replaceAll('\\\\', '/').replaceAll('\\', '/')
  const encoded = clean
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${CHRONA_MEDIA_SCHEME}:///${encoded}`
}
