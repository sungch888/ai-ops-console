/* =====================================================================
 * 通知中心 + 外部接入（配置化）+ 报表生成与 CSV 导出
 * 通知由引擎事件自动产生；接入通道的健康状态会影响纳管数据的可采集性
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine, type EngineState } from './engine'
import { dbRead, dbWrite, dbSeed } from './db'


/* ---------------- 通知中心 ---------------- */
export interface Notif {
  id: string; time: string; level: '一般' | '重要' | '紧急'; title: string; text: string; channels: string[]
  read: boolean; handled: boolean; source: string
  /** 这条告警属于「哪一个原因」；同 cause 的旧告警自动完成处置，值班员只处理最新一条 */
  cause?: string
  /** 写入这条时自动并入了几条同因旧告警 */
  merged?: number
  handled_by?: string
}

export const AUTO_MERGE_BY = '系统自动并入（同因重复报警）'

/** 同一原因又报一次 → 之前没处置的同因通知自动记为已处置（页面上看得见是被谁并的） */
function mergeSameCause(cause: string, reason: string): number {
  if (!cause) return 0
  const n = notifs.filter((x) => !x.handled && x.cause === cause).length
  if (!n) return 0
  notifs = notifs.map((x) => (!x.handled && x.cause === cause)
    ? { ...x, read: true, handled: true, handled_by: AUTO_MERGE_BY, text: `${x.text}（同因重复报警：${reason} · 自动完成处置，不必逐条点）` }
    : x)
  return n
}

export type RouteRules = Record<Notif['level'], string[]>

const DEFAULT_ROUTES: RouteRules = {
  紧急: ['站内看板', '短信', '即时通讯', '值班电话'],
  重要: ['站内看板', '即时通讯'],
  一般: ['站内看板'],
}

const NOTIF_KEY = 'dsh-demo-notif-v1'
const ROUTE_KEY = 'dsh-demo-route-v1'

let notifs: Notif[] = loadNotifs()
dbSeed(NOTIF_KEY, notifs)
let routes: RouteRules = loadRoutes()
dbSeed(ROUTE_KEY, routes)
const nListeners = new Set<() => void>()
let seq = 1

function loadNotifs(): Notif[] {
  try { const r = dbRead(NOTIF_KEY); return r ? JSON.parse(r) as Notif[] : [] } catch { return [] }
}
function loadRoutes(): RouteRules {
  try { const r = dbRead(ROUTE_KEY); return r ? JSON.parse(r) as RouteRules : structuredClone(DEFAULT_ROUTES) } catch { return structuredClone(DEFAULT_ROUTES) }
}
/** 没显式给 cause 时，从标题+正文推一个「原因指纹」：
 *  把轮次 / 百分比 / 时间点这类会变的数字抹掉，让「同一个原因、不同读数」落到同一个 cause 上。 */
function sigOf(title: string, text: string) {
  const s = `${title}|${text}`
    .replace(/\d+:\d{2}(:\d{2})?/g, '#')
    .replace(/第\s*\d+\s*轮/g, '第#轮')
    .replace(/\d+(\.\d+)?\s*%/g, '#%')
    .replace(/\s+/g, ' ')
    .trim()
  return 'sig:' + s.slice(0, 160)
}

function persist() {
  try { dbWrite(NOTIF_KEY, JSON.stringify(notifs.slice(0, 60))); dbWrite(ROUTE_KEY, JSON.stringify(routes)) } catch { /* 落库失败已在数据层记录 */ }
}
function emitN() { notifs = [...notifs]; nListeners.forEach((l) => l()) }

function nowStr() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const notifyStore = {
  get: () => notifs,
  subscribe: (l: () => void) => { nListeners.add(l); return () => { nListeners.delete(l) } },
  routes: () => routes,
  push(level: Notif['level'], title: string, text: string, source: string, cause = '') {
    const ck = cause || sigOf(title, text)
    const merged = mergeSameCause(ck, `最新一条已写入（${title}）`)
    const n: Notif = { id: `N-${String(seq++).padStart(4, '0')}`, time: nowStr(), level, title, text, channels: routes[level], read: false, handled: false, source, cause: ck, merged }
    notifs = [n, ...notifs].slice(0, 60)
    persist(); emitN()
  },
  /** 原因已经处理掉了（例外已处置 / 通道已恢复）→ 该原因下未处置的通知一并闭环 */
  closeCause(cause: string, note = '原因已处置，同因告警一并闭环') {
    const n = mergeSameCause(cause, note)
    if (n) emitN()
    return n
  },
  markRead(id: string) { notifs = notifs.map((n) => (n.id === id ? { ...n, read: true } : n)); persist(); emitN() },
  markAllRead() { notifs = notifs.map((n) => ({ ...n, read: true })); persist(); emitN() },
  markHandled(id: string) { notifs = notifs.map((n) => (n.id === id ? { ...n, handled: true, read: true } : n)); persist(); emitN() },
  toggleChannel(level: Notif['level'], ch: string) {
    const cur = routes[level]
    routes = { ...routes, [level]: cur.includes(ch) ? cur.filter((c) => c !== ch) : [...cur, ch] }
    persist(); emitN()
  },
  unread: () => notifs.filter((n) => !n.read).length,
  reset() { notifs = []; routes = structuredClone(DEFAULT_ROUTES); persist(); emitN() },
}

/** 引擎事件 → 自动产生通知（按等级路由到渠道）
 * 注意：此函数需在 App 挂载后显式调用，避免模块加载时的隐式副作用 */
let knownEvents = 0
export function hookEngineEvents() {
  const st = engine.get()
  knownEvents = st.events.length
  engine.subscribe(() => {
    const cur = engine.get().events
    if (cur.length > knownEvents) {
      const fresh = cur.slice(0, cur.length - knownEvents).reverse()
      fresh.forEach((e) => notifyStore.push(e.level, e.level === '紧急' ? '紧急安全事件' : e.level === '重要' ? '运行异常与调度建议' : '运行提示', e.text, '模型中心 / 算力中心', e.cause || ''))
    }
    knownEvents = cur.length
  })
}


export function useNotifs() {
  return useSyncExternalStore(notifyStore.subscribe, notifyStore.get, notifyStore.get)
}
export function useUnread() {
  return useSyncExternalStore(notifyStore.subscribe, () => notifs.filter((n) => !n.read).length, () => 0)
}

/* ---------------- 外部接入（配置化）----------------
 * 接入对象与接入配置统一存放在 connectors.ts（配置即接入）；
 * 这里只做兼容导出，并在通道状态变化时产生通知。
 * ===================================================================== */
import { connectorStore, useConnectors, readiness, MODE_LABEL, type Connector, type IntStatus, type ConnMode, type ConnKind } from './connectors'

export type { IntStatus, Connector, ConnMode, ConnKind }
export type Integration = Connector
export { useConnectors, connectorStore, readiness, MODE_LABEL }
export { TRANSPORTS, AUTHS, FALLBACKS, KIND_GROUP, RENT_ID, LLM_CHANNEL_ID, rentConfig, llmChannelConfig } from './connectors'

export const intStore = {
  get: connectorStore.get,
  subscribe: connectorStore.subscribe,
  setHealth(id: string, health: Connector['health']) {
    connectorStore.setHealth(id, health)
    const it = connectorStore.find(id)
    if (it) {
      // 同一条接入反复好坏切换：cause 相同 → 旧的未处置通知自动并入最新一条
      if (health === 'fault') notifyStore.push('重要', `对接中断：${it.name}`, `${MODE_LABEL[it.mode]}通道不可用，${it.dataItems} 停止采集，纳管数据将出现缺口（降级策略：${it.fallback}）。责任方：${it.owner}`, '外部接入配置', `CONN:${it.id}`)
      if (health === 'ok') notifyStore.push('一般', `对接恢复：${it.name}`, '通道恢复，纳管数据继续采集（这条接入之前未处置的中断告警已自动闭环）', '外部接入配置', `CONN:${it.id}`)
    }
  },
  setStatus: connectorStore.setStatus,
  reset: connectorStore.reset,
}

export function useIntegrations() {
  return useSyncExternalStore(connectorStore.subscribe, connectorStore.get, connectorStore.get)
}
export function integrationOf(name: string) {
  return connectorStore.find(name) ?? connectorStore.get().find((i) => i.name === name)
}

/* ---------------- 报表生成与 CSV 导出 ---------------- */
export interface ReportRec { id: string; name: string; type: string; time: string; state: '编制中' | '已生成' | '已报送'; rows: number; note: string }

const REPORT_KEY = 'dsh-demo-reports-v1'
const DEFAULT_REPORTS: ReportRec[] = [
  { id: 'R-01', name: '模型服务运行周报（W43）', type: '周报', time: '11-01', state: '已报送', rows: 42, note: '含可用率 / 成功率 / 异常摘要' },
  { id: 'R-02', name: '10 月运营月报', type: '月报', time: '11-03', state: '编制中', rows: 0, note: '含应用热度 / 资源占比 / 活跃度' },
  { id: 'R-03', name: 'Q3 容量评估报告', type: '季度', time: '10-31', state: '已报送', rows: 18, note: '含容量趋势与扩缩建议' },
]
let reports: ReportRec[] = loadReports()
dbSeed(REPORT_KEY, reports)
const rListeners = new Set<() => void>()
function loadReports(): ReportRec[] {
  try { const r = dbRead(REPORT_KEY); return r ? JSON.parse(r) as ReportRec[] : structuredClone(DEFAULT_REPORTS) } catch { return structuredClone(DEFAULT_REPORTS) }
}
function emitR() { reports = [...reports]; try { dbWrite(REPORT_KEY, JSON.stringify(reports)) } catch { /* 落库失败已在数据层记录 */ } rListeners.forEach((l) => l()) }

export const reportStore = {
  get: () => reports,
  subscribe: (l: () => void) => { rListeners.add(l); return () => { rListeners.delete(l) } },
  generate(name: string, type: string, st: EngineState) {
    const credRows = st.creds.length
    const orderRows = st.orders.length
    const poolRows = st.pools.reduce((s, p) => s + 1, 0) + st.models.length
    const rec: ReportRec = {
      id: `R-${String(reports.length + 1).padStart(2, '0')}${Date.now() % 100}`,
      name, type,
      time: nowStr().slice(0, 11),
      state: '已生成',
      rows: credRows + orderRows + poolRows,
      note: `生成时点快照：凭证 ${credRows} · 工单 ${orderRows} · 资源项 ${poolRows}`,
    }
    reports = [rec, ...reports]
    emitR()
    notifyStore.push('一般', `报表已生成：${name}`, rec.note, '运营分析')
    return rec
  },
  markSent(id: string) { reports = reports.map((r) => (r.id === id ? { ...r, state: '已报送' } : r)); emitR() },
  reset() { reports = structuredClone(DEFAULT_REPORTS); emitR() },
}
export function useReports() {
  return useSyncExternalStore(reportStore.subscribe, reportStore.get, reportStore.get)
}

/** 生成 CSV（含 BOM，Excel 直接可开）并下载 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '\ufeff' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  notifyStore.push('一般', `数据已导出：${filename}`, `共 ${rows.length} 行，UTF-8 BOM 编码，可直接用 Excel 打开`, '运营分析')
}
