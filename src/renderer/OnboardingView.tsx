import { useEffect, useMemo, useState } from 'react'
import type { SetupStatus } from '../shared/ipc'

type StepId = 'welcome' | 'gemini' | 'capture' | 'ready'

export function OnboardingView(props: {
  setupStatus: SetupStatus | null
  onboardingCompleted: boolean
  onRefreshSetupStatus: () => Promise<void>
  onMarkCompleted: () => Promise<void>
  onStartRecording: () => Promise<void>
  onGoToTimeline: () => void
}) {
  const isMac = props.setupStatus?.platform === 'darwin'

  const steps = useMemo(() => {
    const base: StepId[] = ['welcome', 'gemini']
    if (isMac) base.push('capture')
    base.push('ready')
    return base
  }, [isMac])

  const [stepIndex, setStepIndex] = useState<number>(0)
  const step = steps[Math.max(0, Math.min(steps.length - 1, stepIndex))]!

  const [apiKeyInput, setApiKeyInput] = useState<string>('')
  const [keyLine, setKeyLine] = useState<string>('')
  const [keyTestLine, setKeyTestLine] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  useEffect(() => {
    void props.onRefreshSetupStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasGeminiKey = !!props.setupStatus?.hasGeminiKey
  const captureStatus = props.setupStatus?.captureAccess.status ?? 'unknown'
  const captureMessage = props.setupStatus?.captureAccess.message ?? null

  const canRecord = !isMac || captureStatus === 'granted'

  async function onSaveKey() {
    const trimmed = apiKeyInput.trim()
    if (!trimmed) {
      setKeyLine('Enter an API key first')
      return
    }

    setBusy(true)
    setKeyLine('Saving…')
    setKeyTestLine('')
    try {
      await window.chrona.setGeminiApiKey(trimmed)
      setApiKeyInput('')
      setKeyLine('Saved')
      await props.onRefreshSetupStatus()
    } catch (e) {
      setKeyLine(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onTestKey() {
    setBusy(true)
    setKeyTestLine('Testing…')
    try {
      const res = await window.chrona.testGeminiApiKey(apiKeyInput.trim() ? apiKeyInput.trim() : null)
      setKeyTestLine(`${res.ok ? 'OK' : 'Failed'}: ${res.message}`)
      await props.onRefreshSetupStatus()
    } catch (e) {
      setKeyTestLine(`Test failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onFinish() {
    setBusy(true)
    try {
      await props.onMarkCompleted()
      props.onGoToTimeline()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onboardingWrap">
      <div className="onboardingCard">
        <div className="onboardingHeader">
          <div>
            <div className="sideTitle">Setup Chrona</div>
            <div className="sideMeta">
              {props.onboardingCompleted ? 'You can re-run setup any time.' : 'A quick first-run setup.'}
            </div>
          </div>
          <div className="pill">
            Step {stepIndex + 1} / {steps.length}
          </div>
        </div>

        {step === 'welcome' ? (
          <div className="onboardingBody">
            <div className="onboardingLead">
              Chrona captures periodic screenshots and generates a timeline of your activities.
            </div>
            <div className="onboardingList">
              <div className="row">
                <div className="pill">Local-first</div>
                <div className="sideMeta">Screenshots and the database live on your machine.</div>
              </div>
              <div className="row">
                <div className="pill">Gemini</div>
                <div className="sideMeta">Used for transcription and timeline cards.</div>
              </div>
              {isMac ? (
                <div className="row">
                  <div className="pill">macOS permission</div>
                  <div className="sideMeta">Screen Recording permission is required to capture.</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 'gemini' ? (
          <div className="onboardingBody">
            <div className="sideTitle">Gemini API key</div>
            <div className="sideMeta">
              Status: {hasGeminiKey ? 'configured' : 'missing'}. The key is stored in your OS credential store.
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={busy} onClick={() => void window.chrona.openGeminiKeyPage()}>
                Get a key
              </button>
              <button className="btn" disabled={busy} onClick={() => void onTestKey()}>
                Test
              </button>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="input"
                type="password"
                value={apiKeyInput}
                placeholder="AIza…"
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button className="btn btn-accent" disabled={busy} onClick={() => void onSaveKey()}>
                Save
              </button>
            </div>

            {keyLine ? (
              <div className="row" style={{ marginTop: 10 }}>
                <div className="mono">{keyLine}</div>
              </div>
            ) : null}

            {keyTestLine ? (
              <div className="row" style={{ marginTop: 10 }}>
                <div className={`mono ${keyTestLine.startsWith('Failed') ? 'error' : ''}`}>{keyTestLine}</div>
              </div>
            ) : null}

            <div className="sideMeta" style={{ marginTop: 12 }}>
              You can record without a key, but analysis will stay pending until one is configured.
            </div>
          </div>
        ) : null}

        {step === 'capture' ? (
          <div className="onboardingBody">
            <div className="sideTitle">macOS Screen Recording permission</div>
            <div className="sideMeta">
              Status: {captureStatus === 'granted' ? 'granted' : captureStatus === 'denied' ? 'missing' : 'unknown'}
              {captureMessage ? ` · ${captureMessage}` : ''}
            </div>

            <div className="sideMeta" style={{ marginTop: 10 }}>
              In System Settings: Privacy &amp; Security → Screen Recording → enable Chrona.
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void window.chrona.openMacScreenRecordingSettings()}
              >
                Open System Settings
              </button>
              <button className="btn" disabled={busy} onClick={() => void props.onRefreshSetupStatus()}>
                Check again
              </button>
              <button className="btn" disabled={busy} onClick={() => void window.chrona.relaunch()}>
                Relaunch Chrona
              </button>
            </div>

            <div className="sideMeta" style={{ marginTop: 12 }}>
              After enabling permission, macOS may require a relaunch for capture to work.
            </div>
          </div>
        ) : null}

        {step === 'ready' ? (
          <div className="onboardingBody">
            <div className="sideTitle">Ready</div>
            <div className="onboardingList">
              <div className="row">
                <div className="pill">Gemini</div>
                <div className="sideMeta">{hasGeminiKey ? 'Configured' : 'Missing (analysis paused)'}</div>
              </div>
              {isMac ? (
                <div className="row">
                  <div className="pill">Capture</div>
                  <div className="sideMeta">
                    {captureStatus === 'granted' ? 'Permission granted' : 'Permission missing (recording disabled)'}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-accent" disabled={busy} onClick={() => void onFinish()}>
                Finish setup
              </button>
              <button
                className="btn"
                disabled={busy || !canRecord}
                title={canRecord ? '' : 'Enable Screen Recording permission first'}
                onClick={() => void props.onStartRecording()}
              >
                Start recording
              </button>
            </div>
          </div>
        ) : null}

        <div className="onboardingFooter">
          <button
            className="btn"
            disabled={busy || stepIndex <= 0}
            onClick={() => setStepIndex((x) => Math.max(0, x - 1))}
          >
            Back
          </button>

          <div className="onboardingFooterRight">
            <button className="btn" disabled={busy} onClick={() => void onFinish()}>
              Skip for now
            </button>
            <button
              className="btn"
              disabled={busy || stepIndex >= steps.length - 1}
              onClick={() => setStepIndex((x) => Math.min(steps.length - 1, x + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
