import { useEffect, useState, useCallback } from 'react'
import {
  fetchRepos, fetchAuthors, fetchTreemap, fetchTimeline,
  type Repo, type Author, type TreeNode, type TimelinePoint, type MapMode,
} from './lib/api'
import { TreeMap } from './components/TreeMap'
import { PersonFilter } from './components/PersonFilter'
import { Timeline } from './components/Timeline'
import { AuthorPanel } from './components/AuthorPanel'

const SIDEBAR_W = 228
const TIMELINE_H = 72
const TOOLBAR_H = 46
const ACTIVE_REPO_KEY = 'gitmap.activeRepoId'

export default function App() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [activeRepo, setActiveRepo] = useState<Repo | null>(null)
  const [authors, setAuthors] = useState<Author[]>([])
  const [treemap, setTreemap] = useState<TreeNode | null>(null)
  const [timeline, setTimeline] = useState<TimelinePoint[]>([])
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set())
  const [timeRange, setTimeRange] = useState<[number, number]>([0, 9999999999])
  const [mapMode, setMapMode] = useState<MapMode>('active')
  const [treeDepth, setTreeDepth] = useState(3)
  const [loading, setLoading] = useState(false)
  const [profileEmail, setProfileEmail] = useState<string | null>(null)

  const mapW = window.innerWidth - SIDEBAR_W - (profileEmail ? 400 : 0)
  const mapH = window.innerHeight - TOOLBAR_H - TIMELINE_H

  useEffect(() => {
    fetchRepos().then(rs => {
      setRepos(rs)
      const savedRepoId = localStorage.getItem(ACTIVE_REPO_KEY)
      setActiveRepo(rs.find(r => r.repo_id === savedRepoId) ?? rs[0] ?? null)
    })
  }, [])

  useEffect(() => {
    if (!activeRepo) return
    fetchAuthors(activeRepo.repo_id).then(list => {
      setAuthors(list)
    })
    fetchTimeline(activeRepo.repo_id, []).then(pts => {
      setTimeline(pts)
      if (pts.length > 0) {
        const first = monthToTs(pts[0].month)
        const last  = monthToTs(pts[pts.length - 1].month) + 86400 * 31
        setTimeRange([first, last])
      }
    })
  }, [activeRepo])

  const loadTreemap = useCallback(async () => {
    if (!activeRepo) return
    setLoading(true)
    try {
      const data = await fetchTreemap(
        activeRepo.repo_id,
        timeRange[0],
        timeRange[1],
        Array.from(selectedEmails),
        treeDepth,
        mapMode,
      )
      setTreemap(data)
    } finally {
      setLoading(false)
    }
  }, [activeRepo, timeRange, selectedEmails, mapMode, treeDepth])

  useEffect(() => { loadTreemap() }, [loadTreemap])

  const toggleEmail = useCallback((email: string) => {
    setSelectedEmails(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedEmails(new Set(authors.map(a => a.email)))
  }, [authors])

  const clearAll = useCallback(() => {
    setSelectedEmails(new Set())
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
      background: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* Toolbar */}
      <div style={{
        height: TOOLBAR_H, background: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12,
        flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}>
        <span style={{
          fontSize: 15, fontWeight: 800, color: '#3b82f6',
          letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          🗺 GitMap
        </span>
        <div style={{ width: 1, height: 22, background: '#e2e8f0' }} />

        <select
          value={activeRepo?.repo_id ?? ''}
          onChange={e => {
            const repo = repos.find(r => r.repo_id === e.target.value) ?? null
            if (repo) localStorage.setItem(ACTIVE_REPO_KEY, repo.repo_id)
            setActiveRepo(repo)
          }}
          style={{
            background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
            color: '#334155', padding: '5px 10px', fontSize: 12,
            cursor: 'pointer', outline: 'none',
          }}
        >
          {repos.map(r => (
            <option key={r.repo_id} value={r.repo_id}>
              {r.name} · {r.commit_count} commits · {r.author_count} 人
            </option>
          ))}
        </select>

        {/* Switchboard: Active / LoC */}
        <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 7, padding: 2, gap: 0 }}>
          {(['active', 'loc'] as MapMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMapMode(m)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                border: 'none', borderRadius: 5, cursor: 'pointer', transition: 'all 0.12s',
                background: mapMode === m ? '#ffffff' : 'transparent',
                color: mapMode === m ? '#2563eb' : '#64748b',
                boxShadow: mapMode === m ? '0 1px 3px rgba(0,0,0,0.10)' : 'none',
              }}
            >
              {m === 'active' ? 'Active' : 'LoC'}
            </button>
          ))}
        </div>

        {loading && (
          <span style={{
            fontSize: 11, color: '#94a3b8', marginLeft: 4,
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <Spinner /> 构建地图中...
          </span>
        )}

        {activeRepo && !loading && treemap && (
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
            {selectedEmails.size > 0
              ? `聚焦 ${selectedEmails.size} 位贡献者`
              : `${authors.length} 位贡献者`}
          </span>
        )}
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <PersonFilter
          authors={authors}
          selected={selectedEmails}
          onToggle={toggleEmail}
          onSelectAll={selectAll}
          onClearAll={clearAll}
          onOpenProfile={setProfileEmail}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {treemap ? (
              <TreeMap
                data={treemap}
                highlightEmails={selectedEmails}
                width={mapW}
                height={mapH}
                mode={mapMode}
                depth={treeDepth}
                onDepthChange={setTreeDepth}
              />
            ) : (
              <div style={{
                width: mapW, height: mapH,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#94a3b8', fontSize: 13,
              }}>
                {loading ? '正在构建地图...' : '等待数据'}
              </div>
            )}
          </div>
          <Timeline timeline={timeline} value={timeRange} onChange={setTimeRange} />
        </div>
      </div>

      {profileEmail && activeRepo && (
        <AuthorPanel
          repoId={activeRepo.repo_id}
          email={profileEmail}
          onClose={() => setProfileEmail(null)}
        />
      )}
    </div>
  )
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10,
      border: '2px solid #e2e8f0', borderTopColor: '#3b82f6',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  )
}

function monthToTs(month: string): number {
  return Math.floor(new Date(month + '-01').getTime() / 1000)
}
