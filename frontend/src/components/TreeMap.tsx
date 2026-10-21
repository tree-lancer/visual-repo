/**
 * VoronoiTreeMap — pan/zoom + depth-aware labels + domain boundaries
 *
 * Interaction:
 *   Drag       — pan
 *   Wheel      — zoom (0.4×–30×)
 *   ＋/－/⊙   — zoom buttons (bottom-right)
 *   🏷         — "全家福" toggle: show ALL labels at once (non-default)
 *
 * Label sizing:
 *   font-size ∝ √(screen area)  so large cells get large text, small cells hide
 *
 * Depth boundaries:
 *   depth-1 dirs: thick border + drop-shadow  → domain outline clearly visible
 *   depth-2 dirs: medium border
 *   file cells:   thin border, colored by top owner
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as d3 from 'd3'
import { voronoiTreemap } from 'd3-voronoi-treemap'
import type { VoronoiNode } from 'd3-voronoi-treemap'
import type { TreeNode } from '../lib/api'
import type { MapMode } from '../lib/api'
import { authorColor } from '../lib/colors'
import { HoverCard } from './HoverCard'

interface Props {
  data: TreeNode
  highlightEmails: Set<string>
  width: number
  height: number
  mode: MapMode
  depth: number
  onDepthChange: (d: number) => void
}

interface HoverState {
  node: TreeNode
  screenX: number
  screenY: number
}

function rectClip(w: number, h: number): [number, number][] {
  return [[0, 0], [w, 0], [w, h], [0, h]]
}

function centroid(poly: [number, number][]): [number, number] {
  let cx = 0, cy = 0
  for (const [x, y] of poly) { cx += x; cy += y }
  return [cx / poly.length, cy / poly.length]
}

function polyRadius(poly: [number, number][], c: [number, number]): number {
  let r = 0
  for (const [x, y] of poly) {
    const d = Math.hypot(x - c[0], y - c[1])
    if (d > r) r = d
  }
  return r
}

function makePrng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function TreeMap({ data, highlightEmails, width, height, mode, depth, onDepthChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomBehavior = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const [transform, setTransform] = useState<d3.ZoomTransform>(d3.zoomIdentity)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showAllLabels, setShowAllLabels] = useState(false)

  const [layoutError, setLayoutError] = useState(false)

  const voronoiNodes = useMemo<VoronoiNode<TreeNode>[]>(() => {
    if (width < 10 || height < 10) return []
    setLayoutError(false)
    try {
      const hier = d3.hierarchy<TreeNode>(data, d => d.children?.length ? d.children : null)
        .sum(d => {
          if (d.children?.length) return 0
          const raw = mode === 'loc' ? (d.total_loc ?? 0) : (d.total_churn ?? 0)
          // sqrt 压缩极端权重比例，防止 handleOverweighted1 崩溃
          return Math.max(Math.sqrt(Math.max(raw, 0)), 1)
        })
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      const layout = voronoiTreemap<TreeNode>()
        .clip(rectClip(width, height))
        .maxIterationCount(80)
        .convergenceRatio(0.002)
        .prng(makePrng(width * height))
      layout(hier)
      const nodes: VoronoiNode<TreeNode>[] = []
      hier.each(n => {
        const vn = n as VoronoiNode<TreeNode>
        if (vn.polygon && vn.polygon.length >= 3) nodes.push(vn)
      })
      return nodes
    } catch (e) {
      console.warn('[TreeMap] voronoi layout failed:', e)
      setLayoutError(true)
      return []
    }
  }, [data, width, height, mode])

  // d3-zoom
  useEffect(() => {
    if (!svgRef.current) return
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 30])
      .on('start', () => setDragging(true))
      .on('zoom', (ev: d3.D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(ev.transform))
      .on('end', () => setDragging(false))
    zoomBehavior.current = zoom
    d3.select(svgRef.current).call(zoom)
    return () => { d3.select(svgRef.current!).on('.zoom', null) }
  }, [])

  const zoomIn = useCallback(() => {
    if (!svgRef.current || !zoomBehavior.current) return
    d3.select(svgRef.current).transition().duration(220).call(zoomBehavior.current.scaleBy, 1.6)
  }, [])
  const zoomOut = useCallback(() => {
    if (!svgRef.current || !zoomBehavior.current) return
    d3.select(svgRef.current).transition().duration(220).call(zoomBehavior.current.scaleBy, 1 / 1.6)
  }, [])
  const zoomReset = useCallback(() => {
    if (!svgRef.current || !zoomBehavior.current) return
    d3.select(svgRef.current).transition().duration(350).call(zoomBehavior.current.transform, d3.zoomIdentity)
  }, [])

  const hitTestFile = useCallback((mx: number, my: number): VoronoiNode<TreeNode> | null => {
    let hit: VoronoiNode<TreeNode> | null = null
    let minArea = Infinity
    for (const vn of voronoiNodes) {
      if (vn.data.type !== 'file') continue
      if (d3.polygonContains(vn.polygon, [mx, my])) {
        const a = Math.abs(d3.polygonArea(vn.polygon))
        if (a < minArea) { minArea = a; hit = vn }
      }
    }
    return hit
  }, [voronoiNodes])

  // 多边形几何量只依赖布局，与缩放无关：缓存避免每帧重算
  const geom = useMemo(() => voronoiNodes.map(vn => {
    const c = centroid(vn.polygon)
    return {
      c,
      r: polyRadius(vn.polygon, c),
      area: Math.abs(d3.polygonArea(vn.polygon)),
      points: vn.polygon.map(([x, y]) => `${x},${y}`).join(' '),
    }
  }), [voronoiNodes])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const [mx, my] = transform.invert([e.clientX - rect.left, e.clientY - rect.top])
    const hit = hitTestFile(mx, my)
    setHover(hit ? { node: hit.data, screenX: e.clientX, screenY: e.clientY } : null)
  }, [transform, hitTestFile])

  const k = transform.k
  const invK = 1 / k

  // ── Label visibility rules ─────────────────────────────────────────────────
  // ── Label visibility rules ───────────────────────────────────────────────── 
  const autoMaxDir   = k < 2 ? 1 : k < 5 ? 2 : 99
  const maxDirDepth  = showAllLabels ? depth : autoMaxDir
  const showFileLabels = showAllLabels ? true : k >= 5

  const forced = showAllLabels
  const dirMinScreenArea  = forced ? 0    : 1200
  const dirMinScreenR     = forced ? 0    : 14
  const fileMinScreenArea = forced ? 0    : 900
  const fileMinScreenR    = forced ? 0    : 10

  const tStr = `translate(${transform.x},${transform.y}) scale(${k})`

  const viewLabel = k < 2 ? '模块视图' : k < 5 ? '目录视图' : '文件视图'

  return (
    <div style={{ position: 'relative', width, height, background: '#f1f5f9', overflow: 'hidden' }}>
      {layoutError && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(241,245,249,0.92)', gap: 8,
        }}>
          <span style={{ fontSize: 28 }}>⚠️</span>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>地图布局失败</span>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>数据权重差异过大，尝试缩小时间范围或减少展开深度</span>
        </div>
      )}
      <svg
        ref={svgRef}
        width={width}
        height={height}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', cursor: dragging ? 'grabbing' : 'grab' }}
      >
        {/* ── SVG filters ─────────────────────────────────── */}
        <defs>
          {/* Drop-shadow for depth-1 domain borders */}
          <filter id="domain-shadow" x="-8%" y="-8%" width="116%" height="116%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#4a6fa5" floodOpacity="0.28" />
          </filter>
        </defs>

        <g transform={tStr}>
          {/* ── polygons: files (bottom layer) ────────────── */}
          {voronoiNodes.map((vn, i) => {
            if (vn.depth === 0) return null
            // file 节点，或被截断成叶子的 dir 节点（children 为空）都填充颜色
            const isLeaf = vn.data.type === 'file' || !vn.data.children?.length
            if (!isLeaf) return null
            const nd = vn.data
            const pts = geom[i].points
            const owners = Array.isArray(nd.owners) ? nd.owners : []
            const topOwner = owners[0]
            const isHighlighted = highlightEmails.size > 0 && owners.some(o => highlightEmails.has(o.email))
            const dimmed = highlightEmails.size > 0 && !isHighlighted
            const baseColor = topOwner ? authorColor(topOwner.email) : '#94a3b8'
            return (
              <polygon key={`pf${i}`} points={pts}
                fill={baseColor}
                fillOpacity={dimmed ? 0.07 : isHighlighted ? 0.62 : 0.28}
                stroke={isHighlighted ? baseColor : '#bfcad4'}
                strokeWidth={invK * (isHighlighted ? 1.5 : 0.4)}
              />
            )
          })}

          {/* ── polygons: depth-2 dirs (middle layer) ─────── */}
          {voronoiNodes.map((vn, i) => {
            if (vn.depth === 0 || vn.data.type !== 'dir' || vn.depth <= 1) return null
            const pts = geom[i].points
            return (
              <polygon key={`pd2${i}`} points={pts}
                fill="none"
                stroke="#8aa8c4"
                strokeWidth={invK * 1.2}
                strokeDasharray={`${invK * 4},${invK * 2}`}
              />
            )
          })}

          {/* ── polygons: depth-1 domain borders (top layer) ─ */}
          {voronoiNodes.map((vn, i) => {
            if (vn.depth !== 1 || vn.data.type !== 'dir') return null
            const pts = geom[i].points
            return (
              <polygon key={`pd1${i}`} points={pts}
                fill="none"
                stroke="#3b6fa0"
                strokeWidth={invK * 2.8}
                filter="url(#domain-shadow)"
                style={{ pointerEvents: 'none' }}
              />
            )
          })}

          {/* ── labels ────────────────────────────────────── */}
          {voronoiNodes.map((vn, i) => {
            if (vn.depth === 0) return null
            const nd = vn.data
            const { c, r, area } = geom[i]
            const screenArea = area * k * k
            const screenR    = r * k

            if (nd.type === 'dir') {
              if (vn.depth > maxDirDepth) return null
              if (screenArea < dirMinScreenArea || screenR < dirMinScreenR) return null

              // Font size proportional to √(screen area), clamped [7, 22]
              const fs = Math.min(22, Math.max(7, Math.sqrt(screenArea) * 0.075)) * invK

              // In 全家福 mode, tiny cells get even smaller text (floor at 6px screen)
              const minScreenPx = showAllLabels ? 6 : 0
              if (fs * k < minScreenPx) return null

              const isDomain = vn.depth === 1
              return (
                <text key={`l${i}`}
                  x={c[0]} y={c[1] + fs * 0.38}
                  textAnchor="middle"
                  fontSize={fs}
                  fontWeight={isDomain ? 800 : 600}
                  fill={isDomain ? '#0f2d52' : '#2c4a6b'}
                  paintOrder="stroke"
                  stroke={isDomain ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.5)'}
                  strokeWidth={fs * 0.25}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {nd.name}
                </text>
              )
            }

            // file label
            if (!showFileLabels) return null
            if (screenArea < fileMinScreenArea || screenR < fileMinScreenR) return null
            const fs = Math.min(11, Math.max(6, Math.sqrt(screenArea) * 0.055)) * invK
            if (fs * k < 6) return null
            const label = nd.name.length > 20 ? nd.name.slice(-18) : nd.name
            return (
              <text key={`l${i}`}
                x={c[0]} y={c[1] + fs * 0.38}
                textAnchor="middle" fontSize={fs}
                fill="#3d5166"
                paintOrder="stroke"
                stroke="rgba(255,255,255,0.55)"
                strokeWidth={fs * 0.22}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {label}
              </text>
            )
          })}
        </g>
      </svg>

      {/* ── Controls (bottom-right) ──────────────────────── */}
      <div style={{
        position: 'absolute', right: 12, bottom: 16,
        display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10,
      }}>
        <ZoomBtn onClick={zoomIn}>＋</ZoomBtn>
        <ZoomBtn onClick={zoomOut}>－</ZoomBtn>
        <ZoomBtn onClick={zoomReset} title="重置视图">⊙</ZoomBtn>

        {/* ── 深度调节器 ── */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6,
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden',
        }}>
          <button
            onClick={() => onDepthChange(Math.min(5, depth + 1))}
            disabled={depth >= 5}
            title="增加展开深度"
            style={stepBtnStyle(depth >= 5)}
          >▲</button>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#3b82f6',
            lineHeight: 1, padding: '3px 0', userSelect: 'none',
          }}
            title={`当前展开 ${depth} 层`}
          >D{depth}</div>
          <button
            onClick={() => onDepthChange(Math.max(3, depth - 1))}
            disabled={depth <= 3}
            title="减少展开深度"
            style={stepBtnStyle(depth <= 3)}
          >▼</button>
        </div>

        {/* ── 地名层级调节器 ── */}
        <ZoomBtn
          onClick={() => setShowAllLabels(v => !v)}
          title={showAllLabels ? `关闭全家福（当前显示 L1~${depth}）` : '全家福：显示所有地名'}
          active={showAllLabels}
        >
          🏷
        </ZoomBtn>
      </div>

      {/* ── Scale hint (bottom-left) ─────────────────────── */}
      <div style={{
        position: 'absolute', left: 10, bottom: 18, zIndex: 10,
        fontSize: 10, color: '#94a3b8', userSelect: 'none', pointerEvents: 'none',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        <span>{showAllLabels ? `🏷 L1~${depth}` : viewLabel}</span>
        <span style={{ opacity: 0.6 }}>× {k.toFixed(1)}</span>
      </div>

      {hover && (
        <HoverCard node={hover.node} x={hover.screenX} y={hover.screenY} mode={mode} />
      )}
    </div>
  )
}

// ─── Step button style helper ────────────────────────────────────────────────
function stepBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 30, height: 18,
    border: 'none', background: 'transparent',
    color: disabled ? '#cbd5e1' : '#475569',
    fontSize: 9, lineHeight: 1,
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
  }
}

// ─── Zoom button ──────────────────────────────────────────────────────────────
function ZoomBtn({ onClick, children, title, active = false }: {
  onClick: () => void
  children: React.ReactNode
  title?: string
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 30, height: 30,
        border: active ? '1.5px solid #3b82f6' : '1px solid #e2e8f0',
        borderRadius: 6,
        background: active ? '#eff6ff' : '#fff',
        color: active ? '#2563eb' : '#475569',
        fontSize: 15, lineHeight: 1,
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: active ? '0 0 0 2px rgba(59,130,246,0.2)' : '0 1px 3px rgba(0,0,0,0.08)',
        padding: 0, transition: 'all 0.12s',
      }}
    >
      {children}
    </button>
  )
}
