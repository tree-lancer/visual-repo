import { memo, useCallback, useMemo, useState } from 'react'
import type { Author } from '../lib/api'
import { authorColor, avatarFallbackColor, getInitials } from '../lib/colors'

interface Props {
  authors: Author[]
  selected: Set<string>
  onToggle: (email: string) => void
  onSelectAll: () => void
  onClearAll: () => void
  onOpenProfile: (email: string) => void
}

export function PersonFilter({ authors, selected, onToggle, onSelectAll, onClearAll, onOpenProfile }: Props) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => authors.filter(a =>
    !search ||
    a.name.includes(search) ||
    a.email.includes(search)
  ), [authors, search])

  return (
    <div style={{
      width: 228, height: '100%',
      background: '#ffffff',
      borderRight: '1px solid #e2e8f0',
      display: 'flex', flexDirection: 'column',
      boxShadow: '1px 0 4px rgba(0,0,0,0.04)',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          贡献者
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索..."
          style={{
            width: '100%', background: '#f8fafc',
            border: '1px solid #e2e8f0', borderRadius: 6,
            padding: '5px 8px', fontSize: 12,
            color: '#334155', outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button onClick={onSelectAll} style={btnStyle}>全选</button>
          <button onClick={onClearAll}  style={btnStyle}>清空</button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filtered.map(author => (
          <AuthorRow
            key={author.email}
            author={author}
            active={selected.size === 0 || selected.has(author.email)}
            checked={selected.has(author.email)}
            onToggle={onToggle}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </div>
    </div>
  )
}

const AuthorRow = memo(function AuthorRow({ author, active, checked, onToggle, onOpenProfile }: {
  author: Author
  active: boolean
  checked: boolean
  onToggle: (email: string) => void
  onOpenProfile: (email: string) => void
}) {
  const color = authorColor(author.email)
  const handleToggle = useCallback(() => onToggle(author.email), [onToggle, author.email])

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '5px 8px 5px 12px',
      background: checked ? `${color}12` : 'transparent',
      opacity: active ? 1 : 0.38,
      transition: 'background 0.12s, opacity 0.15s',
    }}>
      {/* Left: toggle highlight */}
      <div
        onClick={handleToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}
      >
        <div style={{
          width: 3, height: 28, borderRadius: 2, flexShrink: 0,
          background: checked ? color : '#e2e8f0',
        }} />
        <div style={{
          width: 28, height: 28, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
          border: `1.5px solid ${checked ? color : '#e2e8f0'}`,
        }}>
          <div style={{
            width: 28, height: 28,
            background: avatarFallbackColor(author.email),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#fff',
          }}>
            {getInitials(author.name)}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <div style={{
              fontSize: 12, color: checked ? '#1e293b' : '#64748b',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontWeight: checked ? 600 : 400, flex: 1, minWidth: 0,
            }}>
              {author.name}
            </div>
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8' }}>
            {author.username} · {author.commit_count}c
          </div>
        </div>
      </div>

      {/* Right: open profile */}
      <button
        onClick={e => { e.stopPropagation(); onOpenProfile(author.email) }}
        title="查看画像"
        style={{
          flexShrink: 0, width: 24, height: 24,
          border: 'none', background: 'transparent',
          borderRadius: 5, fontSize: 13,
          color: '#cbd5e1', cursor: 'pointer', padding: 0,
          transition: 'background 0.1s, color 0.1s',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = '#f1f5f9'
          ;(e.currentTarget as HTMLElement).style.color = '#3b82f6'
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = 'transparent'
          ;(e.currentTarget as HTMLElement).style.color = '#cbd5e1'
        }}
      >
        📊
      </button>
    </div>
  )
})

const btnStyle: React.CSSProperties = {
  flex: 1, padding: '4px 0', fontSize: 11,
  background: '#f8fafc', border: '1px solid #e2e8f0',
  borderRadius: 5, color: '#64748b', cursor: 'pointer',
}
