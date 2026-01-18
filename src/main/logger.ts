import fs from 'node:fs/promises'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

export function createLogger(opts: { userDataPath: string }): Logger {
  const logPath = path.join(opts.userDataPath, 'logs', 'app.log')

  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      meta: meta ?? null
    })

    // Console is still useful during development.
    // Keep it structured to make copy/paste debugging easy.
    // eslint-disable-next-line no-console
    console.log(line)

    void (async () => {
      try {
        await fs.mkdir(path.dirname(logPath), { recursive: true })
        await fs.appendFile(logPath, line + '\n', 'utf8')
      } catch {
        // Best-effort logging; never crash the app.
      }
    })()
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta)
  }
}
