import React, { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom'
import { auth, useSession, useMatrix, ROLE_LABEL, type PermKey } from './engine/auth'
import { useExceptions } from './engine/exceptions'
import { useUnread } from './engine/ops'
import { liveAlertStore, startLiveAlertPoll, useLiveAlertBadge, useLiveAlerts } from './engine/liveAlerts'
import { THEMES, setTheme, useTheme } from './engine/ui'
import { telemetryStore } from './engine/telemetry'
import { useDbStatus } from './engine/db'
import './engine/alerts'

/* ---------- icons ---------- */
const I = (d: string) => (
  <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {d.split('|').map((p, i) => <path key={i} d={p} />)}
  </svg>
)
const ICONS: Record<string, string> = {
  overview: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
  compute: 'M9 3v3|M15 3v3|M9 18v3|M15 18v3|M3 9h3|M3 15h3|M18 9h3|M18 15h3|M7 7h10v10H7z|M11 11h2v2h-2z',
  schedule: 'M4 7h16|M4 12h10|M4 17h13|M18 15l3 2-3 2',
  storage: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z|M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6|M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6',
  assets: 'M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z|M12 11l8-4.5|M12 11L4 6.5|M12 11v11',
  gateway: 'M5 6a2 2 0 104 0 2 2 0 00-4 0z|M15 18a2 2 0 104 0 2 2 0 00-4 0z|M5 18a2 2 0 104 0 2 2 0 00-4 0z|M9 6h6a4 4 0 014 4v2|M13 18H7a4 4 0 01-4-4v-2',
  credential: 'M14 11l-2 2|M11 8l1.5 1.5|M8.5 11.5L10 13|M21 3l-9.6 9.6|M15.5 7.5L18 10l3-3a3.18 3.18 0 010 4.5l-1.5 1.5a3.18 3.18 0 01-4.5 0L9.5 8a3.18 3.18 0 010-4.5L11 2a3.18 3.18 0 014.5 0z',
  fineTune: 'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M2 14h4|M10 8h4|M18 16h4',
  trace: 'M3 12h4l3-7 4 14 3-7h4',
  security: 'M12 2l8 3.5v5.2c0 5-3.4 9.6-8 11.3-4.6-1.7-8-6.3-8-11.3V5.5L12 2z|M9 12l2 2 4-4',
  market: 'M4 9h16l-1.5 11.5a2 2 0 01-2 1.5h-9a2 2 0 01-2-1.5L4 9z|M8 9V7a4 4 0 018 0v2',
  agents: 'M12 3v3|M8 6h8a2 2 0 012 2v11a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2z|M9 12h.01|M15 12h.01|M9.5 15.5c.8.6 1.7 1 2.5 1s1.7-.4 2.5-1',
  kb: 'M5 3h11a3 3 0 013 3v15H8a3 3 0 01-3-3V3z|M19 8H8a3 3 0 00-3 3|M12 11h6|M12 15h4',
  tools: 'M14.7 6.3a4.5 4.5 0 00-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 005.6-6L14.5 12 12 9.5l2.7-3.2z',
  accounts: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7z|M2.5 21c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5|M16 4.5a3.5 3.5 0 010 7|M17.5 14.7c2.4.6 4 2.9 4 5.8',
  analytics: 'M4 20V10|M10 20V4|M16 20v-7|M22 20H2',
  clock: 'M12 3a9 9 0 109 9|M12 7v5l3 2',
  bell: 'M18 8A6 6 0 006 8c0 7-3 8-3 8h18s-3-1-3-8|M10.3 21a2 2 0 003.4 0',
  alert: 'M12 3.5l9 16H3l9-16z|M12 10v4.5|M12 17.5v.5',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7|M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  screen: 'M3 5h18v11H3z|M8 20h8|M12 16v4',
}

/* ---------- nav config ---------- */
const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  { group: '总览', items: [{ to: '/', label: '运营总览', icon: 'overview' }, { to: '/account', label: '账号与安全', icon: 'accounts' }, { to: '/govern', label: '统一接管范围', icon: 'compute' }, { to: '/briefing', label: '投屏汇报首页', icon: 'screen' }, { to: '/network', label: '部署形态与网络分区', icon: 'compute' }] },
  {
    group: '算力中心',
    items: [
      { to: '/compute/overview', label: '算力资源总览', icon: 'compute' },
      { to: '/compute/schedule', label: '资源池与调度', icon: 'schedule' },
      { to: '/compute/storage', label: '存储与网络', icon: 'storage' },
      { to: '/compute/exceptions', label: '例外监控与阻断', icon: 'alert' },
      { to: '/compute/cards', label: '算力卡监控（昇腾）', icon: 'compute' },
    ],
  },
  {
    group: '模型中心',
    items: [
      { to: '/model/deploy', label: '模型部署与发布', icon: 'assets' },
      { to: '/model/assets', label: '模型资产管理', icon: 'assets' },
      { to: '/model/monitor', label: '推理服务监控', icon: 'gateway' },
      { to: '/model/gateway', label: '推理网关', icon: 'gateway' },
      { to: '/model/litellm', label: 'LiteLLM 网关仪表', icon: 'gateway' },
      { to: '/model/engine', label: '推理引擎指标', icon: 'gateway' },
      { to: '/model/credentials', label: '凭证与配额', icon: 'credential' },
      { to: '/model/personal', label: '个人模型中心', icon: 'credential' },
      { to: '/model/fineTune', label: '微调训练', icon: 'fineTune' },
      { to: '/model/trace', label: '调用溯源', icon: 'trace' },
      { to: '/model/audit', label: '调用审计检索', icon: 'trace' },
      { to: '/model/security', label: '安全检测', icon: 'security' },
      { to: '/model/safety-flow', label: '安全检测流程（接口留位）', icon: 'security' },
    ],
  },
  {
    group: '应用中心',
    items: [
      { to: '/app/market', label: '应用广场', icon: 'market' },
      { to: '/app/agents', label: '智能体纳管', icon: 'agents' },
      { to: '/app/kb', label: '知识库纳管', icon: 'kb' },
      { to: '/app/tools', label: '工具生态', icon: 'tools' },
      { to: '/app/templates', label: '运营模板库', icon: 'kb' },
      { to: '/app/security', label: '安全事件', icon: 'security' },
      { to: '/app/dify', label: 'Dify / RAGFlow 纳管', icon: 'link' },
      { to: '/app/accounts', label: '跨平台运营', icon: 'accounts' },
    ],
  },
  { group: '运营分析', items: [{ to: '/ops/workflow', label: '资源调配工作台', icon: 'schedule' }, { to: '/ops/alert-rules', label: '告警规则管理', icon: 'alert' }, { to: '/ops/analytics', label: '运营分析报表', icon: 'analytics' }, { to: '/ops/records', label: '台账与审计（查库）', icon: 'trace' }, { to: '/ops/notifications', label: '通知中心', icon: 'bell' }, { to: '/ops/integrations', label: '外部对接清单', icon: 'link' }, { to: '/ops/apply', label: '申请与审批台', icon: 'accounts' }, { to: '/ops/settings', label: '配置中心（来源与派单）', icon: 'link' }, { to: '/ops/commands', label: '处置指令台（预检/下发/兜底）', icon: 'security' }] },
]

/** 路由 → 权限点（权限矩阵编辑后立即生效） */
const ROUTE_PERM: Record<string, PermKey> = {
  '/briefing': 'overview',
  '/network': 'overview',
  '/compute/exceptions': 'compute', '/compute/cards': 'compute',
  '/model/deploy': 'gateway', '/model/monitor': 'gateway', '/model/litellm': 'gateway',
  '/model/safety-flow': 'security', '/app/dify': 'app', '/ops/apply': 'workflow', '/ops/records': 'audit',
  '/govern': 'overview',
  '/': 'overview',
  '/compute/overview': 'compute', '/compute/schedule': 'compute', '/compute/storage': 'compute',
  '/model/assets': 'gateway', '/model/gateway': 'gateway', '/model/engine': 'gateway', '/model/credentials': 'cred',
  '/model/fineTune': 'cred', '/model/trace': 'audit', '/model/audit': 'audit', '/model/security': 'security',
  '/model/personal': 'personal',
  '/app/market': 'app', '/app/agents': 'agent', '/app/kb': 'kb', '/app/tools': 'tool', '/app/templates': 'app',
  '/app/security': 'security', '/app/accounts': 'matrix',
  '/ops/workflow': 'workflow', '/ops/alert-rules': 'analytics', '/ops/analytics': 'analytics', '/ops/notifications': 'overview', '/ops/integrations': 'integration',
  '/ops/settings': 'workflow', '/ops/commands': 'security',
}

const TITLES: Record<string, string> = {
  '/': '运营总览',
  '/briefing': '投屏汇报首页（16:9 · 5 页）',
  '/network': '部署形态与网络分区视图',
  '/compute/exceptions': '算力中心 · 例外监控与阻断',
  '/compute/cards': '算力中心 · 算力卡监控（昇腾）',
  '/model/deploy': '模型中心 · 模型部署与发布',
  '/model/monitor': '模型中心 · 推理服务监控',
  '/model/litellm': '模型中心 · LiteLLM 网关仪表',
  '/model/safety-flow': '模型中心 · 模型安全检测流程',
  '/app/dify': '应用中心 · Dify / RAGFlow 纳管',
  '/ops/apply': '运营分析 · 申请与审批台',
  '/ops/records': '运营分析 · 台账与审计（数据服务查询）',
  '/account': '账号与安全（口令 / 会话 / 演示账号开关）',
  '/ops/settings': '运营分析 · 配置中心（身份来源 / 审批来源 / 通知渠道 / 排班派单）',
  '/ops/commands': '运营分析 · 处置指令台（预检 / 下发 / 确认 / 回滚 / 人工兜底）',
  '/govern': '总览 · 统一接管范围',
  '/compute/overview': '算力中心 · 算力资源总览',
  '/compute/schedule': '算力中心 · 资源池与调度',
  '/compute/storage': '算力中心 · 存储与网络',
  '/model/assets': '模型中心 · 模型资产管理',
  '/model/gateway': '模型中心 · 推理网关',
  '/model/engine': '模型中心 · 推理引擎运行指标',
  '/model/credentials': '模型中心 · 凭证与配额',
  '/model/personal': '模型中心 · 个人模型中心',
  '/model/fineTune': '模型中心 · 微调训练',
  '/model/trace': '模型中心 · 调用溯源',
  '/model/audit': '模型中心 · 调用审计检索',
  '/model/security': '模型中心 · 安全检测',
  '/app/market': '应用中心 · 应用广场',
  '/app/agents': '应用中心 · 智能体纳管',
  '/app/kb': '应用中心 · 知识库纳管',
  '/app/tools': '应用中心 · 工具生态',
  '/app/templates': '应用中心 · 运营模板库',
  '/app/security': '应用中心 · 安全事件处置',
  '/app/accounts': '应用中心 · 跨平台运营与权限矩阵',
  '/ops/analytics': '运营分析 · 报表与成本',
  '/ops/workflow': '运营分析 · 资源调配工作台',
  '/ops/alert-rules': '运营分析 · 告警规则管理',
  '/ops/notifications': '运营分析 · 通知中心',
  '/ops/integrations': '运营分析 · 外部对接清单',
}

/** 内网版：读采集层落盘数据（collector 写 dist/data/*.json）；没有就回落平台推导 */
function useCollectorPoll() {
  useEffect(() => {
    telemetryStore.pull()
    const t = setInterval(() => telemetryStore.pull(), 30000)
    return () => clearInterval(t)
  }, [])
}

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

const P_OVERVIEW = React.lazy(() => import('./pages/overview'))
const P_C_OVERVIEW = React.lazy(() => import('./pages/compute/overview'))
const P_C_SCHEDULE = React.lazy(() => import('./pages/compute/schedule'))
const P_C_STORAGE = React.lazy(() => import('./pages/compute/storage'))
const P_M_ASSETS = React.lazy(() => import('./pages/model/assets'))
const P_M_GATEWAY = React.lazy(() => import('./pages/model/gateway'))
const P_M_ENGINE = React.lazy(() => import('./pages/model/engine'))
const P_M_CRED = React.lazy(() => import('./pages/model/credentials'))
const P_M_PERSONAL = React.lazy(() => import('./pages/model/personal'))
const P_M_FINE = React.lazy(() => import('./pages/model/fineTune'))
const P_M_TRACE = React.lazy(() => import('./pages/model/trace'))
const P_M_AUDIT = React.lazy(() => import('./pages/model/audit'))
const P_M_SEC = React.lazy(() => import('./pages/model/security'))
const P_A_MARKET = React.lazy(() => import('./pages/app/market'))
const P_A_AGENTS = React.lazy(() => import('./pages/app/agents'))
const P_A_KB = React.lazy(() => import('./pages/app/kb'))
const P_A_TOOLS = React.lazy(() => import('./pages/app/tools'))
const P_A_TEMPLATES = React.lazy(() => import('./pages/app/templates'))
const P_A_SEC = React.lazy(() => import('./pages/app/security'))
const P_A_ACCT = React.lazy(() => import('./pages/app/accounts'))
const P_OPS = React.lazy(() => import('./pages/ops/analytics'))
const P_OPS_WORKFLOW = React.lazy(() => import('./pages/ops/workflow'))
const P_OPS_ALERTS = React.lazy(() => import('./pages/ops/alertRules'))
const P_OPS_NOTIF = React.lazy(() => import('./pages/ops/notifications'))
const P_OPS_INT = React.lazy(() => import('./pages/ops/integrations'))
const P_LOGIN = React.lazy(() => import('./pages/login'))
const P_BRIEF = React.lazy(() => import('./pages/briefing'))
const P_NETWORK = React.lazy(() => import('./pages/network'))
const P_GOVERN = React.lazy(() => import('./pages/govern'))
const P_COMPUTE_EXC = React.lazy(() => import('./pages/compute/exceptions'))
const P_C_CARDS = React.lazy(() => import('./pages/compute/cards'))
const P_M_DEPLOY = React.lazy(() => import('./pages/model/deploy'))
const P_M_MONITOR = React.lazy(() => import('./pages/model/monitor'))
const P_M_LITELLM = React.lazy(() => import('./pages/model/litellm'))
const P_M_SAFETY = React.lazy(() => import('./pages/model/safetyFlow'))
const P_A_DIFY = React.lazy(() => import('./pages/app/dify'))
const P_OPS_APPLY = React.lazy(() => import('./pages/ops/apply'))
const P_OPS_RECORDS = React.lazy(() => import('./pages/ops/records'))
const P_ACCOUNT = React.lazy(() => import('./pages/account'))
const P_OPS_SETTINGS = React.lazy(() => import('./pages/ops/settings'))
const P_OPS_COMMANDS = React.lazy(() => import('./pages/ops/commands'))

function Shell() {
  const loc = useLocation()
  const nav = useNavigate()
  const now = useClock()
  useCollectorPoll()
  const time = now.toLocaleTimeString('zh-CN', { hour12: false })
  const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
  const acc = useSession()
  const matrix = useMatrix()
  const unread = useUnread()
  const theme = useTheme()
  const liveBadge = useLiveAlertBadge()
  const liveList = useLiveAlerts()
  useEffect(() => { startLiveAlertPoll(20) }, [])
  const excList = useExceptions()
  const excOpen = excList.filter((e) => e.status === '待分析' && e.severity !== '中').length
  const db = useDbStatus()
  const dbLabel = db.status === 'online' ? '数据已存库'
    : db.status === 'saving' ? '写入中 ' + db.pending
    : db.status === 'failed' ? '写入失败 · 重试中'
    : db.status === 'offline' ? '数据服务未连接 · 本次不保存'
    : '连接数据服务…'
  const dbBad = db.status === 'failed' || db.status === 'offline'

  if (!acc) return <P_LOGIN />

  const personalOnly = acc.role === 'dev' || acc.role === 'user'
  const allowed = (to: string) => personalOnly
    ? to === '/model/personal'
    : to === '/account' || matrix[acc.role].view.includes(ROUTE_PERM[to] ?? 'overview')
  if (personalOnly && loc.pathname !== '/model/personal') return <Navigate to="/model/personal" replace />
  const navGroups = NAV.map((g) => ({ ...g, items: g.items.filter((it) => allowed(it.to)) })).filter((g) => g.items.length > 0)
  const denied = !allowed(loc.pathname)
  const presentation = loc.pathname === '/briefing'

  return (
    <div className="layout">
      {presentation ? null : <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z" />
              <path d="M12 11l8-4.5M12 11L4 6.5M12 11v11" />
            </svg>
          </div>
          <div>
            <div className="brand-name">AI 运营管理平台</div>
            <div className="brand-sub">算力 · 模型 · 应用 一体化</div>
          </div>
        </div>
        <nav className="nav">
          {navGroups.map((g) => (
            <div key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((it) => (
                <div
                  key={it.to}
                  className={`nav-item ${loc.pathname === it.to ? 'active' : ''}`}
                  onClick={() => nav(it.to)}
                >
                  {I(ICONS[it.icon])}
                  <span>{it.label}</span>
                  {it.to === '/ops/notifications' && liveBadge > 0 ? <span className="tag red" style={{ marginLeft: 'auto' }}>{unread}</span> : null}
                  {it.to === '/compute/exceptions' && excOpen > 0 ? <span className="tag red" style={{ marginLeft: 'auto' }}>{excOpen}</span> : null}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          演示版本 v3.9（选型交流 · 内网可接真实数据 · 资源接入在系统里配 · 连不通会告警）
          <br />
          数据均为虚拟模拟 · 外部系统按清单虚拟接入
          <br />
          业务状态存数据服务（SQLite）· 登录与权限在服务端判定
          <br />
          {personalOnly ? '当前角色只开放个人模型中心' : '当前角色可见菜单已按权限矩阵过滤'}
        </div>
      </aside>}
      <div className="main-col">
        <header className="topbar">
          <div className="topbar-title">
            {TITLES[loc.pathname] ?? 'AI 运营管理平台'}
            <span className="net-badge">
              <span className="dot" />
              示例单位信息网 · 演示环境
            </span>
          </div>
          <div className="topbar-right">
            <span className="demo-badge">DEMO</span>
            <span
              className="mono"
              title={db.lastError ? '数据服务：' + db.lastError : '业务状态写入数据服务的数据库（SQLite），浏览器本地不保存'}
              style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 7, whiteSpace: 'nowrap',
                border: '1px solid ' + (dbBad ? 'rgba(var(--red-rgb), .45)' : 'rgba(var(--blue-rgb), .4)'),
                color: dbBad ? 'var(--bad-text)' : 'var(--link-text)',
                background: dbBad ? 'rgba(var(--red-rgb), .16)' : 'rgba(var(--blue-rgb), .14)',
              }}
            >
              {dbLabel}
            </span>
            <span className="row gap6" title="配色：五套可选，选择记在数据服务里，换电脑登录也是这套">
              <select className="btn sm" style={{ minWidth: 96 }} value={theme} aria-label="配色"
                onChange={(e) => setTheme(e.target.value)}>
                {THEMES.map((t) => <option key={t.id} value={t.id} title={t.note}>{t.name}</option>)}
              </select>
            </span>
            <span className="mono">{date}</span>
            <span className="mono" style={{ color: 'var(--brand-text)' }}>{time}</span>
            {personalOnly ? null : (
            <span
              className="row gap6"
              style={{ cursor: 'pointer', position: 'relative' }}
              onClick={() => nav('/ops/notifications')}
              title={'通知中心 · 真实告警待处置 ' + liveBadge + ' 条'
                + (liveList.length ? '（最近：' + liveList[0].level + ' ' + liveList[0].title.slice(0, 40) + '）' : '')
                + (liveAlertStore.error() ? ' · ' + liveAlertStore.error() : '')}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round">
                <path d="M18 8A6 6 0 006 8c0 7-3 8-3 8h18s-3-1-3-8" />
                <path d="M10.3 21a2 2 0 003.4 0" />
              </svg>
              {liveBadge > 0
                ? <span className="tag red">真实告警待处置 {liveBadge}</span>
                : <span className="tiny faint">无待处置告警</span>}
              {liveList.length ? (
                <span
                  className="tiny"
                  style={{
                    maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: liveBadge > 0 ? (liveList[0].level === '紧急' ? 'var(--bad-text)' : 'var(--warn-text)') : 'var(--text-dim)',
                  }}
                  title={liveList[0].title + ' · ' + liveList[0].body}
                >
                  {liveList[0].level} · {liveList[0].title.slice(0, 34)}（{liveList[0].time}）
                </span>
              ) : null}
            </span>
            )}
            <span className="row gap6">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
              {acc.name}
              <span className="tag gray">{ROLE_LABEL[acc.role]}</span>
              <span className="tiny faint">{acc.domain}</span>
            </span>
            <button className="btn sm ghost" onClick={() => auth.logout()}>退出</button>
          </div>
        </header>
        <main className="main">
          {denied ? (
            <div className="panel" style={{ maxWidth: 620, margin: '40px auto' }}>
              <div className="panel-head"><span className="ph-left">无访问权限</span><span className="extra">{TITLES[loc.pathname] ?? loc.pathname}</span></div>
              <div className="panel-body">
                <div className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>
                  当前角色 <b>{ROLE_LABEL[acc.role]}</b>（{acc.domain}）不具备该功能点的可见权限。权限由「应用中心 · 跨平台运营」中的<b>权限矩阵</b>决定，矩阵修改后立即可见生效结果。
                </div>
                <div className="row gap12 mt14" style={{ marginTop: 14 }}>
                  <button className="btn" onClick={() => nav('/')}>返回运营总览</button>
                  <button className="btn ghost" onClick={() => nav('/app/accounts')}>查看权限矩阵（需管理员）</button>
                </div>
              </div>
            </div>
          ) : (
          <Routes>
            <Route path="/" element={<P_OVERVIEW />} />
            <Route path="/briefing" element={<P_BRIEF />} />
            <Route path="/network" element={<P_NETWORK />} />
            <Route path="/govern" element={<P_GOVERN />} />
            <Route path="/compute/exceptions" element={<P_COMPUTE_EXC />} />
            <Route path="/compute/cards" element={<P_C_CARDS />} />
            <Route path="/model/deploy" element={<P_M_DEPLOY />} />
            <Route path="/model/monitor" element={<P_M_MONITOR />} />
            <Route path="/model/litellm" element={<P_M_LITELLM />} />
            <Route path="/model/safety-flow" element={<P_M_SAFETY />} />
            <Route path="/app/dify" element={<P_A_DIFY />} />
            <Route path="/ops/apply" element={<P_OPS_APPLY />} />
            <Route path="/ops/records" element={<P_OPS_RECORDS />} />
            <Route path="/account" element={<P_ACCOUNT />} />
            <Route path="/ops/settings" element={<P_OPS_SETTINGS />} />
            <Route path="/ops/commands" element={<P_OPS_COMMANDS />} />
            <Route path="/compute/overview" element={<P_C_OVERVIEW />} />
            <Route path="/compute/schedule" element={<P_C_SCHEDULE />} />
            <Route path="/compute/storage" element={<P_C_STORAGE />} />
            <Route path="/model/assets" element={<P_M_ASSETS />} />
            <Route path="/model/gateway" element={<P_M_GATEWAY />} />
            <Route path="/model/engine" element={<P_M_ENGINE />} />
            <Route path="/model/credentials" element={<P_M_CRED />} />
            <Route path="/model/personal" element={<P_M_PERSONAL />} />
            <Route path="/model/fineTune" element={<P_M_FINE />} />
            <Route path="/model/trace" element={<P_M_TRACE />} />
            <Route path="/model/audit" element={<P_M_AUDIT />} />
            <Route path="/model/security" element={<P_M_SEC />} />
            <Route path="/app/market" element={<P_A_MARKET />} />
            <Route path="/app/agents" element={<P_A_AGENTS />} />
            <Route path="/app/kb" element={<P_A_KB />} />
            <Route path="/app/tools" element={<P_A_TOOLS />} />
            <Route path="/app/templates" element={<P_A_TEMPLATES />} />
            <Route path="/app/security" element={<P_A_SEC />} />
            <Route path="/app/accounts" element={<P_A_ACCT />} />
            <Route path="/ops/analytics" element={<P_OPS />} />
            <Route path="/ops/workflow" element={<P_OPS_WORKFLOW />} />
            <Route path="/ops/alert-rules" element={<P_OPS_ALERTS />} />
            <Route path="/ops/notifications" element={<P_OPS_NOTIF />} />
            <Route path="/ops/integrations" element={<P_OPS_INT />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          )}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <React.Suspense fallback={<div className="empty">加载中…</div>}>
        <Shell />
      </React.Suspense>
    </HashRouter>
  )
}
