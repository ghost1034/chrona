import { useCallback, useEffect, useState } from 'react'
import type { BlurRegion } from '../shared/blurRegions'
import { normalizedRectFromDrag } from '../shared/blurRegions'
import { ChronaMark } from './components/Icon'
import './styles/overlay.css'

type DragState = {
  startX: number
  startY: number
  curX: number
  curY: number
}

const FILL_COLOR = '#1A1A1A'

export function OverlayApp() {
  const displayId = new URLSearchParams(window.location.search).get('displayId') ?? ''

  const [regions, setRegions] = useState<BlurRegion[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)

  const refresh = useCallback(async () => {
    const res = await window.chrona.listBlurRegions()
    setRegions(res.regions.filter((r) => r.displayId === displayId))
  }, [displayId])

  useEffect(() => {
    void refresh()
    return window.chrona.onBlurRegionsChanged(() => void refresh())
  }, [refresh])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void window.chrona.closeBlurOverlay()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Ignore drags that start on a delete button.
    if ((e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    setDrag((d) => (d ? { ...d, curX: e.clientX, curY: e.clientY } : d))
  }

  const onPointerUp = () => {
    if (!drag) return
    setDrag(null)
    const rect = normalizedRectFromDrag(
      { x: drag.startX, y: drag.startY },
      { x: drag.curX, y: drag.curY },
      { width: window.innerWidth, height: window.innerHeight }
    )
    if (rect) void window.chrona.addBlurRegion({ displayId, rect })
  }

  const marquee = drag
    ? {
        left: Math.min(drag.startX, drag.curX),
        top: Math.min(drag.startY, drag.curY),
        width: Math.abs(drag.curX - drag.startX),
        height: Math.abs(drag.curY - drag.startY)
      }
    : null

  return (
    <div
      className="blurOverlay"
      data-display-id={displayId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {regions.map((r) => (
        <div
          key={r.id}
          style={{
            position: 'absolute',
            left: `${r.rect.x * 100}%`,
            top: `${r.rect.y * 100}%`,
            width: `${r.rect.w * 100}%`,
            height: `${r.rect.h * 100}%`,
            background: FILL_COLOR,
            border: '1px solid rgba(255, 255, 255, 0.5)',
            boxSizing: 'border-box'
          }}
        >
          <button
            onClick={() => void window.chrona.removeBlurRegion(r.id)}
            title="Remove this blurred area"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 22,
              height: 22,
              lineHeight: '18px',
              padding: 0,
              border: 'none',
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.85)',
              color: '#111',
              fontSize: 14,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>
      ))}

      {marquee && (
        <div
          style={{
            position: 'absolute',
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
            background: 'rgba(26, 26, 26, 0.6)',
            border: '1px dashed rgba(255, 255, 255, 0.8)',
            boxSizing: 'border-box',
            pointerEvents: 'none'
          }}
        />
      )}

      <div className="blurHud">
        <ChronaMark />
        <div><strong>Protect a screen area</strong><span>Drag to add · click × to remove · Esc to finish</span></div>
        <small>Excluded before storage or AI analysis</small>
      </div>
    </div>
  )
}
