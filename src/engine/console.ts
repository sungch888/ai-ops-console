/* =====================================================================
 * v3.3 / v3.4 / v3.6 的运营控制数据：排班派单、审批来源、处置指令、人工兜底
 *   - 权威数据都在数据服务的库里（duty_shifts / duty_routes / approvals / commands / fallback_tasks）
 *   - 前端只保留内存副本；服务不可用时明确显示「读不到」，并退回代码里的默认值班口径
 *   - 口径：先内建独立运行，外部来源做成配置开关（审批来源 / 排班来源 / 通知渠道 / 身份来源）
 * 注意：这里只调 /api 接口，不做任何真实设备调用；影响面清单由平台台账推导。
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { apiGet, apiSend } from './db'

export interface DutyShift {
  id: string; role: string; name: string; phone: string; lead: string; scope: string; enabled: number; updated_at: string
}
export interface DutyRoute { kind: string; duty_role: string; escalate_role: string; updated_at: string }
export interface ApprovalRow {
  id: number; order_id: string; source: string; external_ref: string; state: string
  decision: string | null; note: string; actor: string; due_at: string; at: string; decided_at: string
}
export interface CommandRow {
  id: string; target_class: string; target: string; action: string; dry_run: number; status: string
  emergency: number; issued_by: string; issued_at: string; ack_at: string; ack_by: string
  fail_reason: string; rollback_of: string; created_at: string
}
export interface FallbackRow {
  id: string; kind: string; ref: string; title: string; detail: string; status: string; owner: string; created_at: string
}

/** 服务读不到时的兜底口径（与代码里原有演示口径一致，界面会标明「代码默认值」） */
export const FALLBACK_DUTY: DutyShift[] = [
  { id: 'D-01', role: '算力资源值班', name: '当班 · 陈××（网运）', phone: '内线 8021', lead: '值班长 · 刘××', scope: '算力池与卡位异常', enabled: 1, updated_at: '' },
  { id: 'D-02', role: '网络与接入值班', name: '当班 · 示例××（网运）', phone: '内线 8035', lead: '值班长 · 刘××', scope: '旁路接入与通道', enabled: 1, updated_at: '' },
  { id: 'D-03', role: '应用与智能体值班', name: '当班 · 李××（应用）', phone: '内线 8048', lead: '值班长 · 刘××', scope: '智能体与知识库', enabled: 1, updated_at: '' },
  { id: 'D-04', role: '安全值班', name: '当班 · 赵××（安全）', phone: '内线 8060', lead: '值班长 · 刘××', scope: '例外与配额越界', enabled: 1, updated_at: '' },
  { id: 'D-05', role: '值班长', name: '刘××', phone: '内线 8000', lead: '信息化管理部值班领导', scope: '超时升级与决策', enabled: 1, updated_at: '' },
]
export const FALLBACK_ROUTES: DutyRoute[] = [
  { kind: '旁路接入', duty_role: '网络与接入值班', escalate_role: '值班长', updated_at: '' },
  { kind: '旁路调用', duty_role: '应用与智能体值班', escalate_role: '值班长', updated_at: '' },
  { kind: '接管缺口', duty_role: '算力资源值班', escalate_role: '值班长', updated_at: '' },
  { kind: '资源异常', duty_role: '算力资源值班', escalate_role: '值班长', updated_at: '' },
  { kind: '配额越界', duty_role: '安全值班', escalate_role: '值班长', updated_at: '' },
]

interface State {
  shifts: DutyShift[]; routes: DutyRoute[]; approvals: ApprovalRow[]; commands: CommandRow[]
  fallbacks: FallbackRow[]; fromServer: boolean; error: string; loading: boolean
}
let st: State = {
  shifts: FALLBACK_DUTY, routes: FALLBACK_ROUTES, approvals: [], commands: [], fallbacks: [],
  fromServer: false, error: '', loading: false,
}
const listeners = new Set<() => void>()
function emit(patch: Partial<State>) { st = { ...st, ...patch }; listeners.forEach((l) => l()) }

export const consoleStore = {
  get: () => st,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },

  /** 一次性刷新（页面挂载时调用）；服务端不可用时保留代码默认口径并把状态标出来 */
  async refresh(orderId = ''): Promise<void> {
    emit({ loading: true })
    const errs: string[] = []
    try {
      const [d, r, a, c, f] = await Promise.all([
        apiGet('/duty?limit=100'),
        apiGet('/duty_routes?limit=100'),
        apiGet('/approvals?limit=100' + (orderId ? '&order=' + encodeURIComponent(orderId) : '')),
        apiGet('/commands?limit=100'),
        apiGet('/fallback?limit=100'),
      ])
      emit({
        shifts: (d.rows && d.rows.length ? d.rows : FALLBACK_DUTY),
        routes: (r.rows && r.rows.length ? r.rows : FALLBACK_ROUTES),
        approvals: a.rows || [], commands: c.rows || [], fallbacks: f.rows || [],
        fromServer: !!(d.rows && d.rows.length), error: '', loading: false,
      })
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e))
      emit({ fromServer: false, error: '排班 / 审批 / 处置数据读不到（沿用代码默认口径）：' + errs[0], loading: false })
    }
  },

  async saveShift(v: Partial<DutyShift>): Promise<{ ok: boolean; error?: string }> {
    try {
      await apiSend('POST', '/duty/shift', v)
      await this.refresh()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async saveRoute(v: Partial<DutyRoute>): Promise<{ ok: boolean; error?: string }> {
    try {
      await apiSend('POST', '/duty/route', v)
      await this.refresh()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  /** 派单：例外类型 → 岗位（可配） */
  dutyRoleFor(kind: string): DutyRoute | null {
    return st.routes.find((r) => r.kind === kind) || null
  },
  shiftForRole(role: string): DutyShift | null {
    return st.shifts.find((s) => s.role === role && s.enabled) || null
  },

  async createApproval(orderId: string, externalRef: string, dueMinutes: number, note: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await apiSend('POST', '/approval/create', { order_id: orderId, external_ref: externalRef, due_minutes: dueMinutes, note })
      await this.refresh()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async decideApproval(orderId: string, decision: 'approve' | 'reject', externalRef: string, note: string): Promise<{ ok: boolean; deduped?: boolean; error?: string }> {
    try {
      const b = await apiSend('POST', '/approval/decide', { order_id: orderId, decision, external_ref: externalRef, note })
      await this.refresh()
      return { ok: true, deduped: !!b.deduped }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },

  async dryRun(v: { target_class: string; target: string; action: string; params?: Record<string, unknown> }): Promise<{ ok: boolean; id?: string; impact?: any; error?: string }> {
    try {
      const b = await apiSend('POST', '/commands/dry-run', v)
      await this.refresh()
      return { ok: true, id: b.id, impact: b.impact }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async issue(id: string, emergency: boolean): Promise<{ ok: boolean; impact?: any; error?: string }> {
    try {
      const b = await apiSend('POST', '/commands/issue', { id, confirm: true, emergency })
      await this.refresh()
      return { ok: true, impact: b.impact }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async ack(id: string, ok: boolean, reason = ''): Promise<{ ok: boolean; error?: string }> {
    try {
      await apiSend('POST', '/commands/ack', { id, ok, reason })
      await this.refresh()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async rollback(id: string): Promise<{ ok: boolean; rollback_id?: string; error?: string }> {
    try {
      const b = await apiSend('POST', '/commands/rollback', { id })
      await this.refresh()
      return { ok: true, rollback_id: b.rollback_id }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
  async claimFallback(id: string, status: '已接管' | '已关闭'): Promise<{ ok: boolean; error?: string }> {
    try {
      await apiSend('POST', '/fallback/claim', { id, status })
      await this.refresh()
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  },
}

export function useConsole() {
  return useSyncExternalStore(consoleStore.subscribe, consoleStore.get, consoleStore.get)
}

/** 演练 / 下发用的目标设备类型清单（都是虚拟模拟对象，本期不接真实设备） */
export const TARGET_CLASSES = [
  '旁路接入设备', '旁路调用网关', '算力池调度接口', '凭证代理接口', '日志采集器', '未接设备',
]
export const COMMAND_ACTIONS = [
  '阻断接入通道', '端口隔离', '降配额', '暂停模型副本', '吊销凭证', '只读锁定', '恢复接入', '回滚上一次变更',
]
