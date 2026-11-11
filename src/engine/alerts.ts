/* =====================================================================
 * 告警规则管理（可配置 · 可启停 · 立即生效）
 * 维度：渠道 / 资源池 / 全局 / 凭证
 * 模式：固定阈值 · 基线偏离（环比突增）
 * 处置：仅告警 / 生成建议工单 / 自动切换渠道 / 自动凭证盘点
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine, poolUtil, freeCards, type EngineState } from './engine'
import { notifyStore } from './ops'
import { dbRead, dbWrite, dbSeed } from './db'


export type AlertDim = '渠道' | '资源池' | '全局' | '凭证' | '应用'
export type AlertMetric = 'p95延迟' | '错误率' | '配额占用率' | '利用率' | '空闲卡位' | '数量' | '成功率' | '调用失败率' | '解析失败率'
export type AlertMode = '固定阈值' | '基线偏离'
export type AlertAction = '仅告警' | '生成建议工单' | '自动切换渠道' | '自动凭证盘点' | '自动暂停或隔离'
export type AlertLevel = '一般' | '重要' | '紧急'

export interface AlertRule {
  id: string
  name: string
  dim: AlertDim
  metric: AlertMetric
  obj: string
  mode: AlertMode
  op: '>' | '<'
  threshold: number
  level: AlertLevel
  action: AlertAction
  enabled: boolean
  fired: number
  lastFired: string
}

export const METRIC_BY_DIM: Record<AlertDim, AlertMetric[]> = {
  渠道: ['p95延迟', '错误率', '配额占用率'],
  资源池: ['利用率'],
  全局: ['空闲卡位'],
  凭证: ['数量'],
  应用: ['成功率', '调用失败率', '解析失败率'],
}
export const METRIC_UNIT: Record<AlertMetric, string> = { p95延迟: 'ms', 错误率: '%', 配额占用率: '%', 利用率: '%', 空闲卡位: '卡', 数量: '个', 成功率: '%', 调用失败率: '%', 解析失败率: '%' }

const DEFAULT_RULES: AlertRule[] = [
  { id: 'AR-01', name: '高保集群容量触顶', dim: '资源池', metric: '利用率', obj: '高保服务集群', mode: '固定阈值', op: '>', threshold: 90, level: '重要', action: '生成建议工单', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-02', name: '共享集群过载预警', dim: '资源池', metric: '利用率', obj: '共享推理集群', mode: '固定阈值', op: '>', threshold: 85, level: '一般', action: '仅告警', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-03', name: '渠道错误率超阈（自动切换）', dim: '渠道', metric: '错误率', obj: '全部', mode: '固定阈值', op: '>', threshold: 2, level: '重要', action: '自动切换渠道', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-04', name: '渠道延迟基线偏离', dim: '渠道', metric: 'p95延迟', obj: '全部', mode: '基线偏离', op: '>', threshold: 40, level: '一般', action: '仅告警', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-05', name: '全局空闲卡位不足', dim: '全局', metric: '空闲卡位', obj: '算力资源池', mode: '固定阈值', op: '<', threshold: 4, level: '紧急', action: '生成建议工单', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-06', name: '凭证临期与僵尸识别', dim: '凭证', metric: '数量', obj: '临期 / 僵尸凭证', mode: '固定阈值', op: '>', threshold: 2, level: '一般', action: '自动凭证盘点', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-07', name: '知识库解析失败率超阈', dim: '应用', metric: '解析失败率', obj: '全部', mode: '固定阈值', op: '>', threshold: 8, level: '重要', action: '自动暂停或隔离', enabled: true, fired: 0, lastFired: '' },
  { id: 'AR-08', name: '智能体成功率骤降', dim: '应用', metric: '成功率', obj: '全部', mode: '固定阈值', op: '<', threshold: 90, level: '重要', action: '仅告警', enabled: true, fired: 0, lastFired: '' },
]

const RULE_KEY = 'dsh-demo-alert-rules-v1'
const BASE_KEY = 'dsh-demo-alert-baseline-v1'

let rules: AlertRule[] = loadRules()
dbSeed(RULE_KEY, rules)
let baselines: Record<string, number[]> = loadBaselines()
const listeners = new Set<() => void>()
let evaluating = false
const lastAt: Record<string, number> = {}

function loadRules(): AlertRule[] {
  try { const r = dbRead(RULE_KEY); return r ? JSON.parse(r) as AlertRule[] : structuredClone(DEFAULT_RULES) } catch { return structuredClone(DEFAULT_RULES) }
}
function loadBaselines(): Record<string, number[]> {
  try { const r = dbRead(BASE_KEY); return r ? JSON.parse(r) as Record<string, number[]> : {} } catch { return {} }
}
function persist() {
  try {
    dbWrite(RULE_KEY, JSON.stringify(rules))
    dbWrite(BASE_KEY, JSON.stringify(baselines))
  } catch { /* 落库失败已在数据层记录 */ }
}
function emit() { rules = [...rules]; listeners.forEach((l) => l()) }
function nowStr() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

interface Sample { key: string; dim: AlertDim; obj: string; metric: AlertMetric; unit: string; value: number; ctx: Record<string, string> }

function sample(st: EngineState): Sample[] {
  const out: Sample[] = []
  st.pools.forEach((p) => out.push({ key: `pool:${p.id}`, dim: '资源池', obj: p.name, metric: '利用率', unit: '%', value: poolUtil(st, p.id), ctx: { poolId: p.id } }))
  st.channels.forEach((c) => {
    out.push({ key: `lat:${c.id}`, dim: '渠道', obj: c.name, metric: 'p95延迟', unit: 'ms', value: c.latency, ctx: { channelId: c.id } })
    out.push({ key: `err:${c.id}`, dim: '渠道', obj: c.name, metric: '错误率', unit: '%', value: c.err, ctx: { channelId: c.id } })
    out.push({ key: `quota:${c.id}`, dim: '渠道', obj: c.name, metric: '配额占用率', unit: '%', value: c.capacityRpm > 0 ? Math.round((c.allocatedRpm / c.capacityRpm) * 100) : 100, ctx: { channelId: c.id } })
  })
  out.push({ key: 'free-cards', dim: '全局', obj: '算力资源池', metric: '空闲卡位', unit: '卡', value: freeCards(st), ctx: {} })
  const risky = st.creds.filter((c) => c.status !== 'off' && (c.expDays <= 15 || c.lastUsedDays >= 90)).length
  out.push({ key: 'cred-risk', dim: '凭证', obj: '临期 / 僵尸凭证', metric: '数量', unit: '个', value: risky, ctx: {} })
  st.managed.forEach((m) => {
    out.push({ key: `app-succ:${m.id}`, dim: '应用', obj: m.name, metric: '成功率', unit: '%', value: m.success, ctx: { kind: m.kind, name: m.name } })
    out.push({ key: `app-fail:${m.id}`, dim: '应用', obj: m.name, metric: '调用失败率', unit: '%', value: m.failRate, ctx: { kind: m.kind, name: m.name } })
    if (m.kind === '知识库') out.push({ key: `app-parse:${m.id}`, dim: '应用', obj: m.name, metric: '解析失败率', unit: '%', value: m.parseFail, ctx: { kind: m.kind, name: m.name } })
  })
  return out
}

function hit(r: AlertRule, s: Sample): { fired: boolean; detail: string } {
  if (r.mode === '固定阈值') {
    const ok = r.op === '>' ? s.value > r.threshold : s.value < r.threshold
    return { fired: ok, detail: ok ? `${s.obj} ${s.metric} ${s.value}${s.unit} ${r.op} ${r.threshold}${s.unit}` : '' }
  }
  const hist = baselines[s.key] ?? []
  if (hist.length < 3) return { fired: false, detail: '基线样本不足（需 3 次采样）' }
  const base = hist.reduce((a, b) => a + b, 0) / hist.length
  const dev = base === 0 ? 0 : ((s.value - base) / base) * 100
  const ok = r.op === '>' ? dev > r.threshold : dev < -r.threshold
  return { fired: ok, detail: ok ? `${s.obj} ${s.metric} ${s.value}${s.unit}，基线 ${base.toFixed(1)}${s.unit}，偏离 ${dev > 0 ? '+' : ''}${dev.toFixed(0)}%` : '' }
}

function act(r: AlertRule, s: Sample) {
  if (r.action === '自动暂停或隔离') {
    const res = engine.autoContainment(s.ctx.kind as '知识库' | '智能体应用' | 'MCP工具' | '插件', s.ctx.name, `告警规则「${r.name}」触发：${s.obj} ${s.metric} ${s.value}${s.unit} 超阈值`)
    return res.ok ? `已自动执行处置「${res.action}」→ ${res.status}（工单 ${res.orderId}）` : `处置未执行：${res.reason}`
  }
  if (r.action === '仅告警') return ''
  if (r.action === '自动切换渠道') {
    const res = engine.failover(s.ctx.channelId)
    return res.ok ? `已自动切换渠道：${res.from} → ${res.to}` : `切换未执行：${res.reason}`
  }
  if (r.action === '自动凭证盘点') {
    const n = engine.scanCreds()
    return `已自动执行凭证盘点，识别 ${n} 项回收建议`
  }
  if (r.action === '生成建议工单') {
    if (s.ctx.poolId) {
      const rr = engine.submit({ type: 'pool_expand', applicant: '运行监测 · 自动处置', dept: '模型中心', level: '高保', reason: `${r.name}：${s.obj} ${s.metric} ${s.value}${s.unit}`, spec: { pool: s.ctx.poolId, cards: 4 }, auto: true })
      return rr.precheck.ok ? `已生成扩容建议工单 ${rr.order.id}（+4 卡）` : `建议工单被准入校验拒绝：${rr.precheck.reason}`
    }
    if (s.key === 'free-cards') {
      const donor = engine.get().pools.find((p) => poolUtil(engine.get(), p.id) < 60)
      const rr = engine.submit({ type: 'pool_release', applicant: '运行监测 · 自动处置', dept: '模型中心', level: '共享', reason: `${r.name}：全局空闲卡位 ${s.value}${s.unit} 不足`, spec: { pool: donor?.id ?? 'train', cards: 2 }, auto: true })
      return rr.precheck.ok ? `已生成资源回收建议工单 ${rr.order.id}` : `建议工单被准入校验拒绝：${rr.precheck.reason}`
    }
    const n = engine.scanCreds()
    return `已自动执行凭证盘点，识别 ${n} 项回收建议`
  }
  return ''
}

export function evaluateRules(): { fired: number; log: string[] } {
  if (evaluating) return { fired: 0, log: [] }
  evaluating = true
  const log: string[] = []
  try {
    const st = engine.get()
    const ss = sample(st)
    ss.forEach((s) => {
      const hist = baselines[s.key] ?? []
      hist.push(s.value)
      if (hist.length > 12) hist.shift()
      baselines[s.key] = hist
    })
    rules.filter((r) => r.enabled).forEach((r) => {
      ss.filter((s) => s.dim === r.dim && s.metric === r.metric && (r.obj === '全部' || s.obj === r.obj)).forEach((s) => {
        const h = hit(r, s)
        if (!h.fired) return
        if (lastAt[r.id] && Date.now() - lastAt[r.id] < 25000) return
        lastAt[r.id] = Date.now()
        r.fired += 1
        r.lastFired = nowStr()
        const actText = act(r, s)
        notifyStore.push(r.level, `告警：${r.name}`, `${h.detail}${actText ? ' · 处置：' + actText : ''}`, `${r.dim === '凭证' ? '模型中心' : r.dim === '渠道' ? '模型中心 / 推理网关' : '算力中心'}`, `RULE:${r.id}:${s.obj}`)
        engine.get().events.unshift({ time: nowStr(), level: r.level, text: `告警规则「${r.name}」触发：${h.detail}${actText ? ' · ' + actText : ''}` })
        log.push(`${r.name} → ${h.detail}${actText ? ' · ' + actText : ''}`)
      })
    })
    persist()
    emit()
    if (log.length) engine.refresh()
  } finally { evaluating = false }
  return { fired: log.length, log }
}

export const ruleStore = {
  get: () => rules,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  baselines: () => baselines,
  toggle(id: string) { rules = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)); persist(); emit() },
  setThreshold(id: string, v: number) { rules = rules.map((r) => (r.id === id ? { ...r, threshold: v } : r)); persist(); emit() },
  setOp(id: string, op: '>' | '<') { rules = rules.map((r) => (r.id === id ? { ...r, op } : r)); persist(); emit() },
  setAction(id: string, a: AlertAction) { rules = rules.map((r) => (r.id === id ? { ...r, action: a } : r)); persist(); emit() },
  setLevel(id: string, l: AlertLevel) { rules = rules.map((r) => (r.id === id ? { ...r, level: l } : r)); persist(); emit() },
  create(input: { name: string; dim: AlertDim; metric: AlertMetric; obj: string; mode: AlertMode; op: '>' | '<'; threshold: number; level: AlertLevel; action: AlertAction }) {
    const id = `AR-${String(rules.length + 1).padStart(2, '0')}${Date.now() % 100}`
    rules = [{ id, ...input, enabled: true, fired: 0, lastFired: '' }, ...rules]
    persist(); emit()
    notifyStore.push('一般', `告警规则已启用：${input.name}`, `${input.dim} · ${input.obj} · ${input.metric} ${input.op} ${input.threshold}（${input.mode}）· 处置：${input.action}`, '运营分析')
    return id
  },
  remove(id: string) { rules = rules.filter((r) => r.id !== id); persist(); emit() },
  reset() { rules = structuredClone(DEFAULT_RULES); baselines = {}; persist(); emit() },
  samplesNow: () => sample(engine.get()),
}

/** 引擎每次状态变化后自动评估一次（采样即巡检） */
engine.subscribe(() => { evaluateRules() })

export function useAlertRules() {
  return useSyncExternalStore(ruleStore.subscribe, ruleStore.get, ruleStore.get)
}
