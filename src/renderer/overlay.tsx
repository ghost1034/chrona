import { createRoot } from 'react-dom/client'
import '@fontsource-variable/ibm-plex-sans'
import { OverlayApp } from './OverlayApp'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(<OverlayApp />)
