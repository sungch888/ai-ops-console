/* =====================================================================
 * 演示视图（v3.10）
 *
 *   演示档（默认）：侧栏只留重点入口，页内次要面板收成一行；
 *   完整档：全部入口与面板照常显示。功能一个都没删，只是不摆在台面上。
 *
 *   模式、留哪些入口、是否折叠次要面板 —— 都是数据服务里的配置项
 *   （状态键 dsh-demo-view-v1），在「配置中心」里改，不用改代码。
 * ===================================================================== */
import React from 'react'
import { dbRead, dbSeed, dbWrite } from './db'

export type ViewMode = 'demo' | 'full'

export interface ViewConf { mode: ViewMode; nav: string[]; fold: boolean; panels: Record<string, string[]> }

/** 演示档默认保留的入口：总览 1 + 算力 3 + 模型 4 + 应用 3 + 运营分析 4 */
export const DEMO_NAV: string[] = [
  '/', '/govern',
  '/compute/overview', '/compute/cards', '/compute/exceptions',
  '/model/monitor', '/model/gateway', '/model/credentials', '/model/security',
  '/app/market', '/app/agents', '/app/security',
  '/ops/workflow', '/ops/notifications', '/ops/settings', '/ops/commands',
]

/**
 * 演示档每页保留哪些面板（按面板标题匹配，匹配不上的一律收成一行）。
 * 不在这张表里的页面 = 演示档从侧栏收起来的页面，用户主动点进去看时完整显示。
 */
export const FOCUS_PANELS: Record<string, string[]> = {
  '/': ['近 24 小时模型调用量趋势', '在线模型负载分布', '今日安全事件动态', '核心应用调用 TOP'],
  '/govern': ['接管深度阶梯', '接管登记册', '各类别接管覆盖率', '新增接管对象登记'],
  '/compute/overview': ['节点资源监控', '算力卡厂商分布', '节点明细'],
  '/compute/cards': ['卡位热力网格', '卡明细', '实连 GPU'],
  '/compute/exceptions': ['例外台账', '整改闭环台账', '值班表与派单时限'],
  '/model/monitor': ['服务清单', '首包 TTFT 与 P99 时延', '平台内置监控探针', '时延趋势', '算力侧趋势'],
  '/model/gateway': ['渠道状态', '渠道故障切换'],
  '/model/credentials': ['凭证清单', '双 Key 差异化管控'],
  '/model/security': ['双向检测链路', '检测策略库', '策略处置日志'],
  '/app/market': ['智能体应用广场'],
  '/app/agents': ['智能体运行监控', '智能体调用量趋势'],
  '/app/security': ['四条防线态势', '安全事件台账', '处置动作执行'],
  '/ops/workflow': ['变更窗口与执行队列', '外部算力资源接入', '资源账本', '工单队列'],
  '/ops/notifications': ['真实告警通知'],
  '/ops/settings': ['资源接入与采集', '来源配置', '排班与派单'],
  '/ops/commands': ['下一条指令', '人工兜底工单'],
}

const KEY = 'dsh-demo-view-v1'
const LS = 'aiops.view'

const DEFAULTS: ViewConf = { mode: 'demo', nav: DEMO_NAV, fold: true, panels: FOCUS_PANELS }

function norm(v: unknown): ViewConf {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ViewConf>
  const nav = Array.isArray(o.nav) ? o.nav.filter((x) => typeof x === 'string') : DEFAULTS.nav
  const panels = (o.panels && typeof o.panels === 'object' && !Array.isArray(o.panels)) ? (o.panels as Record<string, string[]>) : DEFAULTS.panels
  return {
    mode: o.mode === 'full' ? 'full' : 'demo',
    nav: nav.length ? nav : DEFAULTS.nav,
    fold: o.fold !== false,
    panels,
  }
}

function readLocal(): ViewConf | null {
  try {
    const raw = localStorage.getItem(LS)
    return raw ? norm(JSON.parse(raw)) : null
  } catch { return null }
}

let conf: ViewConf = readLocal() || DEFAULTS
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }
function persist() {
  try { localStorage.setItem(LS, JSON.stringify(conf)) } catch { /* 隐私模式读不到就算了 */ }
  dbWrite(KEY, JSON.stringify(conf))
}

export function getView(): ViewConf { return conf }

/** 页面加载完（已从库里取回状态）后调用：库里的配置优先 */
export function initView(): ViewConf {
  let fromDb: unknown = null
  try {
    const raw = dbRead(KEY)
    if (raw) fromDb = JSON.parse(raw)
  } catch { /* 忽略 */ }
  if (fromDb !== null) conf = norm(fromDb)   // 库里存的（含每页面板白名单）优先
  persist()
  emit()
  return conf
}

export function setView(patch: Partial<ViewConf>): ViewConf {
  conf = norm({ ...conf, ...patch })
  persist()
  emit()
  return conf
}

export function useView(): ViewConf {
  return React.useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, getView, getView)
}

/** 当前路由（HashRouter） */
export function currentPath(): string {
  const h = (typeof window === 'undefined' ? '' : window.location.hash) || ''
  const p = h.replace(/^#/, '').split('?')[0]
  return p || '/'
}

/** 演示档 + 开了折叠 + 本页有重点白名单 + 标题不在白名单里 → 这个面板收成一行 */
export function isMinorPanel(title: string): boolean {
  if (!conf.fold || conf.mode !== 'demo') return false
  const path = currentPath()
  const keep = conf.panels[path] ?? FOCUS_PANELS[path]
  if (!keep) return false
  return !keep.some((k) => title.includes(k) || k.includes(title))
}

/** 本页在配置里生效的面板白名单（配置中心显示用） */
export function keptPanels(path: string): string[] { return conf.panels[path] ?? FOCUS_PANELS[path] ?? [] }

export function isNavHidden(to: string): boolean {
  if (conf.mode !== 'demo') return false
  return !conf.nav.includes(to)
}

export { KEY as VIEW_STATE_KEY }
