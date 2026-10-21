import { useState, useRef, useCallback } from 'react'
import type { TimelinePoint } from '../lib/api'

interface Props {
  timeline: TimelinePoint[]
  value: [number, number]
  onChange: (v: [number, number]) => void
}

export function Timeline({ timeline, value, onChange }: Props) {
  // ── All hooks MUST come before any early return ───────────────────────────
  const railRef  = useRef<HTMLDivElement>(null)
  const dragging = useRef<'left' | 'right' | 'range' | null>(null)
  const dragStart = useRef<{ x: number; v: [number, number] } | null>(null)
  const [activeDrag, setActiveDrag] = useState<'left' | 'right' | 'range' | null>(null)

  // Derive time extents — safe even when timeline is empty
  const tsFirst = timeline.length > 0 ? monthToTs(timeline[0].month) : 0
  const tsLast  = timeline.length > 0 ? monthToTs(timeline[timeline.length - 1].month) + 86400 * 31 : 1
  const span    = Math.max(1, tsLast - tsFirst)

  const getRailX = useCallback((clientX: number): number => {
    if (!railRef.current) return 0
    const r = railRef.current.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100
  }, [])

  const toTs = useCallback(
    (pct: number) => tsFirst + (pct / 100) * span,
    [tsFirst, span],
  )

  const onUp = useCallback(() => {
    dragging.current = null
    dragStart.current = null
    setActiveDrag(null)
  }, [])

  const onMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!dragging.current || !dragStart.current) return
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const curPct   = getRailX(clientX)
    const startPct = getRailX(dragStart.current.x)
    const deltaTs  = ((curPct - startPct) / 100) * span
    const [sv0, sv1] = dragStart.current.v

    if (dragging.current === 'left') {
      onChange([Math.min(toTs(curPct), value[1] - 86400 * 30), value[1]])
    } else if (dragging.current === 'right') {
      onChange([value[0], Math.max(toTs(curPct), value[0] + 86400 * 30)])
    } else {
      const n0 = Math.max(tsFirst, Math.min(sv0 + deltaTs, tsLast - 86400 * 30))
      const n1 = Math.max(tsFirst + 86400 * 30, Math.min(sv1 + deltaTs, tsLast))
      onChange([n0, n1])
    }
  }, [value, onChange, span, tsFirst, tsLast, getRailX, toTs])

  const attachGlobal = useCallback(() => {
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',  onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend',  onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',  onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend',  onUp)
    }
  }, [onMove, onUp])

  const onHandleDown = useCallback((which: 'left' | 'right') =>
    (e: React.MouseEvent | React.TouchEvent) => {
      e.stopPropagation()
      dragging.current = which
      setActiveDrag(which)
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      dragStart.current = { x: clientX, v: value.slice() as [number, number] }
      const cleanup = attachGlobal()
      window.addEventListener('mouseup',  cleanup, { once: true })
      window.addEventListener('touchend', cleanup, { once: true })
    },
    [value, attachGlobal],
  )

  const onRangeDown = useCallback((e: React.MouseEvent) => {
    dragging.current = 'range'
    setActiveDrag('range')
    dragStart.current = { x: e.clientX, v: value.slice() as [number, number] }
    const cleanup = attachGlobal()
    window.addEventListener('mouseup', cleanup, { once: true })
  }, [value, attachGlobal])

  // ── Early return AFTER all hooks ──────────────────────────────────────────
  if (timeline.length === 0) return null

  const maxTotal = Math.max(...timeline.map(t => t.total), 1)
  const toPct    = (ts: number) => Math.min(100, Math.max(0, (ts - tsFirst) / span * 100))
  const leftPct  = toPct(value[0])
  const rightPct = toPct(value[1])

  return (
    <div style={{
      padding: '6px 16px 10px',
      background: '#ffffff', borderTop: '1px solid #e2e8f0',
      userSelect: 'none',
    }}>
      <div style={{ position: 'relative', height: 48 }}>
        {/* Bars */}
        <div
          ref={railRef}
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'flex-end', gap: 1,
          }}
        >
          {timeline.map(pt => {
            const ts = monthToTs(pt.month)
            const inRange = ts >= value[0] && ts <= value[1]
            const barH = Math.max(3, (pt.total / maxTotal) * 44)
            return (
              <div
                key={pt.month}
                title={`${pt.month}: ${pt.total} commits`}
                style={{
                  flex: 1, height: barH,
                  background: inRange ? '#3b82f6' : '#cbd5e1',
                  borderRadius: '1px 1px 0 0',
                  transition: 'background 0.12s',
                }}
              />
            )
          })}
        </div>

        {/* Range overlay — drag to pan */}
        <div
          onMouseDown={onRangeDown}
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${leftPct}%`, right: `${100 - rightPct}%`,
            background: 'rgba(59,130,246,0.08)',
            border: '1.5px solid rgba(59,130,246,0.4)',
            borderRadius: 2,
            cursor: activeDrag === 'range' ? 'grabbing' : 'grab',
            zIndex: 2,
          }}
        />

        {/* Handles */}
        <Handle pct={leftPct}  onMouseDown={onHandleDown('left')}  active={activeDrag === 'left'} />
        <Handle pct={rightPct} onMouseDown={onHandleDown('right')} active={activeDrag === 'right'} />
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, marginTop: 3,
      }}>
        <span style={{ color: '#3b82f6', fontWeight: 600 }}>{fmtMonth(value[0])}</span>
        <span style={{ color: '#94a3b8', fontSize: 10 }}>拖拽调整时间范围</span>
        <span style={{ color: '#3b82f6', fontWeight: 600 }}>{fmtMonth(value[1])}</span>
      </div>
    </div>
  )
}

function Handle({ pct, onMouseDown, active }: {
  pct: number
  onMouseDown: (e: React.MouseEvent) => void
  active: boolean
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute', top: 0, bottom: 0,
        left: `${pct}%`, transform: 'translateX(-50%)',
        width: 10, cursor: 'ew-resize', zIndex: 5,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 4, height: '100%',
        background: active ? '#2563eb' : '#3b82f6',
        borderRadius: 2,
        boxShadow: active ? '0 0 0 3px rgba(59,130,246,0.3)' : 'none',
        transition: 'box-shadow 0.12s',
      }} />
    </div>
  )
}

function monthToTs(month: string): number {
  return Math.floor(new Date(month + '-01').getTime() / 1000)
}

function fmtMonth(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short' })
}
