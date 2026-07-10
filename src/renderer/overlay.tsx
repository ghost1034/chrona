import { createRoot } from 'react-dom/client'
import { OverlayApp } from './OverlayApp'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(<OverlayApp />)
