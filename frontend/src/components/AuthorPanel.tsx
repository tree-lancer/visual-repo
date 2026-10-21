import { useEffect, useState } from 'react'
import { authorColor, avatarFallbackColor, getInitials, formatChurn, formatTs } from '../lib/colors'
import { isStaticMode, fetchAuthorProfileStatic } from '../lib/staticData'

interface ModuleStat {
  name: string; churn: number; touches: number; pct: number
}
interface CollabPartner {
  email: string; name: string; username: string
  shared_files: number; overlap_pct: number
}
interface AuthorProfileData {
  email: string; name: string; username: string
  first_commit_ts: number; last_commit_ts: number
  active_months: number; total_months: number; consistency_score: number
  total_commits: number; total_churn: number; avg_churn_per_commit: number
  total_files_touched: number; solo_owned_files: number
  module_count: number; concentration: number
  bridge_commit_count: number; bridge_ratio: number
  most_bridged_modules: string[]
  top_modules: ModuleStat[]
  collab_partners: CollabPartner[]
  recent_messages: string[]
  role_tags: string[]
}

interface Props {
  repoId: string
  email: string
  onClose: () => void
}

export function AuthorPanel({ repoId, email, onClose }: Props) {
  const [profile, setProfile] = useState<AuthorProfileData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setProfile(null)
    const req = isStaticMode()
      ? fetchAuthorProfileStatic(repoId, email)
      : fetch(`/api/author_profile?repo_id=${repoId}&email=${encodeURIComponent(email)}`)
          .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
    req.then(d => { setProfile(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [repoId, email])

  const color = (profile?.email) ? authorColor(profile.email) : '#3b82f6'

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 400,
      background: '#ffffff', borderLeft: '1px solid #e2e8f0',
      display: 'flex', flexDirection: 'column',
      zIndex: 200, boxShadow: '-6px 0 30px rgba(0,0,0,0.1)',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px', borderBottom: '1px solid #f1f5f9',
        display: 'flex', alignItems: 'center', gap: 12,
        background: `linear-gradient(135deg, ${color}10, transparent)`,
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
          border: `2.5px solid ${color}`, boxShadow: `0 0 0 3px ${color}22`,
        }}>
          {profile ? (
            <div style={{
              width: 52, height: 52, background: avatarFallbackColor(email),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 700, color: '#fff',
            }}>{getInitials(profile.name)}</div>
          ) : (
            <div style={{ width: 52, height: 52, background: '#f1f5f9' }} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
            {profile?.name ?? email}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{email}</div>
        </div>
        <button onClick={onClose} style={{
          background: '#f8fafc', border: '1px solid #e2e8f0',
          borderRadius: 6, color: '#64748b',
          cursor: 'pointer', fontSize: 14, padding: '4px 8px', lineHeight: 1,
        }}>✕</button>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
          加载中...
        </div>
      ) : !profile ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', padding: '0 24px', textAlign: 'center' }}>
          {isStaticMode() ? 'Demo 仅预渲染了 Top 贡献者的完整画像' : '数据加载失败'}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 20px' }}>

          {/* Role tags — fun badge system, no summary text */}
          <div style={{ padding: '14px 16px 0' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {profile.role_tags.map(tag => (
                <RoleTagBadge key={tag} tag={tag} color={color} profile={profile} />
              ))}
            </div>
          </div>

          {/* Stats grid */}
          <div style={{ padding: '12px 16px 0' }}>
            <SectionTitle>关键数据</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <StatCard label="总 Commits"   value={String(profile.total_commits)}                       color={color} />
              <StatCard label="代码变动量"   value={formatChurn(profile.total_churn)}                    color={color} />
              <StatCard label="触及文件数"   value={String(profile.total_files_touched)}                 color={color} />
              <StatCard label="独占文件数"   value={String(profile.solo_owned_files)}                    color={color} />
              <StatCard label="活跃月份"     value={`${profile.active_months} 月`}                      color={color} />
              <StatCard label="持续稳定性"   value={`${(profile.consistency_score * 100).toFixed(0)}%`}  color={color} />
            </div>
          </div>

          {/* Module distribution */}
          <div style={{ padding: '14px 16px 0' }}>
            <SectionTitle>模块分布</SectionTitle>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {profile.top_modules.map(m => (
                <ModuleBar key={m.name} mod={m} color={color} />
              ))}
            </div>
          </div>

          {/* Bridge info */}
          {profile.bridge_commit_count > 0 && (
            <div style={{ padding: '14px 16px 0' }}>
              <SectionTitle>跨模块胶水工作</SectionTitle>
              <div style={{
                marginTop: 6, padding: '10px 12px',
                background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
              }}>
                <div style={{ fontSize: 12, color: '#475569' }}>
                  <span style={{ color: '#1e293b', fontWeight: 700 }}>{profile.bridge_commit_count}</span> 次 commit 跨越多个模块
                  （占 <span style={{ color: color, fontWeight: 600 }}>{(profile.bridge_ratio * 100).toFixed(0)}%</span>）
                </div>
                {profile.most_bridged_modules.length > 0 && (
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 5 }}>
                    常见桥接：{profile.most_bridged_modules.join(' ↔ ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Collab partners */}
          {profile.collab_partners.length > 0 && (
            <div style={{ padding: '14px 16px 0' }}>
              <SectionTitle>主要协作伙伴</SectionTitle>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {profile.collab_partners.map(p => <CollabRow key={p.email} partner={p} />)}
              </div>
            </div>
          )}

          {/* Activity time */}
          <div style={{ padding: '14px 16px 0' }}>
            <SectionTitle>活跃时间</SectionTitle>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 5 }}>
              {formatTs(profile.first_commit_ts)} — {formatTs(profile.last_commit_ts)}
            </div>
          </div>

          {/* AI Analysis — Agent引导（静态 demo 没有本地后端可供 Agent 调用，隐藏） */}
          {!isStaticMode() && (
          <div style={{ padding: '14px 16px 0' }}>
            <SectionTitle>AI 深度画像</SectionTitle>
            <div style={{
              marginTop: 8, padding: '12px 14px',
              background: 'linear-gradient(135deg, #eff6ff, #f8fafc)',
              border: '1px solid #bfdbfe', borderRadius: 10,
              fontSize: 12, color: '#334155', lineHeight: 1.7,
            }}>
              <div style={{ fontWeight: 600, color: '#1d4ed8', marginBottom: 6, fontSize: 13 }}>
                🤖 在 AI Agent 中分析
              </div>
              <div style={{ color: '#475569', marginBottom: 10 }}>
                复制下方指令，粘贴到你的 AI Agent 对话框，即可获得基于 Git 数据的 AI 深度画像：
              </div>
              <AgentPromptBox
                email={profile.email}
                repoId={repoId}
                name={profile.name}
              />
            </div>
          </div>
          )}

          {/* Recent commits */}
          <div style={{ padding: '14px 16px 0' }}>
            <SectionTitle>近期 Commit</SectionTitle>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {profile.recent_messages.slice(0, 8).map((msg, i) => (
                <div key={i} style={{
                  fontSize: 11, color: '#64748b', padding: '5px 8px',
                  background: '#f8fafc', borderRadius: 5, border: '1px solid #f1f5f9',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={msg}>
                  <span style={{ color: '#cbd5e1', marginRight: 6 }}>·</span>{msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Agent Prompt Box ─────────────────────────────────────────────────────────
function AgentPromptBox({ email, repoId, name }: { email: string; repoId: string; name: string }) {
  const [copied, setCopied] = useState(false)
  const prompt =
    `请调用 GitMap 的 /api/author_context 接口分析工程师 ${name} 的 Git 行为画像。\n` +
    `\n接口：GET http://localhost:7842/api/author_context?repo_id=${repoId}&email=${encodeURIComponent(email)}\n` +
    `\n请基于返回的结构化数据，从以下三个角度做深度分析：\n` +
    `1. 角色定位：这个人在团队中扮演什么角色？\n` +
    `2. 工作特征：提交风格、技术偏好、有哪些值得关注的模式？\n` +
    `3. 潜在风险与洞察：知识孤岛风险、过度依赖、或跨领域架构视野？\n` +
    `\n每个判断都需要有数据支撑，语气专业客观。`

  function copy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        background: '#f1f5f9', borderRadius: 6, padding: '8px 36px 8px 10px',
        fontSize: 11, color: '#475569', lineHeight: 1.6,
        fontFamily: 'monospace', whiteSpace: 'pre-wrap',
        maxHeight: 130, overflowY: 'auto',
        border: '1px solid #e2e8f0',
        userSelect: 'text',
      }}>
        {prompt}
      </div>
      <button
        onClick={copy}
        style={{
          position: 'absolute', top: 6, right: 6,
          padding: '3px 9px', fontSize: 10,
          background: copied ? '#dcfce7' : '#ffffff',
          border: `1px solid ${copied ? '#86efac' : '#e2e8f0'}`,
          borderRadius: 4, color: copied ? '#16a34a' : '#64748b',
          cursor: 'pointer', transition: 'all 0.15s', fontWeight: 600,
        }}
      >
        {copied ? '✓ 已复制' : '复制'}
      </button>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: '#94a3b8',
      textTransform: 'uppercase', letterSpacing: '0.07em',
    }}>
      {children}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#f8fafc', borderRadius: 8, padding: '8px 10px',
      border: '1px solid #f1f5f9',
    }}>
      <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function ModuleBar({ mod, color }: { mod: ModuleStat; color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#334155', fontWeight: 500 }}>{mod.name}</span>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>{mod.pct}%  ·  {formatChurn(mod.churn)} 行</span>
      </div>
      <div style={{ height: 5, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${mod.pct}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  )
}

function CollabRow({ partner }: { partner: CollabPartner }) {
  const color = authorColor(partner.email)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
        border: `1.5px solid ${color}`,
      }}>
        <div style={{
          width: 26, height: 26, background: avatarFallbackColor(partner.email),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 700, color: '#fff',
        }}>{getInitials(partner.name)}</div>
      </div>
      <div style={{ flex: 1 }}>
        <span style={{ fontSize: 11, color: '#1e293b', fontWeight: 500 }}>{partner.name}</span>
        <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 6 }}>
          共同修改 {partner.shared_files} 个文件
        </span>
      </div>
    </div>
  )
}

// ─── Role Tag Tooltip ─────────────────────────────────────────────────────────

const TAG_REASONS: Record<string, (p: AuthorProfileData) => string> = {
  '🏆 贡献 MVP':    p => `提交数在仓库中排名第 1（共 ${p.total_commits} 次 commit）`,
  '🥇 Top 贡献者': p => `提交数排名前 3（共 ${p.total_commits} 次 commit）`,
  '⭐ 活跃核心':    p => `提交数排名前 10（共 ${p.total_commits} 次 commit）`,
  '🏰 领域守护者': p => `最高浓度模块占比 ${(p.concentration * 100).toFixed(0)}%，仅涉及 ${p.module_count} 个顶层模块`,
  '🌐 全栈游侠':    p => `触及 ${p.module_count} 个顶层模块，无单一主导领域`,
  '🌉 胶水大王':    p => `${(p.bridge_ratio * 100).toFixed(0)}% 的 commit 跨越多个模块（共 ${p.bridge_commit_count} 次）`,
  '🔗 模块摆渡人': p => `${(p.bridge_ratio * 100).toFixed(0)}% 的 commit 跨越多个模块（共 ${p.bridge_commit_count} 次）`,
  '👑 代码领主':    p => `独占 ${p.solo_owned_files} 个文件（占触及文件 ${(p.solo_owned_files / Math.max(1, p.total_files_touched) * 100).toFixed(0)}%）`,
  '🗺 独立王国':    p => `独占 ${p.solo_owned_files} 个文件`,
  '🚀 大刀阔斧':    p => `平均每次 commit 变动 ${p.avg_churn_per_commit.toFixed(0)} 行`,
  '⚡ 雷厉风行':    p => `平均每次 commit 变动 ${p.avg_churn_per_commit.toFixed(0)} 行`,
  '🔬 精雕细琢':    p => `平均每次 commit 仅变动 ${p.avg_churn_per_commit.toFixed(0)} 行`,
  '🐛 Fix 之神':    _p => `commit 信息中 fix 类关键词占比极高`,
  '🔧 救火队员':    _p => `commit 信息中含大量 fix/bug/hotfix 关键词`,
  '🌱 功能先锋':    _p => `commit 信息中 feat/add/新增 类关键词占主导`,
  '✨ 代码洁癖':    _p => `commit 信息中 refactor/clean/整理 占比 ≥25%`,
  '📅 常青贡献者': p => `${p.active_months} 个月持续活跃，稳定性 ${(p.consistency_score * 100).toFixed(0)}%`,
  '🌊 集中冲刺型': p => `集中在少数时间段爆发提交，稳定性 ${(p.consistency_score * 100).toFixed(0)}%`,
  '🦉 熬夜能手':    _p => `大量 commit 发生在 22:00–05:00`,
  '🐓 早起打工人': _p => `大量 commit 发生在 05:00–09:00`,
  '🔧 稳定贡献者': p => `持续贡献，共 ${p.total_commits} 次 commit`,
}

function RoleTagBadge({ tag, color, profile }: { tag: string; color: string; profile: AuthorProfileData }) {
  const [show, setShow] = useState(false)
  const reason = TAG_REASONS[tag]?.(profile) ?? ''

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{
        display: 'inline-block',
        padding: '5px 11px', borderRadius: 20,
        background: `${color}18`, border: `1px solid ${color}50`,
        fontSize: 12, color, fontWeight: 600,
        letterSpacing: '0.01em', cursor: 'default',
      }}>{tag}</span>
      {show && reason && (
        <div style={{
          position: 'absolute', top: '110%', left: '50%',
          transform: 'translateX(-50%)',
          background: '#f8fafc',
          border: `1px solid ${color}60`,
          color: '#334155',
          fontSize: 11, lineHeight: 1.5,
          padding: '6px 10px', borderRadius: 7,
          whiteSpace: 'nowrap', zIndex: 9999,
          boxShadow: '0 3px 10px rgba(0,0,0,0.10)',
          pointerEvents: 'none',
        }}>
          {reason}
          <div style={{
            position: 'absolute', bottom: '100%', left: '50%',
            transform: 'translateX(-50%)',
            border: '5px solid transparent',
            borderBottomColor: color,
          }} />
        </div>
      )}
    </div>
  )
}
