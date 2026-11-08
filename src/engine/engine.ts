/* =====================================================================
 * 演示用「资源调配」引擎（纯前端可交互闭环）
 * 三条线：算力池扩缩 / 模型副本与路由权重 / 凭证配额
 * 能力：申请→审批（准入计算）→执行→生效验证→回收，全过程留痕
 * 状态持久化在数据服务的数据库（SQLite），浏览器本地不保存；可一键重置
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { gatewayChannels, credentials as seedCreds } from '../data/mock'
import { rentConfig, llmChannelConfig, connectorStore, readiness, type Connector } from './connectors'
import { dbRead, dbWrite } from './db'


const TOTAL_CARDS = 88
const STORAGE_KEY = 'dsh-demo-engine-v4'

export type Level = '高保' | '共享' | '灰度'
export type ScenarioId = 'channel' | 'hpPressure' | 'incident' | 'compliance' | 'nightWindow'
export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  channel: '渠道劣化与自动故障切换',
  hpPressure: '高保集群吃紧与优先抢占',
  incident: '重点事件高峰与限流保护',
  compliance: '合规抽查与凭证吊销申请',
  nightWindow: '夜间变更窗口与队列接续',
}
export type OrderType = 'training_dataset' | 'train_extend' | 'model_admission' | 'pool_expand' | 'pool_release' | 'preempt' | 'replica_scale' | 'weight_adjust' | 'credential_issue' | 'credential_revoke' | 'quota_adjust' | 'containment' | 'model_rollback' | 'model_retire' | 'access_block' | 'access_restore' | 'model_deploy' | 'train_reserve' | 'train_release'
/** 需要外部执行回执的工单：平台发单、容器平台 / 运维执行，回执到位才生效 */
export const EXTERNAL_TYPES: OrderType[] = ['model_deploy']
/** 紧急处置类工单：不受变更窗口与执行队列限制（例外监控阻断走这一类） */
/** 接入阻断范围：全通道 / 只停某几个采集项 / 只停某时段 / 只停某个来源 IP */
export const BLOCK_SCOPES = ['全通道', '采集项', '时段', '来源 IP']
export const URGENT_TYPES: OrderType[] = ['containment', 'access_block', 'access_restore', 'credential_revoke', 'quota_adjust']

export type ContainKind = '知识库' | '智能体应用' | 'MCP工具' | '插件' | 'Skill'
/** 双目录联动范围：MCP 工具 / 插件 / Skill 都在技术注册目录与业务使用目录两侧登记 */
export const DIRECTORY_KINDS: ContainKind[] = ['MCP工具', '插件', 'Skill']
export type ContainAction = '暂停入库' | '恢复入库' | '限流保护' | '暂停应用' | '恢复应用' | '隔离出目录' | '重新纳入' | '禁用' | '启用'
export type ManagedStatus = '正常' | '限流' | '暂停' | '隔离' | '禁用'
export type OrderStatus = 'submitted' | 'approved' | 'queued' | 'rejected' | 'running' | 'rolled_back' | 'closed' | 'external'

export type PoolId = 'hp' | 'shared' | 'train'
export interface Pool { id: 'hp' | 'shared' | 'train'; name: string; cards: number; policy: string; sla: string }
export interface ModelDef { name: string; short: string; pool: 'hp' | 'shared' | 'train'; replicas: number; perReplica: number; ver: string; versions: string[]; state: '运行中' | '已下线' }
export interface Channel { id: string; name: string; kind: '本地' | '外部'; replicas: number; weight: number; capacityRpm: number; allocatedRpm: number; health: 'ok' | 'warn' | 'fault'; latency: number; err: number }
export interface WindowSlot { id: string; date: string; from: string; to: string; scope: '全平台' | '高保集群' | '共享集群'; reason: string; by: string; status: '已预约' | '使用中' | '已结束' | '已取消'; note?: string }
export interface Managed { id: string; kind: ContainKind; name: string; owner: string; status: ManagedStatus; success: number; failRate: number; parseFail: number; queue: number; calls: string; level: Level; tech: boolean; biz: boolean }
export interface Cred { id: string; kind: '个人密钥' | '平台代理'; holder: string; app: string; model: string; channel: string; rpm: number; tpm: string; ip: string; expDays: number; lastUsedDays: number; status: 'ok' | 'warn' | 'off' }
export interface TraceItem { time: string; actor: string; action: string; detail: string; tone: 'good' | 'warn' | 'bad' | 'info' }
export interface Order {
  id: string
  type: OrderType
  title: string
  applicant: string
  dept: string
  level: Level
  target: string
  amount: string
  reason: string
  status: OrderStatus
  auto: boolean
  createdAt: number
  decidedAt?: number
  executedAt?: number
  decidedBy?: string
  rejectReason?: string
  spec: Record<string, number | string | boolean>
  trace: TraceItem[]
}

export interface TrainJob { id: string; name: string; pool: PoolId; cards: number; applicant: string; dept: string; framework: string; dataLevel: string; hours: number; dueAt: string; state: '运行中' | '排队中' | '已完成'
  reserveId?: string
  deadline?: number
  execution?: {
    reference: string
    parameters: string
    status: '已登记' | '运行中' | '失败' | '已完成'
    evidence: string
    artifact?: { version: string; location: string; sha256: string }
  }
}

export interface EngineState {
  pools: Pool[]
  models: ModelDef[]
  managed: Managed[]
  jobs: TrainJob[]
  windowSlots: WindowSlot[]
  channels: Channel[]
  creds: Cred[]
  orders: Order[]
  events: { time: string; level: '一般' | '重要' | '紧急'; text: string }[]
  tick: number
  rented: number
  seq: number
  history: { time: string; util: Record<string, number> }[]
  failover: { active: boolean; channelId: string; channelName: string; at: string; prevWeights: string; toChannel: string; affectedApps: string[]; orderId: string } | null
}

export const TYPE_LABEL: Record<OrderType, string> = {
  pool_expand: '资源池扩容',
  pool_release: '资源池回收',
  preempt: '高保优先抢占',
  replica_scale: '推理副本扩缩',
  weight_adjust: '路由权重调整',
  credential_issue: '凭证发放申请',
  credential_revoke: '凭证回收吊销',
  quota_adjust: '凭证配额调整',
  containment: '运行处置动作',
  model_rollback: '模型版本回退',
  model_retire: '模型下线变更',
  access_block: '接入通道阻断',
  access_restore: '接入通道恢复',
  model_admission: '模型准入',
  model_deploy: '模型部署与发布',
  training_dataset: '训练数据使用申请',
  train_extend: '训练算力延期',
  train_reserve: '训练算例申请',
  train_release: '训练卡位归还',
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { submitted: '待审批', approved: '已审批待执行', queued: '排队待窗口', rejected: '已驳回', running: '执行中', rolled_back: '已回滚', closed: '已闭环', external: '已下发·待回执' }

export const KIND_ACTIONS: Record<ContainKind, ContainAction[]> = {
  知识库: ['暂停入库', '恢复入库'],
  智能体应用: ['限流保护', '暂停应用', '恢复应用'],
  MCP工具: ['隔离出目录', '重新纳入'],
  插件: ['禁用', '启用'],
  Skill: ['禁用', '启用', '隔离出目录', '重新纳入'],
}
export const ACTION_STATUS: Record<ContainAction, ManagedStatus> = {
  暂停入库: '暂停', 恢复入库: '正常', 限流保护: '限流', 暂停应用: '暂停', 恢复应用: '正常',
  隔离出目录: '隔离', 重新纳入: '正常', 禁用: '禁用', 启用: '正常',
}
export const BASIS_OPTS = ['告警触发', '人工分析', '客户方指令', '合规抽查']

/** 模型 → 依赖该模型的业务应用（抢占时用于生成被抢占方通知） */
export const MODEL_APPS: Record<string, string[]> = {
  'Qwen3-32B': ['报告撰写助手（示例业务一部）', '记录摘要助手（示例业务三部）'],
  'GLM-4-9B': ['咨询问答助手（综合业务）', '窗口智能引导（示范市02）'],
  'BGE-M3': ['法规知识问答（全区）', '向量检索底层服务'],
  'Reranker': ['法规知识问答（重排序）'],
  'Whisper': ['咨询语音转写（示范市01）'],
  'Qwen2.5-VL': ['交通违规图像审核（示例业务二部）'],
}

/* ---------------- seed ---------------- */
const seedPools: Pool[] = [
  { id: 'hp', name: '高保服务集群', cards: 14, policy: '优先级抢占 · 核心业务优先', sla: '99.95%' },
  { id: 'shared', name: '共享推理集群', cards: 16, policy: '权重分流 · 延迟优先', sla: '99.9%' },
  { id: 'train', name: '训练资源池', cards: 16, policy: '队列排队 · 长任务保障', sla: '—' },
]

const seedModels: ModelDef[] = [
  { name: 'Qwen3-32B · 业务微调 v2.3', short: 'Qwen3-32B', pool: 'hp', replicas: 4, perReplica: 2, ver: 'v2.3', versions: ['v2.3', 'v2.2', 'v2.1'], state: '运行中' },
  { name: 'GLM-4-9B · 咨询问答', short: 'GLM-4-9B', pool: 'hp', replicas: 2, perReplica: 1, ver: 'v4.9-1', versions: ['v4.9-1', 'v4.9-0'], state: '运行中' },
  { name: 'BGE-M3（Embedding）', short: 'BGE-M3', pool: 'hp', replicas: 2, perReplica: 1, ver: 'v1.5', versions: ['v1.5', 'v1.4'], state: '运行中' },
  { name: 'BGE-Reranker-v2', short: 'Reranker', pool: 'shared', replicas: 1, perReplica: 1, ver: 'v2.0', versions: ['v2.0', 'v1.9'], state: '运行中' },
  { name: 'Whisper-large · 语音转写', short: 'Whisper', pool: 'shared', replicas: 1, perReplica: 1, ver: 'v4.0', versions: ['v4.0', 'v3.5'], state: '运行中' },
  { name: 'Qwen2.5-VL · 视频理解（灰度）', short: 'Qwen2.5-VL', pool: 'shared', replicas: 2, perReplica: 2, ver: 'v7.6', versions: ['v7.6', 'v7.5'], state: '运行中' },
]

const seedManaged: (Omit<Managed, 'tech' | 'biz'> & { tech?: boolean; biz?: boolean })[] = [
  { id: 'KB-01', kind: '知识库', name: '业务法规条例库', owner: '示例业务三部', status: '正常', success: 99.1, failRate: 0.9, parseFail: 1.2, queue: 12, calls: '128万/月', level: '高保' },
  { id: 'KB-02', kind: '知识库', name: '典型案例库（刑事）', owner: '示例业务一部', status: '正常', success: 98.6, failRate: 1.4, parseFail: 2.1, queue: 8, calls: '96万/月', level: '共享' },
  { id: 'KB-03', kind: '知识库', name: '咨询标准话术库', owner: '示例业务五部', status: '正常', success: 98.9, failRate: 1.1, parseFail: 1.6, queue: 5, calls: '64万/月', level: '共享' },
  { id: 'KB-04', kind: '知识库', name: '交通违规判例库', owner: '示例业务二部', status: '正常', success: 97.4, failRate: 2.6, parseFail: 3.4, queue: 26, calls: '41万/月', level: '共享' },
  { id: 'KB-05', kind: '知识库', name: '公开信息案例库', owner: '示例业务四部', status: '正常', success: 95.2, failRate: 4.8, parseFail: 6.2, queue: 48, calls: '6.2万/月', level: '灰度' },
  { id: 'AP-01', kind: '智能体应用', name: '报告撰写助手', owner: '示例业务一部', status: '正常', success: 99.2, failRate: 0.8, parseFail: 0, queue: 0, calls: '8.6万/日', level: '高保' },
  { id: 'AP-02', kind: '智能体应用', name: '交通违规图像审核', owner: '示例业务二部', status: '正常', success: 97.9, failRate: 2.1, parseFail: 0, queue: 0, calls: '2.8万/日', level: '灰度' },
  { id: 'AP-03', kind: '智能体应用', name: '公开信息筛选', owner: '示例业务四部', status: '正常', success: 96.8, failRate: 3.2, parseFail: 0, queue: 0, calls: '0.9万/日', level: '共享' },
  { id: 'AP-04', kind: '智能体应用', name: '专项数据检索助手', owner: '专项手段部门', status: '正常', success: 97.6, failRate: 2.4, parseFail: 0, queue: 0, calls: '0.7万/日', level: '高保' },
  { id: 'SK-01', kind: 'Skill', name: '记录要素抽取 Skill', owner: '示例业务一部', status: '正常', success: 98.4, failRate: 1.6, parseFail: 0, queue: 0, calls: '3.4万/日', level: '高保' },
  { id: 'SK-02', kind: 'Skill', name: '法条引用校验 Skill', owner: '示例业务三部', status: '正常', success: 99.3, failRate: 0.7, parseFail: 0, queue: 0, calls: '5.1万/日', level: '高保' },
  { id: 'SK-03', kind: 'Skill', name: '公文格式规范化 Skill', owner: '办公室', status: '正常', success: 96.1, failRate: 3.9, parseFail: 0, queue: 0, calls: '1.2万/日', level: '共享' },
  { id: 'MC-01', kind: 'MCP工具', name: '视频图像检索', owner: '信息化管理部', status: '正常', success: 94.8, failRate: 5.2, parseFail: 0, queue: 0, calls: '6.2万/日', level: '共享', tech: true, biz: false },
  { id: 'MC-02', kind: 'MCP工具', name: '车辆管理查询', owner: '示例业务二部', status: '正常', success: 99.1, failRate: 0.9, parseFail: 0, queue: 0, calls: '18万/日', level: '共享' },
  { id: 'MC-03', kind: 'MCP工具', name: '业务系统查询', owner: '信息化管理部', status: '正常', success: 99.6, failRate: 0.4, parseFail: 0, queue: 0, calls: '32万/日', level: '高保' },
  { id: 'PL-01', kind: '插件', name: '文档 OCR', owner: '信息化管理部', status: '正常', success: 98.9, failRate: 1.1, parseFail: 0, queue: 0, calls: '22万/日', level: '共享' },
  { id: 'PL-02', kind: '插件', name: '法规库检索', owner: '示例业务三部', status: '正常', success: 99.8, failRate: 0.2, parseFail: 0, queue: 0, calls: '46万/日', level: '高保' },
]

const seedChannels: Channel[] = gatewayChannels.map((c) => ({
  id: c.name.includes('昇腾') ? 'ascend' : c.name.includes('厂商') ? 'vendor' : 'cambricon',
  name: c.name,
  kind: c.type === '本地' ? '本地' : '外部',
  replicas: c.name.includes('昇腾') ? 6 : c.name.includes('厂商') ? 0 : 3,
  weight: c.weight,
  capacityRpm: parseInt(c.qps.split('/')[1]) * 60,
  allocatedRpm: 0,
  health: c.status as 'ok' | 'warn',
  latency: parseInt(c.latency),
  err: parseFloat(c.err),
}))

const seedCredsLive: Cred[] = seedCreds.map((c) => ({
  id: c.id,
  kind: c.type === '个人密钥' ? '个人密钥' : '平台代理',
  holder: c.holder,
  app: c.app,
  model: c.model,
  channel: c.model.includes('GLM') ? 'cambricon' : c.model.includes('DeepSeek') ? 'vendor' : 'ascend',
  rpm: typeof c.rpm === 'number' ? c.rpm : 60,
  tpm: c.tpm,
  ip: c.ip,
  expDays: c.status === 'off' ? -3 : c.status === 'warn' ? 6 : 28,
  lastUsedDays: c.status === 'off' ? 96 : 0,
  status: c.status as Cred['status'],
}))

function seedState(): EngineState {
  const st: EngineState = {
    pools: seedPools.map((p) => ({ ...p })),
    models: seedModels.map((m) => ({ ...m })),
    managed: seedManaged.map((m) => ({ tech: true, biz: true, ...m })),
    jobs: [
      { id: 'FT-118', name: 'Qwen3-8B 业务领域微调（LoRA）', pool: 'train', cards: 8, applicant: '示例业务一部 · 示例××', dept: '示例业务一部', framework: 'MindForm + MindIE', dataLevel: '内部（已脱敏）', hours: 36, dueAt: '11-06 18:00', state: '运行中' },
      { id: 'FT-121', name: 'VL 图像增广数据预处理', pool: 'train', cards: 6, applicant: '示例业务二部 · 示例××', dept: '示例业务二部', framework: 'MindForm', dataLevel: '敏感（专用网络内）', hours: 24, dueAt: '11-07 09:00', state: '排队中' },
    ],
    windowSlots: [{ id: 'CW-01', date: new Date().toISOString().slice(0, 10), from: '02:00', to: '05:00', scope: '全平台', reason: '演示默认开放窗口（可在排期页关闭并预约下一个）', by: '运营值班', status: '使用中' }],
    channels: seedChannels.map((c) => ({ ...c })),
    creds: seedCredsLive.map((c) => ({ ...c })),
    orders: [
      mkOrder(1, 'replica_scale', '共享推理集群 Qwen2.5-VL 副本扩容', '示例业务二部 · 平台代理', '示例业务二部', '灰度', 'Qwen2.5-VL', '+2 副本（+4 卡）', '违法图像审核进入灰度放量，需提升并发承载', 'submitted', false, { model: 'Qwen2.5-VL', delta: 2 }),
      mkOrder(2, 'credential_issue', '平台代理凭证发放 · 示例业务六部', '示例业务六部 · 示例××', '示例业务四部', '共享', 'SA-0121', 'RPM 120 / TPM 24万', '示例业务六部话术问答助手上线，需绑定 DeepSeek-V3 渠道', 'submitted', false, { kind: '平台代理', holder: '示例业务六部 · 示例××', app: '示例业务六部话术问答助手', model: 'DeepSeek-V3', channel: 'vendor', rpm: 120, tpm: '24万' }),
      mkOrder(3, 'pool_release', '训练池空闲资源回收', '运营值班 · 模型供给运营', '信息化管理部', '共享', '训练资源池', '-2 卡', 'LoRA 微调任务已完成，训练池利用率 50%，回收待变更窗口', 'approved', false, { pool: 'train', cards: 2 }),
    ],
    events: [
      { time: nowStr(), level: '重要', text: '高保服务集群利用率超 85% 持续 2 个采样周期，调度引擎已生成扩容建议' },
    ],
    rented: 0,
    tick: 0,
    seq: 4,
    history: [],
    failover: null,
  }
  syncChannelRpm(st)
  pushHistory(st)
  return st
}

/* ---------------- helpers ---------------- */
function nowStr() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function mkOrder(seq: number, type: OrderType, title: string, applicant: string, dept: string, level: Level, target: string, amount: string, reason: string, status: OrderStatus, auto: boolean, spec: Record<string, number | string | boolean>): Order {
  return { id: `WO-${String(seq).padStart(4, '0')}`, type, title, applicant, dept, level, target, amount, reason, status, auto, createdAt: Date.now(), spec, trace: [{ time: nowStr(), actor: applicant, action: '提交申请', detail: `${TYPE_LABEL[type]} · ${target} ${amount}`, tone: 'info' }] }
}
function demandOf(st: EngineState, poolId: Pool['id']) {
  const byModel = st.models.filter((m) => m.pool === poolId).reduce((s, m) => s + m.replicas * m.perReplica, 0)
  const byJob = (st.jobs ?? []).filter((j) => j.pool === poolId && j.state === '运行中').reduce((s, j) => s + j.cards, 0)
  return byModel + byJob
}
export function poolFree(st: EngineState, poolId: Pool['id']) {
  const p = st.pools.find((x) => x.id === poolId)!
  return p.cards - demandOf(st, poolId)
}
export function poolUtil(st: EngineState, poolId: Pool['id']) {
  const p = st.pools.find((x) => x.id === poolId)!
  if (p.cards === 0) return 0
  return Math.round((demandOf(st, poolId) / p.cards) * 100)
}
export function totalAllocated(st: EngineState) {
  return st.pools.reduce((s, p) => s + p.cards, 0)
}
export function freeCards(st: EngineState) {
  return TOTAL_CARDS - totalAllocated(st) + st.rented
}
/** 外部算力扩租通道状态（来自接入配置，改配置即改平台能力） */
export function rentInfo(st: EngineState) {
  const c = rentConfig()
  const used = st.rented
  const live = c.liveQuota ?? c.quota
  const available = c.enabled ? Math.max(0, live - used) : 0
  const blocked = !c.enabled
    ? `外部算力扩租通道未启用（${c.name} · 额度 ${c.quota} 卡 · ${c.status}）`
    : c.health === 'fault' ? `外部算力扩租通道探活失败（${c.name}），暂不可开卡` : ''
  return { enabled: c.enabled, quota: c.quota, liveQuota: live, used, available, price: c.price, mode: c.mode, status: c.status, blocked }
}
export function totalReplicas(st: EngineState) {
  return st.models.reduce((s, m) => s + m.replicas, 0)
}
export function activeCreds(st: EngineState) {
  return st.creds.filter((c) => c.status !== 'off').length
}
function syncChannelRpm(st: EngineState) {
  st.channels.forEach((c) => { c.allocatedRpm = st.creds.filter((x) => x.channel === c.id && x.status !== 'off').reduce((s, x) => s + x.rpm, 0) })
}
function pushHistory(st: EngineState) {
  st.history.push({ time: nowStr().slice(0, 5), util: { hp: poolUtil(st, 'hp'), shared: poolUtil(st, 'shared'), train: poolUtil(st, 'train') } })
  if (st.history.length > 24) st.history.shift()
}
function trace(o: Order, actor: string, action: string, detail: string, tone: TraceItem['tone']) {
  o.trace.push({ time: nowStr(), actor, action, detail, tone })
}

/** 抢占时被压缩的业务模型（按占用卡位从大到小，直到凑满抢占卡位） */
function affectedModels(st: EngineState, poolId: Pool['id'], cards: number): ModelDef[] {
  const inPool = st.models.filter((m) => m.pool === poolId).map((m) => ({ m, c: m.replicas * m.perReplica }))
  inPool.sort((a, b) => b.c - a.c)
  const out: ModelDef[] = []
  let acc = 0
  for (const it of inPool) { out.push(it.m); acc += it.c; if (acc >= cards) break }
  return out
}
function affectedApps(st: EngineState, poolId: Pool['id'], cards: number): ModelDef[] {
  return affectedModels(st, poolId, cards)
}
function affectedLabel(st: EngineState, poolId: Pool['id'], cards: number) {
  return affectedModels(st, poolId, cards)
    .map((m) => `${m.short}（${(MODEL_APPS[m.short] ?? ['—']).join('、')}）`)
    .join(' | ')
}
/** 依赖某模型的业务应用（用于版本回退 / 下线的变更联动通知） */
export function appsOfModel(st: EngineState, short: string): string[] {
  const creds = st.creds.filter((c) => c.model.includes(short) && c.status !== 'off').map((c) => c.app)
  return Array.from(new Set([...creds, ...(MODEL_APPS[short] ?? [])]))
}

/* ---------------- 准入计算 ---------------- */
function admission(st: EngineState, o: Order): { ok: boolean; reason?: string; suggest?: string } {
  switch (o.type) {
    case 'pool_expand': {
      const pool = String(o.spec.pool) as Pool['id']
      const cards = Number(o.spec.cards)
      const free = freeCards(st)
      if (cards <= 0) return { ok: false, reason: '扩容卡位必须为正整数' }
      const rent = rentInfo(st)
      if (cards > free) {
        const needRent = cards - free
        if (rent.enabled && !rent.blocked && rent.available >= needRent) {
          return { ok: true, reason: undefined, suggest: `本地空闲 ${free} 卡 + 外部扩租 ${needRent} 卡（额度剩 ${rent.available} 卡 · ${rent.price} 元/卡/日）· 执行后「${st.pools.find((x) => x.id === pool)!.name}」${cards} 卡到位` }
        }
        const donor = st.pools.find((p) => p.id !== pool && poolUtil(st, p.id) < 70)
        const rentNote = rent.enabled
          ? rent.blocked || `扩租额度剩 ${rent.available} 卡，不足 ${needRent} 卡`
          : `${rent.blocked}；开通后本地不足时可扩租最多 ${rent.quota} 卡`
        return { ok: false, reason: `全局空闲卡位不足（空闲 ${free} 卡，申请 ${cards} 卡）`, suggest: `${rentNote}${donor ? `；也可先从「${donor.name}」回收 ${Math.min(Number(donor.cards - demandOf(st, donor.id)), free + Number(donor.cards - demandOf(st, donor.id)))} 卡或错峰降载` : ''}` }
      }
      const after = st.pools.find((p) => p.id === pool)!.cards + cards
      const utilAfter = Math.round((demandOf(st, pool) / after) * 100)
      return { ok: true, reason: undefined, suggest: `执行后「${st.pools.find((p) => p.id === pool)!.name}」利用率 ${poolUtil(st, pool)}% → ${utilAfter}%` }
    }
    case 'pool_release': {
      const pool = String(o.spec.pool) as Pool['id']
      const cards = Number(o.spec.cards)
      const p = st.pools.find((x) => x.id === pool)!
      const idle = p.cards - demandOf(st, pool)
      if (cards > idle) return { ok: false, reason: `回收将侵占在用资源：${p.name} 空闲仅 ${idle} 卡，申请回收 ${cards} 卡` }
      return { ok: true, suggest: `回收后 ${p.name} 利用率将升至 ${Math.round((demandOf(st, pool) / (p.cards - cards)) * 100)}%（阈值 85%）` }
    }
    case 'preempt': {
      const fromId = String(o.spec.from) as Pool['id']
      const toId = String(o.spec.to) as Pool['id']
      const cards = Number(o.spec.cards)
      const from = st.pools.find((p) => p.id === fromId)!
      const to = st.pools.find((p) => p.id === toId)!
      if (cards <= 0) return { ok: false, reason: '抢占卡位必须为正整数' }
      if (fromId === toId) return { ok: false, reason: '源池与目标池不能相同' }
      if (o.level !== '高保') return { ok: false, reason: '抢占仅限高保业务（调度等级须为「高保」），共享 / 灰度业务须走常规扩容' }
      const utilTo = poolUtil(st, toId)
      const utilFrom = poolUtil(st, fromId)
      if (utilTo <= 90) return { ok: false, reason: `${to.name} 当前利用率 ${utilTo}%，未达抢占触发线（>90%）`, suggest: `先提交「${to.name} 扩容」；若全局空闲不足再申请抢占` }
      const canGive = from.cards - demandOf(st, fromId)
      if (cards > canGive) return { ok: false, reason: `${from.name} 可让出上限 ${canGive} 卡（在用 ${demandOf(st, fromId)} 卡不可侵占），本次申请抢占 ${cards} 卡`, suggest: `可分批执行：先抢占 ${Math.max(1, canGive)} 卡，剩余走扩租或错峰降载` }
      const affected = affectedApps(st, fromId, cards)
      const utilToAfter = Math.round((demandOf(st, toId) / (to.cards + cards)) * 100)
      const utilFromAfter = Math.round((demandOf(st, fromId) / (from.cards - cards)) * 100)
      return { ok: true, suggest: `抢占后 ${to.name} ${utilTo}% → ${utilToAfter}% · ${from.name} ${utilFrom}% → ≤${utilFromAfter}%（被抢占副本降级后实际更低）· 受影响业务 ${affected.length} 项须通知` }
    }
    case 'replica_scale': {
      const m = st.models.find((x) => x.short === o.spec.model)
      if (!m) return { ok: false, reason: `未找到模型 ${String(o.spec.model)}` }
      const delta = Number(o.spec.delta)
      const need = delta * m.perReplica
      const free = freeCards(st)
      if (delta > 0 && need > free) return { ok: false, reason: `副本扩容需 ${need} 卡，全局空闲仅 ${free} 卡；建议先做资源池扩容或降低共享池占位` }
      if (delta < 0 && m.replicas + delta < 1) return { ok: false, reason: `副本数不得低于 1（当前 ${m.replicas}）` }
      const pool = st.pools.find((p) => p.id === m.pool)!
      const utilAfter = Math.round((demandOf(st, m.pool) + need) / pool.cards * 100)
      if (delta > 0 && utilAfter > 92) return { ok: false, reason: `执行后 ${pool.name} 利用率将达 ${utilAfter}%，超过 92% 安全上限，须先扩容资源池` }
      return { ok: true, suggest: `执行后 ${m.short} 副本 ${m.replicas} → ${m.replicas + delta}，${pool.name} 利用率 → ${utilAfter}%` }
    }
    case 'training_dataset': {
      const required = ['name', 'version', 'source', 'owner', 'dataLevel']
      if (required.some((key) => !String(o.spec[key] ?? '').trim())) return { ok: false, reason: '须填写数据集、版本、来源、责任人和密级' }
      if (st.orders.some((other) => other.id !== o.id && other.type === o.type && ['submitted', 'closed'].includes(other.status) && other.applicant === o.applicant && other.spec.name === o.spec.name && other.spec.version === o.spec.version)) return { ok: false, reason: '本人已有相同数据集版本的在办或已通过申请' }
      return { ok: true, suggest: '等待登记数据安全检测报告' }
    }
    case 'model_admission': {
      const required = ['model', 'version', 'source', 'artifact', 'owner', 'provenance', 'location', 'integrity', 'scan', 'evaluation', 'image', 'nodes']
      if (required.some((key) => !String(o.spec[key] ?? '').trim())) return { ok: false, reason: '须填写制品信息、校验与评测证据，以及部署预设' }
      if (o.spec.source === '平台内微调模型') {
        const job = st.jobs.find((item) => item.id === o.spec.trainingJobId)
        const artifact = job?.execution?.artifact
        if (!artifact || artifact.version !== o.spec.version || artifact.location !== o.spec.location || artifact.sha256 !== o.spec.artifactHash) return { ok: false, reason: '内部模型须引用原训练任务已登记的制品版本、位置与 SHA-256 基准' }
      }
      if (st.orders.some((other) => other.id !== o.id && other.type === 'model_admission' && ['submitted', 'closed'].includes(other.status) && other.spec.model === o.spec.model && other.spec.version === o.spec.version)) return { ok: false, reason: '该模型版本已有待审批或已入库的准入工单' }
      return { ok: true, suggest: '材料已登记，等待人工核验证据' }
    }
    case 'model_deploy': {
      const short = String(o.spec.model ?? '').trim()
      if (!short) return { ok: false, reason: '要写明部署哪个模型（模型简称或新模型名称）' }
      const replicas = Number(o.spec.replicas)
      const per = Number(o.spec.perReplica) || 1
      if (!(replicas >= 1) || replicas > 8) return { ok: false, reason: '单条部署工单的副本数要在 1–8 之间（更大的发布拆成多条工单，便于逐条回滚）' }
      const m = st.models.find((x) => x.short === short)
      const version = String(o.spec.version ?? '').trim()
      if (m && !o.spec.admissionId && version && version !== m.ver && !m.versions.includes(version)) return { ok: false, reason: `${short} 的版本「${version}」不在版本清单（可选：${m.versions.join(' / ')}）；新镜像要先在模型资产里登记版本` }
      if (!m || o.spec.admissionId || st.orders.some((candidate) => candidate.type === 'model_admission' && candidate.status === 'closed' && candidate.spec.model === short && candidate.spec.version === (version || m.ver))) {
        const record = st.orders.find((candidate) => candidate.id === o.spec.admissionId && candidate.type === 'model_admission' && candidate.status === 'closed')
        if (!record || record.spec.model !== short || record.spec.version !== version || record.spec.image !== o.spec.image || record.spec.nodes !== o.spec.nodes) return { ok: false, reason: '部署须引用同版本已入库准入工单及其镜像、节点预设' }
      }
      const gray = Number(o.spec.gray ?? 100)
      if (!(gray >= 1) || gray > 100) return { ok: false, reason: '灰度比例要在 1–100 之间（灰度发布要写清放量比例）' }
      const nodes = String(o.spec.nodes ?? '').trim()
      if (!nodes) return { ok: false, reason: '要写明目标节点（例：AI-Infer-03 / AI-Infer-04）—— 部署动作由容器平台在这些节点执行，平台只发单与验收' }
      const image = String(o.spec.image ?? '').trim()
      if (!image) return { ok: false, reason: '要写明镜像与版本（例：mindie:2.1.qwen3），执行回执要能对上镜像' }
      const pool = st.pools.find((x) => x.id === String(o.spec.pool))
      if (!pool) return { ok: false, reason: `未找到资源池 ${String(o.spec.pool)}` }
      const need = replicas * per
      const free = poolFree(st, pool.id)
      if (need > free) return { ok: false, reason: `${pool.name} 当前空闲 ${free} 卡，本次要 ${need} 卡（${replicas} 副本 × ${per} 卡）；先做池扩容或换空闲更多的池` }
      const utilAfter = Math.round((demandOf(st, pool.id) + need) / pool.cards * 100)
      if (utilAfter > 92) return { ok: false, reason: `部署后 ${pool.name} 利用率将达 ${utilAfter}%，超过 92% 安全上限，须先扩容` }
      return { ok: true, suggest: `在 ${pool.name}（${nodes}）部署 ${short} ${version || m?.ver || image}：${replicas} 副本 × ${per} 卡 = ${need} 卡 · 灰度 ${gray}% · 池利用率 → ${utilAfter}% · 待容器平台执行回执` }
    }
    case 'train_reserve': {
      const cards = Number(o.spec.cards)
      const hours = Number(o.spec.hours)
      const pool = st.pools.find((x) => x.id === 'train')!
      if (!(cards >= 1) || cards > 8) return { ok: false, reason: '单个训练算例 1–8 卡；更大的任务拆成多笔申请，便于逐笔回收' }
      if (!(hours >= 1) || hours > 72) return { ok: false, reason: '训练时长 1–72 小时；超长期占用要单独排期并走窗口审批' }
      if (!String(o.spec.name ?? '').trim()) return { ok: false, reason: '要写任务名称与用途，台账与成本归集要用' }
      if (!String(o.spec.framework ?? '').trim()) return { ok: false, reason: '要写训练框架（例：MindForm / MindIE），镜像与环境要能对上' }
      if (!String(o.spec.dataLevel ?? '').trim()) return { ok: false, reason: '要写训练数据密级（内部 / 敏感 / 已脱敏），密级门禁与网络平面要核验' }
      if (o.spec.trainingWorkflow === true) {
        const dataset = st.orders.find((item) => item.id === o.spec.datasetId && item.type === 'training_dataset' && item.status === 'closed')
        if (!dataset || dataset.applicant !== o.applicant || dataset.spec.dataLevel !== o.spec.dataLevel) return { ok: false, reason: '请绑定本人已审核通过且密级一致的数据集版本' }
        const base = st.orders.find((item) => item.id === o.spec.baseId && item.type === 'model_admission' && item.status === 'closed')
        if (!base) return { ok: false, reason: '请绑定已准入入库的基座模型版本' }
      }
      const free = poolFree(st, 'train')
      if (cards > free) return { ok: false, reason: `训练池空闲 ${free} 卡，本次要 ${cards} 卡；可先排队（不占卡位）或归还其他任务卡位后再提交` }
      return { ok: true, suggest: `训练池预留 ${cards} 卡 × ${hours} 小时（空闲 ${free} 卡 → ${free - cards} 卡）· 任务 ${String(o.spec.name)} · 归口 ${o.dept} · 数据密级 ${String(o.spec.dataLevel)}` }
    }
    case 'train_extend': {
      const job = st.jobs.find((item) => item.id === o.spec.jobId)
      const extra = Number(o.spec.hours)
      if (!job?.reserveId || !job.deadline || job.state !== '运行中' || job.deadline <= Date.now()) return { ok: false, reason: '仅未到期且仍占用卡位的训练申请可以延期' }
      if (job.applicant !== o.applicant || job.reserveId !== o.spec.reserveId) return { ok: false, reason: '延期必须关联本人原算力工单' }
      if (st.orders.some((item) => item.id !== o.id && item.type === 'train_extend' && ['submitted', 'approved', 'queued'].includes(item.status) && item.spec.jobId === job.id && item.createdAt <= o.createdAt)) return { ok: false, reason: '该任务已有在办延期工单' }
      if (!Number.isInteger(extra) || extra < 1 || job.hours + extra > 72) return { ok: false, reason: '延期须为整小时，累计不得超过 72 小时' }
      return { ok: true, suggest: `在原期限基础上延长 ${extra} 小时` }
    }
    case 'train_release': {
      const j = (st.jobs ?? []).find((x) => x.id === String(o.spec.jobId))
      if (!j) return { ok: false, reason: `未找到训练任务 ${String(o.spec.jobId)}` }
      if (j.state === '已完成') return { ok: false, reason: `${j.name} 的卡位已归还，无需重复归还` }
      const pool = st.pools.find((x) => x.id === 'train')!
      return { ok: true, suggest: `归还「${j.name}」占用的 ${j.cards} 卡：训练池利用率 ${poolUtil(st, 'train')}% → ${Math.round((demandOf(st, 'train') - j.cards) / pool.cards * 100)}%` }
    }
    case 'weight_adjust': {
      const ws = (o.spec.weights as string).split(',').map((x) => parseInt(x))
      if (ws.length !== st.channels.length) return { ok: false, reason: '权重数量需覆盖全部渠道' }
      if (ws.reduce((s, x) => s + x, 0) !== 100) return { ok: false, reason: `权重合计须为 100（当前 ${ws.reduce((s, x) => s + x, 0)}）` }
      const bad = st.channels.filter((c, i) => c.health !== 'ok' && ws[i] > 20)
      if (bad.length) return { ok: false, reason: `异常渠道权重上限 20%：${bad.map((b) => b.name.split('（')[0]).join('、')}` }
      const ext = llmChannelConfig()
      const vendorUp = st.channels.filter((c, i) => c.id === 'vendor' && ws[i] > c.weight)
      if (vendorUp.length && !ext.enabled) return { ok: false, reason: `外部模型渠道接入未开通（${ext.name} · ${ext.status}），不得上调外部渠道权重`, suggest: '先在「运营分析 · 外部接入配置」启用该接入并探活，或改为本地渠道扩容' }
      const dev = Math.max(...ws) - Math.min(...ws)
      return { ok: true, suggest: `调整后负载均衡偏离度 ${dev}%（>30% 须提出优化方案）` }
    }
    case 'credential_issue': {
      const ch = st.channels.find((c) => c.id === o.spec.channel)
      if (!ch) return { ok: false, reason: `未找到渠道「${String(o.spec.channel)}」（可选：${st.channels.map((c) => `${c.id} · ${c.name.split('（')[0]}`).join(' / ')}）` }
      const rpm = Number(o.spec.rpm)
      const usedPct = Math.round((ch.allocatedRpm / ch.capacityRpm) * 100)
      if (ch.allocatedRpm + rpm > ch.capacityRpm) return { ok: false, reason: `渠道 ${ch.name.split('（')[0]} 配额已用 ${usedPct}%，剩余 ${ch.capacityRpm - ch.allocatedRpm} RPM 不足以发放 ${rpm} RPM` }
      if (ch.health !== 'ok' && o.spec.kind === '平台代理') return { ok: false, reason: `目标渠道当前状态异常，平台代理凭证须绑定健康渠道` }
      if (o.spec.kind === '个人密钥' && rpm > 120) return { ok: false, reason: '个人密钥默认低配额上限 120 RPM，须先申请提额审批' }
      return { ok: true, suggest: `发放后该渠道配额占用 ${Math.round(((ch.allocatedRpm + rpm) / ch.capacityRpm) * 100)}%` }
    }
    case 'quota_adjust': {
      const c = st.creds.find((x) => x.id === o.spec.credId)
      if (!c) return { ok: false, reason: `未找到凭证 ${String(o.spec.credId)}` }
      const ch = st.channels.find((x) => x.id === c.channel)!
      const rpm = Number(o.spec.rpm)
      const others = ch.allocatedRpm - c.rpm
      if (others + rpm > ch.capacityRpm) return { ok: false, reason: `提额后渠道配额将达 ${Math.round(((others + rpm) / ch.capacityRpm) * 100)}%，超过 100% 上限` }
      if (c.kind === '个人密钥' && rpm > 120) return { ok: false, reason: '个人密钥配额上限 120 RPM' }
      return { ok: true, suggest: `${c.id} RPM ${c.rpm} → ${rpm}，双人复核后生效` }
    }
    case 'credential_revoke': {
      const c = st.creds.find((x) => x.id === o.spec.credId)
      if (!c) return { ok: false, reason: `未找到凭证 ${String(o.spec.credId)}` }
      if (c.status === 'off') return { ok: false, reason: '该凭证已吊销' }
      return { ok: true, suggest: `吊销 ${c.id} 释放 ${c.rpm} RPM，关联授权与路由一并清理` }
    }
    case 'access_block': {
      const c = connectorStore.find(String(o.spec.connectorId))
      if (!c) return { ok: false, reason: `未找到接入配置 ${String(o.spec.connectorId)}` }
      const scope = String(o.spec.scope ?? '全通道')
      const value = String(o.spec.value ?? '').trim()
      if (!BLOCK_SCOPES.includes(scope)) return { ok: false, reason: `阻断范围只能是 ${BLOCK_SCOPES.join(' / ')}` }
      const basis = String(o.spec.basis ?? '')
      if (!BASIS_OPTS.includes(basis)) return { ok: false, reason: `接入阻断须注明依据（${BASIS_OPTS.join(' / ')}）` }
      const depends = governDependents(c.name)
      if (scope !== '全通道') {
        if (!value) return { ok: false, reason: `「${scope}」阻断须写明要停的对象（例：采集项名称 / 02:00-06:00 / 10.42.7.18）` }
        if (scope === '来源 IP' && !/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value)) return { ok: false, reason: `来源 IP 写法不对（例：10.42.7.18 或 10.42.7.0/24）：当前「${value}」` }
        if (scope === '时段' && !/\d{1,2}:\d{2}\s*[-~]\s*\d{1,2}:\d{2}/.test(value)) return { ok: false, reason: `时段写法不对（例：02:00-06:00）：当前「${value}」` }
        if (scope === '采集项') {
          const items = c.dataItems.split('、').map((x) => x.trim())
          if (!items.some((it) => value.includes(it))) return { ok: false, reason: `「${value}」不在 ${c.name} 的采集清单里（可停：${items.join(' / ')}）` }
        }
        return { ok: true, suggest: `部分阻断 ${c.name}（${scope}：${value}）：这条接入其余采集与调用继续 · 受影响登记对象 ${depends.length} 项 · 归口 ${c.owner} 须通知` }
      }
      if (!c.enabled) return { ok: false, reason: `${c.name} 通道已是停用状态，无需阻断` }
      return { ok: true, suggest: `阻断 ${c.name}（${c.transport} · ${c.enabled ? '已启用' : '未启用'}）：停止采集与调用，受影响登记对象 ${depends.length} 项${depends.length ? `（${depends.slice(0, 3).join('、')}${depends.length > 3 ? ' 等' : ''}）` : ''} · 归口 ${c.owner} 须通知` }
    }
    case 'access_restore': {
      const c = connectorStore.find(String(o.spec.connectorId))
      if (!c) return { ok: false, reason: `未找到接入配置 ${String(o.spec.connectorId)}` }
      const partial = Boolean(c.blockedScope)
      if (c.enabled && !partial) return { ok: false, reason: `${c.name} 通道已处于启用状态` }
      if (partial) return { ok: true, suggest: `解除 ${c.name} 的${c.blockedScope}限制（${c.blockedValue}）：这条接入全量采集与调用恢复 · 归口 ${c.owner} 须确认整改完成` }
      const miss = readiness(c)
      if (miss.length) return { ok: false, reason: `整改未闭环，不能恢复接入：缺 ${miss.join(' / ')}` }
      return { ok: true, suggest: `恢复 ${c.name} 接入与采集（${c.transport} · ${c.mode === 'real' ? '真实接口' : '虚拟模拟'}）· 恢复后接管深度回到 L${c.status === '已定' ? 4 : 2}，归口 ${c.owner} 须确认整改完成` }
    }
    case 'containment': {
      const kind = String(o.spec.kind) as ContainKind
      const action = String(o.spec.action) as ContainAction
      const m = st.managed.find((x) => x.kind === kind && x.name === o.spec.name)
      if (!m) return { ok: false, reason: `未纳管该对象：${kind} · ${String(o.spec.name)}` }
      if (!KIND_ACTIONS[kind].includes(action)) return { ok: false, reason: `${kind} 不支持「${action}」，可用处置：${KIND_ACTIONS[kind].join(' / ')}` }
      const want = ACTION_STATUS[action]
      if (m.status === want) return { ok: false, reason: `${m.name} 当前已是「${m.status}」状态，处置动作无变化` }
      const basis = String(o.spec.basis ?? '')
      if (!BASIS_OPTS.includes(basis)) return { ok: false, reason: `处置须注明依据（${BASIS_OPTS.join(' / ')}）` }
      const suspending = want === '暂停' || want === '隔离' || want === '禁用'
      if (suspending && m.level === '高保' && basis !== '告警触发' && basis !== '客户方指令') return { ok: false, reason: `${m.name} 属高保业务对象，暂停 / 隔离须有「告警触发」或「客户方指令」依据` }
      if (suspending && o.reason.trim().length < 12) return { ok: false, reason: '暂停 / 隔离 / 禁用 须在理由中写明业务影响与影响范围（不少于 12 字）' }
      const queue = m.kind === '知识库' && want === '暂停' ? Math.max(30, m.queue + 40) : m.queue
      return { ok: true, suggest: `${m.name} 状态 ${m.status} → ${want}${m.kind === '知识库' && want === '暂停' ? ` · 在库队列 ${queue} 项滞留，恢复后自动解除` : ''} · 归口 ${m.owner} 须通知` }
    }
    case 'model_rollback': {
      const m = st.models.find((x) => x.short === o.spec.model)
      if (!m) return { ok: false, reason: `未找到模型 ${String(o.spec.model)}` }
      if (m.state !== '运行中') return { ok: false, reason: `${m.short} 已下线，不可执行版本回退` }
      const to = String(o.spec.toVersion)
      if (!m.versions.includes(to)) return { ok: false, reason: `${m.short} 无历史版本 ${to}（可用：${m.versions.join(' / ')}）` }
      if (to === m.ver) return { ok: false, reason: `${m.short} 当前即为 ${to}，无需回退` }
      const apps = appsOfModel(st, m.short)
      return { ok: true, suggest: `${m.short} 版本 ${m.ver} → ${to} · 回退后须验证调用链路可用性 · 受影响应用 ${apps.length} 项须通知` }
    }
    case 'model_retire': {
      const m = st.models.find((x) => x.short === o.spec.model)
      if (!m) return { ok: false, reason: `未找到模型 ${String(o.spec.model)}` }
      if (m.state !== '运行中') return { ok: false, reason: `${m.short} 已下线` }
      const basis = String(o.spec.basis ?? '')
      if (!BASIS_OPTS.includes(basis)) return { ok: false, reason: `模型下线须注明依据（${BASIS_OPTS.join(' / ')}）并经下线审批` }
      const cards = m.replicas * m.perReplica
      const pool = st.pools.find((p) => p.id === m.pool)!
      if (m.pool === 'hp' && m.replicas <= 1) return { ok: false, reason: `${m.short} 在高保集群仅 ${m.replicas} 个副本，须先扩容或迁移承载后再下线` }
      const creds = st.creds.filter((c) => c.model.includes(m.short) && c.status !== 'off')
      const apps = appsOfModel(st, m.short)
      return { ok: true, suggest: `${m.short} 下线释放 ${cards} 卡归还「${pool.name}」· 活跃凭证 ${creds.length} 个须先吊销或迁移 · 受影响应用 ${apps.length} 项须通知 · 保留配置快照可恢复` }
    }
  }
  return { ok: false, reason: '未知申请类型' }
}

/* ---------------- 引擎 ---------------- */
class Engine {
  private state: EngineState
  private listeners = new Set<() => void>()

  constructor() {
    const stored = this.load()
    this.state = stored || seedState()
    if (!stored) this.save()   // 首次运行：初始演示数据直接入库，之后一律以库为准
  }
  private load(): EngineState | null {
    try {
      const raw = dbRead(STORAGE_KEY)
      if (!raw) return null
      const p = JSON.parse(raw) as EngineState
      if (!p.pools || p.pools.length !== 3) return null
      if (!p.managed || !Array.isArray(p.managed) || p.managed.length === 0) return null
      if (!p.windowSlots || !Array.isArray(p.windowSlots)) return null
      if (p.managed.some((m: { tech?: boolean }) => typeof m.tech !== 'boolean')) return null
      if (!p.models.every((m) => Array.isArray(m.versions))) return null
      if (!p.managed.some((m: { kind: string }) => m.kind === 'Skill')) return null
      p.rented = Number(p.rented ?? 0)
      p.jobs = Array.isArray(p.jobs) ? p.jobs : seedState().jobs
      return p
    } catch { return null }
  }
  private save() {
    try { dbWrite(STORAGE_KEY, JSON.stringify(this.state)) } catch { /* 落库失败已在数据层记录 */ }
  }
  private emit() {
    this.state = { ...this.state }
    this.save()
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }

  /** 外部模块（例外监控、接入配置等）写入运行事件并立即广播，通知中心同步 */
  announce(level: '一般' | '重要' | '紧急', text: string) {
    this.state.events = [{ time: nowStr(), level, text }, ...this.state.events].slice(0, 80)
    this.emit()
  }
  get = () => this.state
  /** 外部模块（如告警规则）写入状态后刷新订阅 */
  refresh() { this.emit() }

  reset() { this.state = seedState(); this.emit() }

  submit(input: { type: OrderType; applicant: string; dept: string; level: Level; reason: string; spec: Record<string, number | string | boolean>; auto?: boolean }) {
    const st = this.state
    st.seq += 1
    const target = describeTarget(st, input.type, input.spec)
    const spec = input.type === 'train_reserve' ? { ...input.spec, trainingWorkflow: true } : { ...input.spec }
    const o = mkOrder(st.seq, input.type, `${TYPE_LABEL[input.type]} · ${target}`, input.applicant, input.dept, input.level, target, describeAmount(input.type, input.spec), input.reason || '（未填写业务理由）', 'submitted', input.auto ?? false, spec)
    const pre = admission(st, o)
    st.orders.unshift(o)
    if (!pre.ok) {
      o.status = 'rejected'
      o.decidedAt = Date.now()
      o.decidedBy = '系统准入校验'
      o.rejectReason = pre.reason
      trace(o, '系统准入校验', '提交即驳回', pre.reason!, 'bad')
      st.events.unshift({ time: nowStr(), level: '一般', text: `${o.id} 准入校验未通过：${pre.reason}` })
    } else {
      trace(o, '系统准入校验', '预检通过', pre.suggest ?? '', 'good')
    }
    this.emit()
    return { order: o, precheck: pre }
  }

  /** 变更窗口：同一时刻仅允许一个变更实际执行，其余审批通过后排队 */
  windowOrder(): Order | undefined { return this.state.orders.find((o) => o.status === 'running') }
  queueOrders(): Order[] { return this.state.orders.filter((o) => o.status === 'queued').sort((a, b) => a.createdAt - b.createdAt) }

  private enqueue(st: EngineState, o: Order, cause: 'busy' | 'noslot' = 'busy') {
    o.status = 'queued'
    const cur = this.windowOrder()
    const pos = this.queueOrders().length
    const next = this.slotList().find((x) => x.status === '已预约')
    if (cause === 'noslot') {
      trace(o, '变更窗口调度', '当前无开放变更窗口 → 排入下一预约窗口', `${o.id} 排队位次 ${pos} · ${next ? `预计窗口 ${next.id}（${next.date} ${next.from}-${next.to}）` : '暂无预约窗口，需先预约'} · 紧急处置不受窗口限制`, 'warn')
      st.events.unshift({ time: nowStr(), level: '一般', text: `${o.id} 不在变更窗口时段，已排队（位次 ${pos}）${next ? ` · 预计窗口 ${next.id} ${next.date} ${next.from}` : ' · 暂无预约窗口'}` })
    } else {
      trace(o, '变更窗口调度', '审批通过但窗口被占用 → 排队', `当前窗口由 ${cur?.id} 占用 · 排队位次 ${pos} · 窗口释放后自动按序执行`, 'warn')
      st.events.unshift({ time: nowStr(), level: '一般', text: `${o.id} 已进入变更窗口队列（位次 ${pos}），当前窗口由 ${cur?.id} 占用` })
    }
  }

  /* -------- 变更窗口排期 -------- */
  slotList(): WindowSlot[] {
    return [...this.state.windowSlots].sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from))
  }
  activeSlot(): WindowSlot | undefined { return this.state.windowSlots.find((x) => x.status === '使用中') }

  bookSlot(input: { date: string; from: string; to: string; scope: WindowSlot['scope']; reason: string; by: string }) {
    const st = this.state
    if (!input.date || !input.from || !input.to) return { ok: false as const, reason: '须填写日期与起止时间' }
    if (input.from >= input.to) return { ok: false as const, reason: `结束时间须晚于开始时间（${input.from} → ${input.to}）` }
    const overlap = st.windowSlots.find((x) => x.date === input.date && x.status !== '已取消' && x.status !== '已结束' && !(x.to <= input.from || x.from >= input.to))
    if (overlap) return { ok: false as const, reason: `与已预约窗口 ${overlap.id}（${overlap.from}-${overlap.to}）时间重叠，不可重复预约` }
    const id = `CW-${String(st.windowSlots.length + 1).padStart(2, '0')}`
    st.windowSlots.push({ id, date: input.date, from: input.from, to: input.to, scope: input.scope, reason: input.reason || '（未填写变更事由）', by: input.by, status: '已预约' })
    st.events.unshift({ time: nowStr(), level: '一般', text: `变更窗口 ${id} 已预约：${input.date} ${input.from}-${input.to} · ${input.scope} · ${input.reason || '未填写事由'} · 当前排队工单 ${this.queueOrders().length} 项将在窗口开启时按序执行` })
    this.emit()
    return { ok: true as const, id }
  }

  openSlot(id: string) {
    const st = this.state
    const slot = st.windowSlots.find((x) => x.id === id)
    if (!slot) return { ok: false as const, reason: '未找到该预约窗口' }
    if (slot.status === '使用中') return { ok: false as const, reason: `${id} 已在使用中` }
    if (slot.status !== '已预约') return { ok: false as const, reason: `${id} 状态为 ${slot.status}，不可开启` }
    const cur = this.activeSlot()
    if (cur) return { ok: false as const, reason: `变更窗口已被 ${cur.id} 占用，须先结束当前窗口` }
    slot.status = '使用中'
    st.events.unshift({ time: nowStr(), level: '重要', text: `变更窗口 ${id}（${slot.date} ${slot.from}-${slot.to} · ${slot.scope}）已开启，排队工单按序开始执行` })
    this.emit()
    this.pumpQueue()
    return { ok: true as const, id }
  }

  closeSlot(id: string) {
    const st = this.state
    const slot = st.windowSlots.find((x) => x.id === id)
    if (!slot || slot.status !== '使用中') return { ok: false as const, reason: '该窗口当前未在使用中' }
    slot.status = '已结束'
    const queued = this.queueOrders()
    const next = this.slotList().find((x) => x.status === '已预约')
    slot.note = `已闭环 · 结束时排队 ${queued.length} 项`
    st.events.unshift({ time: nowStr(), level: '重要', text: `变更窗口 ${id} 已结束${queued.length ? ` · 剩余 ${queued.length} 项排队工单${next ? `顺延至预约窗口 ${next.id}（${next.date} ${next.from}-${next.to}）` : '（暂无预约窗口，需预约后执行）'}` : ''}` })
    this.emit()
    this.pumpQueue()
    return { ok: true as const, id }
  }

  cancelSlot(id: string) {
    const st = this.state
    const slot = st.windowSlots.find((x) => x.id === id)
    if (!slot || slot.status !== '已预约') return { ok: false as const, reason: '仅未开始的预约窗口可取消' }
    slot.status = '已取消'
    st.events.unshift({ time: nowStr(), level: '一般', text: `变更窗口预约 ${id} 已取消（${slot.date} ${slot.from}-${slot.to}）` })
    this.emit()
    return { ok: true as const, id }
  }

  private pumpQueue() {
    const st = this.state
    if (this.windowOrder()) return
    const next = this.queueOrders()[0]
    if (!next) return
    trace(next, '变更窗口调度', '窗口释放 · 按队列顺序开始执行', `轮到 ${next.id}（排队位次提前至 1）`, 'info')
    this.execute(next.id)
  }

  approve(id: string, reviewer?: string) {
    const st = this.state
    const o = st.orders.find((x) => x.id === id)
    if (!o || o.status !== 'submitted') return
    if (o.type === 'training_dataset' || (o.type === 'model_admission' && !reviewer?.trim())) return
    const chk = admission(st, o)
    if (!chk.ok) {
      o.status = 'rejected'
      o.decidedAt = Date.now()
      o.decidedBy = '运营主管'
      o.rejectReason = chk.reason
      trace(o, '运营主管', '审批驳回', chk.reason!, 'bad')
      this.emit()
      return
    }
    if (o.type === 'model_admission') {
      o.status = 'closed'
      o.decidedAt = Date.now()
      o.decidedBy = reviewer
      trace(o, reviewer!, '核验证据并登记入库', '人工确认完整性、安全扫描与安全评测证据', 'good')
      this.emit()
      return
    }
    o.status = 'approved'
    o.decidedAt = Date.now()
    o.decidedBy = '运营主管'
    trace(o, '运营主管', '审批通过', chk.suggest ?? '准入计算通过', 'good')
    if (EXTERNAL_TYPES.includes(o.type)) {
      o.trace.push({ time: nowStr(), actor: '流程门禁', action: '等待下发与执行回执', detail: '这类工单由容器平台 / 运维执行：审批通过后可下发，回执到位才生效', tone: 'info' })
      st.events.unshift({ time: nowStr(), level: '一般', text: `${o.id} 已审批通过，等待下发外部执行与回执（未回执前不生效、不占卡位）` })
      this.emit()
      return
    }
    this.execute(id)
  }

  recordDatasetResult(id: string, actor: string, passed: boolean, report: string) {
    const order = this.state.orders.find((item) => item.id === id)
    if (!order || order.type !== 'training_dataset' || order.status !== 'submitted' || !actor.trim() || !report.trim()) return false
    order.status = passed ? 'closed' : 'rejected'
    order.decidedBy = actor
    order.decidedAt = Date.now()
    order.spec.report = report.trim()
    if (!passed) order.rejectReason = report.trim()
    trace(order, actor, passed ? '登记通过报告并固化版本' : '登记未通过报告', report.trim(), passed ? 'good' : 'bad')
    this.emit()
    return true
  }

  recordTraining(id: string, actor: string, update: NonNullable<TrainJob['execution']>) {
    const job = this.state.jobs.find((item) => item.id === id)
    const reserve = this.state.orders.find((item) => item.id === job?.reserveId && item.type === 'train_reserve')
    if (!job || !reserve || job.state !== '运行中' || actor !== job.applicant || !job.deadline || job.deadline <= Date.now()) return false
    if (!update.reference.trim() || !update.parameters.trim() || !update.evidence.trim()) return false
    if (!job.execution && update.status !== '已登记') return false
    if (job.execution && (job.execution.reference !== update.reference || job.execution.parameters !== update.parameters || !['已登记', '运行中'].includes(job.execution.status) || update.status === '已登记')) return false
    if (update.status === '已完成' && (!update.artifact?.version.trim() || !update.artifact.location.trim() || !/^[a-f0-9]{64}$/i.test(update.artifact.sha256))) return false
    job.execution = update
    trace(reserve, actor, `登记外部训练状态 · ${update.status}`, `${update.reference} · ${update.evidence}`, update.status === '失败' ? 'bad' : 'info')
    this.emit()
    return true
  }

  reject(id: string, reason: string) {
    const o = this.state.orders.find((x) => x.id === id)
    if (!o) return
    o.status = 'rejected'
    o.decidedAt = Date.now()
    o.decidedBy = '运营主管'
    o.rejectReason = reason
    trace(o, '运营主管', '审批驳回', reason, 'bad')
    this.emit()
  }

  execute(id: string) {
    const st = this.state
    const o = st.orders.find((x) => x.id === id)
    if (!o || (o.status !== 'approved' && o.status !== 'submitted' && o.status !== 'queued')) return
    if (o.type === 'training_dataset' || o.type === 'model_admission') return
    if (['train_extend', 'train_reserve'].includes(o.type) && o.status === 'submitted') return
    const externallyDone = Boolean(o.spec.receiptNote)
    if (EXTERNAL_TYPES.includes(o.type) && !externallyDone) {
      trace(o, '流程门禁', '未下发外部执行 · 不生效', `${o.id} ${TYPE_LABEL[o.type]}须先下发给容器平台 / 运维执行并取回回执，平台不代为生效`, 'warn')
      this.emit()
      return
    }
    if (!URGENT_TYPES.includes(o.type) && !externallyDone) {
      const busy = st.orders.find((x) => x.status === 'running' && x.id !== id)
      if (busy) { this.enqueue(st, o, 'busy'); this.emit(); return }
      if (!this.activeSlot() && !o.auto) { this.enqueue(st, o, 'noslot'); this.emit(); return }
    }
    const chk = admission(st, o)
    if (!chk.ok) { o.status = 'rejected'; o.rejectReason = chk.reason; trace(o, '执行引擎', '执行前校验失败', chk.reason!, 'bad'); this.emit(); return }
    o.status = 'running'
    o.executedAt = Date.now()
    trace(o, '变更窗口 · 执行引擎', '执行变更', `${o.target} ${o.amount}`, 'info')
    applyEffect(st, o)
    syncChannelRpm(st)
    if (o.type === 'train_extend' || (o.type === 'train_reserve' && o.spec.trainingWorkflow === true)) {
      o.status = 'closed'
      trace(o, '训练算力台账', '登记完成', '台账已更新，释放变更窗口', 'good')
      pushHistory(st)
      this.emit()
      this.pumpQueue()
      return
    }
    trace(o, '健康探针', '生效验证通过', verifyResult(st, o), 'good')
    if (o.type === 'preempt') {
      const list = String(o.spec.affected ?? '')
      trace(o, '调度通知', '被抢占方通知已发出', `${list} · 副本已降级并限流保障，恢复窗口见回滚说明`, 'warn')
      st.events.unshift({ time: nowStr(), level: '重要', text: `${o.id} 高保优先抢占已执行：${o.target} ${o.amount} · 被抢占业务：${list}` })
    } else if (o.type === 'containment') {
      const m = st.managed.find((x) => x.kind === o.spec.kind && x.name === o.spec.name)!
      const users = m.kind === '知识库' ? `归口 ${m.owner} · 依赖该库的应用与检索链路` : `归口 ${m.owner} · 使用方 ${m.name}`
      const dirs = (m.kind === 'MCP工具' || m.kind === '插件') ? ` · 目录同步：技术注册目录${m.tech ? '保留' : '已摘除'} / 业务使用目录${m.biz ? '保留' : '已摘除'}` : ''
      trace(o, '运行处置通知', '处置通知已发出', `${m.name} → ${m.status} · ${users}${dirs} · 依据「${String(o.spec.basis)}」`, 'warn')
      st.events.unshift({ time: nowStr(), level: m.level === '高保' ? '紧急' : '重要', text: `${o.id} 处置动作已生效：${m.kind} ${m.name} → ${m.status}（依据 ${String(o.spec.basis)}）· ${users} 已通知` })
    } else if (o.type === 'access_block' || o.type === 'access_restore') {
      const c = connectorStore.find(String(o.spec.connectorId))!
      const depends = governDependents(c.name)
      trace(o, '例外监控通知', o.type === 'access_block' ? '阻断通知已发出' : '恢复通知已发出', `${c.name} · 归口 ${c.owner} · 受影响登记对象 ${depends.length} 项${depends.length ? `（${depends.slice(0, 3).join('、')}${depends.length > 3 ? ' 等' : ''}）` : ''}`, o.type === 'access_block' ? 'bad' : 'good')
      st.events.unshift({ time: nowStr(), level: '紧急', text: `${o.id} ${TYPE_LABEL[o.type]}已生效：${c.name} ${o.amount} · 受影响登记对象 ${depends.length} 项 · 归口 ${c.owner} 已通知` })
    } else if (o.type === 'model_retire' || o.type === 'model_rollback') {
      const apps = appsOfModel(st, String(o.spec.model))
      trace(o, '变更联动通知', o.type === 'model_retire' ? '下线通知已推送至应用中心' : '版本变更通知已推送至应用中心', `${apps.join(' | ') || '无活跃应用'} · 共 ${apps.length} 项`, 'warn')
      st.events.unshift({ time: nowStr(), level: '重要', text: `${o.id} ${TYPE_LABEL[o.type]} 已生效：${o.target} ${o.amount} · 受影响应用 ${apps.length} 项已通知（${apps.slice(0, 3).join('、')}${apps.length > 3 ? ' 等' : ''}）` })
    } else {
      st.events.unshift({ time: nowStr(), level: o.level === '高保' ? '重要' : '一般', text: `${o.id} ${TYPE_LABEL[o.type]} 已执行并生效：${o.target} ${o.amount}` })
    }
    pushHistory(st)
    this.emit()
  }

  rollback(id: string) {
    const st = this.state
    const o = st.orders.find((x) => x.id === id)
    if (!o || o.status !== 'running') return
    if (o.type === 'train_reserve' && st.jobs.some((job) => job.reserveId === o.id && job.execution)) return
    reverseEffect(st, o)
    syncChannelRpm(st)
    o.status = 'rolled_back'
    trace(o, '变更窗口 · 执行引擎', '回滚至变更前快照', o.type === 'preempt' ? '卡位与副本均已恢复 · 被抢占业务恢复原保障等级' : '配置快照恢复 · 调用链路已验证', 'warn')
    st.events.unshift({ time: nowStr(), level: '重要', text: `${o.id} 已回滚，资源配置恢复至变更前快照` })
    pushHistory(st)
    this.emit()
    this.pumpQueue()
  }

  /** 模型部署工单：审批通过后下发给容器平台执行，回执到位才生效（平台不直接下发部署） */
  dispatch(id: string) {
    const st = this.state
    const o = st.orders.find((x) => x.id === id)
    if (!o) return { ok: false as const, reason: '未找到工单' }
    if (!EXTERNAL_TYPES.includes(o.type)) return { ok: false as const, reason: '只有模型部署类工单需要下发外部执行并等回执' }
    if (o.status !== 'approved') return { ok: false as const, reason: `工单当前是「${ORDER_STATUS_LABEL[o.status]}」，须先审批通过才能下发执行` }
    o.status = 'external'
    trace(o, '运营值班', '已下发容器平台执行', `等待执行回执 · 目标节点 ${String(o.spec.nodes ?? '未指定')} · 镜像 ${String(o.spec.image ?? '未指定')}`, 'info')
    st.events.unshift({ time: nowStr(), level: '一般', text: `${o.id} ${TYPE_LABEL[o.type]}已下发容器平台执行，等待执行回执（未回执前卡位不占用、副本不变）` })
    this.emit()
    return { ok: true as const }
  }

  /** 执行回执回填：成功才生效（占用卡位、副本变化），失败记台账且不动资源 */
  receipt(id: string, ok: boolean, detail: string, instances: string, gateway?: { route: string; trial: string }) {
    const st = this.state
    const o = st.orders.find((x) => x.id === id)
    if (!o) return { ok: false as const, reason: '未找到工单' }
    if (o.status !== 'external') return { ok: false as const, reason: `工单当前是「${ORDER_STATUS_LABEL[o.status]}」，不在「待执行回执」状态` }
    if (!detail.trim()) return { ok: false as const, reason: '回执要写执行结果说明（不少于 6 字），台账与审计要看' }
    if (ok && o.spec.admissionId && (!instances.trim() || !gateway?.route.trim() || !gateway.trial.trim())) {
      return { ok: false as const, reason: '已准入模型的成功回执须附健康实例、网关路由和试调用记录' }
    }
    o.spec.receiptResult = ok ? '成功' : '失败'
    if (!ok) {
      o.status = 'rejected'
      o.decidedAt = Date.now()
      o.decidedBy = '容器平台回执'
      o.rejectReason = `执行失败：${detail.trim()}`
      trace(o, '容器平台', '执行失败回执', detail.trim(), 'bad')
      st.events.unshift({ time: nowStr(), level: '紧急', text: `${o.id} 部署执行失败：${detail.trim()} · 卡位未占用、副本未变化，可改参数后重新提交` })
      this.emit()
      return { ok: true as const }
    }
    if (gateway?.route.trim() && gateway.trial.trim()) {
      o.spec.gatewayRoute = gateway.route.trim()
      o.spec.gatewayTrial = gateway.trial.trim()
      trace(o, '网关验收回执', '登记路由与试调用', `${o.spec.gatewayRoute} · ${o.spec.gatewayTrial}`, 'info')
    }
    o.spec.receiptNote = detail.trim()
    o.spec.instances = instances.trim() || '（回执未附实例清单）'
    o.status = 'approved'
    trace(o, '容器平台', '执行回执到位', `${o.spec.instances} · ${o.spec.receiptNote} · 平台侧生效登记不再占变更窗口`, 'good')
    this.execute(id)
    if (st.orders.find((item) => item.id === id)?.status === 'rejected') return { ok: false as const, reason: o.rejectReason ?? '生效校验未通过' }
    return { ok: true as const }
  }

  close(id: string) {
    const o = this.state.orders.find((x) => x.id === id)
    if (!o) return
    if (o.type === 'model_admission' || o.type === 'training_dataset') return
    const wasWindow = o.status === 'running'
    o.status = 'closed'
    trace(o, '运营值班', '登记台账并闭环', '闭环状态：已闭环' + (wasWindow ? ' · 变更窗口已释放' : ''), 'good')
    this.emit()
    if (wasWindow) this.pumpQueue()
  }

  /* ---------------- 渠道故障切换（自动处置） ---------------- */
  degradeChannel(id: string) {
    const st = this.state
    const c = st.channels.find((x) => x.id === id)
    if (!c) return { ok: false, reason: '未找到该渠道' }
    c.health = 'warn'
    c.err = Math.max(c.err, 2.6)
    c.latency = Math.max(c.latency, 215)
    st.events.unshift({ time: nowStr(), level: '一般', text: `${c.name} 健康探测连续失败（错误率 ${c.err}% · p95 ${c.latency}ms），已标记异常` })
    this.emit()
    return { ok: true }
  }

  failover(channelId?: string) {
    const st = this.state
    if (st.failover?.active) return { ok: false, reason: '已有切换生效中，请先执行回切' }
    const bad = channelId ? st.channels.find((c) => c.id === channelId) : st.channels.find((c) => c.health !== 'ok')
    if (!bad) return { ok: false, reason: '当前没有异常渠道，可先「模拟渠道劣化」再触发切换' }
    if (bad.health === 'ok') { bad.health = 'warn'; bad.err = Math.max(bad.err, 2.6); bad.latency = Math.max(bad.latency, 215) }
    const healthy = st.channels.filter((c) => c.id !== bad.id && c.health === 'ok').sort((a, b) => (a.latency + a.err * 30) - (b.latency + b.err * 30))
    if (healthy.length === 0) {
      st.events.unshift({ time: nowStr(), level: '紧急', text: `${bad.name} 异常且无可用备用渠道，已执行入口限流保护（未切换）` })
      this.emit()
      return { ok: false, reason: '无健康备用渠道，已执行限流保护，需人工介入' }
    }
    const to = healthy[0]
    const prevWeights = st.channels.map((c) => c.weight).join(',')
    const badIds = new Set(st.channels.filter((c) => c.health !== 'ok').map((c) => c.id))
    const weights = st.channels.map((c) => (c.id === bad.id ? 5 : badIds.has(c.id) ? Math.min(c.weight, 15) : 0))
    const usedByBad = weights.reduce((s, x) => s + x, 0)
    const share = 100 - usedByBad
    const hsum = healthy.reduce((s, c) => s + c.weight, 0) || healthy.length
    st.channels.forEach((c, i) => { if (!badIds.has(c.id)) weights[i] = Math.max(5, Math.round((c.weight / hsum) * share)) })
    const toIdx = st.channels.findIndex((c) => c.id === to.id)
    weights[toIdx] += 100 - weights.reduce((s, x) => s + x, 0)
    const affected = st.creds.filter((c) => c.channel === bad.id && c.status !== 'off').map((c) => c.app)
    const r = this.submit({ type: 'weight_adjust', applicant: '运行监测 · 自动处置', dept: '模型中心', level: '高保', reason: `渠道 ${bad.name} 探测连续失败（错误率 ${bad.err}% · p95 ${bad.latency}ms），自动切换至 ${to.name}`, spec: { weights: weights.join(',') }, auto: true })
    if (!r.precheck.ok) return { ok: false, reason: r.precheck.reason }
    this.approve(r.order.id)
    st.failover = { active: true, channelId: bad.id, channelName: bad.name, at: nowStr(), prevWeights, toChannel: to.name, affectedApps: affected, orderId: r.order.id }
    st.events.unshift({ time: nowStr(), level: '重要', text: `自动故障切换：${bad.name} → ${to.name}（异常渠道降权至 5%）· 受影响应用 ${affected.length} 项已通知` })
    trace(r.order, '运行监测 · 自动处置', '切换通知已发出', affected.length ? affected.join(' | ') : '该渠道当前无活跃凭证占用', 'warn')
    this.emit()
    return { ok: true, from: bad.name, to: to.name, orderId: r.order.id, affected }
  }

  restoreFailover() {
    const st = this.state
    const f = st.failover
    if (!f || !f.active) return { ok: false, reason: '当前没有生效中的切换' }
    const prev = f.prevWeights.split(',').map((x) => parseInt(x))
    st.channels.forEach((c, i) => { if (!Number.isNaN(prev[i])) c.weight = prev[i] })
    const bad = st.channels.find((c) => c.id === f.channelId)
    if (bad) { bad.health = 'ok'; bad.err = Math.min(bad.err, 0.6); bad.latency = Math.min(bad.latency, 120) }
    st.failover = null
    st.events.unshift({ time: nowStr(), level: '一般', text: `渠道 ${f.channelName} 健康恢复，已回切至变更前权重方案（${prev.join('/')}）` })
    const o = st.orders.find((x) => x.id === f.orderId)
    if (o && (o.status === 'running' || o.status === 'queued' || o.status === 'approved')) {
      o.status = 'closed'
      trace(o, '运行监测 · 自动处置', '渠道恢复 · 自动回切并闭环', `权重恢复为 ${prev.join('/')}`, 'good')
    }
    this.emit()
    return { ok: true, weights: prev.join('/') }
  }

  /** 告警自动处置：按对象类型选择处置动作并提交（受准入与变更窗口约束） */
  autoContainment(kind: ContainKind, name: string, reason: string) {
    const st = this.state
    const m = st.managed.find((x) => x.kind === kind && x.name === name)
    if (!m) return { ok: false, reason: `未找到纳管对象 ${name}` }
    const action: ContainAction = kind === '知识库' ? '暂停入库'
      : kind === '智能体应用' ? '限流保护'
      : kind === 'MCP工具' ? '隔离出目录' : '禁用'
    if (m.status === ACTION_STATUS[action]) return { ok: false, reason: `${m.name} 已处于「${m.status}」状态` }
    const r = this.submit({ type: 'containment', applicant: '运行监测 · 自动处置', dept: '应用中心', level: m.level, reason, spec: { kind, name, action, basis: '告警触发' }, auto: true })
    if (!r.precheck.ok) return { ok: false, reason: r.precheck.reason }
    this.approve(r.order.id)
    const after = st.managed.find((x) => x.kind === kind && x.name === name)!
    return { ok: true, name, action, status: after.status, orderId: r.order.id }
  }

  /** 采样周期：模拟负载波动，超阈值自动生成扩缩建议 */
  tickSimulate() {
    const st = this.state
    st.tick += 1
    // 负载随机游走
    st.models.forEach((m) => {
      if (m.replicas > 0 && Math.random() < 0.18) {
        // 业务侧偶发请求激增：临时提高单副本压力，反映为池利用率上升
        m.perReplica = Math.min(4, Math.max(1, m.perReplica + (Math.random() < 0.5 ? 1 : 0)))
      }
    })
    st.channels.forEach((c) => {
      c.latency = Math.max(20, Math.round(c.latency + (Math.random() - 0.5) * 18))
      c.err = Math.max(0.05, +(c.err + (Math.random() - 0.5) * 0.4).toFixed(2))
      c.health = c.err > 1.5 ? 'warn' : 'ok'
    })
    // 纳管对象运行态：正常对象随机漂移；被处置对象按状态演化
    st.managed.forEach((m) => {
      if (m.status === '正常') {
        m.failRate = Math.max(0.1, +(m.failRate + (Math.random() - 0.5) * 0.7).toFixed(2))
        m.success = +(100 - m.failRate).toFixed(1)
        if (m.kind === '知识库') {
          m.parseFail = Math.max(0.2, +(m.parseFail + (Math.random() - 0.5) * 0.9).toFixed(2))
          m.queue = Math.max(0, m.queue + (Math.random() < 0.6 ? 1 : -1))
        }
      } else if (m.status === '暂停' && m.kind === '知识库') {
        m.queue += Math.round(4 + Math.random() * 12)
      } else if (m.status === '暂停' || m.status === '隔离' || m.status === '禁用') {
        m.success = 0
        m.failRate = 100
      } else if (m.status === '限流') {
        m.failRate = Math.min(8, +(m.failRate + 0.5).toFixed(2))
        m.success = +(100 - m.failRate).toFixed(1)
      }
    })
    // 阈值检测 → 自动生成建议工单
    st.pools.forEach((p) => {
      const u = poolUtil(st, p.id)
      if (u > 90) {
        const exists = st.orders.some((o) => o.status === 'submitted' && o.type === 'pool_expand' && o.spec.pool === p.id)
        if (!exists && freeCards(st) > 0) {
          st.seq += 1
          const need = Math.min(freeCards(st), Math.max(2, Math.ceil(demandOf(st, p.id) / 0.75 - p.cards)))
          const o = mkOrder(st.seq, 'pool_expand', `自动扩容建议 · ${p.name}`, '调度引擎（自动）', '运营', p.id === 'hp' ? '高保' : '共享', p.name, `+${need} 卡`, `${p.name} 利用率 ${u}% 连续超阈值 90%，自动生成扩缩协同建议`, 'submitted', true, { pool: p.id, cards: need })
          trace(o, '调度引擎', '自动触发', `利用率 ${u}% > 阈值 90% · 空闲 ${freeCards(st)} 卡`, 'warn')
          st.orders.unshift(o)
          st.events.unshift({ time: nowStr(), level: '重要', text: `${p.name} 利用率 ${u}% 超阈值，自动生成扩容建议 ${o.id}` })
        }
      }
    })
    // 权重偏离度检测
    const ws = st.channels.map((c) => c.weight)
    const dev = Math.max(...ws) - Math.min(...ws)
    if (dev > 30) {
      const exists = st.orders.some((o) => o.status === 'submitted' && o.type === 'weight_adjust')
      if (!exists) {
        st.seq += 1
        const rebal = suggestWeights(st)
        const o = mkOrder(st.seq, 'weight_adjust', '自动调度优化建议 · 负载均衡偏离', '调度引擎（自动）', '运营', '共享', '全渠道', `权重 → ${rebal.join('/')}`, `渠道负载偏离度 ${dev}% 超 30%，自动生成调度优化建议`, 'submitted', true, { weights: rebal.join(',') })
        trace(o, '调度引擎', '自动触发', `偏离度 ${dev}% · 低效渠道 <30% / 过载渠道 >80%`, 'warn')
        st.orders.unshift(o)
      }
    }
    pushHistory(st)
    this.emit()
  }

  /** 僵尸凭证 / 到期凭证扫描 */
  scanCreds() {
    const st = this.state
    const stale = st.creds.filter((c) => c.status !== 'off' && (c.expDays <= 15 || c.lastUsedDays >= 90))
    stale.forEach((c) => {
      const exists = st.orders.some((o) => o.status === 'submitted' && o.type === 'credential_revoke' && o.spec.credId === c.id)
      if (exists) return
      st.seq += 1
      const why = c.lastUsedDays >= 90 ? `连续 ${c.lastUsedDays} 天未使用（僵尸凭证）` : `距到期仅 ${c.expDays} 天，须轮换或回收`
      const o = mkOrder(st.seq, 'credential_revoke', `凭证回收建议 · ${c.id}`, '凭证管控岗（自动盘点）', '运营', c.kind === '个人密钥' ? '共享' : '高保', `${c.id}（${c.holder}）`, `${c.rpm} RPM`, why, 'submitted', true, { credId: c.id })
      trace(o, '凭证盘点', '自动触发', why, 'warn')
      st.orders.unshift(o)
    })
    st.events.unshift({ time: nowStr(), level: '一般', text: `凭证盘点完成：识别 ${stale.length} 项待轮换/回收，已生成回收建议工单` })
    this.emit()
    return stale.length
  }

  /** 一键演示：冲击负载 → 自动建议 → 审批 → 执行 */
  /* -------- 演示场景包：一键把平台推到某个可讲解的状态 -------- */
  applyScenario(id: ScenarioId) {
    const st = this.state
    const steps: string[] = []
    const done = (t: string) => steps.push(t)
    const run = (res: { order: Order; precheck: { ok: boolean; reason?: string; suggest?: string } }) => {
      const oid = res.order.id
      if (!res.precheck.ok) { done(`✗ ${res.order.title} 被准入拒绝：${res.precheck.reason ?? ''}`); return undefined }
      this.approve(oid)
      const cur = st.orders.find((x) => x.id === oid)!
      done(`✔ ${oid} ${res.order.title} → ${cur.status === 'queued' ? '已排队（等待变更窗口）' : cur.status === 'running' ? '已执行生效' : cur.status}`)
      return oid
    }

    if (id === 'channel') {
      const cam = st.channels.find((c) => c.id === 'cambricon')
      if (cam) { cam.err = 6.8; cam.latency = 420; cam.health = 'fault'; done(`✔ 模拟健康探测失败：${cam.name} 错误率升至 ${cam.err}% · p95 ${cam.latency}ms`) }
      const r = this.failover('cambricon')
      done(r.ok && 'from' in r ? `✔ 自动故障切换已生效：${r.from} → ${r.to} · 受影响业务方 ${r.affected?.length ?? 0} 个（异常渠道已降权）` : `✗ 自动切换未执行：${('reason' in r ? r.reason : '') ?? '条件不满足'}`)
      done('→ 可在推理网关页看到渠道权重变化与被通知的业务方，演练结束可点「回切」恢复')
    } else if (id === 'hpPressure') {
      const rel = run(this.submit({ type: 'pool_release', applicant: '运营值班 · 场景演练', dept: '运营', level: '共享', reason: '演练前置：高保集群回收 2 卡给训练任务，制造容量吃紧场景', spec: { pool: 'hp', cards: 2 } }))
      if (rel) this.close(rel)
      done(`✔ 高保集群利用率推高至 ${poolUtil(st, 'hp')}%（触发线 90%）`)
      const pre = run(this.submit({ type: 'preempt', applicant: '运营值班 · 场景演练', dept: '运营', level: '高保', reason: '高保集群利用率超触发线，从共享集群抢占卡位保障核心业务 A 与核心业务 B', spec: { from: 'shared', to: 'hp', cards: 3 } }))
      if (pre) this.close(pre)
      done(`✔ 抢占后：高保 ${st.pools.find((x) => x.id === 'hp')!.cards} 卡（利用率 ${poolUtil(st, 'hp')}%）· 共享 ${st.pools.find((x) => x.id === 'shared')!.cards} 卡（利用率 ${poolUtil(st, 'shared')}%）`)
      done('→ 被抢占方应用已收到副本降级通知，工单可回滚恢复原保障等级')
    } else if (id === 'incident') {
      const q = run(this.submit({ type: 'quota_adjust', applicant: '调度行 · 场景演练', dept: '信息', level: '高保', reason: '重点事件高发时段业务事件报告调用激增，平台代理凭证临时提额以保障成文链路', spec: { credId: 'SA-0092', rpm: 360 } }))
      if (q) this.close(q)
      const c = run(this.submit({ type: 'containment', applicant: '运行监测 · 场景演练', dept: '应用中心', level: '共享', reason: '事件高峰期间公开信息类应用并发拉高，先限流保护共享池，避免拖垮业务事件与咨询核心链路', spec: { kind: '智能体应用', name: '公开信息筛选', action: '限流保护', basis: '告警触发' } }))
      if (c) this.close(c)
      const scan = this.scanCreds()
      done(`✔ 凭证临时提额（SA-0092 300 → 360 RPM）· 公开信息应用限流保护 · 自动凭证盘点生成 ${scan} 项建议工单`)
      done(`✔ 承载变化：存活副本 ${totalReplicas(st)} 个 · 推理卡位 ${st.pools.filter((x) => x.id !== 'train').reduce((sm, x) => sm + x.cards, 0)} 卡 · 限流保护中应用 1 项`)
      done('→ 可在总览与运营分析看到调用量与成本同步变化，运营通知查看限流通知处置')
    } else if (id === 'compliance') {
      const k = run(this.submit({ type: 'containment', applicant: '合规抽查 · 场景演练', dept: '示例业务三部', level: '共享', reason: '合规抽查发现知识库存在超期未复核条目，暂停入库并在复核完成后恢复', spec: { kind: '知识库', name: '交通违规判例库', action: '暂停入库', basis: '合规抽查' } }))
      if (k) this.close(k)
      const rvRes = this.submit({ type: 'credential_revoke', applicant: '合规抽查 · 场景演练', dept: '示例业务三部', level: '共享', reason: '个人密钥临期且长期未使用，存在外发迹象，提交吊销申请待运营审批', spec: { credId: 'PK-2503' } })
      if (!rvRes.precheck.ok) done(`✗ 吊销申请被拒：${rvRes.precheck.reason ?? ''}`)
      else { done(`✔ 凭证吊销申请 ${rvRes.order.id} 已提交（演示保留待审批状态，可在凭证页或工单里手动通过）`); done(`   准入判断：${rvRes.precheck.suggest ?? '已纳入待审批队列'}`) }
      const rv = undefined
      done(`✔ 知识库暂停入库已执行（在库队列滞留，恢复后自动解除）· 凭证吊销保持待审批，演示审批环节`)
      done(`✔ 自动凭证盘点：${0} 项配额异常已生成建议工单`)
      done('→ 可在应用中心安全事件与模型中心凭证页看到处置状态与待审批申请')
    } else if (id === 'nightWindow') {
      const cur = this.activeSlot()
      if (cur) { this.closeSlot(cur.id); done(`✔ 结束当前变更窗口 ${cur.id}`) }
      st.orders.filter((o) => o.status === 'running').forEach((o) => this.close(o.id))
      const date = new Date().toISOString().slice(0, 10)
      const book = this.bookSlot({ date, from: '22:00', to: '23:30', scope: '全平台', reason: '夜间变更窗口：共享池扩容与 GLM 副本调整', by: '运营值班 · 场景演练' })
      done(book.ok ? `✔ 预约夜间窗口 ${book.id}（${date} 22:00-23:30 全平台）` : `✗ 预约失败：${book.reason}`)
      run(this.submit({ type: 'pool_expand', applicant: '示例业务二部 · 场景演练', dept: '示例业务二部', level: '灰度', reason: '灰度模型承载不足，夜间窗口内为共享集群扩容 4 卡', spec: { pool: 'shared', cards: 4 } }))
      run(this.submit({ type: 'replica_scale', applicant: '示例业务二部 · 场景演练', dept: '示例业务二部', level: '灰度', reason: '灰度图像审核并发上升，夜间窗口内为 Qwen2.5-VL 增 1 副本', spec: { model: 'Qwen2.5-VL', delta: 1 } }))
      done(`✔ 窗口外提交的 2 项变更已排队（当前排队 ${this.queueOrders().length} 项），工单轨迹写明「排入下一预约窗口」`)
      if (book.ok) { const o = this.openSlot(String(book.id)); done(o.ok ? `✔ 夜间窗口已开启，排队工单按序自动接续执行` : `✗ 开启窗口失败：${o.reason}`) }
      done(`✔ 窗口开启后：排队剩余 ${this.queueOrders().length} 项 · 高保 ${poolUtil(st, 'hp')}% · 共享 ${poolUtil(st, 'shared')}%`)
    }

    st.events.unshift({ time: nowStr(), level: '重要', text: `演示场景包已执行：${SCENARIO_LABEL[id]}（共 ${steps.filter((x) => x.startsWith('✔')).length} 项动作）` })
    this.emit()
    this.pumpQueue()
    return { ok: true as const, steps }
  }

  runScenario() {
    const st = this.state
    // 1) 冲击负载：把高保池需求拉高
    const q = st.models.find((m) => m.short === 'Qwen3-32B')
    if (q && poolUtil(st, 'hp') < 95) { q.replicas += 2; q.perReplica = 2 }
    this.tickSimulate()
    // 2) 自动审批引擎建议（模拟人工确认）
    const suggestion = st.orders.find((o) => o.status === 'submitted' && o.auto && o.type === 'pool_expand')
    if (suggestion) this.approve(suggestion.id)
    // 3) 渠道劣化 → 权重再平衡
    const cam = st.channels.find((c) => c.id === 'cambricon')
    if (cam) { cam.err = 2.4; cam.health = 'warn'; cam.weight = 34 }
    if (st.channels.reduce((s, c) => s + c.weight, 0) !== 100) {
      const reb = suggestWeights(st)
      this.submit({ type: 'weight_adjust', applicant: '调度引擎（自动）', dept: '运营', level: '共享', reason: '渠道劣化触发权重再平衡', spec: { weights: reb.join(',') } })
    }
  }
}

function suggestWeights(st: EngineState) {
  // 权重建议：配额余量越大、健康度越好 → 权重越高；异常渠道明显降权
  const capLoad = st.channels.map((c) => {
    const occ = c.capacityRpm > 0 ? (c.allocatedRpm / c.capacityRpm) * 100 : 100
    const headroom = Math.max(5, 100 - occ)
    const healthFactor = c.health === 'ok' ? 1 : c.err > 2 ? 0.25 : 0.45
    const latPenalty = c.latency > 180 ? 0.7 : 1
    return Math.max(5, Math.round(headroom * healthFactor * latPenalty))
  })
  const sum = capLoad.reduce((s, x) => s + x, 0)
  const scaled = capLoad.map((x) => Math.max(5, Math.round((x / sum) * 100)))
  // 归一化修正
  const d = 100 - scaled.reduce((s, x) => s + x, 0)
  scaled[0] += d
  return scaled
}


/** 该接入通道被哪些登记对象依赖（用于阻断影响面提示） */
function governDependents(connectorName: string): string[] {
  return connectorStore.dependentsOf(connectorName)
}

function describeTarget(st: EngineState, type: OrderType, spec: Record<string, number | string | boolean>) {
  if (type === 'pool_expand' || type === 'pool_release') return st.pools.find((p) => p.id === spec.pool)?.name ?? String(spec.pool)
  if (type === 'replica_scale') return String(spec.model)
  if (type === 'weight_adjust') return '全渠道权重'
  if (type === 'preempt') {
    const from = st.pools.find((p) => p.id === spec.from)?.name ?? String(spec.from)
    const to = st.pools.find((p) => p.id === spec.to)?.name ?? String(spec.to)
    return `${from} → ${to}`
  }
  if (type === 'credential_issue') return String(spec.app)
  if (type === 'credential_revoke') return String(spec.credId)
  if (type === 'quota_adjust') return String(spec.credId)
  if (type === 'containment') return `${String(spec.kind)} · ${String(spec.name)}`
  if (type === 'access_block' || type === 'access_restore') return connectorStore.find(String(spec.connectorId))?.name ?? String(spec.connectorId)
  if (type === 'model_admission') return String(spec.model)
  if (type === 'model_rollback') return `${String(spec.model)} 版本`
  if (type === 'model_retire') return String(spec.model)
  if (type === 'model_deploy') return `${String(spec.model)} → ${st.pools.find((p) => p.id === String(spec.pool))?.name ?? String(spec.pool)}`
  if (type === 'training_dataset') return `${spec.name} · ${spec.version}`
  if (type === 'train_extend') return String(spec.jobId)
  if (type === 'train_reserve') return String(spec.name)
  if (type === 'train_release') return String(spec.jobId)
  return ''
}
function describeAmount(type: OrderType, spec: Record<string, number | string | boolean>) {
  if (type === 'pool_expand') return `+${spec.cards} 卡`
  if (type === 'pool_release') return `-${spec.cards} 卡`
  if (type === 'preempt') return `抢占 ${spec.cards} 卡`
  if (type === 'replica_scale') return `${Number(spec.delta) > 0 ? '+' : ''}${spec.delta} 副本`
  if (type === 'weight_adjust') return `权重 ${String(spec.weights).replace(/,/g, '/')}`
  if (type === 'credential_issue') return `RPM ${spec.rpm}`
  if (type === 'credential_revoke') return '吊销'
  if (type === 'quota_adjust') return `RPM → ${spec.rpm}`
  if (type === 'containment') return String(spec.action)
  if (type === 'access_block') {
    const scope = String(spec.scope ?? '全通道')
    return scope === '全通道' ? '阻断接入并停止采集' : `部分阻断（${scope}）：${String(spec.value ?? '')}`
  }
  if (type === 'access_restore') return '恢复接入与采集'
  if (type === 'model_rollback') return `→ ${spec.toVersion}`
  if (type === 'model_retire') return '下线变更'
  if (type === 'model_deploy') return `${spec.replicas} 副本 × ${Number(spec.perReplica) || 1} 卡 · 灰度 ${Number(spec.gray ?? 100)}%`
  if (type === 'train_reserve') return `${spec.cards} 卡 × ${spec.hours} 小时`
  if (type === 'train_extend') return `+${spec.hours} 小时`
  if (type === 'train_release') return '归还卡位'
  return ''
}

function applyEffect(st: EngineState, o: Order) {
  switch (o.type) {
    case 'pool_expand': {
      const p = st.pools.find((x) => x.id === o.spec.pool)!
      const cards = Number(o.spec.cards)
      const localFree = TOTAL_CARDS - (totalAllocated(st) - st.rented)
      const rentPart = Math.max(0, Math.min(cards - localFree, rentInfo(st).available))
      o.spec.rentedPart = rentPart
      p.cards += cards
      st.rented += rentPart
      if (rentPart > 0) trace(o, '调度引擎', '外部扩租开卡', `其中 ${rentPart} 卡来自外部算力扩租通道（${rentConfig().price} 元/卡/日）· 额度已用 ${st.rented} / ${rentConfig().quota} 卡`, 'info')
      break
    }
    case 'pool_release': {
      const p = st.pools.find((x) => x.id === o.spec.pool)!
      const cards = Number(o.spec.cards)
      const backRent = Math.min(cards, st.rented)
      o.spec.releasedRented = backRent
      p.cards -= cards
      st.rented -= backRent
      if (backRent > 0) trace(o, '调度引擎', '退回扩租卡位', `退回外部扩租卡位 ${backRent} 卡 · 额度与外部成本同步回滚`, 'info')
      break
    }
    case 'model_deploy': {
      const pool = st.pools.find((x) => x.id === String(o.spec.pool))!
      const short = String(o.spec.model)
      const replicas = Number(o.spec.replicas)
      const per = Number(o.spec.perReplica) || 1
      const m = st.models.find((x) => x.short === short)
      const version = String(o.spec.version ?? '').trim() || m?.ver || String(o.spec.image ?? 'v1.0')
      o.spec.prevDeployed = m ? '0' : '1'
      o.spec.prevReplicas = m?.replicas ?? 0
      o.spec.prevVersion = m?.ver ?? ''
      if (m) {
        m.replicas = m.replicas + replicas
        m.ver = version
        if (!m.versions.includes(version)) m.versions = [...m.versions, version]
        m.state = '运行中'
      } else {
        st.models.push({ name: `${short} · 内网部署`, short, pool: pool.id, replicas, perReplica: per, ver: version, versions: [version], state: '运行中' })
      }
      o.spec.prevPoolCards = pool.cards
      trace(o, '容器平台', '部署执行回执已回填', `实例 ${String(o.spec.instances ?? '未提供清单')} · ${String(o.spec.receiptNote ?? '回执无附加说明')} · 目标节点 ${String(o.spec.nodes)}`, 'good')
      break
    }
    case 'train_reserve': {
      const due = new Date(Date.now() + Number(o.spec.hours) * 3600000)
      st.jobs = [...(st.jobs ?? []), {
        id: `FT-${o.id}`, reserveId: o.id, deadline: due.getTime(), name: String(o.spec.name), pool: 'train', cards: Number(o.spec.cards),
        applicant: o.applicant, dept: o.dept, framework: String(o.spec.framework), dataLevel: String(o.spec.dataLevel),
        hours: Number(o.spec.hours), dueAt: `${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')} ${due.toTimeString().slice(0, 5)}`, state: '运行中',
      }]
      trace(o, '调度引擎', '训练卡位已预留', `${o.spec.name} · ${o.spec.cards} 卡 × ${o.spec.hours} 小时 · 归口 ${o.dept} · 数据密级 ${o.spec.dataLevel}`, 'good')
      break
    }
    case 'train_extend': {
      const job = st.jobs.find((item) => item.id === o.spec.jobId)!
      o.spec.previousDeadline = job.deadline!
      job.deadline! += Number(o.spec.hours) * 3600000
      job.hours += Number(o.spec.hours)
      job.dueAt = new Date(job.deadline!).toLocaleString('zh-CN', { hour12: false })
      trace(o, '训练算力台账', '已更新训练期限', job.dueAt, 'good')
      break
    }
    case 'train_release': {
      const j = st.jobs.find((x) => x.id === String(o.spec.jobId))!
      o.spec.prevJobState = j.state
      o.spec.prevJobCards = j.cards
      j.state = '已完成'
      trace(o, '运营值班', '训练卡位已归还', `${j.name} · 归还 ${j.cards} 卡 · 台账闭环`, 'good')
      break
    }
    case 'replica_scale': { const m = st.models.find((x) => x.short === o.spec.model)!; m.replicas += Number(o.spec.delta); break }
    case 'weight_adjust': {
      const ws = String(o.spec.weights).split(',').map((x) => parseInt(x))
      o.spec.prevWeights = st.channels.map((c) => c.weight).join(',')
      st.channels.forEach((c, i) => { c.weight = ws[i] })
      break
    }
    case 'preempt': {
      const from = st.pools.find((p) => p.id === o.spec.from)!
      const to = st.pools.find((p) => p.id === o.spec.to)!
      const cards = Number(o.spec.cards)
      const affected = affectedModels(st, from.id, cards)
      o.spec.prevFromCards = from.cards
      o.spec.prevToCards = to.cards
      o.spec.prevReplicas = affected.map((m) => `${m.short}:${m.replicas}`).join(',')
      o.spec.affected = affected.map((m) => `${m.short}（${(MODEL_APPS[m.short] ?? ['—']).join('、')}）`).join(' | ')
      from.cards -= cards
      to.cards += cards
      let left = cards
      affected.forEach((m) => {
        const can = Math.max(0, m.replicas - 1)
        const cut = Math.min(can, Math.floor(left / m.perReplica))
        if (cut > 0) { m.replicas -= cut; left -= cut * m.perReplica }
      })
      break
    }
    case 'credential_issue': {
      st.creds.unshift({ id: String(o.spec.credId ?? `SA-${1000 + st.seq}`), kind: o.spec.kind as Cred['kind'], holder: String(o.spec.holder), app: String(o.spec.app), model: String(o.spec.model), channel: String(o.spec.channel), rpm: Number(o.spec.rpm), tpm: String(o.spec.tpm), ip: String(o.spec.ip ?? '10.20.0.0/24'), expDays: 90, lastUsedDays: 0, status: 'ok' })
      break
    }
    case 'access_block': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      const scope = String(o.spec.scope ?? '全通道')
      const value = String(o.spec.value ?? '').trim()
      o.spec.prevEnabled = c.enabled
      o.spec.prevHealth = c.health
      o.spec.prevScope = c.blockedScope ?? ''
      o.spec.prevValue = c.blockedValue ?? ''
      if (scope === '全通道') {
        connectorStore.setEnabled(c.id, false)
        connectorStore.setHealth(c.id, 'fault')
        connectorStore.update(c.id, { blocking: `已阻断：${String(o.spec.note ?? o.reason).slice(0, 40)}`, blockedScope: '', blockedValue: '' })
        trace(o, '例外监控', '接入通道已阻断', `${c.name} · 采集与调用同时停止 · 归口 ${c.owner} 已通知`, 'bad')
      } else {
        connectorStore.setHealth(c.id, 'warn')
        connectorStore.update(c.id, { blockedScope: scope, blockedValue: value, blocking: `部分阻断（${scope}）：${value}` })
        trace(o, '例外监控', `接入部分阻断（${scope}）`, `${c.name} · 已切断：${value} · 其余采集与调用继续 · 归口 ${c.owner} 已通知`, 'warn')
      }
      break
    }
    case 'access_restore': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      const partial = Boolean(c.blockedScope)
      o.spec.prevEnabled = c.enabled
      o.spec.prevHealth = c.health
      o.spec.prevScope = c.blockedScope ?? ''
      o.spec.prevValue = c.blockedValue ?? ''
      connectorStore.setEnabled(c.id, true)
      connectorStore.setHealth(c.id, 'ok')
      connectorStore.update(c.id, { blockedScope: '', blockedValue: '', blocking: partial ? `部分阻断已解除（原 ${c.blockedScope}：${c.blockedValue}）` : '整改完成，接入已恢复' })
      trace(o, '例外监控', partial ? '部分阻断已解除' : '接入通道已恢复', `${c.name} · 采集恢复 · ${partial ? '该来源限制已清除' : '前置条件与就绪校验通过'}`, 'good')
      break
    }
    case 'credential_revoke': { const c = st.creds.find((x) => x.id === o.spec.credId)!; c.status = 'off'; break }
    case 'quota_adjust': { const c = st.creds.find((x) => x.id === o.spec.credId)!; o.spec.prevRpm = c.rpm; c.rpm = Number(o.spec.rpm); break }
    case 'containment': {
      const m = st.managed.find((x) => x.kind === o.spec.kind && x.name === o.spec.name)!
      o.spec.prevStatus = m.status
      o.spec.prevTech = m.tech
      o.spec.prevBiz = m.biz
      const want = ACTION_STATUS[String(o.spec.action) as ContainAction]
      m.status = want
      if (m.kind === 'MCP工具' || m.kind === '插件') {
        if (want === '隔离' || want === '禁用') { m.tech = false; m.biz = false }
        if (want === '正常') { m.tech = true; m.biz = true }
      }
      if (m.kind === '知识库' && want === '暂停') { o.spec.prevQueue = m.queue; m.queue = Math.max(30, m.queue + 40) }
      if (m.kind === '知识库' && want === '正常') { m.queue = Math.max(0, Math.round(m.queue * 0.4)) }
      break
    }
    case 'model_rollback': {
      const m = st.models.find((x) => x.short === o.spec.model)!
      o.spec.prevVer = m.ver
      m.ver = String(o.spec.toVersion)
      m.name = m.name.replace(/v\d+\.\d+(-\d+)?/, m.ver)
      break
    }
    case 'model_retire': {
      const m = st.models.find((x) => x.short === o.spec.model)!
      const pool = st.pools.find((p) => p.id === m.pool)!
      o.spec.prevReplicas = m.replicas
      o.spec.prevPool = m.pool
      o.spec.freedCards = m.replicas * m.perReplica
      pool.cards += m.replicas * m.perReplica
      m.replicas = 0
      m.state = '已下线'
      break
    }
  }
}
function reverseEffect(st: EngineState, o: Order) {
  switch (o.type) {
    case 'pool_expand': { const p = st.pools.find((x) => x.id === o.spec.pool)!; p.cards -= Number(o.spec.cards); st.rented -= Number(o.spec.rentedPart ?? 0); break }
    case 'pool_release': { const p = st.pools.find((x) => x.id === o.spec.pool)!; p.cards += Number(o.spec.cards); st.rented += Number(o.spec.releasedRented ?? 0); break }
    case 'model_deploy': {
      const short = String(o.spec.model)
      if (String(o.spec.prevDeployed) === '1') st.models = st.models.filter((x) => x.short !== short)
      else {
        const m = st.models.find((x) => x.short === short)
        if (m) { m.replicas = Number(o.spec.prevReplicas); m.ver = String(o.spec.prevVersion || m.ver) }
      }
      trace(o, '变更窗口 · 执行引擎', '部署已回滚', `${short} 恢复到部署前状态 · 卡位已归还 · 路由与凭证不受影响`, 'warn')
      break
    }
    case 'train_extend': {
      const job = st.jobs.find((item) => item.id === o.spec.jobId)
      if (job) {
        job.deadline = Number(o.spec.previousDeadline)
        job.hours -= Number(o.spec.hours)
        job.dueAt = new Date(job.deadline).toLocaleString('zh-CN', { hour12: false })
      }
      break
    }
    case 'train_reserve': {
      st.jobs = st.jobs.filter((job) => job.reserveId ? job.reserveId !== o.id : !(job.name === String(o.spec.name) && job.cards === Number(o.spec.cards) && job.state === '运行中'))
      break
    }
    case 'train_release': {
      const j = st.jobs.find((x) => x.id === String(o.spec.jobId))
      if (j) { j.state = (o.spec.prevJobState as '运行中') ?? '运行中'; j.cards = Number(o.spec.prevJobCards) || j.cards }
      break
    }
    case 'replica_scale': { const m = st.models.find((x) => x.short === o.spec.model)!; m.replicas -= Number(o.spec.delta); break }
    case 'weight_adjust': {
      const prev = String(o.spec.prevWeights ?? '').split(',').map((x) => parseInt(x))
      if (prev.length === st.channels.length) st.channels.forEach((c, i) => { c.weight = prev[i] })
      break
    }
    case 'preempt': {
      const from = st.pools.find((p) => p.id === o.spec.from)!
      const to = st.pools.find((p) => p.id === o.spec.to)!
      if (o.spec.prevFromCards !== undefined) from.cards = Number(o.spec.prevFromCards)
      if (o.spec.prevToCards !== undefined) to.cards = Number(o.spec.prevToCards)
      String(o.spec.prevReplicas ?? '').split(',').forEach((pair) => {
        const [short, n] = pair.split(':')
        const m = st.models.find((x) => x.short === short)
        if (m && n) m.replicas = Number(n)
      })
      break
    }
    case 'credential_issue': { st.creds = st.creds.filter((c) => c.app !== String(o.spec.app)); break }
    case 'access_block': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      if (o.spec.prevEnabled !== undefined) connectorStore.setEnabled(c.id, Boolean(o.spec.prevEnabled))
      if (o.spec.prevHealth) connectorStore.setHealth(c.id, o.spec.prevHealth as Connector['health'])
      connectorStore.update(c.id, { blockedScope: String(o.spec.prevScope ?? ''), blockedValue: String(o.spec.prevValue ?? ''), blocking: o.spec.prevScope ? `部分阻断（${o.spec.prevScope}）：${o.spec.prevValue}` : c.blocking })
      trace(o, '例外监控', '阻断已撤销', `${c.name} · 接入与采集恢复至阻断前状态`, 'warn')
      break
    }
    case 'access_restore': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      if (o.spec.prevEnabled !== undefined) connectorStore.setEnabled(c.id, Boolean(o.spec.prevEnabled))
      if (o.spec.prevHealth) connectorStore.setHealth(c.id, o.spec.prevHealth as Connector['health'])
      if (o.spec.prevScope) connectorStore.update(c.id, { blockedScope: String(o.spec.prevScope), blockedValue: String(o.spec.prevValue ?? ''), blocking: `部分阻断（${o.spec.prevScope}）：${o.spec.prevValue}` })
      trace(o, '例外监控', '恢复已撤销', `${c.name} · 回到阻断状态`, 'warn')
      break
    }
    case 'credential_revoke': { const c = st.creds.find((x) => x.id === o.spec.credId)!; c.status = 'ok'; break }
    case 'quota_adjust': { const c = st.creds.find((x) => x.id === o.spec.credId)!; if (o.spec.prevRpm !== undefined) c.rpm = Number(o.spec.prevRpm); break }
    case 'containment': {
      const m = st.managed.find((x) => x.kind === o.spec.kind && x.name === o.spec.name)!
      if (o.spec.prevStatus) m.status = o.spec.prevStatus as ManagedStatus
      if (o.spec.prevQueue !== undefined) m.queue = Number(o.spec.prevQueue)
      if (o.spec.prevTech !== undefined) m.tech = Boolean(o.spec.prevTech)
      if (o.spec.prevBiz !== undefined) m.biz = Boolean(o.spec.prevBiz)
      break
    }
    case 'model_rollback': {
      const m = st.models.find((x) => x.short === o.spec.model)!
      if (o.spec.prevVer) { m.name = m.name.replace(/v\d+\.\d+(-\d+)?/, String(o.spec.prevVer)); m.ver = String(o.spec.prevVer) }
      break
    }
    case 'model_retire': {
      const m = st.models.find((x) => x.short === o.spec.model)!
      const pool = st.pools.find((p) => p.id === (o.spec.prevPool ?? m.pool))!
      m.replicas = Number(o.spec.prevReplicas ?? 1)
      m.state = '运行中'
      pool.cards -= m.replicas * m.perReplica
      break
    }
  }
}
function verifyResult(st: EngineState, o: Order) {
  if (o.type === 'pool_expand' || o.type === 'pool_release') {
    const p = st.pools.find((x) => x.id === o.spec.pool)!
    return `${p.name} 卡位 ${p.cards} · 当前利用率 ${poolUtil(st, p.id)}%`
  }
  if (o.type === 'preempt') {
    const from = st.pools.find((p) => p.id === o.spec.from)!
    const to = st.pools.find((p) => p.id === o.spec.to)!
    return `${to.name} ${to.cards} 卡（利用率 ${poolUtil(st, to.id)}%）· ${from.name} ${from.cards} 卡（利用率 ${poolUtil(st, from.id)}%）· 被抢占方通知已发出`
  }
  if (o.type === 'replica_scale') { const m = st.models.find((x) => x.short === o.spec.model)!; return `${m.short} 副本 ${m.replicas} 存活 · 健康探针通过` }
  if (o.type === 'weight_adjust') return st.channels.map((c) => `${c.name.split('（')[0]} ${c.weight}%`).join(' · ')
  if (o.type === 'credential_issue') return '凭证已发放 · 配额与审批单一致 · IP 白名单生效'
  if (o.type === 'credential_revoke') return '凭证已吊销 · 关联授权与路由已清理'
  if (o.type === 'access_block' || o.type === 'access_restore') {
    const c = connectorStore.find(String(o.spec.connectorId))!
    const depends = governDependents(c.name)
    return `${c.name} 通道${c.enabled ? '已启用（采集中）' : '已阻断（停止采集与调用）'} · 健康 ${c.health} · 关联登记对象 ${depends.length} 项 · 配置版本 v${c.version}`
  }
  if (o.type === 'containment') {
    const m = st.managed.find((x) => x.kind === o.spec.kind && x.name === o.spec.name)!
    return `${m.name} 状态 ${String(o.spec.prevStatus ?? '—')} → ${m.status}${m.kind === '知识库' && m.status === '暂停' ? ` · 在库队列 ${m.queue} 项滞留（恢复后自动解除）` : ''}${(m.kind === 'MCP工具' || m.kind === '插件') ? ` · 目录同步：技术注册目录${m.tech ? '保留' : '已摘除'} / 业务使用目录${m.biz ? '保留' : '已摘除'}` : ''} · 归口 ${m.owner} 通知已发出`
  }
  if (o.type === 'model_rollback') {
    const m = st.models.find((x) => x.short === o.spec.model)!
    return `${m.short} 已运行于 ${m.ver} · 副本 ${m.replicas} 存活 · 调用链路可用性验证通过（Chat / Embed / Rerank / ASR 探测正常）`
  }
  if (o.type === 'model_retire') {
    const m = st.models.find((x) => x.short === o.spec.model)!
    const pool = st.pools.find((p) => p.id === m.pool)!
    return `${m.short} 已下线并从能力目录摘除 · 释放 ${String(o.spec.freedCards ?? 0)} 卡归还「${pool.name}」（利用率 ${poolUtil(st, pool.id)}%）· 受影响应用通知已发出 · 配置快照保留可恢复`
  }
  return '变更已生效'
}

export const engine = new Engine()
export function useEngine() {
  return useSyncExternalStore(engine.subscribe, engine.get, engine.get)
}
export { TOTAL_CARDS }
