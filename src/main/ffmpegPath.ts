import path from 'node:path'

function rewriteAsarPath(p: string): string {
  // In packaged Electron apps, `ffmpeg-static` resolves to a path under
  // `.../Resources/app.asar/...`, but `app.asar` is a file (not a dir), so
  // spawning the binary fails (ENOTDIR). The executable is placed under
  // `app.asar.unpacked`.
  //
  // Example:
  //   /.../Resources/app.asar/node_modules/ffmpeg-static/ffmpeg
  // ->/..../Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg
  return p.replace(/app\.asar(?!\.unpacked)([\\/])/g, 'app.asar.unpacked$1')
}

export async function resolveFfmpegPath(): Promise<string> {
  if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) return process.env.FFMPEG_PATH.trim()

  try {
    const mod = await import('ffmpeg-static')
    const p = (mod as any).default ?? (mod as any)
    if (typeof p === 'string' && p.trim()) {
      // Normalize to platform separators first, then handle ASAR rewriting.
      const normalized = path.normalize(p)
      return rewriteAsarPath(normalized)
    }
  } catch {
    // ignore
  }

  return 'ffmpeg'
}
