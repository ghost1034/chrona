import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveFfmpegPath } from '../ffmpegPath'

export async function buildCompressedTimelineVideo(opts: {
  ffmpegPath?: string
  inputJpegPaths: string[]
  outMp4Path: string
  targetHeight?: number
}): Promise<void> {
  if (opts.inputJpegPaths.length === 0) throw new Error('No screenshots to build video')

  const ffmpeg = opts.ffmpegPath ?? (await resolveFfmpegPath())
  const targetHeight = opts.targetHeight ?? 540

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-ffmpeg-'))
  const listPath = path.join(tmpDir, 'inputs.txt')

  try {
    const lines: string[] = []
    for (const p of opts.inputJpegPaths) {
      // Concat demuxer requires quoting, and wants forward slashes.
      const norm = p.replaceAll('\\', '/')
      lines.push(`file '${escapeSingleQuotes(norm)}'`)
      lines.push('duration 1')
    }
    // Repeat the last file without duration to ensure it is included.
    const last = opts.inputJpegPaths[opts.inputJpegPaths.length - 1].replaceAll('\\', '/')
    lines.push(`file '${escapeSingleQuotes(last)}'`)

    await fs.writeFile(listPath, lines.join('\n') + '\n', 'utf8')

    await fs.mkdir(path.dirname(opts.outMp4Path), { recursive: true })

    // 1 frame per second "compressed timeline".
    // Use a fairly aggressive compression since this is only for OCR/understanding.
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
      '-r',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '35',
      '-preset',
      'veryfast',
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
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 2000)}`))
    })
  })
}
