import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocalAISetup } from './LocalAISetup'

const noop = async () => undefined

describe('LocalAISetup', () => {
  it('guides users to install or start a supported runtime when none is available', () => {
    const html = renderToStaticMarkup(
      <LocalAISetup
        busy={false}
        onConfigure={noop}
        onOpenGuide={noop}
        result={{
          status: 'unavailable',
          runtime: null,
          baseUrl: null,
          models: [],
          visionModel: null,
          textModel: null,
          message: 'No local AI server was found.',
          recommendedCommand: null
        }}
      />
    )
    expect(html).toContain('Install Ollama')
    expect(html).toContain('Set up LM Studio')
    expect(html).toContain('No local AI server was found.')
  })

  it('shows the exact consent-based model download command when Ollama needs a model', () => {
    const html = renderToStaticMarkup(
      <LocalAISetup
        busy={false}
        onConfigure={noop}
        onOpenGuide={noop}
        result={{
          status: 'needs_models',
          runtime: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [],
          visionModel: null,
          textModel: null,
          message: 'Ollama needs a model.',
          recommendedCommand: 'ollama pull qwen3-vl:4b'
        }}
      />
    )
    expect(html).toContain('model files are large')
    expect(html).toContain('ollama pull qwen3-vl:4b')
    expect(html).toContain('Open Ollama setup guide')
  })
})
