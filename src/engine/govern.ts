/* =====================================================================
 * 统一接管登记表（算力平台 / 算力资源 / 智能体 / Skill / MCP）
 * 接管不是「挂个名字」，而是四级能力，深度由「接入配置就绪程度」实时推导：
 *   L1 可见（登记在册）→ L2 可度量（采到运行指标）→ L3 可处置（下发指令并生效）→ L4 可调度（纳入统一调度与变更窗口）
 * 所以「能不能接管、接管到哪一级」不是嘴上说的，改接入配置就会变。
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { connectorStore, type Connector } from './connectors'
import { engine } from './engine'

export type Domain = '算力平台' | '算力资源' | '智能体' | 'Skill' | 'MCP'
export const DOMAINS: Domain[] = ['算力平台', '算力资源', '智能体', 'Skill', 'MCP']
export const DEPTH_LABEL: Record<number, string> = { 1: 'L1 可见', 2: 'L2 可度量', 3: 'L3 可处置', 4: 'L4 可调度' }
export const DEPTH_WHY: Record<number, string> = {
  1: '只登记在册，数据靠人工填报 / 离线导入',
  2: '能采到运行指标，可出报表与告警，但指令下不去',
  3: '可下发处置指令并在平台侧生效（暂停 / 限流 / 隔离 / 禁用）',
  4: '纳入统一调度与变更窗口（卡位、副本、权重、排期）',
}

export interface Governed {
  id: string
  domain: Domain
  name: string
  source: '自建' | '已建子系统' | '外部厂商' | '边缘 / 终端' | '第三方资源'
  vendor: string
  scale: string
  cards: number
  connectorId: string
  wantDepth: 1 | 2 | 3 | 4
  owner: string
  cls: '公开' | '内部' | '敏感'
  note: string
}

const G = (g: Governed) => g

const SEED: Governed[] = [
  // 算力平台
  G({ id: 'g-cp-local', domain: '算力平台', name: '本地昇腾推理集群（AI-Infer-01/02）', source: '自建', vendor: '华为昇腾', scale: '高保 14 卡 / 共享 16 卡 / 训练 16 卡', cards: 46, connectorId: '', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '平台原生纳管：卡位、副本、权重、变更窗口全可控' }),
  G({ id: 'g-cp-cambricon', domain: '算力平台', name: '寒武纪本地推理池', source: '自建', vendor: '寒武纪', scale: 'GLM 系列 2 副本 / 4 卡', cards: 4, connectorId: '', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '渠道健康与权重可实时调整' }),
  G({ id: 'g-cp-train', domain: '算力平台', name: '模型训练平台（微调 / 带教）', source: '已建子系统', vendor: '子系统厂商', scale: '16 卡训练池 · LoRA 任务队列', cards: 16, connectorId: 'i-train', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '任务与卡位占用需接口回传才能纳入统一排期' }),
  G({ id: 'g-cp-video', domain: '算力平台', name: '视频图像专网 NPU 集群', source: '已建子系统', vendor: '视频平台厂商', scale: '24 卡 · 图像审核专用', cards: 24, connectorId: 'i-agent', wantDepth: 4, owner: '示例业务二部', cls: '内部', note: '专网侧调度指令需设备侧执行回执' }),
  G({ id: 'g-cp-rent', domain: '算力平台', name: '第三方 GPU 扩租池', source: '第三方资源', vendor: '资源方', scale: '额度 8 卡 · 260 元/卡/日', cards: 8, connectorId: 'r-gpu', wantDepth: 4, owner: '客户方 + 资源方', cls: '内部', note: '启用后可在本地不足时补卡位；未启用则只能登记' }),
  G({ id: 'g-cp-edge', domain: '算力平台', name: '边缘推理盒子（基层站点 / 前端节点）', source: '边缘 / 终端', vendor: '多家硬件厂商', scale: '12 个站点 · 每站 1-2 卡', cards: 18, connectorId: 'r-extdata', wantDepth: 3, owner: '属地机关事业单位', cls: '内部', note: '站点分散，需现场运维配合，暂不纳入统一调度' }),

  // 算力资源
  G({ id: 'g-res-cards', domain: '算力资源', name: '推理卡位池（88 卡总量）', source: '自建', vendor: '自建机房', scale: '已分配 30 卡 · 空闲 42 卡 · 训练 16 卡', cards: 88, connectorId: '', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '扩容 / 回收 / 抢占全部走工单与变更窗口' }),
  G({ id: 'g-res-storage', domain: '算力资源', name: '分布式存储与向量库存储', source: '自建', vendor: '自建', scale: '480 TB · 配额与用量台账', cards: 0, connectorId: '', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '配额调整走变更单' }),
  G({ id: 'g-res-backup', domain: '算力资源', name: '外部备份与冷存储', source: '第三方资源', vendor: '客户方指定服务商', scale: '120 TB · SFTP 批量交换', cards: 0, connectorId: 'r-backup', wantDepth: 3, owner: '客户方', cls: '敏感', note: '保留期与恢复演练频次未定，暂不做平台侧排程' }),
  G({ id: 'g-res-net', domain: '算力资源', name: '跨网链路与带宽（示例单位信息网 / 视频专网 / 接入区）', source: '自建', vendor: '网络运维', scale: '3 条链路 · 带宽与可用率台账', cards: 0, connectorId: '', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '链路切换属网络侧操作，平台只展示与告警' }),

  // 智能体
  G({ id: 'g-ag-report', domain: '智能体', name: '报告撰写助手', source: '已建子系统', vendor: '子系统厂商', scale: '高保 · 6 副本 · 99.1% 成功率', cards: 0, connectorId: 'i-agent', wantDepth: 4, owner: '示例业务一部', cls: '敏感', note: '限流 / 暂停 / 回滚已可下发' }),
  G({ id: 'g-ag-interview', domain: '智能体', name: '咨询问答助手', source: '已建子系统', vendor: '子系统厂商', scale: '高保 · 2 副本', cards: 0, connectorId: 'i-agent', wantDepth: 4, owner: '示例业务五部', cls: '内部', note: '可限流、可暂停，恢复须归口确认' }),
  G({ id: 'g-ag-image', domain: '智能体', name: '交通违规图像审核', source: '已建子系统', vendor: '子系统厂商', scale: '灰度 · 2 副本 / 4 卡', cards: 0, connectorId: 'i-agent', wantDepth: 4, owner: '示例业务二部', cls: '内部', note: '灰度批次与副本可调' }),
  G({ id: 'g-ag-opinion', domain: '智能体', name: '公开信息筛选', source: '已建子系统', vendor: '子系统厂商', scale: '共享 · 限流保护中', cards: 0, connectorId: 'i-agent', wantDepth: 4, owner: '示例业务四部', cls: '敏感', note: '处置动作与通知闭环已打通' }),
  G({ id: 'g-ag-12345', domain: '智能体', name: '12345 热线转办智能体', source: '外部厂商', vendor: '第三方服务商', scale: '接入区 · 日调用 3.2 万次', cards: 0, connectorId: 'r-extdata', wantDepth: 3, owner: '客户方', cls: '内部', note: '外部智能体：可度量，处置需服务商执行' }),
  G({ id: 'g-ag-train', domain: '智能体', name: '新人带教智能体', source: '已建子系统', vendor: '子系统厂商', scale: '训练池承载', cards: 0, connectorId: 'i-train', wantDepth: 3, owner: '训练处', cls: '内部', note: '训练平台侧的下线动作待回执确认' }),

  // Skill
  G({ id: 'g-sk-record', domain: 'Skill', name: '记录要素抽取 Skill', source: '已建子系统', vendor: '子系统厂商', scale: 'v3 · 引用 124 次', cards: 0, connectorId: 'i-plugin', wantDepth: 4, owner: '示例业务一部', cls: '敏感', note: '可禁用 / 启用并双向摘除目录' }),
  G({ id: 'g-sk-law', domain: 'Skill', name: '法条引用校验 Skill', source: '已建子系统', vendor: '子系统厂商', scale: 'v2.8 · 引用 158 次', cards: 0, connectorId: 'i-plugin', wantDepth: 4, owner: '示例业务三部', cls: '内部', note: '版本与提示词联动，改版须审批' }),
  G({ id: 'g-sk-label', domain: 'Skill', name: '图像复核标注 Skill', source: '已建子系统', vendor: '子系统厂商', scale: 'v4.0 · 灰度引用', cards: 0, connectorId: 'i-plugin', wantDepth: 3, owner: '示例业务二部', cls: '内部', note: '禁用可下发，启用需业务归口确认' }),
  G({ id: 'g-sk-doc', domain: 'Skill', name: '公文格式规范化 Skill（外部 Skill 仓库）', source: '外部厂商', vendor: '第三方 Skill 仓库', scale: 'v1.4 · 待上架', cards: 0, connectorId: 'i-plugin', wantDepth: 3, owner: '办公室', cls: '内部', note: '外部仓库：安装与更新在对方侧，平台管目录与启停' }),

  // MCP
  G({ id: 'g-mcp-addr', domain: 'MCP', name: '标准地址解析 MCP 服务', source: '自建', vendor: '自建', scale: '3 副本 · 51.2 万次/日', cards: 0, connectorId: 'i-mcp', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '双目录联动，可隔离出目录' }),
  G({ id: 'g-mcp-vehicle', domain: 'MCP', name: '车辆管理查询 MCP 服务', source: '已建子系统', vendor: '交通管理子系统', scale: '2 副本 · 36.4 万次/日', cards: 0, connectorId: 'i-mcp', wantDepth: 4, owner: '示例业务二部', cls: '敏感', note: '权限矩阵按角色 + 密级控制' }),
  G({ id: 'g-mcp-case', domain: 'MCP', name: '业务系统查询 MCP 服务', source: '已建子系统', vendor: '调度行子系统', scale: '4 副本 · 141.4 万次/日', cards: 0, connectorId: 'i-mcp', wantDepth: 4, owner: '情报中心', cls: '敏感', note: '检索量与命中可度量，可隔离' }),
  G({ id: 'g-mcp-video', domain: 'MCP', name: '视频图像检索 MCP 服务', source: '已建子系统', vendor: '视频子系统', scale: '已隔离出目录（演示）', cards: 0, connectorId: 'i-mcp', wantDepth: 4, owner: '信息化管理部', cls: '内部', note: '双目录摘除与恢复已演示' }),
  G({ id: 'g-mcp-cross', domain: 'MCP', name: '跨网数据交换 MCP 服务', source: '外部厂商', vendor: '待确认厂商', scale: '待上架 · 依赖跨网通道', cards: 0, connectorId: 'r-extdata', wantDepth: 2, owner: '客户方', cls: '敏感', note: '跨网通道与密级边界未定，暂只能登记' }),
]

function syncDependents(list: Governed[]) {
  for (const g of list) if (g.connectorId) connectorStore.registerDependent(g.connectorId, g.name)
}

const KEY = 'dsh-demo-govern-v1'
const listeners = new Set<() => void>()
let rows: Governed[] = load()
syncDependents(rows)

function load(): Governed[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) { const p = JSON.parse(raw) as Governed[]; if (Array.isArray(p) && p.length >= 15) return p }
  } catch { /* 演示环境忽略 */ }
  return SEED.map((g) => ({ ...g }))
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { /* 忽略 */ } }
function emit() { listeners.forEach((l) => l()) }

/** 纳管深度由接入配置实时推导（自建对象默认全接管） */
export function depthOf(g: Governed): { depth: 1 | 2 | 3 | 4; why: string } {
  if (g.source === '自建' && !g.connectorId) return { depth: 4, why: '自建资源：平台原生纳管，卡位 / 处置 / 调度全部生效' }
  const c = connectorStore.find(g.connectorId)
  if (!c) return { depth: 1, why: '未配置接入通道：只能登记在册' }
  if (!c.enabled) return { depth: 1, why: `接入通道未启用（${c.name} · ${c.status}）：只能登记与人工填报` }
  if (c.health === 'fault') return { depth: 1, why: `接入通道中断（${c.name}）：运行数据采不到，处置指令无回执` }
  if (c.blockedScope) return { depth: 3, why: `已做部分阻断（${c.blockedScope}：${c.blockedValue}）：该来源已切断，其余采集与处置仍生效` }
  if (c.status !== '已定') return { depth: 2, why: `接口状态「${c.status}」：可采基础指标出报表，处置指令下不去（${c.blocking}）` }
  const receiptKey = c.prereq.find((p) => p.includes('回执') || p.includes('执行'))
  if (receiptKey && !c.prereqDone.includes(receiptKey)) return { depth: 3, why: `接口已定：可下发处置，但「${receiptKey}」未完成，不纳入统一调度` }
  return { depth: 4, why: `接口已定 + 执行回执确认：可纳入统一调度与变更窗口（${c.transport} · ${c.mode === 'real' ? '真实接口' : '虚拟模拟'}）` }
}

export interface GovernedView extends Governed { depth: 1 | 2 | 3 | 4; why: string; connectorName: string; mode: string; statusLabel: string; demo: boolean; demoWhy: string }

/** 演示内能不能当场点到这个对象的处置动作（平台纳管表里有同名对象即可模拟生效） */
function demoActionable(g: Governed): { demo: boolean; demoWhy: string } {
  if (g.source === '自建' && !g.connectorId) return { demo: true, demoWhy: '平台内置对象，处置与调度当场生效' }
  const base = g.name.split('（')[0].trim()
  const hit = engine.get().managed.find((m) => m.name === base || m.name.includes(base) || base.includes(m.name))
  if (hit) return { demo: true, demoWhy: `演示内可处置（平台侧影子状态：${hit.id} · ${hit.status}）；真实环境需接口执行` }
  return { demo: false, demoWhy: '演示内也不可控：该对象不在平台纳管表内，只能登记与展示' }
}

export function governViews(): GovernedView[] {
  return rows.map((g) => {
    const d = depthOf(g)
    const c = connectorStore.find(g.connectorId)
    const statusLabel = d.depth >= 3 ? '已纳管' : d.depth === 2 ? '部分纳管（可度量）' : '未纳管（仅登记）'
    const demo = demoActionable(g)
    return { ...g, depth: d.depth, why: d.why, connectorName: c?.name ?? '（无需接入）', mode: c ? (c.mode === 'real' ? '真实接口' : '虚拟模拟') : '平台内置', statusLabel, demo: demo.demo, demoWhy: demo.demoWhy }
  })
}

export function governSummary() {
  const v = governViews()
  const total = v.length
  const manageable = v.filter((x) => x.depth >= 3).length
  const schedulable = v.filter((x) => x.depth >= 4).length
  const registeredOnly = v.filter((x) => x.depth === 1).length
  const demoActionableCount = v.filter((x) => x.demo).length
  const externalCards = v.filter((x) => (x.domain === '算力平台' || x.domain === '算力资源') && x.source !== '自建' && x.depth >= 4).reduce((s, x) => s + x.cards, 0)
  const visibleCards = v.filter((x) => (x.domain === '算力平台' || x.domain === '算力资源') && x.depth >= 2).reduce((s, x) => s + x.cards, 0)
  const byDomain = DOMAINS.map((d) => {
    const list = v.filter((x) => x.domain === d)
    return {
      domain: d, total: list.length,
      l3: list.filter((x) => x.depth >= 3).length,
      l4: list.filter((x) => x.depth >= 4).length,
      rate: list.length ? Math.round((list.filter((x) => x.depth >= 3).length / list.length) * 100) : 0,
    }
  })
  return {
    total, manageable, schedulable, registeredOnly, externalCards, visibleCards, byDomain, demoActionableCount,
    manageRate: Math.round((manageable / total) * 100),
    scheduleRate: Math.round((schedulable / total) * 100),
  }
}

export const governStore = {
  get: () => rows,
  views: governViews,
  summary: governSummary,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  setWantDepth(id: string, depth: 1 | 2 | 3 | 4) {
    rows = rows.map((g) => (g.id === id ? { ...g, wantDepth: depth } : g))
    persist(); emit()
  },
  setNote(id: string, note: string) { rows = rows.map((g) => (g.id === id ? { ...g, note } : g)); persist(); emit() },
  /** 把登记对象挂到某条接入配置上：深度立即按该配置就绪程度重算 */
  bind(id: string, connectorId: string) {
    const g = rows.find((x) => x.id === id)
    if (!g) return { ok: false as const, reason: '未找到该登记对象' }
    if (connectorId && !connectorStore.find(connectorId)) return { ok: false as const, reason: '未找到该接入配置' }
    rows = rows.map((x) => (x.id === id ? { ...x, connectorId } : x))
    if (connectorId) connectorStore.registerDependent(connectorId, rows.find((x) => x.id === id)!.name)
    persist(); emit()
    const d = depthOf(rows.find((x) => x.id === id)!)
    return { ok: true as const, id, depth: d.depth }
  },
  add(g: Omit<Governed, 'wantDepth'> & { wantDepth?: 1 | 2 | 3 | 4 }) {
    if (rows.some((x) => x.name === g.name)) return { ok: false as const, reason: '同名对象已登记，请改名或补充来源区分' }
    rows = [...rows, { ...g, wantDepth: g.wantDepth ?? 4 }]
    connectorStore.registerDependent(g.connectorId, g.name)
    persist(); emit()
    return { ok: true as const, id: g.id }
  },
  reset() { rows = SEED.map((g) => ({ ...g })); persist(); emit() },
}

export function useGovern() {
  return useSyncExternalStore(governStore.subscribe, governStore.get, governStore.get)
}

/* 接管深度取决于接入配置：订阅两边并缓存快照，避免重复渲染 */
const crossListeners = new Set<() => void>()
let viewsCache: GovernedView[] | null = null
function invalidateViews() { viewsCache = null }
function getViewsCached() {
  if (!viewsCache) viewsCache = governViews()
  return viewsCache
}
governStore.subscribe(invalidateViews)
connectorStore.subscribe(invalidateViews)

export function useGovernViews() {
  return useSyncExternalStore(
    (l) => {
      crossListeners.add(l)
      const offA = governStore.subscribe(() => { invalidateViews(); crossListeners.forEach((f) => f()) })
      const offB = connectorStore.subscribe(() => { invalidateViews(); crossListeners.forEach((f) => f()) })
      return () => { crossListeners.delete(l); offA(); offB() }
    },
    getViewsCached,
    getViewsCached,
  )
}
