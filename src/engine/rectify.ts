/* =====================================================================
 * 例外整改闭环与值班派单
 * 阻断只是止损：每条例外自动开一张整改单，派给当班角色，有期限、有进展记录、
 * 必须复核通过才允许恢复接入；超时未接单自动升级到值班长
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine } from './engine'
import { dbRead, dbWrite, dbSeed } from './db'
import { consoleStore, FALLBACK_DUTY, FALLBACK_ROUTES } from './console'


export type RectStatus = '待接单' | '整改中' | '待复核' | '已关闭' | '已升级'
export interface DutyRole { role: string; name: string; phone: string; lead: string; scope: string }
export interface RectLogItem { time: string; actor: string; text: string }
export interface RectifyRec {
  key: string
  excKind: string
  excTitle: string
  target: string
  owner: string
  severity: string
  role: string
  assignee: string
  phone: string
  dispatchedAt: number
  dueAt: number
  ackAt?: number
  status: RectStatus
  actionLabel: string
  orderId?: string
  note: string
  log: RectLogItem[]
}
export interface DutySettings { responseMin: number; dueMin: number; autoDispatch: boolean }

/** 代码默认值班表（服务读不到时兜底）。正式口径：排班来源可配 ——
 * 试运行由建设团队安排（duty-source=local，在「配置中心 → 排班与派单」里改），
 * 成熟后 duty-source=external，由客户方值班系统提供，本系统只做派单与升级跟踪。 */
export const DUTY_ROSTER: DutyRole[] = [
  { role: '算力资源值班', name: '当班 · 陈××（网运）', phone: '内线 8021', lead: '值班长 · 刘××', scope: '算力池 / 卡位 / 扩租通道' },
  { role: '网络与接入值班', name: '当班 · 示例××（网运）', phone: '内线 8035', lead: '值班长 · 刘××', scope: '接入通道 / 入网白名单 / 来源 IP' },
  { role: '应用与智能体值班', name: '当班 · 李××（应用）', phone: '内线 8048', lead: '值班长 · 刘××', scope: '智能体 / 知识库 / 模板 / 目录' },
  { role: '安全值班', name: '当班 · 赵××（安全）', phone: '内线 8060', lead: '值班长 · 刘××', scope: '凭证 / 密级 / 检测策略' },
  { role: '值班长', name: '刘××', phone: '内线 8000', lead: '信息化管理部值班领导', scope: '超时升级与跨专业处置' },
]

/** 派单口径：例外类型 → 当班角色 */
export const ASSIGN_BY_KIND: Record<string, string> = {
  旁路接入: '网络与接入值班',
  旁路调用: '应用与智能体值班',
  接管缺口: '算力资源值班',
  资源异常: '算力资源值班',
  配额越界: '安全值班',
  目录不一致: '应用与智能体值班',
}

const KEY = 'dsh-demo-rectify-v1'
const SKEY = 'dsh-demo-duty-v1'
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
const rank: Record<RectStatus, number> = { 已升级: 0, 待接单: 1, 整改中: 2, 待复核: 3, 已关闭: 4 }

function loadRecs(): Record<string, RectifyRec> {
  try { const r = dbRead(KEY); if (r) return JSON.parse(r) as Record<string, RectifyRec> } catch { /* 落库失败已在数据层记录 */ }
  return {}
}
function loadSettings(): DutySettings {
  try { const r = dbRead(SKEY); if (r) return JSON.parse(r) as DutySettings } catch { /* 落库失败已在数据层记录 */ }
  return { responseMin: 15, dueMin: 90, autoDispatch: true }
}

let recs: Record<string, RectifyRec> = loadRecs()
dbSeed(KEY, recs)
let settings: DutySettings = loadSettings()
dbSeed(SKEY, settings)
let cache: RectifyRec[] | null = null
const listeners = new Set<() => void>()
function persist() { try { dbWrite(KEY, JSON.stringify(recs)) } catch { /* 落库失败已在数据层记录 */ } }
function persistSettings() { try { dbWrite(SKEY, JSON.stringify(settings)) } catch { /* 落库失败已在数据层记录 */ } }
function emit() { cache = null; listeners.forEach((l) => l()) }
function dutyRosterLive(): DutyRole[] {
  const st = consoleStore.get()
  if (!st.fromServer) return DUTY_ROSTER
  return st.shifts.filter((x) => x.enabled).map((x) => ({ role: x.role, name: x.name, phone: x.phone, lead: x.lead, scope: x.scope }))
}
/** 当前生效的派单映射（例外类型 → 岗位 → 超时升级岗位），来自配置中心 */
export function dutyRoutesLive(): { kind: string; duty_role: string; escalate_role: string }[] {
  const st = consoleStore.get()
  return st.fromServer && st.routes.length ? st.routes.map((r) => ({ kind: r.kind, duty_role: r.duty_role, escalate_role: r.escalate_role })) : FALLBACK_ROUTES
}
export function dutyRosterView(): DutyRole[] { return dutyRosterLive() }
function roleOf(name: string): DutyRole {
  const list = dutyRosterLive()
  return list.find((r) => r.role === name) ?? list[list.length - 1]
}
function escalateRoleFor(kind: string): string {
  return dutyRoutesLive().find((r) => r.kind === kind)?.escalate_role || '值班长'
}

export const rectifyStore = {
  list(): RectifyRec[] {
    if (cache) return cache
    cache = Object.values(recs).sort((a, b) => rank[a.status] - rank[b.status] || b.dispatchedAt - a.dispatchedAt)
    return cache
  },
  for(key: string) { return recs[key] },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  settings: () => settings,

  stats() {
    const list = rectifyStore.list()
    const open = list.filter((r) => r.status !== '已关闭')
    return {
      total: list.length, open: open.length,
      wait: list.filter((r) => r.status === '待接单').length,
      doing: list.filter((r) => r.status === '整改中').length,
      review: list.filter((r) => r.status === '待复核').length,
      closed: list.filter((r) => r.status === '已关闭').length,
      escalated: list.filter((r) => r.status === '已升级').length,
      overdue: open.filter((r) => Date.now() > r.dueAt).length,
    }
  },

  /** 处置生效后自动开整改单并派给当班角色 */
  open(input: { key: string; excKind: string; excTitle: string; target: string; owner: string; severity: string; actionLabel: string; orderId?: string }, by = '例外监控') {
    if (recs[input.key] && recs[input.key].status !== '已关闭') return recs[input.key]
    const role = roleOf(consoleStore.dutyRoleFor(input.excKind)?.duty_role || ASSIGN_BY_KIND[input.excKind] || '值班长')
    const t = Date.now()
    const rec: RectifyRec = {
      key: input.key, excKind: input.excKind, excTitle: input.excTitle, target: input.target, owner: input.owner, severity: input.severity,
      role: role.role, assignee: role.name, phone: role.phone,
      dispatchedAt: t, dueAt: t + settings.dueMin * 60000,
      status: '待接单', actionLabel: input.actionLabel, orderId: input.orderId,
      note: `${input.actionLabel}已生效（${input.orderId ?? '无工单'}）；整改要求：确认接入来源、补齐前置条件与执行回执，提交复核后才允许恢复接入`,
      log: [{ time: now(), actor: by, text: `处置已执行：${input.actionLabel}${input.orderId ? ` · 工单 ${input.orderId}` : ''} · 自动派单给 ${role.name}（${role.phone}）` }],
    }
    recs[input.key] = rec
    persist(); emit()
    engine.announce('一般', `例外整改单已开出：【${input.excKind}】${input.target} → ${role.name}（${role.phone}）· 接单时限 ${settings.responseMin} 分钟 · 整改期限 ${settings.dueMin} 分钟`)
    return rec
  },

  ack(key: string, actor?: string) {
    const r = recs[key]
    if (!r) return { ok: false as const, reason: '未找到整改单' }
    if (r.status !== '待接单' && r.status !== '已升级') return { ok: false as const, reason: `整改单当前是「${r.status}」，无需接单` }
    r.status = '整改中'
    r.ackAt = Date.now()
    r.log = [{ time: now(), actor: actor ?? r.assignee, text: '已接单，开始整改' }, ...r.log]
    persist(); emit()
    return { ok: true as const }
  },

  progress(key: string, note: string, actor?: string) {
    const r = recs[key]
    if (!r) return { ok: false as const, reason: '未找到整改单' }
    if (r.status === '已关闭') return { ok: false as const, reason: '整改单已关闭，如需变更请重开例外监控处置' }
    if (note.trim().length < 6) return { ok: false as const, reason: '整改进展要写清做了什么（不少于 6 字），复核人要看依据' }
    r.status = '整改中'
    r.log = [{ time: now(), actor: actor ?? r.assignee, text: note.trim() }, ...r.log]
    persist(); emit()
    return { ok: true as const }
  },

  submitReview(key: string, note: string, actor?: string) {
    const r = recs[key]
    if (!r) return { ok: false as const, reason: '未找到整改单' }
    if (r.status === '待接单' || r.status === '已升级') return { ok: false as const, reason: '先接单再提交复核' }
    if (note.trim().length < 6) return { ok: false as const, reason: '提交复核要写整改结论与依据（不少于 6 字）' }
    r.status = '待复核'
    r.log = [{ time: now(), actor: actor ?? r.assignee, text: `提交复核：${note.trim()}` }, ...r.log]
    persist(); emit()
    engine.announce('一般', `整改单待复核：【${r.excKind}】${r.target} → ${roleOf(escalateRoleFor(r.excKind)).name} · 复核通过后才允许提交恢复工单`)
    return { ok: true as const }
  },

  review(key: string, pass: boolean, note: string, actor?: string) {
    const r = recs[key]
    if (!r) return { ok: false as const, reason: '未找到整改单' }
    if (r.status !== '待复核') return { ok: false as const, reason: `整改单当前是「${r.status}」，不能复核` }
    if (note.trim().length < 6) return { ok: false as const, reason: '复核结论要写清依据（不少于 6 字）' }
    const who = actor ?? roleOf(escalateRoleFor(r.excKind)).name
    if (pass) {
      r.status = '已关闭'
      r.log = [{ time: now(), actor: who, text: `复核通过并关闭：${note.trim()}` }, ...r.log]
      persist(); emit()
      engine.announce('重要', `整改复核通过：【${r.excKind}】${r.target} 已闭环，可提交恢复接入工单（引擎仍会做就绪校验）`)
      return { ok: true as const }
    }
    r.status = '整改中'
    r.dueAt = Date.now() + settings.dueMin * 60000
    r.log = [{ time: now(), actor: who, text: `复核退回：${note.trim()}` }, ...r.log]
    persist(); emit()
    engine.announce('重要', `整改复核退回：【${r.excKind}】${r.target} → ${r.assignee}（${r.phone}），整改期限顺延 ${settings.dueMin} 分钟`)
    return { ok: true as const }
  },

  remove(key: string) { if (recs[key]) { delete recs[key]; persist(); emit() } },

  /** 每轮扫描调用：超时未接单自动升级到值班长 */
  tick() {
    const t = Date.now()
    let escalated = 0
    for (const r of Object.values(recs)) {
      if (r.status === '待接单' && t - r.dispatchedAt >= settings.responseMin * 60000) {
        const lead = roleOf(escalateRoleFor(r.excKind))
        r.status = '已升级'
        r.log = [{ time: now(), actor: '例外监控', text: `超时 ${settings.responseMin} 分钟未接单，已升级至 ${lead.name}（${lead.phone}），上级 ${lead.lead}` }, ...r.log]
        escalated += 1
        engine.announce('紧急', `例外整改超时未接单：【${r.excKind}】${r.target} → 已升级至 ${lead.name}（${lead.phone}）· 归口 ${r.owner}`)
      } else if (r.status !== '已关闭' && t > r.dueAt && !r.log.some((l) => l.text.startsWith('已超整改期限'))) {
        r.log = [{ time: now(), actor: '例外监控', text: `已超整改期限（${settings.dueMin} 分钟），归口 ${r.owner} 须说明延期原因` }, ...r.log]
        engine.announce('重要', `整改超期：【${r.excKind}】${r.target} · ${r.assignee} · 期限 ${settings.dueMin} 分钟已过`)
      }
    }
    if (escalated) { persist(); emit() }
    return escalated
  },

  setSettings(patch: Partial<DutySettings>) { settings = { ...settings, ...patch }; persistSettings(); emit() },
  reset() { recs = {}; persist(); emit() },
}

function snapshot() { return rectifyStore.list() }
export function useRectify() {
  return useSyncExternalStore(rectifyStore.subscribe, snapshot, snapshot)
}
