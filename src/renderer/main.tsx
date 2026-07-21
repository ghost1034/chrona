import { createRoot } from 'react-dom/client'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import { App } from './App'
import './styles/tokens.css'
import './styles/reset.css'
import './styles.css'
import './styles/quickAccess.css'
import { installFixtureFromUrl } from './testing/fixtures'

installFixtureFromUrl()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(<App />)
