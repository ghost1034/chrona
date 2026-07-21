import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('application shell', () => {
  it('opens on Today with accessible primary landmarks', () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('aria-label="Primary navigation"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('<main class="layout">')
    expect(html).toContain('<h1>Today</h1>')
    expect(html).toContain('Your day at a glance')
    expect(html).not.toContain('>Setup</button>')
  })

  it('exposes non-color recording status text', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Not recording')
    expect(html).toContain('aria-pressed="false"')
  })
})
