// staticData.ts — 无后端静态 demo 模式的数据引擎
//
// 构建 demo 时（VITE_STATIC_MODE=true），api.ts 会把所有数据请求代理到这里。
// 数据来源是 `visualrepo export` 产出的一组静态 JSON（见 export_snapshot.py），
// 在浏览器端按时间窗口 / 作者筛选 / Active|LoC 模式重新聚合出 treemap，
// 不需要任何后端查询。

import type { Author, Repo, TimelinePoint, TreeNode, OwnerInfo, MapMode } from './api'

const DATA_BASE = import.meta.env.BASE_URL + 'data'

interface Snapshot {
  meta: {
    repo_id: string
    name: string
    indexed_at: number
    sampled: boolean
    real_totals: { commits: number; authors: number; files: number }
    sample_sizes: { files: number; authors: number; profiles: number }
  }
  authors: Author[]
  files: string[]
  months: string[]
  // [file_idx, author_idx, month_idx, churn, touches]
  cells: [number, number, number, number, number][]
  // [file_idx, month_idx, net_loc]
  locCells: [number, number, number][]
  timeline: TimelinePoint[]
  profiles: Record<string, any>
}

let loaded: Promise<Snapshot> | null = null

async function load(): Promise<Snapshot> {
  if (!loaded) {
    loaded = (async () => {
      const [meta, authors, files, months, cells, locCells, timeline, profiles] = await Promise.all([
        fetchJson(`${DATA_BASE}/meta.json`),
        fetchJson(`${DATA_BASE}/authors.json`),
        fetchJson(`${DATA_BASE}/files.json`),
        fetchJson(`${DATA_BASE}/months.json`),
        fetchJson(`${DATA_BASE}/cells.json`),
        fetchJson(`${DATA_BASE}/loc_cells.json`),
        fetchJson(`${DATA_BASE}/timeline.json`),
        fetchJson(`${DATA_BASE}/profiles.json`),
      ])
      return { meta, authors, files, months, cells, locCells, timeline, profiles }
    })()
  }
  return loaded
}

async function fetchJson(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`static data fetch failed: ${url} (${res.status})`)
  return res.json()
}

export function isStaticMode(): boolean {
  return import.meta.env.VITE_STATIC_MODE === 'true'
}

export async function fetchReposStatic(): Promise<Repo[]> {
  const snap = await load()
  return [
    {
      repo_id: snap.meta.repo_id,
      name: snap.meta.name,
      path: `(static demo · 采样自 ${snap.meta.sample_sizes.files}/${snap.meta.real_totals.files} 文件、` +
        `${snap.meta.sample_sizes.authors}/${snap.meta.real_totals.authors} 位作者)`,
      commit_count: snap.meta.real_totals.commits,
      author_count: snap.meta.real_totals.authors,
      indexed_at: snap.meta.indexed_at,
    },
  ]
}

export async function fetchAuthorsStatic(_repoId: string): Promise<Author[]> {
  const snap = await load()
  return snap.authors
}

export async function fetchTimelineStatic(_repoId: string, _emails: string[]): Promise<TimelinePoint[]> {
  const snap = await load()
  return snap.timeline
}

export async function fetchAuthorProfileStatic(_repoId: string, email: string): Promise<any | null> {
  const snap = await load()
  return snap.profiles[email] ?? null
}

function monthToTs(month: string): number {
  return Math.floor(new Date(month + '-01T00:00:00Z').getTime() / 1000)
}

export async function fetchTreemapStatic(
  _repoId: string,
  tsFrom: number,
  tsTo: number,
  emails: string[],
  _depth: number,
  mode: MapMode,
): Promise<TreeNode> {
  const snap = await load()
  const highlightSet = new Set(emails)
  const filterSet = emails.length > 0 ? new Set(emails) : null

  const monthInRange = snap.months.map(m => {
    const ts = monthToTs(m)
    return ts >= tsFrom && ts <= tsTo
  })

  // 文件级聚合：churn（窗口内）+ 各作者占比
  interface FileAgg { totalChurn: number; owners: Map<number, { churn: number; touches: number }> }
  const fileAgg = new Map<number, FileAgg>()

  for (const [fileIdx, authorIdx, monthIdx, churn, touches] of snap.cells) {
    if (!monthInRange[monthIdx]) continue
    const email = snap.authors[authorIdx]?.email
    if (filterSet && (!email || !filterSet.has(email))) continue
    let agg = fileAgg.get(fileIdx)
    if (!agg) { agg = { totalChurn: 0, owners: new Map() }; fileAgg.set(fileIdx, agg) }
    agg.totalChurn += churn
    const o = agg.owners.get(authorIdx) ?? { churn: 0, touches: 0 }
    o.churn += churn
    o.touches += touches
    agg.owners.set(authorIdx, o)
  }

  // LoC 模式：ts_to 之前的累计净行数（不分作者，不受 emails 筛选影响，与后端一致）
  const locByFile = new Map<number, number>()
  if (mode === 'loc') {
    for (const [fileIdx, monthIdx, net] of snap.locCells) {
      const ts = monthToTs(snap.months[monthIdx])
      if (ts > tsTo) continue
      locByFile.set(fileIdx, (locByFile.get(fileIdx) ?? 0) + net)
    }
  }

  const fileNodes: { path: string; total_churn: number; total_loc: number; owners: OwnerInfo[] }[] = []
  const seen = new Set<number>()

  for (const [fileIdx, agg] of fileAgg) {
    seen.add(fileIdx)
    const owners: OwnerInfo[] = [...agg.owners.entries()]
      .map(([authorIdx, o]) => {
        const a = snap.authors[authorIdx]
        return {
          email: a.email, name: a.name, username: a.username,
          churn: o.churn, touches: o.touches,
          pct: agg.totalChurn > 0 ? Math.round((o.churn / agg.totalChurn) * 1000) / 10 : 0,
          highlighted: highlightSet.has(a.email),
        }
      })
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 5)
    const loc = locByFile.get(fileIdx) ?? 0
    fileNodes.push({
      path: snap.files[fileIdx],
      total_churn: agg.totalChurn,
      total_loc: Math.max(loc, 0),
      owners,
    })
  }

  if (mode === 'loc') {
    for (const [fileIdx, loc] of locByFile) {
      if (seen.has(fileIdx) || loc <= 0) continue
      fileNodes.push({ path: snap.files[fileIdx], total_churn: 0, total_loc: loc, owners: [] })
    }
  }

  return buildTree(fileNodes, mode)
}

function buildTree(
  files: { path: string; total_churn: number; total_loc: number; owners: OwnerInfo[] }[],
  mode: MapMode,
): TreeNode {
  interface MutNode {
    name: string; path: string; type: 'file' | 'dir'
    total_churn: number; total_loc: number
    owners: OwnerInfo[]
    ownerMerge: Map<string, OwnerInfo>
    children: Map<string, MutNode>
  }
  const root: MutNode = {
    name: 'root', path: '', type: 'dir',
    total_churn: 0, total_loc: 0, owners: [], ownerMerge: new Map(), children: new Map(),
  }

  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLeaf = i === parts.length - 1
      if (isLeaf) {
        node.children.set(part, {
          name: part, path: f.path, type: 'file',
          total_churn: f.total_churn, total_loc: f.total_loc,
          owners: f.owners, ownerMerge: new Map(), children: new Map(),
        })
      } else {
        let child = node.children.get(part)
        if (!child) {
          const dirPath = parts.slice(0, i + 1).join('/')
          child = {
            name: part, path: dirPath, type: 'dir',
            total_churn: 0, total_loc: 0, owners: [], ownerMerge: new Map(), children: new Map(),
          }
          node.children.set(part, child)
        }
        child.total_churn += f.total_churn
        child.total_loc += f.total_loc
        node = child
      }
    }
  }

  aggregateOwners(root)
  return serialize(root, mode)

  function aggregateOwners(node: MutNode): void {
    if (node.children.size === 0) return
    for (const child of node.children.values()) aggregateOwners(child)
    if (node.type === 'file') return

    const merged = new Map<string, OwnerInfo>()
    for (const child of node.children.values()) {
      for (const o of child.owners) {
        const existing = merged.get(o.email)
        if (existing) existing.churn += o.churn
        else merged.set(o.email, { ...o })
      }
    }
    if (merged.size === 0) return
    const total = [...merged.values()].reduce((s, o) => s + o.churn, 0) || 1
    const list = [...merged.values()].sort((a, b) => b.churn - a.churn).slice(0, 5)
    for (const o of list) {
      o.pct = Math.round((o.churn / total) * 1000) / 10
      o.highlighted = false
    }
    node.owners = list
  }

  function serialize(node: MutNode, mode: MapMode): TreeNode {
    const sortKey = mode === 'loc' ? 'total_loc' : 'total_churn'
    const children = [...node.children.values()].sort((a, b) => b[sortKey] - a[sortKey])
    return {
      name: node.name,
      path: node.path,
      type: node.type,
      total_churn: node.total_churn,
      total_loc: node.total_loc,
      owners: node.owners,
      children: children.map(c => serialize(c, mode)),
    }
  }
}
