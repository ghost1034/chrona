import { useEffect, useState } from 'react'
import { effectiveNowTs } from '../shared/demo'

export function DemoControls(props: {
  open: boolean
  timeOffsetSeconds: number | null
  cardsHidden: boolean
  onClose: () => void
  onApply: (next: { timeOffsetSeconds: number | null; cardsHidden: boolean }) => Promise<void>
}) {
  const [clockDraft, setClockDraft] = useState('')
  const [useSystemTime, setUseSystemTime] = useState(true)
  const [cardsHidden, setCardsHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!props.open) return
    setUseSystemTime(props.timeOffsetSeconds === null)
    setClockDraft(toDateTimeLocal(effectiveNowTs(nowTs(), props.timeOffsetSeconds)))
    setCardsHidden(props.cardsHidden)
  }, [props.open, props.timeOffsetSeconds, props.cardsHidden])

  if (!props.open) return null

  const apply = async () => {
    const parsed = new Date(clockDraft).getTime()
    if (!useSystemTime && !Number.isFinite(parsed)) return
    const real = nowTs()
    const offset = useSystemTime ? null : Math.floor(parsed / 1000) - real
    setBusy(true)
    try {
      await props.onApply({ timeOffsetSeconds: offset, cardsHidden })
      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modalOverlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose()
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="demo-controls-title">
        <div className="modalTitle" id="demo-controls-title">Demo controls</div>
        <div className="modalMeta">Concealed controls for a staged recording.</div>

        <label className="pill">
          <input
            type="checkbox"
            checked={useSystemTime}
            onChange={(event) => setUseSystemTime(event.target.checked)}
          />
          Use system time
        </label>

        <label className="field">
          <span className="label">Current date and time</span>
          <input
            className="input"
            type="datetime-local"
            step="60"
            value={clockDraft}
            disabled={useSystemTime}
            onChange={(event) => setClockDraft(event.target.value)}
          />
        </label>

        <label className="pill">
          <input
            type="checkbox"
            checked={cardsHidden}
            onChange={(event) => setCardsHidden(event.target.checked)}
          />
          Hide all timeline cards
        </label>

        <div className="sideMeta">
          Open with Cmd/Ctrl+Shift+D. Toggle card visibility instantly with Cmd/Ctrl+Shift+H.
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" disabled={busy} onClick={props.onClose}>Cancel</button>
          <button className="btn btn-accent" disabled={busy || (!useSystemTime && !clockDraft)} onClick={() => void apply()}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000)
}

function toDateTimeLocal(ts: number): string {
  const date = new Date(ts * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
