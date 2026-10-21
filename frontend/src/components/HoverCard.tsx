import type { TreeNode, OwnerInfo, MapMode } from '../lib/api'
import { authorColor, avatarFallbackColor, getInitials, formatChurn } from '../lib/colors'

interface Props {
  node: TreeNode
  x: number
  y: number
  mode: MapMode
}

export function HoverCard({ node, x, y, mode }: Props) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cardW = 290

  const left = x + cardW + 20 > vw ? x - cardW - 8 : x + 16
  const top  = y + 220 > vh ? y - 220 : y + 12

  return (
    <div style={{
      position: 'fixed',
      left, top,
      width: cardW,
      background: '#ffffff',
      border: '1px solid #e2e8f0',
      borderRadius: 10,
      padding: '12px 14px',
      pointerEvents: 'none',
      zIndex: 1000,
      boxShadow: '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    }}>
      {/* File path */}
      <div style={{
        fontSize: 11, color: '#64748b', marginBottom: 8,
        wordBreak: 'break-all', lineHeight: 1.5,
        background: '#f8fafc', padding: '4px 6px', borderRadius: 5,
      }}>
        {node.path}
      </div>

      {/* Size metric */}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
        {mode === 'loc' ? (
          <>代码量 <span style={{ color: '#1e293b', fontWeight: 700 }}>{(node.total_loc || 0).toLocaleString()}</span> 行<sup style={{ fontSize: 9, color: '#94a3b8', marginLeft: 2 }}>LoC</sup></>
        ) : (
          <>活跃量 <span style={{ color: '#1e293b', fontWeight: 700 }}>{formatChurn(node.total_churn)}</span> 行变动<sup style={{ fontSize: 9, color: '#94a3b8', marginLeft: 2 }}>churn</sup></>
        )}
      </div>

      {/* Owners */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {Array.isArray(node.owners) && node.owners.map((o, i) => (
          <OwnerRow key={o.email} owner={o} rank={i} />
        ))}
      </div>
    </div>
  )
}

function OwnerRow({ owner, rank }: { owner: OwnerInfo; rank: number }) {
  const color = authorColor(owner.email)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
        border: `1.5px solid ${color}`,
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: '50%',
          background: avatarFallbackColor(owner.email),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 700, color: '#fff',
        }}>
          {getInitials(owner.name)}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 11, color: '#1e293b', fontWeight: rank === 0 ? 700 : 400 }}>
            {owner.name}
          </span>
          <span style={{ fontSize: 10, color: '#94a3b8' }}>{owner.pct}%</span>
        </div>
        <div style={{ height: 3, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${owner.pct}%`, background: color, borderRadius: 2 }} />
        </div>
      </div>
    </div>
  )
}
