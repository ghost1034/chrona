import { useEffect, useMemo, useState } from 'react'
import type { SetupStatus } from '../shared/ipc'

type StepId = 'privacy' | 'capture' | 'ai' | 'ready'

export function OnboardingView(props: {
  setupStatus: SetupStatus | null
  onboardingCompleted: boolean
  onRefreshSetupStatus: () => Promise<void>
  onMarkCompleted: () => Promise<void>
  onStartRecording: () => Promise<void>
  onGoToTimeline: () => void
}) {
  const isMac = props.setupStatus?.platform === 'darwin'

  const steps = useMemo<StepId[]>(() => ['privacy', 'capture', 'ai', 'ready'], [])

  const [stepIndex, setStepIndex] = useState<number>(0)
  const step = steps[Math.max(0, Math.min(steps.length - 1, stepIndex))]!

  const [apiKeyInput, setApiKeyInput] = useState<string>('')
  const [keyLine, setKeyLine] = useState<string>('')
  const [keyTestLine, setKeyTestLine] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)
  const [provider, setProvider] = useState<'gemini' | 'local'>(props.setupStatus?.aiProvider ?? 'gemini')
  const [localBaseUrl, setLocalBaseUrl] = useState('http://127.0.0.1:11434/v1')
  const [localVisionModel, setLocalVisionModel] = useState('')
  const [localTextModel, setLocalTextModel] = useState('')
  const [localToken, setLocalToken] = useState('')
  const [localModels, setLocalModels] = useState<string[]>([])
  const [localLine, setLocalLine] = useState('')

  useEffect(() => {
    void props.onRefreshSetupStatus()
    void window.chrona.getSettings().then((settings) => {
      setProvider(settings.aiProvider)
      setLocalBaseUrl(settings.localBaseUrl)
      setLocalVisionModel(settings.localVisionModel)
      setLocalTextModel(settings.localTextModel)
    })
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

  async function onSelectProvider(next: 'gemini' | 'local') {
    setProvider(next)
    await window.chrona.updateSettings({ aiProvider: next })
    await props.onRefreshSetupStatus()
  }

  async function onDiscoverLocal() {
    setBusy(true)
    setLocalLine('Discovering…')
    try {
      const result = await window.chrona.discoverLocalModels(localBaseUrl, localToken || null)
      setLocalModels(result.models.map((model) => model.id))
      setLocalLine(`Found ${result.models.length} model${result.models.length === 1 ? '' : 's'}`)
    } catch (error) {
      setLocalLine(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onSaveLocal() {
    setBusy(true)
    setLocalLine('Saving…')
    try {
      await window.chrona.updateSettings({
        aiProvider: 'local',
        localBaseUrl,
        localVisionModel: localVisionModel.trim(),
        localTextModel: localTextModel.trim()
      })
      if (localToken.trim()) await window.chrona.setLocalBearerToken(localToken)
      setLocalToken('')
      setLocalLine('Saved')
      await props.onRefreshSetupStatus()
    } catch (error) {
      setLocalLine(`Save failed: ${error instanceof Error ? error.message : String(error)}`)
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

        {step === 'privacy' ? (
          <div className="onboardingBody">
            <div className="eyebrow">Private by design</div>
            <div className="onboardingStepTitle">Understand where your time goes.</div>
            <div className="onboardingLead">
              Chrona turns periodic screen captures into a clear, searchable timeline—so you can reflect without tracking every task by hand.
            </div>
            <div className="onboardingList">
              <div className="onboardingPromise">
                <span aria-hidden="true">✓</span>
                <div><strong>Your data stays local</strong><small>Screenshots and your timeline live on this computer.</small></div>
              </div>
              <div className="onboardingPromise">
                <span aria-hidden="true">✓</span>
                <div><strong>You control capture</strong><small>Pause at any time and blur sensitive areas before they are saved.</small></div>
              </div>
              <div className="onboardingPromise">
                <span aria-hidden="true">✓</span>
                <div><strong>AI is optional</strong><small>Use Gemini or a local Ollama / LM Studio server for summaries, Ask, and journal drafts.</small></div>
              </div>
            </div>
          </div>
        ) : null}

        {step === 'ai' ? (
          <div className="onboardingBody">
            <div className="sideTitle">AI provider</div>
            <label className="label" style={{ marginTop: 10 }}>
              Provider
              <select className="input" value={provider}
                onChange={(event) => void onSelectProvider(event.target.value as 'gemini' | 'local')}>
                <option value="gemini">Gemini</option>
                <option value="local">Local (Ollama / LM Studio)</option>
              </select>
            </label>

            {provider === 'gemini' ? <>
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
            </> : <>
              <div className="sideMeta" style={{ marginTop: 10 }}>
                Local mode keeps screenshots and all AI operations on this computer. Start Ollama or LM Studio first.
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <input className="input" value={localBaseUrl} onChange={(event) => setLocalBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:11434/v1" />
                <button className="btn" disabled={busy} onClick={() => void onDiscoverLocal()}>Refresh models</button>
              </div>
              <datalist id="onboarding-local-models">
                {localModels.map((model) => <option key={model} value={model} />)}
              </datalist>
              <div className="row" style={{ marginTop: 10 }}>
                <input className="input" list="onboarding-local-models" value={localVisionModel}
                  onChange={(event) => setLocalVisionModel(event.target.value)} placeholder="Vision model ID" />
                <input className="input" list="onboarding-local-models" value={localTextModel}
                  onChange={(event) => setLocalTextModel(event.target.value)} placeholder="Text model ID" />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <input className="input" type="password" value={localToken}
                  onChange={(event) => setLocalToken(event.target.value)} placeholder="Optional Bearer token" />
                <button className="btn btn-accent" disabled={busy} onClick={() => void onSaveLocal()}>Save</button>
              </div>
              {localLine ? <div className="mono" style={{ marginTop: 10 }}>{localLine}</div> : null}
            </>}
          </div>
        ) : null}

        {step === 'capture' ? (
          <div className="onboardingBody">
            <div className="eyebrow">Capture permission</div>
            <div className="onboardingStepTitle">Let Chrona observe your work.</div>
            <div className="sideTitle">{isMac ? 'macOS Screen Recording permission' : 'Screen capture access'}</div>
            <div className="sideMeta">
              Status: {!isMac ? 'available' : captureStatus === 'granted' ? 'granted' : captureStatus === 'denied' ? 'missing' : 'unknown'}
              {captureMessage ? ` · ${captureMessage}` : ''}
            </div>

            {isMac ? <div className="sideMeta" style={{ marginTop: 10 }}>
              In System Settings: Privacy &amp; Security → Screen Recording → enable Chrona.
            </div> : <div className="sideMeta" style={{ marginTop: 10 }}>Windows will ask for access when Chrona begins capturing. You remain in control from the app or tray.</div>}

            {isMac ? <div className="row" style={{ marginTop: 10 }}>
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
            </div> : null}

            {isMac ? <div className="sideMeta" style={{ marginTop: 12 }}>
              After enabling permission, macOS may require a relaunch for capture to work.
            </div> : null}
          </div>
        ) : null}

        {step === 'ready' ? (
          <div className="onboardingBody">
            <div className="sideTitle">Ready</div>
            <div className="onboardingList">
              <div className="row">
                <div className="pill">AI</div>
                <div className="sideMeta">
                  {props.setupStatus?.aiConfigured
                    ? `${props.setupStatus.aiProvider === 'local' ? 'Local' : 'Gemini'} configured`
                    : 'Missing configuration (analysis paused)'}
                </div>
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
