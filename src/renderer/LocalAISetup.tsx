import type { LocalSetupResult } from '../shared/ipc'

export function LocalAISetup(props: {
  result: LocalSetupResult | null
  busy: boolean
  onConfigure: () => Promise<void>
  onOpenGuide: (runtime: 'ollama' | 'lm_studio') => Promise<void>
}) {
  const result = props.result
  const detectedRuntime = result?.runtime === 'ollama' || result?.runtime === 'lm_studio'
    ? result.runtime
    : null

  return (
    <div className="block">
      <div className="sideTitle">Automatic local setup</div>
      <div className="sideMeta">
        Chrona detects Ollama or LM Studio, finds installed models, and selects the vision and text models for you.
      </div>
      <div className="row">
        <button className="btn btn-accent" disabled={props.busy} onClick={() => void props.onConfigure()}>
          {props.busy ? 'Checking…' : result ? 'Check again' : 'Set up automatically'}
        </button>
        {result ? (
          <div className={`mono ${result.status === 'unavailable' ? 'error' : ''}`} role="status">
            {result.message}
          </div>
        ) : null}
      </div>

      {result?.recommendedCommand ? (
        <div className="sideMeta" style={{ marginTop: 10 }}>
          This download requires your approval because model files are large. Run in Terminal, then choose Check again:
          <div className="mono" style={{ marginTop: 6 }}>{result.recommendedCommand}</div>
        </div>
      ) : null}

      {result?.status === 'unavailable' ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void props.onOpenGuide('ollama')}>Install Ollama</button>
          <button className="btn" onClick={() => void props.onOpenGuide('lm_studio')}>Set up LM Studio</button>
        </div>
      ) : result && result.status !== 'ready' && detectedRuntime ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void props.onOpenGuide(detectedRuntime)}>
            Open {detectedRuntime === 'ollama' ? 'Ollama' : 'LM Studio'} setup guide
          </button>
        </div>
      ) : null}
    </div>
  )
}
