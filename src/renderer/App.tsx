import { useEffect, useState } from 'react'

export function App() {
  const [ping, setPing] = useState<string>('')
  const [interval, setInterval] = useState<number | null>(null)
  const [recording, setRecording] = useState<boolean>(false)
  const [systemPaused, setSystemPaused] = useState<boolean>(false)
  const [statusLine, setStatusLine] = useState<string>('')
  const [lastError, setLastError] = useState<string | null>(null)
  const [displays, setDisplays] = useState<Array<{ id: string; bounds: any; scaleFactor: number }>>([])
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const state = await window.dayflow.getCaptureState()
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatStatus(state))

      const ds = await window.dayflow.listDisplays()
      setDisplays(ds)
    })()

    const unsubState = window.dayflow.onRecordingStateChanged((state) => {
      setInterval(state.intervalSeconds)
      setRecording(state.desiredRecordingEnabled)
      setSystemPaused(state.isSystemPaused)
      setLastError(state.lastError)
      setSelectedDisplayId(state.selectedDisplayId)
      setStatusLine(formatStatus(state))
    })

    const unsubErr = window.dayflow.onCaptureError((err) => {
      setLastError(err.message)
    })

    return () => {
      unsubState()
      unsubErr()
    }
  }, [])

  async function onPing() {
    const res = await window.dayflow.ping()
    setPing(`ok @ ${new Date(res.nowTs * 1000).toLocaleTimeString()}`)
  }

  async function onSaveInterval() {
    if (interval === null || !Number.isFinite(interval) || interval <= 0) return
    const next = await window.dayflow.setCaptureInterval(interval)
    setInterval(next.intervalSeconds)
  }

  async function onSelectDisplay(id: string) {
    const displayId = id === 'auto' ? null : id
    setSelectedDisplayId(displayId)
    await window.dayflow.setSelectedDisplay(displayId)
  }

  async function onToggleRecording() {
    const next = await window.dayflow.setRecordingEnabled(!recording)
    setRecording(next.desiredRecordingEnabled)
    setSystemPaused(next.isSystemPaused)
    setStatusLine(formatStatus(next))
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
          <button className="btn btn-accent" onClick={onToggleRecording}>
            {recording ? 'Stop recording' : 'Start recording'}
          </button>
          <div className="mono">{statusLine}</div>
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
          <button className="btn" onClick={() => void window.dayflow.openRecordingsFolder()}>
            Open recordings
          </button>
        </section>

        <section className="row">
          <label className="label">
            Capture display
            <select
              className="input"
              value={selectedDisplayId ?? 'auto'}
              onChange={(e) => void onSelectDisplay(e.target.value)}
            >
              <option value="auto">Auto (cursor)</option>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  Display {d.id} ({d.bounds.width}x{d.bounds.height} @ {d.scaleFactor}x)
                </option>
              ))}
            </select>
          </label>
        </section>

        {systemPaused ? (
          <section className="row">
            <div className="pill">System paused (sleep/lock)</div>
          </section>
        ) : null}

        {lastError ? (
          <section className="row">
            <div className="mono error">Last capture error: {lastError}</div>
          </section>
        ) : null}
      </main>
    </div>
  )
}

function formatStatus(state: {
  desiredRecordingEnabled: boolean
  isSystemPaused: boolean
  lastCaptureTs: number | null
  resolvedDisplayId: string | null
}) {
  const base = state.isSystemPaused
    ? 'System paused'
    : state.desiredRecordingEnabled
      ? 'Recording'
      : 'Idle'

  const parts: string[] = [base]
  if (state.resolvedDisplayId) parts.push(`display=${state.resolvedDisplayId}`)
  if (state.lastCaptureTs) parts.push(`last=${new Date(state.lastCaptureTs * 1000).toLocaleTimeString()}`)
  return parts.join(' · ')
}
