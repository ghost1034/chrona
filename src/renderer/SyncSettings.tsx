import { useEffect, useState } from 'react'
import type { SyncStatusDTO } from '../shared/sync'

/**
 * Settings panel for CPAAutomation sync: pair with a manager-minted code,
 * watch sync health, pause, force a push, or unpair. Self-contained — talks
 * to the main process directly via window.chrona.
 */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatusDTO | null>(null)
  const [codeDraft, setCodeDraft] = useState<string>('')
  const [intervalDraft, setIntervalDraft] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmUnpair, setConfirmUnpair] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [st, settings] = await Promise.all([
          window.chrona.getSyncStatus(),
          window.chrona.getSettings()
        ])
        if (cancelled) return
        setStatus(st)
        setIntervalDraft(String(settings.syncIntervalSeconds ?? 300))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    const unsubscribe = window.chrona.onSyncStatusChanged((st) => {
      setStatus(st)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const run = (fn: () => Promise<SyncStatusDTO | void>) => {
    void (async () => {
      try {
        setError(null)
        setBusy(true)
        const st = await fn()
        if (st) setStatus(st)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const statusLine = (() => {
    if (!status) return 'Loading...'
    if (!status.paired) return 'Not paired'
    const parts: string[] = []
    parts.push(status.enabled ? (status.syncing ? 'Syncing…' : 'Paired') : 'Paired (sync paused)')
    if (status.displayName) parts.push(`as “${status.displayName}”`)
    if (status.lastSyncTs) parts.push(`· last sync ${new Date(status.lastSyncTs * 1000).toLocaleString()}`)
    if (status.pendingCount > 0) parts.push(`· ${status.pendingCount} pending`)
    return parts.join(' ')
  })()

  return (
    <div className="settingsSection">
      <div className="sideTitle">Sync</div>
      <div className="sideMeta">
        Push timeline cards to a CPAAutomation dashboard. Only card titles, summaries, categories, and
        times are sent — screenshots and videos never leave this device.
      </div>

      <div className="row">
        <div className="mono">{statusLine}</div>
      </div>

      {error ? (
        <div className="row">
          <div className="mono error">{error}</div>
        </div>
      ) : null}
      {status?.lastError && !error ? (
        <div className="row">
          <div className="mono error">{status.lastError}</div>
        </div>
      ) : null}

      {!status?.paired ? (
        <div className="block">
          <div className="sideTitle">Pair this device</div>
          <div className="sideMeta">
            Ask your manager to generate a pairing code in the CPAAutomation dashboard, then enter it here
            within 15 minutes.
          </div>
          <div className="row">
            <label className="label">
              Pairing code
              <input
                className="input"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value.toUpperCase())}
                placeholder="ABCD2345"
                maxLength={16}
              />
            </label>
            <button
              className="btn btn-accent"
              disabled={busy || !codeDraft.trim()}
              onClick={() =>
                run(async () => {
                  const st = await window.chrona.pairSync({ code: codeDraft.trim() })
                  setCodeDraft('')
                  return st
                })
              }
            >
              Pair
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="block">
            <div className="sideTitle">Device</div>
            <div className="sideMeta">
              {status.displayName ? `${status.displayName} · ` : ''}
              {status.endpoint}
            </div>
            <div className="row">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={busy}
                  onChange={(e) => run(() => window.chrona.setSyncEnabled(e.target.checked))}
                />
                Sync enabled
              </label>
              <button className="btn" disabled={busy} onClick={() => run(() => window.chrona.runSyncNow())}>
                Sync now
              </button>
            </div>
          </div>

          <div className="block">
            <div className="sideTitle">Interval</div>
            <div className="row">
              <label className="label">
                Sync interval (seconds)
                <input
                  className="input"
                  type="number"
                  min={30}
                  step={30}
                  value={intervalDraft}
                  onChange={(e) => setIntervalDraft(e.target.value)}
                />
              </label>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const n = Math.max(30, Math.floor(Number(intervalDraft)) || 300)
                    setIntervalDraft(String(n))
                    await window.chrona.updateSettings({ syncIntervalSeconds: n })
                  })
                }
              >
                Save
              </button>
            </div>
          </div>

          <div className="block">
            <div className="sideTitle">Unpair</div>
            <div className="sideMeta">
              Removes this device’s token from the keychain and stops syncing. Already-synced data stays on
              the server until a manager revokes the device.
            </div>
            <div className="row">
              {!confirmUnpair ? (
                <button className="btn" disabled={busy} onClick={() => setConfirmUnpair(true)}>
                  Unpair…
                </button>
              ) : (
                <>
                  <button
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() => {
                      setConfirmUnpair(false)
                      run(() => window.chrona.unpairSync())
                    }}
                  >
                    Confirm unpair
                  </button>
                  <button className="btn" disabled={busy} onClick={() => setConfirmUnpair(false)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
