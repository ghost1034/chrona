import { useEffect, useState } from 'react'

export function App() {
  const [ping, setPing] = useState<string>('')
  const [interval, setInterval] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const settings = await window.dayflow.getSettings()
      setInterval(settings.captureIntervalSeconds)
    })()
  }, [])

  async function onPing() {
    const res = await window.dayflow.ping()
    setPing(`ok @ ${new Date(res.nowTs * 1000).toLocaleTimeString()}`)
  }

  async function onSaveInterval() {
    if (interval === null || !Number.isFinite(interval) || interval <= 0) return
    const next = await window.dayflow.updateSettings({ captureIntervalSeconds: interval })
    setInterval(next.captureIntervalSeconds)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="wordmark">Dayflow</div>
          <div className="tagline">Cross-platform timeline from your screen</div>
        </div>
      </header>

      <main className="panel">
        <section className="row">
          <button className="btn" onClick={onPing}>
            Ping main process
          </button>
          <div className="mono">{ping || '...'}</div>
        </section>

        <section className="row">
          <label className="label">
            Screenshot interval (seconds)
            <input
              className="input"
              type="number"
              min={1}
              step={1}
              value={interval ?? ''}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </label>
          <button className="btn" onClick={onSaveInterval}>
            Save
          </button>
        </section>
      </main>
    </div>
  )
}
