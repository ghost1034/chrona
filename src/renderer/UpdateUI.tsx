import { useEffect, useState } from 'react'
import type { UpdateState } from '../shared/update'

function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let active = true
    void window.chrona.getUpdateState().then(
      (next) => {
        if (active) setState(next)
      },
      () => undefined
    )
    const unsubscribe = window.chrona.onUpdateStateChanged((next) => setState(next))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}

function describeUpdate(state: UpdateState): string {
  switch (state.status) {
    case 'disabled':
      return state.message ?? 'Updates are only available in an installed build.'
    case 'idle':
      return 'Chrona checks for updates automatically.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return 'Chrona is up to date.'
    case 'available':
      return `Version ${state.availableVersion ?? ''} is available.`
    case 'downloading':
      return `Downloading version ${state.availableVersion ?? ''}${
        state.downloadPercent === null ? '…' : ` — ${Math.round(state.downloadPercent)}%`
      }`
    case 'downloaded':
      return `Version ${state.availableVersion ?? ''} is ready to install.`
    case 'error':
      return 'Chrona could not check for updates.'
  }
}

export function UpdateSettings() {
  const state = useUpdateState()
  const [checking, setChecking] = useState(false)

  const checkNow = async () => {
    setChecking(true)
    try {
      await window.chrona.checkForUpdates()
    } catch {
      // The main process also publishes updater failures as state.
    } finally {
      setChecking(false)
    }
  }

  if (!state) {
    return (
      <div className="block">
        <div className="sideTitle">Updates</div>
        <div className="sideMeta">Loading update status…</div>
      </div>
    )
  }

  const busy = checking || state.status === 'checking' || state.status === 'downloading'

  return (
    <div className="block">
      <div className="sideTitle">Updates</div>
      <div className="sideMeta">{describeUpdate(state)}</div>
      <div className="updateVersion mono">Current version {state.currentVersion}</div>
      {state.status === 'downloading' && state.downloadPercent !== null ? (
        <progress className="updateProgress" max={100} value={state.downloadPercent}>
          {Math.round(state.downloadPercent)}%
        </progress>
      ) : null}
      {state.status === 'error' && state.message ? (
        <div className="mono error updateError">{state.message}</div>
      ) : null}
      <div className="row">
        {state.status === 'downloaded' ? (
          <button className="btn btn-accent" onClick={() => void window.chrona.installUpdate()}>
            Restart and update
          </button>
        ) : null}
        <button
          className="btn"
          disabled={!state.supported || busy || state.status === 'downloaded'}
          onClick={() => void checkNow()}
        >
          {state.status === 'downloading' ? 'Downloading…' : busy ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </div>
  )
}

export function UpdateNotice() {
  const state = useUpdateState()
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  if (
    !state ||
    state.status !== 'downloaded' ||
    !state.availableVersion ||
    dismissedVersion === state.availableVersion
  ) {
    return null
  }

  return (
    <div className="updateNotice" role="status">
      <div>
        <strong>Chrona {state.availableVersion} is ready</strong>
        <span>Restart to finish updating.</span>
      </div>
      <div className="row">
        <button className="btn" onClick={() => setDismissedVersion(state.availableVersion)}>
          Later
        </button>
        <button className="btn btn-accent" onClick={() => void window.chrona.installUpdate()}>
          Restart now
        </button>
      </div>
    </div>
  )
}
