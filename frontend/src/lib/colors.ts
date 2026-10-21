// Color palette for contributors — high-contrast on dark background
// Deterministic: same email always gets same color

const PALETTE = [
  '#58a6ff', '#3fb950', '#f78166', '#d2a8ff', '#ffa657',
  '#79c0ff', '#56d364', '#ff7b72', '#bc8cff', '#ffc680',
  '#1f6feb', '#238636', '#da3633', '#8957e5', '#d29922',
  '#388bfd', '#2ea043', '#f85149', '#a371f7', '#e3b341',
]

const cache = new Map<string, string>()

export function authorColor(email: string): string {
  if (cache.has(email)) return cache.get(email)!
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0
  }
  const color = PALETTE[hash % PALETTE.length]
  cache.set(email, color)
  return color
}

/** Generate initials avatar fallback color (same hash, different shade) */
export function avatarFallbackColor(email: string): string {
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 17 + email.charCodeAt(i)) >>> 0
  }
  const hue = hash % 360
  return `hsl(${hue}, 65%, 55%)`
}

/** Get initials from name */
export function getInitials(name: string | undefined | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function formatChurn(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
