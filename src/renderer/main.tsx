import { createRoot } from 'react-dom/client'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource-variable/newsreader'
import { App } from './App'
import { installMockChrona } from './mockChrona'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

installMockChrona()

createRoot(rootEl).render(<App />)
