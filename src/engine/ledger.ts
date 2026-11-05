/* =====================================================================
 * 实时账本：调用量 / Token / 成本由运行态推导，与资源与处置动作联动
 * 依据：模型副本与卡位、渠道权重（本地 vs 外部）、纳管对象处置状态、下线变更
 * ===================================================================== */
import { type EngineState, MODEL_APPS } from './engine'
import { rentConfig } from './connectors'
import { apps as mockApps } from '../data/mock'
import { dbRead, dbWrite } from './db'


const CARD_RPM = 22 // 每张推理卡可持续承载调用数（次/分钟，演示折算口径）
const TOKENS_PER_CALL = 820 // 平均单次调用 Token 数
const LOCAL_CARD_DAY_COST = 210 // 本地卡位日成本（元/卡/日：折旧 + 机房 + 运维折算）
const EXTERNAL_TOKEN_COST = 0.9 // 外部渠道 Token 单价（元/万 token）
const BASE_DAILY_CALLS = 416000 // 基线日调用量（与初始副本配置对应的历史口径）
const BASE_CAPACITY = 18 // 初始纳管副本对应承载卡位（4×2 + 2 + 2 + 1 + 1 + 2×2）
const BASE_ALLOC = 28 // 初始推理池已分配卡位（高保 12 + 共享 16）

const HOUR_WEIGHTS = [0.18, 0.10, 0.07, 0.06, 0.07, 0.12, 0.30, 0.62, 0.88, 1.05, 1.16, 1.08, 0.82, 0.95, 1.10, 1.14, 1.02, 0.86, 0.74, 0.66, 0.58, 0.48, 0.36, 0.26]
const CITY_SHARES = [
  { name: '示范市01', share: 0.245, districts: [{ name: '城区甲', share: 0.38 }, { name: '城区乙', share: 0.27 }, { name: '城郊片区', share: 0.2 }, { name: '县级市甲', share: 0.15 }] },
  { name: '示范市02', share: 0.163, districts: [{ name: '城区甲', share: 0.34 }, { name: '城区乙', share: 0.26 }, { name: '城区丙', share: 0.24 }, { name: '县级市甲', share: 0.16 }] },
  { name: '示范市03', share: 0.146, districts: [{ name: '城区甲', share: 0.33 }, { name: '城区乙', share: 0.25 }, { name: '城区丙', share: 0.24 }, { name: '示范县甲', share: 0.18 }] },
  { name: '示范市09', share: 0.102, districts: [{ name: '城区甲', share: 0.42 }, { name: '县级市甲', share: 0.31 }, { name: '示范县甲', share: 0.27 }] },
  { name: '示范市10', share: 0.081, districts: [{ name: '城区甲', share: 0.44 }, { name: '县级市甲', share: 0.32 }, { name: '县级市乙', share: 0.24 }] },
  { name: '示范市04', share: 0.071, districts: [{ name: '城区甲', share: 0.41 }, { name: '城区乙', share: 0.35 }, { name: '县级市甲', share: 0.24 }] },
  { name: '示范市12', share: 0.066, districts: [{ name: '城区甲', share: 0.4 }, { name: '城区乙', share: 0.34 }, { name: '城郊片区', share: 0.26 }] },
  { name: '示范市05', share: 0.062, districts: [{ name: '城区甲', share: 0.46 }, { name: '城区乙', share: 0.31 }, { name: '城区丙', share: 0.23 }] },
  { name: '示范市07', share: 0.055, districts: [{ name: '城区甲', share: 0.45 }, { name: '示范县甲', share: 0.32 }, { name: '示范县乙', share: 0.23 }] },
]

/* 项目组成本分摊口径：按用量占比 或 按预算科目权重（演示版两种都算，规则待客户方确认） */
export type AllocMode = 'usage' | 'budget'
const ALLOC_KEY = 'dsh-demo-allocation-v1'
const BUDGET_WEIGHTS: Record<string, number> = {
  '文书撰写项目组': 0.24, '法规问答项目组': 0.18, '图像识别项目组': 0.16, '咨询服务项目组': 0.13,
  '训练带教项目组': 0.1, '公开信息项目组': 0.07, '专项检索项目组': 0.06, '装备维保项目组': 0.04, '低空巡检试点项目组': 0.02,
}
export function getAllocMode(): AllocMode {
  try { return dbRead(ALLOC_KEY) === 'budget' ? 'budget' : 'usage' } catch { return 'usage' }
}
export function setAllocMode(mode: AllocMode) {
  try { dbWrite(ALLOC_KEY, mode) } catch { /* 落库失败已在数据层记录 */ }
}
export interface DistrictRow { city: string; name: string; calls: number; tokens: number; cost: number }

export interface LedgerRow { name: string; calls: number; tokens: number; cost: number; note?: string; dept?: string; cards?: number }
const PROJECTS: { name: string; line: string; apps: string[] }[] = [
  { name: '文书撰写项目组', line: '示例业务一部', apps: ['报告撰写助手', '记录结构化助手'] },
  { name: '图像识别项目组', line: '示例业务二部', apps: ['交通违规图像审核', '新车驾管知识问答'] },
  { name: '法规问答项目组', line: '示例业务三部', apps: ['法规知识问答'] },
  { name: '咨询服务项目组', line: '综合业务', apps: ['咨询问答助手', '社区走访风险预测'] },
  { name: '公开信息项目组', line: '示例业务四部', apps: ['公开信息筛选'] },
  { name: '训练带教项目组', line: '训练', apps: ['新人带教助手'] },
  { name: '专项检索项目组', line: '专项手段', apps: ['专项数据检索助手'] },
  { name: '装备维保项目组', line: '信息化管理部', apps: ['装备维保知识库'] },
  { name: '低空巡检试点项目组', line: '低空巡检', apps: ['无人机飞行计划审核'] },
]

export interface PersonUsage { name: string; creds: number; rpm: number; share: number; calls: number; tokens: number; cost: number; points: number; expSoon: number; revoked: number }
export interface ProjectUsage { name: string; line: string; apps: number; calls: number; tokens: number; cost: number; cards: number; note?: string }

export interface Ledger {
  rpm: number
  callsToday: number
  tokensToday: number
  costToday: number
  localCost: number
  externalCost: number
  externalShare: number
  rentCards: number
  rentCost: number
  rentPrice: number
  liveCards: number
  allocCards: number
  capacityFactor: number
  allocFactor: number
  perModel: LedgerRow[]
  perApp: LedgerRow[]
  perCity: LedgerRow[]
  perLine: LedgerRow[]
  series: { hour: string; calls: number; tokens: number; cost: number }[]
  trend30: { day: string; tokens: number }[]
  throttled: string[]
  stopped: string[]
  perProject: ProjectUsage[]
  perPerson: PersonUsage[]
  perDistrict: DistrictRow[]
  allocMode: AllocMode
}

function appLiveFactor(st: EngineState, appName: string, modelRef: string): { mult: number; note: string } {
  const m = st.managed.find((x) => x.name === appName)
  if (m && (m.status === '暂停' || m.status === '禁用')) return { mult: 0, note: `${m.status} · 已停止承接调用` }
  if (m && m.status === '隔离') return { mult: 0, note: '隔离 · 调用路由已摘除' }
  const modelShort = Object.keys(MODEL_APPS).find((k) => modelRef.includes(k))
  if (modelShort) {
    const mm = st.models.find((x) => x.short === modelShort)
    if (mm && mm.state === '已下线') return { mult: 0, note: '依赖模型已下线' }
    if (mm && mm.replicas === 0) return { mult: 0, note: '依赖模型无存活副本' }
  }
  if (m && m.status === '限流') return { mult: 0.4, note: '限流保护中 · 承载降至 40%' }
  return { mult: 1, note: '' }
}

export function ledgerOf(st: EngineState): Ledger {
  const liveModels = st.models.filter((m) => m.state === '运行中' && m.replicas > 0)
  const liveCards = liveModels.reduce((s, m) => s + m.replicas * m.perReplica, 0)
  const allocCards = st.pools.filter((p) => p.id !== 'train').reduce((s, p) => s + p.cards, 0)
  const capacityFactor = liveCards / BASE_CAPACITY
  const allocFactor = allocCards / BASE_ALLOC
  const throttled: string[] = []
  const stopped: string[] = []

  const appRows = mockApps.map((a) => {
    const base = parseFloat(a.calls) * 10000
    const { mult, note } = appLiveFactor(st, a.name, a.model)
    if (mult === 0) stopped.push(a.name)
    else if (mult < 1) throttled.push(a.name)
    return { name: a.name, dept: a.dept, base, mult, note }
  })
  const baseTotal = appRows.reduce((s, a) => s + a.base, 0)
  const liveRatio = appRows.reduce((s, a) => s + a.base * a.mult, 0) / baseTotal
  const callsToday = Math.round(BASE_DAILY_CALLS * capacityFactor * liveRatio)
  const tokensToday = Math.round((callsToday * TOKENS_PER_CALL) / 10000) // 万 token

  const extWeights = st.channels.filter((c) => c.kind === '外部').reduce((s, c) => s + c.weight, 0)
  const externalShare = extWeights / 100
  const externalTokens = Math.round(tokensToday * externalShare)
  const rent = rentConfig()
  const rentCards = Math.max(0, st.rented ?? 0)
  const rentPrice = rent.price || 260
  const localCost = Math.round((allocCards - rentCards) * LOCAL_CARD_DAY_COST)
  const rentCost = Math.round(rentCards * rentPrice)
  const externalCost = Math.round(externalTokens * EXTERNAL_TOKEN_COST) + rentCost
  const costToday = localCost + externalCost

  const perApp: LedgerRow[] = appRows
    .map((a) => {
      const calls = Math.round(callsToday * (a.base / baseTotal) * a.mult)
      const tokens = Math.round((calls * TOKENS_PER_CALL) / 10000)
      return { name: a.name, dept: a.dept, calls, tokens, cost: Math.round((costToday * calls) / Math.max(1, callsToday)), note: a.note }
    })
    .sort((x, y) => y.calls - x.calls)

  const modelBase = liveCards || 1
  const perModel: LedgerRow[] = st.models.map((m) => {
    const cards = m.replicas * m.perReplica
    const share = cards / modelBase
    const calls = m.state === '运行中' ? Math.round(callsToday * share) : 0
    const tokens = Math.round((calls * TOKENS_PER_CALL) / 10000)
    return { name: m.short, cards, calls, tokens, cost: Math.round(localCost * share), note: m.state === '已下线' ? '已下线 · 无存活副本' : `${cards} 卡 · ${m.ver}` }
  }).filter((r) => r.calls > 0 || r.note?.includes('已下线')).sort((x, y) => y.calls - x.calls)

  const perCity: LedgerRow[] = CITY_SHARES.map((c) => ({
    name: c.name,
    calls: Math.round(callsToday * c.share),
    tokens: Math.round((callsToday * c.share * TOKENS_PER_CALL) / 10000),
    cost: Math.round(costToday * c.share),
    note: `${c.districts.length} 个下级单位 / 分区已逐级归集`,
  }))
  const perDistrict: DistrictRow[] = CITY_SHARES.flatMap((c) => c.districts.map((d) => ({
    city: c.name,
    name: d.name,
    calls: Math.round(callsToday * c.share * d.share),
    tokens: Math.round((callsToday * c.share * d.share * TOKENS_PER_CALL) / 10000),
    cost: Math.round(costToday * c.share * d.share),
  })))

  const lineMap = new Map<string, number>()
  appRows.forEach((a) => {
    const key = a.dept === '示例业务三部' || a.dept === '训练' ? '示例业务三部/训练' : a.dept
    lineMap.set(key, (lineMap.get(key) ?? 0) + a.base * a.mult)
  })
  const lineTotal = Array.from(lineMap.values()).reduce((s, v) => s + v, 0) || 1
  const perLine: LedgerRow[] = Array.from(lineMap.entries())
    .map(([name, v]) => ({ name, calls: Math.round(callsToday * (v / lineTotal)), tokens: Math.round((callsToday * (v / lineTotal) * TOKENS_PER_CALL) / 10000), cost: Math.round(costToday * (v / lineTotal)) }))
    .sort((x, y) => y.cost - x.cost)

  const wSum = HOUR_WEIGHTS.reduce((s, x) => s + x, 0)
  const nowHour = new Date().getHours()
  const series = HOUR_WEIGHTS.map((w, i) => {
    const idx = (nowHour - (23 - i) + 24) % 24
    const calls = Math.round((callsToday * w) / wSum)
    const tokens = Math.round((calls * TOKENS_PER_CALL) / 10000)
    return { hour: `${String(idx).padStart(2, '0')}:00`, calls, tokens, cost: Math.round((costToday * w) / wSum) }
  })

  const today = new Date()
  const trend30 = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getTime() - (29 - i) * 86400000)
    const growth = 0.82 + (i / 29) * 0.3
    const wave = 1 + Math.sin(i / 2.4) * 0.09 - (i % 7 === 5 || i % 7 === 6 ? 0.12 : 0)
    return { day: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, tokens: Math.round(tokensToday * growth * wave) }
  })

  const appCost = new Map(perApp.map((a) => [a.name, a]))
  const perProject: ProjectUsage[] = PROJECTS.map((pr) => {
    const rows = pr.apps.map((n) => appCost.get(n)).filter(Boolean) as LedgerRow[]
    const calls = rows.reduce((sm, r) => sm + r.calls, 0)
    const tokens = rows.reduce((sm, r) => sm + r.tokens, 0)
    const cost = rows.reduce((sm, r) => sm + r.cost, 0)
    const usageShare = callsToday > 0 ? calls / callsToday : 0
    const mode = getAllocMode()
    const share = mode === 'budget' ? (BUDGET_WEIGHTS[pr.name] ?? 0) : usageShare
    return {
      name: pr.name, line: pr.line, apps: rows.length, calls, tokens,
      cost: Math.round(costToday * share), cards: Math.round(allocCards * share * 10) / 10,
      note: mode === 'budget' ? `按用量本应占 ${(usageShare * 100).toFixed(1)}%，按预算科目记 ${(share * 100).toFixed(1)}%` : `按用量占比 ${(usageShare * 100).toFixed(1)}%`,
    }
  }).sort((x, y) => y.cost - x.cost)

  const activeCreds = st.creds.filter((c) => c.status !== 'off')
  const totalRpm = activeCreds.reduce((sm, c) => sm + c.rpm, 0) || 1
  const byHolder = new Map<string, { creds: number; rpm: number; expSoon: number; revoked: number }>()
  st.creds.forEach((c) => {
    const cur = byHolder.get(c.holder) ?? { creds: 0, rpm: 0, expSoon: 0, revoked: 0 }
    cur.creds += 1
    if (c.status !== 'off') cur.rpm += c.rpm
    if (c.status !== 'off' && c.expDays <= 15) cur.expSoon += 1
    if (c.status === 'off') cur.revoked += 1
    byHolder.set(c.holder, cur)
  })
  const perPerson: PersonUsage[] = Array.from(byHolder.entries()).map(([name, v]) => {
    const share = v.rpm / totalRpm
    const calls = Math.round(callsToday * share)
    const tokens = Math.round((calls * TOKENS_PER_CALL) / 10000)
    return { name, creds: v.creds, rpm: v.rpm, share: Math.round(share * 1000) / 10, calls, tokens, cost: Math.round(costToday * share), points: Math.round(tokens * 8), expSoon: v.expSoon, revoked: v.revoked }
  }).sort((x, y) => y.calls - x.calls)

  return {
    rpm: Math.round((callsToday / 1440) * 100) / 100,
    callsToday, tokensToday, costToday, localCost, externalCost, externalShare, rentCards, rentCost, rentPrice,
    liveCards, allocCards, capacityFactor: Math.round(capacityFactor * 100) / 100, allocFactor: Math.round(allocFactor * 100) / 100,
    perModel, perApp, perCity, perLine, series, trend30, throttled, stopped, perProject, perPerson, perDistrict, allocMode: getAllocMode(),
  }
}
