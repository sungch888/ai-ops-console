/* =====================================================================
 * 检测策略库（敏感词 / 脱敏规则 / 注入特征 / 输出过滤）
 * 规则：任何新增、修改、启停、回滚都必须提交变更单 → 审批通过后才生效
 *       每次生效写入一个版本快照，可回滚至任意历史版本
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine } from './engine'
import { notifyStore } from './ops'
import { dbRead, dbWrite, dbSeed } from './db'


export type PolicyKind = '敏感词' | '脱敏规则' | '注入特征' | '输出过滤'
export type PolicyAction = '提示' | '脱敏' | '拦截' | '转人工'
export interface PolicySnapshot { pattern: string; scope: string; action: PolicyAction; enabled: boolean }
export interface PolicyVersion extends PolicySnapshot { v: number; at: string; by: string; note: string }
export interface Policy {
  id: string
  name: string
  kind: PolicyKind
  scope: string
  pattern: string
  action: PolicyAction
  enabled: boolean
  hits: number
  by: string
  updatedAt: string
  versions: PolicyVersion[]
}
export interface PolicyChange {
  id: string
  op: '新增' | '修改' | '停用' | '启用' | '回滚'
  policyId: string
  target: string
  detail: string
  submitBy: string
  submitAt: string
  status: '待审批' | '已生效' | '已驳回'
  decideBy?: string
  note?: string
  payload?: PolicySnapshot & { kind?: PolicyKind; name?: string }
  rollbackTo?: number
}
export interface PromptRef { name: string; ver: string; versions: string[]; exposed: boolean; approver: string; updatedAt: string }

const KEY = 'dsh-demo-policy-v1'
export const POLICY_KINDS: PolicyKind[] = ['敏感词', '脱敏规则', '注入特征', '输出过滤']
export const POLICY_ACTIONS: PolicyAction[] = ['提示', '脱敏', '拦截', '转人工']
export const SCOPES = ['全局', '租户 · 信息化管理部', '租户 · 示例业务二部', '租户 · 示例业务四部', '模型 · Qwen3-32B', '应用 · 咨询问答助手']

function nowStr() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function snap(p: { pattern: string; scope: string; action: PolicyAction; enabled: boolean }): PolicySnapshot {
  return { pattern: p.pattern, scope: p.scope, action: p.action, enabled: p.enabled }
}

const DEFAULT_POLICIES: Policy[] = [
  { id: 'P-01', name: '内部字段敏感词组', kind: '敏感词', scope: '全局', pattern: '事项编号 · 调查措施 · 重点关注 · 线索来源', action: '拦截', enabled: true, hits: 412, by: '管理员 A', updatedAt: '10-24 09:12', versions: [{ v: 1, at: '09-12 10:04', by: '管理员 A', note: '初始建立（等保三级自查）', ...snap({ pattern: '事项编号 · 调查措施', scope: '全局', action: '拦截', enabled: true }) }, { v: 2, at: '10-24 09:12', by: '运营 B', note: '新增「重点关注 / 线索来源」两词，命中量 +38%', ...snap({ pattern: '事项编号 · 调查措施 · 重点关注 · 线索来源', scope: '全局', action: '拦截', enabled: true }) }] },
  { id: 'P-02', name: '涉政有害内容词组', kind: '敏感词', scope: '全局', pattern: '按现有词库（3 214 条）', action: '拦截', enabled: true, hits: 1873, by: '内容鉴定一体机同步', updatedAt: '10-30 07:40', versions: [{ v: 1, at: '10-30 07:40', by: '内容鉴定一体机同步', note: '由现有一体机词库同步，平台侧只读引用', ...snap({ pattern: '按现有词库（3 214 条）', scope: '全局', action: '拦截', enabled: true }) }] },
  { id: 'P-03', name: '身份证 / 手机号脱敏', kind: '脱敏规则', scope: '全局', pattern: '\\d{17}[\\dX] · 1[3-9]\\d{9}', action: '脱敏', enabled: true, hits: 8641, by: '管理员 A', updatedAt: '09-28 15:20', versions: [{ v: 1, at: '09-28 15:20', by: '管理员 A', note: '身份证与手机号全链路脱敏', ...snap({ pattern: '\\d{17}[\\dX] · 1[3-9]\\d{9}', scope: '全局', action: '脱敏', enabled: true }) }] },
  { id: 'P-04', name: '人员编号与枪支编号脱敏', kind: '脱敏规则', scope: '租户 · 信息化管理部', pattern: '人员编号 [A-Z]?\\d{6} · 枪支编号', action: '脱敏', enabled: true, hits: 214, by: '运营 B', updatedAt: '10-11 11:05', versions: [{ v: 1, at: '10-11 11:05', by: '运营 B', note: '内部数据域专用', ...snap({ pattern: '人员编号 [A-Z]?\\d{6} · 枪支编号', scope: '租户 · 信息化管理部', action: '脱敏', enabled: true }) }] },
  { id: 'P-05', name: '角色改写型注入特征', kind: '注入特征', scope: '全局', pattern: '忽略以上指令 · 你现在是 · 系统提示词是', action: '拦截', enabled: true, hits: 176, by: '管理员 A', updatedAt: '11-02 13:44', versions: [{ v: 1, at: '10-06 09:30', by: '管理员 A', note: '初始 3 条特征', ...snap({ pattern: '忽略以上指令 · 你现在是', scope: '全局', action: '拦截', enabled: true }) }, { v: 2, at: '11-02 13:44', by: '用户 D', note: '新增「系统提示词是」变体，来自示范市02拦截样本', ...snap({ pattern: '忽略以上指令 · 你现在是 · 系统提示词是', scope: '全局', action: '拦截', enabled: true }) }] },
  { id: 'P-06', name: '越权意图识别', kind: '注入特征', scope: '全局', pattern: '导出全库 · 绕过审批 · 帮我查任意身份证号', action: '转人工', enabled: true, hits: 62, by: '运营 B', updatedAt: '10-19 16:02', versions: [{ v: 1, at: '10-19 16:02', by: '运营 B', note: '命中后转安全值班人工复核', ...snap({ pattern: '导出全库 · 绕过审批 · 帮我查任意身份证号', scope: '全局', action: '转人工', enabled: true }) }] },
  { id: 'P-07', name: '输出位置信息过滤', kind: '输出过滤', scope: '模型 · Qwen3-32B', pattern: '经纬度 · 监测点点位 · 实时位置', action: '拦截', enabled: true, hits: 88, by: '管理员 A', updatedAt: '10-27 10:11', versions: [{ v: 1, at: '10-27 10:11', by: '管理员 A', note: '防止模型输出敏感点位', ...snap({ pattern: '经纬度 · 监测点点位 · 实时位置', scope: '模型 · Qwen3-32B', action: '拦截', enabled: true }) }] },
  { id: 'P-08', name: '不实言论与结论性断言提示', kind: '输出过滤', scope: '应用 · 咨询问答助手', pattern: '定性结论 · 有罪推定表述', action: '提示', enabled: true, hits: 41, by: '运营 B', updatedAt: '11-01 08:30', versions: [{ v: 1, at: '11-01 08:30', by: '运营 B', note: '输出侧加提示，不拦截', ...snap({ pattern: '定性结论 · 有罪推定表述', scope: '应用 · 咨询问答助手', action: '提示', enabled: true }) }] },
  { id: 'P-09', name: '个人极端情绪引导识别', kind: '敏感词', scope: '全局', pattern: '自伤 · 极端报复表述', action: '转人工', enabled: true, hits: 12, by: '运营 B', updatedAt: '11-03 21:15', versions: [{ v: 1, at: '11-03 21:15', by: '运营 B', note: '命中即转人工并推送值班', ...snap({ pattern: '自伤 · 极端报复表述', scope: '全局', action: '转人工', enabled: true }) }] },
]

const DEFAULT_PROMPTS: PromptRef[] = [
  { name: '报告生成 · 系统提示词', ver: 'v7', versions: ['v7', 'v6', 'v5'], exposed: false, approver: '管理员 A', updatedAt: '11-02 10:20' },
  { name: '咨询问答 · 语气与边界提示词', ver: 'v4', versions: ['v4', 'v3'], exposed: false, approver: '运营 B', updatedAt: '10-29 14:05' },
  { name: '记录要素抽取 · 结构化提示词', ver: 'v3', versions: ['v3', 'v2', 'v1'], exposed: false, approver: '管理员 A', updatedAt: '10-14 09:41' },
  { name: '第三方提示词包 · 摘要 v2（已审查准入）', ver: 'v2', versions: ['v2', 'v1'], exposed: false, approver: '安全审批人 · 运营 B', updatedAt: '11-04 16:33' },
]

let policies: Policy[] = loadPolicies()
dbSeed(KEY, policies)
let prompts: PromptRef[] = loadPrompts()
let changes: PolicyChange[] = []
let seq = 1
const listeners = new Set<() => void>()

function loadPolicies(): Policy[] {
  try { const raw = dbRead(KEY); if (!raw) return structuredClone(DEFAULT_POLICIES); const p = JSON.parse(raw) as Policy[]; return Array.isArray(p) && p.length ? p : structuredClone(DEFAULT_POLICIES) } catch { return structuredClone(DEFAULT_POLICIES) }
}
function loadPrompts(): PromptRef[] { return structuredClone(DEFAULT_PROMPTS) }
function persist() { try { dbWrite(KEY, JSON.stringify(policies)) } catch { /* 落库失败已在数据层记录 */ } }
function emitP() { policies = [...policies]; changes = [...changes]; prompts = [...prompts]; listeners.forEach((l) => l()) }

export const policyStore = {
  get: () => policies,
  changes: () => changes,
  prompts: () => prompts,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  reset() { policies = structuredClone(DEFAULT_POLICIES); changes = []; prompts = structuredClone(DEFAULT_PROMPTS); persist(); emitP() },

  submitChange(input: { op: PolicyChange['op']; policyId: string; submitBy: string; payload?: PolicyChange['payload']; rollbackTo?: number; note?: string }) {
    const p = policies.find((x) => x.id === input.policyId)
    const target = input.op === '新增' ? String(input.payload?.name ?? '新策略') : p ? `${p.id} ${p.name}` : input.policyId
    const detail = input.op === '修改' ? `作用域 ${input.payload?.scope} · 处置 ${input.payload?.action} · 命中模式 ${input.payload?.pattern}`
      : input.op === '回滚' ? `回滚至版本 v${input.rollbackTo}`
      : input.op === '新增' ? `${input.payload?.kind} · ${input.payload?.scope} · 处置 ${input.payload?.action}`
      : input.op === '停用' ? '停用该策略' : '重新启用该策略'
    const id = `PC-${String(seq++).padStart(3, '0')}`
    changes = [{ id, op: input.op, policyId: input.policyId, target, detail, submitBy: input.submitBy, submitAt: nowStr(), status: '待审批', payload: input.payload, rollbackTo: input.rollbackTo, note: input.note }, ...changes]
    notifyStore.push('一般', `策略变更待审批：${id}`, `${input.op} · ${target} · ${detail}`, '模型中心 / 安全检测')
    engine.get().events.unshift({ time: nowStr(), level: '一般', text: `策略变更单 ${id} 已提交（${input.op} · ${target}），等待安全审批人处理` })
    emitP()
    return id
  },

  approveChange(id: string, decideBy: string) {
    const c = changes.find((x) => x.id === id)
    if (!c || c.status !== '待审批') return { ok: false, reason: '变更单不存在或已处理' }
    if (c.op === '新增') {
      const newId = `P-${String(policies.length + 1).padStart(2, '0')}`
      policies = [{ id: newId, name: String(c.payload?.name ?? '未命名策略'), kind: (c.payload?.kind ?? '敏感词') as PolicyKind, scope: String(c.payload?.scope ?? '全局'), pattern: String(c.payload?.pattern ?? ''), action: (c.payload?.action ?? '提示') as PolicyAction, enabled: c.payload?.enabled ?? true, hits: 0, by: c.submitBy, updatedAt: nowStr(), versions: [{ v: 1, at: nowStr(), by: c.submitBy, note: `新增并经 ${decideBy} 审批`, pattern: String(c.payload?.pattern ?? ''), scope: String(c.payload?.scope ?? '全局'), action: (c.payload?.action ?? '提示') as PolicyAction, enabled: c.payload?.enabled ?? true }] }, ...policies]
    } else {
      const p = policies.find((x) => x.id === c.policyId)
      if (!p) return { ok: false, reason: '目标策略不存在' }
      if (c.op === '回滚') {
        const v = p.versions.find((x) => x.v === c.rollbackTo)
        if (!v) return { ok: false, reason: `目标版本 v${c.rollbackTo} 不存在` }
        const nextV = Math.max(...p.versions.map((x) => x.v)) + 1
        p.pattern = v.pattern; p.scope = v.scope; p.action = v.action; p.enabled = v.enabled
        p.versions = [...p.versions, { v: nextV, at: nowStr(), by: decideBy, note: `回滚至 v${v.v}（变更单 ${c.id}）`, pattern: v.pattern, scope: v.scope, action: v.action, enabled: v.enabled }]
      } else if (c.op === '停用' || c.op === '启用') {
        const nextV = Math.max(...p.versions.map((x) => x.v)) + 1
        p.enabled = c.op === '启用'
        p.versions = [...p.versions, { v: nextV, at: nowStr(), by: decideBy, note: `${c.op}（变更单 ${c.id}）`, ...snap(p) }]
      } else {
        const nextV = Math.max(...p.versions.map((x) => x.v)) + 1
        if (c.payload) { p.pattern = String(c.payload.pattern); p.scope = String(c.payload.scope); p.action = c.payload.action as PolicyAction; p.enabled = c.payload.enabled }
        p.versions = [...p.versions, { v: nextV, at: nowStr(), by: decideBy, note: `修改（变更单 ${c.id}）`, ...snap(p) }]
      }
      p.by = c.submitBy; p.updatedAt = nowStr()
    }
    c.status = '已生效'; c.decideBy = decideBy
    notifyStore.push('重要', `策略变更已生效：${c.op}`, `${c.target} · ${c.detail} · 审批人 ${decideBy} · 已写入版本历史`, '模型中心 / 安全检测')
    engine.get().events.unshift({ time: nowStr(), level: '一般', text: `策略变更单 ${c.id} 审批通过并生效（${c.op} · ${c.target}）` })
    persist(); emitP()
    return { ok: true }
  },

  rejectChange(id: string, decideBy: string, note: string) {
    const c = changes.find((x) => x.id === id)
    if (!c || c.status !== '待审批') return
    c.status = '已驳回'; c.decideBy = decideBy; c.note = note
    notifyStore.push('一般', `策略变更被驳回：${c.id}`, `${c.target} · ${note}`, '模型中心 / 安全检测')
    emitP()
  },

  promptChange(name: string, newVer: string, submitBy: string, approveBy: string) {
    const p = prompts.find((x) => x.name === name)
    if (!p) return { ok: false, reason: '未找到提示词条目' }
    if (p.versions.includes(newVer)) return { ok: false, reason: `${newVer} 已存在` }
    p.versions = [...p.versions, newVer]
    p.ver = newVer; p.approver = approveBy; p.updatedAt = nowStr()
    notifyStore.push('重要', `系统提示词改版：${name}`, `${name} → ${newVer} · 审批人 ${approveBy} · 历史版本 ${p.versions.length} 个 · 提示词内容不在前端与接口暴露`, '模型中心 / 安全检测')
    engine.get().events.unshift({ time: nowStr(), level: '一般', text: `系统提示词「${name}」改版至 ${newVer}，历史版本已留存并经 ${approveBy} 审批` })
    emitP()
    return { ok: true }
  },
}

export function usePolicies() {
  const policiesNow = useSyncExternalStore(policyStore.subscribe, policyStore.get, policyStore.get)
  const changesNow = useSyncExternalStore(policyStore.subscribe, policyStore.changes, policyStore.changes)
  const promptsNow = useSyncExternalStore(policyStore.subscribe, policyStore.prompts, policyStore.prompts)
  return { policies: policiesNow, changes: changesNow, prompts: promptsNow }
}
