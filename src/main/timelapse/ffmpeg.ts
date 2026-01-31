import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveFfmpegPath } from '../ffmpegPath'

export async function buildTimelapseFromJpegs(opts: {
  ffmpegPath?: string
  inputJpegPaths: string[]
  outMp4Path: string
  fps: number
  targetHeight?: number
}): Promise<void> {
  if (opts.inputJpegPaths.length === 0) throw new Error('No screenshots for timelapse')
  const fps = Math.max(1, Math.floor(opts.fps))
  const frameDuration = 1 / fps
  const targetHeight = opts.targetHeight ?? 720

  const ffmpeg = opts.ffmpegPath ?? (await resolveFfmpegPath())
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dayflow-timelapse-'))
  const listPath = path.join(tmpDir, 'inputs.txt')

  try {
    const lines: string[] = []
    for (const p of opts.inputJpegPaths) {
      const norm = p.replaceAll('\\', '/')
      lines.push(`file '${escapeSingleQuotes(norm)}'`)
      lines.push(`duration ${frameDuration}`)
    }
    const last = opts.inputJpegPaths[opts.inputJpegPaths.length - 1].replaceAll('\\', '/')
    lines.push(`file '${escapeSingleQuotes(last)}'`)

    await fs.writeFile(listPath, lines.join('\n') + '\n', 'utf8')
    await fs.mkdir(path.dirname(opts.outMp4Path), { recursive: true })

    const args = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-vf',
      `scale=-2:${targetHeight}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '28',
      '-preset',
      'veryfast',
      '-movflags',
      '+faststart',
      opts.outMp4Path
    ]

    await run(ffmpeg, args)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

function escapeSingleQuotes(s: string): string {
  return s.replaceAll("'", "'\\''")
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (d) => {
      stderr += String(d)
    })
    p.on('error', (e) => {
      const code = (e as any)?.code
      const codePart = code ? ` (${code})` : ''
      reject(new Error(`Failed to spawn ffmpeg: ${cmd}${codePart}: ${e instanceof Error ? e.message : String(e)}`))
    })
    p.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited with code ${code} (${cmd}): ${stderr.slice(0, 2000)}`))
    })
  })
}
