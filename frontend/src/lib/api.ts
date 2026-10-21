// API types and fetching layer

import { isStaticMode, fetchReposStatic, fetchAuthorsStatic, fetchTreemapStatic, fetchTimelineStatic } from './staticData'

export interface Repo {
  repo_id: string
  name: string
  path: string
  commit_count: number
  author_count: number
  indexed_at: number
}

export interface Author {
  email: string
  name: string
  username: string
  commit_count: number
}

export interface OwnerInfo {
  email: string
  name: string
  username: string
  churn: number
  touches: number
  pct: number
  highlighted: boolean
}

export type MapMode = 'active' | 'loc'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  total_churn: number
  total_loc: number
  owners: OwnerInfo[]
  children: TreeNode[]
}

export interface TimelinePoint {
  month: string
  total: number
  by_author: Record<string, number>
}

const BASE = '/api'

export async function fetchRepos(): Promise<Repo[]> {
  if (isStaticMode()) return fetchReposStatic()
  const res = await fetch(`${BASE}/repos`)
  return res.json()
}

export async function fetchAuthors(repoId: string): Promise<Author[]> {
  if (isStaticMode()) return fetchAuthorsStatic(repoId)
  const res = await fetch(`${BASE}/authors?repo_id=${repoId}`)
  return res.json()
}

export async function fetchTreemap(
  repoId: string,
  tsFrom: number,
  tsTo: number,
  emails: string[],
  depth = 3,
  mode: MapMode = 'active'
): Promise<TreeNode> {
  if (isStaticMode()) return fetchTreemapStatic(repoId, tsFrom, tsTo, emails, depth, mode)
  const params = new URLSearchParams({
    repo_id: repoId,
    ts_from: String(Math.floor(tsFrom)),
    ts_to: String(Math.floor(tsTo)),
    emails: emails.join(','),
    depth: String(depth),
    mode,
  })
  const res = await fetch(`${BASE}/treemap?${params}`)
  return res.json()
}

export async function fetchTimeline(
  repoId: string,
  emails: string[]
): Promise<TimelinePoint[]> {
  if (isStaticMode()) return fetchTimelineStatic(repoId, emails)
  const params = new URLSearchParams({
    repo_id: repoId,
    emails: emails.join(','),
  })
  const res = await fetch(`${BASE}/timeline?${params}`)
  return res.json()
}

export async function fetchIslandRisk(repoId: string) {
  const res = await fetch(`${BASE}/island_risk?repo_id=${repoId}`)
  return res.json()
}
