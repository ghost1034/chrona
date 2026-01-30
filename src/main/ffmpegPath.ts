export async function resolveFfmpegPath(): Promise<string> {
  if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) return process.env.FFMPEG_PATH.trim()

  try {
    const mod = await import('ffmpeg-static')
    const p = (mod as any).default ?? (mod as any)
    if (typeof p === 'string' && p.trim()) return p
  } catch {
    // ignore
  }

  return 'ffmpeg'
}
