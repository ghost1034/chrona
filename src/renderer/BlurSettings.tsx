import { useEffect, useState } from 'react'
import type { BlurRegion } from '../shared/blurRegions'

type DisplayInfo = { id: string; bounds: { width: number; height: number }; scaleFactor: number }

/**
 * Settings panel for privacy blur regions: areas of the screen redacted from
 * captures before anything is written to disk or sent to the AI. Self-contained —
 * talks to the main process directly via window.chrona.
 */
export function BlurSettings(props: { displays: DisplayInfo[] }) {
  const [regions, setRegions] = useState<BlurRegion[]>([])
  const [hotkeyDraft, setHotkeyDraft] = useState<string>('')
  const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const res = await window.chrona.listBlurRegions()
        if (!cancelled) setRegions(res.regions)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    void refresh()
    void (async () => {
      try {
        const settings = await window.chrona.getSettings()
        if (!cancelled) setHotkeyDraft(settings.blurHotkey)
      } catch {
        // leave the draft empty
      }
    })()

    const unsubscribe = window.chrona.onBlurRegionsChanged(() => void refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const displayLabel = (displayId: string) => {
    const d = props.displays.find((x) => x.id === displayId)
    if (!d) return `Display ${displayId} (disconnected)`
    return `Display ${d.id} (${d.bounds.width}x${d.bounds.height})`
  }

  const regionSize = (r: BlurRegion) =>
    `${Math.round(r.rect.w * 100)}% × ${Math.round(r.rect.h * 100)}% of screen`

  const saveHotkey = () => {
    void (async () => {
      try {
        setError(null)
        const res = await window.chrona.setBlurHotkey(hotkeyDraft)
        setHotkeyMessage(res.ok ? 'Shortcut saved.' : res.message)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }

  return (
    <div className="block">
      <div className="sideTitle">Blurred areas</div>
      <div className="sideMeta">
        Blurred areas stay visible to you but are blacked out in every capture before it is saved
        or analyzed by AI.
      </div>

      <div className="row">
        <button className="btn btn-accent" onClick={() => void window.chrona.openBlurOverlay()}>
          Add blurred area…
        </button>
      </div>

      {regions.length === 0 ? (
        <div className="row">
          <div className="sideMeta">No blurred areas defined.</div>
        </div>
      ) : (
        regions.map((r) => (
          <div className="row" key={r.id}>
            <div className="label">
              {displayLabel(r.displayId)} — {regionSize(r)}
            </div>
            <button className="btn" onClick={() => void window.chrona.removeBlurRegion(r.id)}>
              Delete
            </button>
          </div>
        ))
      )}

      <div className="row">
        <label className="label">
          Shortcut to add a blurred area (empty disables)
          <input
            className="input"
            type="text"
            placeholder="CommandOrControl+Shift+B"
            value={hotkeyDraft}
            onChange={(e) => {
              setHotkeyDraft(e.target.value)
              setHotkeyMessage(null)
            }}
          />
        </label>
        <button className="btn" onClick={saveHotkey}>
          Save
        </button>
      </div>
      {hotkeyMessage ? (
        <div className="row">
          <div className="sideMeta">{hotkeyMessage}</div>
        </div>
      ) : null}
      {error ? (
        <div className="row">
          <div className="mono error">{error}</div>
        </div>
      ) : null}
    </div>
  )
}
