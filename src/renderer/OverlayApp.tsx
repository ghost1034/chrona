import { useCallback, useEffect, useState } from 'react'
import type { BlurRegion } from '../shared/blurRegions'
import { normalizedRectFromDrag } from '../shared/blurRegions'

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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'fixed',
        inset: 0,
        cursor: 'crosshair',
        background: 'rgba(0, 0, 0, 0.25)',
        userSelect: 'none',
        fontFamily: 'system-ui, sans-serif'
      }}
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

      <div
        style={{
          position: 'fixed',
          bottom: 32,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '10px 18px',
          borderRadius: 8,
          background: 'rgba(14, 17, 22, 0.9)',
          color: '#e6ebf2',
          fontSize: 13,
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        Drag to add a blur region · click × to remove · Esc to finish. Blurred areas are hidden
        from AI but stay visible to you.
      </div>
    </div>
  )
}
