/* =====================================================================
 * 内网版遥测接入层（只读）
 * 两种取数：
 *   ① 采集层已落数（collector 把昇腾 / MindIE / LiteLLM / Dify / RAGFlow 的
 *      真实数据写成 ./data/*.json，页面直接读，来源标「采集层」）
 *   ② 平台内推导（无采集层时由资源账本 + 推理引擎模型推导出同源指标，
 *      来源标「平台推导」，保证页面有数据在跑但不连外网）
 * 只读：本层不向任何外部系统写数据，处置动作一律走平台工单引擎
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine, poolUtil, type PoolId } from './engine'
import { metricsOf } from './inference'
import { apiGet } from './db'
import { computeNodes } from '../data/mock'

export type SourceId = 'npu' | 'mindie' | 'litellm' | 'dify' | 'ragflow' | 'deploy'
export interface SourceSpec {
  id: SourceId
  name: string
  file: string
  via: string
  auth: string
  every: string
  fields: string[]
  note: string
}

/** 六个取数点：接口清单就是这张表，真实环境按它对接（不改平台代码） */
export const SOURCES: SourceSpec[] = [
  {
    id: 'npu', name: '昇腾卡指标', file: 'cards.json', via: 'npu-smi info（节点侧脚本）或 NPU Exporter → Prometheus query',
    auth: '采集机本地执行 / Prometheus 只读 token', every: '30 秒',
    fields: ['node', 'card_id', 'model', 'pool', 'util_pct', 'hbm_used_gb', 'hbm_total_gb', 'temp_c', 'power_w', 'health', 'service'],
    note: '温度、功耗、HBM、掉卡与 ECC 计数取自 npu-smi；厂商不给的字段留空并在页面标「不可采集」',
  },
  {
    id: 'mindie', name: 'MindIE 推理服务指标', file: 'services.json', via: 'MindIE /metrics（或 vLLM /metrics）',
    auth: '集群内网只读，无鉴权需网络隔离', every: '15 秒',
    fields: ['service', 'model', 'version', 'pool', 'instances', 'ready', 'qps', 'tokens_per_sec', 'ttft_ms', 'p99_ms', 'queue_depth', 'kv_hit_pct', 'hbm_pct', 'err_pct', 'restarts'],
    note: '首包时延与队列深度是选型验收要写清的指标，这里按 MindIE 原字段名对齐',
  },
  {
    id: 'litellm', name: 'LiteLLM 网关仪表', file: 'gateway.json', via: 'LiteLLM Admin API：/key/info · /spend/logs · /model/info · /metrics',
    auth: 'LITELLM_MASTER_KEY（只读作用域）', every: '60 秒',
    fields: ['key_id', 'holder', 'app', 'model', 'rpm_limit', 'tpm_limit', 'used_rpm', 'spend_day', 'requests', 'errors', 'fallbacks', 'status'],
    note: '网关侧的 key 与配额要和平台凭证台账双向对齐，不一致就在页面标出并生成例外',
  },
  {
    id: 'dify', name: 'Dify 应用与发布状态', file: 'apps.json', via: 'Dify Console API / Service API（应用列表 + 应用详情）',
    auth: '邮箱密码登录取 session 或 API Key（建议只读账号）', every: '5 分钟',
    fields: ['name', 'type', 'status', 'owner', 'updated_at', 'models', 'calls_day'],
    note: '第一期只取应用清单与发布状态；日志与配额属第二期，接口位置已留出',
  },
  {
    id: 'ragflow', name: 'RAGFlow 应用与数据集状态', file: 'apps.json', via: 'RAGFlow HTTP API：/api/v1/datasets · /api/v1/chats · /api/v1/agent',
    auth: 'Bearer API Token（建议只读账号）', every: '5 分钟',
    fields: ['name', 'type', 'status', 'owner', 'updated_at', 'models', 'docs'],
    note: '数据集条目数用于与平台知识库目录做一致性核查',
  },
  {
    id: 'deploy', name: '容器平台部署回执', file: 'deploy.json', via: '容器平台工单查询接口（回执已确认可提供）/ 运维回填 drop_file（平台不下发部署）',
    auth: '回执接口 token', every: '工单触发',
    fields: ['order_id', 'result', 'instances', 'image', 'nodes', 'finished_at', 'note'],
    note: '平台只发单与验收：回执到位才算生效，超时未回执在页面标「待回执」并报警',
  },
]

export interface NpuCard {
  id: string
  node: string
  model: string
  pool: PoolId
  poolName: string
  util: number
  hbmUsed: number
  hbmTotal: number
  temp: number
  power: number
  health: 'ok' | 'warn' | 'fault'
  service: string
  eccErrors: number
}
export interface InferenceService {
  service: string
  model: string
  version: string
  pool: PoolId
  poolName: string
  instances: number
  ready: number
  cards: number
  qps: number
  tokensPerSec: number
  ttftMs: number
  p99Ms: number
  queueDepth: number
  kvHit: number
  hbmPct: number
  errPct: number
  restarts: number
  health: 'ok' | 'warn' | 'bad'
}
export interface GatewayKey {
  keyId: string
  holder: string
  app: string
  model: string
  channel: string
  kind: string
  rpmLimit: number
  usedRpm: number
  tpmLimit: string
  spendDay: number
  requests: number
  errors: number
  fallbacks: number
  status: 'ok' | 'warn' | 'off'
}
export interface GatewayRoute { model: string; channel: string; weight: number; rpm: number; tokensWan: number; errPct: number; health: string }
export interface ManagedApp {
  platform: 'Dify' | 'RAGFlow'
  name: string
  type: string
  status: '已发布' | '草稿' | '已下线'
  owner: string
  updatedAt: string
  models: string
  metric: string
  onPlatform: boolean
}
export interface SourceStatus { id: SourceId; name: string; ok: boolean; at: string; items: number; note: string }

/* ---------------- 采集层读入 ---------------- */
export interface DeployReceipt { orderId: string; result: '成功' | '失败'; instances: string; image: string; nodes: string; finishedAt: string; note: string }

interface Collected { at: number; cards?: NpuCard[]; services?: InferenceService[]; gateway?: GatewayKey[]; routes?: GatewayRoute[]; apps?: ManagedApp[]; deploy?: DeployReceipt[]; errors: Record<string, string> }
let collected: Collected | null = null
let pulling = false
let lastPullAt = 0
const listeners = new Set<() => void>()
const FRESH_MS = 15 * 60 * 1000
const base = (typeof import.meta !== 'undefined' && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || './'

async function getJson(name: string): Promise<unknown> {
  const r = await fetch(`${base}data/${name}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export const telemetryStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  collected: () => collected,
  pulling: () => pulling,
  refresh() { telNotify() },
  lastPullAt: () => lastPullAt,

  /** 读一次采集层落盘数据；没有采集层就回落到平台内推导 */
  /** v3.8：先读数据服务里的采集结果（配置在系统里，数据在库里）；接口不可用时才回退到静态文件 */
  async pullFromApi() {
    const res = await apiGet('/collect')
    if (!res || !res.ok) return null
    const status = (res.status || {}) as Record<string, { items: number; error?: string; at?: string }>
    const rows = (res.rows || {}) as Record<string, unknown[]>
    const keys = Object.keys(status)
    if (!keys.length) return null
    const at = Math.max(...keys.map((k) => (status[k]?.at ? new Date(status[k].at as string).getTime() : 0)))
    if (at && Date.now() - at > FRESH_MS) return null
    const out: Collected = { at: at || Date.now(), errors: {} }
    const map: Record<string, keyof Collected> = {
      cards: 'cards', services: 'services', gateway: 'gateway', routes: 'routes', apps: 'apps', deploy: 'deploy',
    }
    keys.forEach((file) => {
      const key = map[file.replace('.json', '')]
      if (!key) return
      const err = status[file]?.error
      if (err) out.errors[file] = String(err)
      const data = rows[file] ?? rows[file.replace('.json', '')]
      if (Array.isArray(data) && data.length) (out as unknown as Record<string, unknown>)[key] = data
    })
    return out
  },

  async pull() {
    if (pulling) return collected
    pulling = true
    try {
      const fromApi = await telemetryStore.pullFromApi().catch(() => null)
      if (fromApi) { collected = fromApi; return collected }
      const manifest = await getJson('manifest.json') as { generatedAt?: string; files?: Record<string, { ok?: boolean; items?: number; error?: string }>; sources?: Record<string, { ok?: boolean; items?: number; error?: string }> }
      const at = manifest.generatedAt ? new Date(manifest.generatedAt).getTime() : Date.now()
      if (Date.now() - at > FRESH_MS) { collected = null; return collected }
      const files = manifest.files ?? manifest.sources ?? {}
      const errors: Record<string, string> = {}
      Object.entries(files).forEach(([k, v]) => { if (v && (v.error || v.ok === false)) errors[k] = String(v.error ?? '该来源本轮未取到') })
      const out: Collected = { at, errors }
      const load = async (key: keyof Collected, file: string) => {
        try {
          if (files[file]?.error) { errors[file] = String(files[file]?.error); return }
          const data = await getJson(file)
          if (Array.isArray(data) && data.length) (out as unknown as Record<string, unknown>)[key] = mapRows(key, data as Record<string, unknown>[])
        } catch (e) { errors[file] = e instanceof Error ? e.message : '读取失败' }
      }
      await load('cards', 'cards.json')
      await load('services', 'services.json')
      await load('gateway', 'gateway.json')
      await load('routes', 'routes.json')
      await load('apps', 'apps.json')
      await load('deploy', 'deploy.json')
      collected = out
    } catch { collected = null } finally { pulling = false; lastPullAt = Date.now(); telNotify() }
    return collected
  },
}

/* 采集层落盘的 JSON 用接口原生字段名（util_pct / hbm_used_gb / key_id …），
   平台内做一层映射，外部系统与平台内部各自保持自己的命名习惯 */
const POOL_BY_LABEL_IN: Record<string, PoolId> = { hp: 'hp', shared: 'shared', train: 'train' }
function mapRows(key: keyof Collected, rows: Record<string, unknown>[]): unknown[] {
  const g = (r: Record<string, unknown>, a: string, b: string, dflt: unknown) => {
    const v = r[a] !== undefined ? r[a] : r[b]
    return v === undefined || v === null || v === '' ? dflt : v
  }
  if (key === 'cards') return rows.map((r) => {
    const pool = String(g(r, 'pool', 'pool', 'shared')) as PoolId
    return {
      id: String(g(r, 'id', 'card_id', `${String(r.node ?? 'node')}?:Card 1`)),
      node: String(g(r, 'node', 'node', '未知节点')), model: String(g(r, 'model', 'card_model', '未标注型号')),
      pool, poolName: POOL_NAME[pool] ?? pool,
      util: Number(g(r, 'util', 'util_pct', 0)),
      hbmUsed: Number(g(r, 'hbmUsed', 'hbm_used_gb', 0)), hbmTotal: Number(g(r, 'hbmTotal', 'hbm_total_gb', 32)),
      temp: Number(g(r, 'temp', 'temp_c', 0)), power: Number(g(r, 'power', 'power_w', 0)),
      health: (String(g(r, 'health', 'health', 'ok')) as NpuCard['health']) || 'ok',
      service: String(g(r, 'service', 'service', '')) || '（采集层未提供承载服务）',
      eccErrors: Number(g(r, 'eccErrors', 'ecc_errors', 0)),
    } as NpuCard
  })
  if (key === 'services') return rows.map((r) => ({
    service: String(g(r, 'service', 'model', '未命名服务')), model: String(g(r, 'model', 'model', '')),
    version: String(g(r, 'version', 'version', '')) || '未标注',
    pool: String(g(r, 'pool', 'pool', 'shared')) as PoolId, poolName: POOL_NAME[POOL_BY_LABEL_IN[String(r.pool)] ?? 'shared'],
    instances: Number(g(r, 'instances', 'replicas', 1)), ready: Number(g(r, 'ready', 'ready_instances', r.instances ?? 1)),
    cards: Number(g(r, 'cards', 'cards_used', 0)), qps: Number(g(r, 'qps', 'requests_per_sec', 0)),
    tokensPerSec: Number(g(r, 'tokensPerSec', 'tokens_per_sec', 0)), ttftMs: Number(g(r, 'ttftMs', 'ttft_ms', 0)),
    p99Ms: Number(g(r, 'p99Ms', 'p99_ms', 0)), queueDepth: Number(g(r, 'queueDepth', 'queue_depth', 0)),
    kvHit: Number(g(r, 'kvHit', 'kv_hit_pct', 0)), hbmPct: Number(g(r, 'hbmPct', 'hbm_pct', 0)),
    errPct: Number(g(r, 'errPct', 'err_pct', 0)), restarts: Number(g(r, 'restarts', 'restart_count', 0)),
    health: (String(g(r, 'health', 'health', 'ok')) as InferenceService['health']) || 'ok',
  } as InferenceService))
  if (key === 'gateway') return rows.map((r) => ({
    keyId: String(g(r, 'keyId', 'key_id', '')), holder: String(g(r, 'holder', 'holder', '')),
    app: String(g(r, 'app', 'app', '')), model: String(g(r, 'model', 'model', '')),
    channel: String(g(r, 'channel', 'channel', '')), kind: String(g(r, 'kind', 'key_type', '未标注')),
    rpmLimit: Number(g(r, 'rpmLimit', 'rpm_limit', 0)), usedRpm: Number(g(r, 'usedRpm', 'used_rpm', 0)),
    tpmLimit: String(g(r, 'tpmLimit', 'tpm_limit', '')), spendDay: Number(g(r, 'spendDay', 'spend_day', 0)),
    requests: Number(g(r, 'requests', 'requests', 0)), errors: Number(g(r, 'errors', 'errors', 0)),
    fallbacks: Number(g(r, 'fallbacks', 'fallbacks', 0)),
    status: (String(g(r, 'status', 'status', 'ok')) as GatewayKey['status']) || 'ok',
  } as GatewayKey))
  if (key === 'routes') return rows.map((r) => ({
    model: String(g(r, 'model', 'model', '')), channel: String(g(r, 'channel', 'channel', '')),
    weight: Number(g(r, 'weight', 'weight', 0)), rpm: Number(g(r, 'rpm', 'rpm', 0)),
    tokensWan: Number(g(r, 'tokensWan', 'tokens_wan', 0)), errPct: Number(g(r, 'errPct', 'err_pct', 0)),
    health: String(g(r, 'health', 'health', 'ok')),
  } as GatewayRoute))
  if (key === 'deploy') return rows.map((r) => {
    const raw = String(g(r, 'result', 'result', '成功'))
    const failed = ['fail', 'failed', 'failure', 'error', 'false'].includes(raw.toLowerCase()) || raw.includes('失败') || raw.includes('未通过')
    return {
      orderId: String(g(r, 'orderId', 'order_id', '')),
      result: (failed ? '失败' : '成功') as DeployReceipt['result'],
      instances: String(g(r, 'instances', 'instances', '')), image: String(g(r, 'image', 'image', '')),
      nodes: String(g(r, 'nodes', 'nodes', '')), finishedAt: String(g(r, 'finishedAt', 'finished_at', '')),
      note: String(g(r, 'note', 'note', '')),
    } as DeployReceipt
  })
  if (key === 'apps') return rows.map((r) => ({
    platform: (String(g(r, 'platform', 'platform', 'Dify')) as ManagedApp['platform']) || 'Dify',
    name: String(g(r, 'name', 'name', '')), type: String(g(r, 'type', 'type', '')),
    status: (String(g(r, 'status', 'status', '草稿')) as ManagedApp['status']) || '草稿',
    owner: String(g(r, 'owner', 'owner', '归口未标注')), updatedAt: String(g(r, 'updatedAt', 'updated_at', '')),
    models: String(g(r, 'models', 'models', '')), metric: String(g(r, 'metric', 'metric', '')),
    onPlatform: Boolean(g(r, 'onPlatform', 'on_platform', false)),
  } as ManagedApp))
  return rows
}

/* ---------------- 推导口径（与资源账本同源） ---------------- */
const jitter = (n: number) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x) }
const POOL_BY_LABEL: Record<string, PoolId> = { 训练池: 'train', 高保集群: 'hp', 共享集群: 'shared' }
const POOL_NAME: Record<PoolId, string> = { hp: '高保服务集群', shared: '共享推理集群', train: '训练资源池' }

export function npuCards(): NpuCard[] {
  if (collected?.cards?.length) return collected.cards
  const st = engine.get()
  const out: NpuCard[] = []
  const busyByPool: Record<PoolId, string[]> = {
    hp: st.models.filter((m) => m.pool === 'hp').map((m) => m.short),
    shared: st.models.filter((m) => m.pool === 'shared').map((m) => m.short),
    train: ['微调任务 FT-118（Qwen3-8B）', 'VL 数据增广任务 FT-121'],
  }
  computeNodes.forEach((n, ni) => {
    const pool = POOL_BY_LABEL[n.pool] ?? 'shared'
    const poolUtilNow = poolUtil(st, pool)
    for (let c = 0; c < n.cards; c += 1) {
      const idx = ni * 100 + c
      const wob = Math.round((jitter(idx + st.tick * 0.37) - 0.5) * 9)
      const base = n.status === 'fault' ? 0 : Math.max(0, Math.min(100, Math.round((n.util * 0.55 + poolUtilNow * 0.45) + wob)))
      const health: NpuCard['health'] = n.status === 'fault' ? 'fault' : n.util > 85 && base > 92 ? 'warn' : 'ok'
      out.push({
        id: `${n.name.replace('AI-', '')}:Card ${c + 1}`,
        node: n.name, model: n.card, pool, poolName: POOL_NAME[pool],
        util: base,
        hbmUsed: Math.round((n.mem / 100) * 32 * (health === 'fault' ? 0.05 : 1) + wob * 0.2),
        hbmTotal: 32,
        temp: health === 'fault' ? 41 : Math.round(n.temp + wob * 0.5),
        power: health === 'fault' ? 12 : Math.round(90 + base * 2.6),
        health,
        service: health === 'fault' ? '（节点隔离中）' : (busyByPool[pool][c % Math.max(1, busyByPool[pool].length)] ?? '空闲'),
        eccErrors: health === 'fault' ? 7 : Math.round(jitter(idx) * 2),
      })
    }
  })
  return out
}

export function inferenceServices(): InferenceService[] {
  if (collected?.services?.length) return collected.services
  const st = engine.get()
  const mm = metricsOf(st)
  return st.models.map((m, i) => {
    const x = mm.find((y) => y.short === m.short)
    const util = poolUtil(st, m.pool)
    return {
      service: `mindie-${m.short.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      model: m.short, version: m.ver, pool: m.pool, poolName: POOL_NAME[m.pool],
      instances: m.replicas, ready: m.state === '运行中' ? m.replicas : 0, cards: m.replicas * m.perReplica,
      qps: x ? Math.round(x.rpm / 60) : 0,
      tokensPerSec: x ? x.tokensPerSec : 0,
      ttftMs: x ? x.ttftMs : 0,
      p99Ms: x ? Math.round(x.ttftMs * 2.6) : 0,
      queueDepth: x ? x.queueDepth : 0,
      kvHit: x ? x.cacheHit : 0,
      hbmPct: Math.min(99, util + 6 + Math.round(jitter(i * 7 + 3) * 8)),
      errPct: x ? Math.round((x.health === 'bad' ? 4.6 : x.health === 'warn' ? 2.4 : 0.6) * 10) / 10 : 0,
      restarts: x ? x.restarts : 0,
      health: (x?.health ?? 'ok') as InferenceService['health'],
    }
  })
}

export function gatewayKeys(): GatewayKey[] {
  if (collected?.gateway?.length) return collected.gateway
  const st = engine.get()
  return st.creds.map((c, i) => {
    const used = Math.round(c.rpm * (0.42 + jitter(i * 13 + st.tick * 0.11) * 0.5))
    const req = Math.round(used * 1440 * (0.55 + jitter(i * 5) * 0.4) / 100) * 100
    return {
      keyId: c.id, holder: c.holder, app: c.app, model: c.model, channel: c.channel, kind: c.kind,
      rpmLimit: c.rpm, usedRpm: used, tpmLimit: c.tpm,
      spendDay: Math.round(req * (c.channel === 'vendor' ? 0.012 : 0.004)),
      requests: req,
      errors: Math.round(req * (c.status === 'warn' ? 0.031 : 0.004)),
      fallbacks: Math.round(req * (c.channel === 'vendor' ? 0.014 : 0.002)),
      status: c.status,
    }
  })
}

export function gatewayRoutes(): GatewayRoute[] {
  if (collected?.routes?.length) return collected.routes
  const st = engine.get()
  const total = st.channels.reduce((s, c) => s + Math.max(1, c.weight), 0)
  return st.channels.map((c) => ({
    model: c.name, channel: c.kind, weight: c.weight,
    rpm: Math.round(416000 / 1440 * (Math.max(1, c.weight) / total) * (c.health === 'fault' ? 0 : 1)),
    tokensWan: Math.round(34112 * (Math.max(1, c.weight) / total) * 10) / 10,
    errPct: c.err, health: c.health,
  }))
}

/** Dify / RAGFlow 应用清单（第一期只取清单与发布状态） */
export function managedApps(): ManagedApp[] {
  if (collected?.apps?.length) return collected.apps
  const names = engine.get().managed.map((m) => m.name)
  const hit = (n: string) => names.some((x) => n.includes(x) || x.includes(n))
  const rows: Omit<ManagedApp, 'onPlatform'>[] = [
    { platform: 'Dify', name: '咨询问答助手', type: '对话应用（Chatflow）', status: '已发布', owner: '示例业务五部', updatedAt: '11-04 16:20', models: 'GLM-4-9B', metric: '4.5 万次/日' },
    { platform: 'Dify', name: '交通违规图像审核', type: '工作流（Workflow）', status: '已发布', owner: '示例业务二部', updatedAt: '11-03 09:40', models: 'Qwen2.5-VL', metric: '2.8 万次/日' },
    { platform: 'Dify', name: '记录要素抽取', type: '工作流（Workflow）', status: '已发布', owner: '示例业务一部', updatedAt: '10-29 14:05', models: 'Qwen3-32B', metric: '3.4 万次/日' },
    { platform: 'Dify', name: '记录结构化助手（试验）', type: '对话应用（Chat）', status: '草稿', owner: '示例业务三部', updatedAt: '11-02 11:35', models: 'Qwen3-32B', metric: '未发布' },
    { platform: 'Dify', name: '窗口智能引导', type: 'Agent', status: '已发布', owner: '示范市02单位', updatedAt: '10-26 10:10', models: 'GLM-4-9B', metric: '1.1 万次/日' },
    { platform: 'RAGFlow', name: '法规知识问答', type: '知识库问答（Chat）', status: '已发布', owner: '示例业务三部', updatedAt: '11-04 18:05', models: 'BGE-M3 + Reranker', metric: '13.3 万次/日 · 文档 12,418 篇' },
    { platform: 'RAGFlow', name: '视频图像检索', type: '数据集 + 检索 Agent', status: '已发布', owner: '信息化管理部', updatedAt: '10-31 15:22', models: 'BGE-M3', metric: '6.2 万次/日 · 文档 84,106 篇' },
    { platform: 'RAGFlow', name: '典型案例检索', type: '知识库问答（Chat）', status: '已发布', owner: '示例业务一部', updatedAt: '10-24 09:12', models: 'BGE-M3', metric: '9.6 万次/月 · 文档 6,905 篇' },
    { platform: 'RAGFlow', name: '公开信息咨询问答', type: '知识库问答（Chat）', status: '已下线', owner: '示例业务四部', updatedAt: '09-18 17:40', models: 'BGE-M3', metric: '已停 · 文档 1,204 篇' },
  ]
  return rows.map((r) => ({ ...r, onPlatform: hit(r.name) }))
}

/** 容器平台执行回执：只来自采集层（回执接口 / 运维回填），平台不猜回执 */
export function deployReceipts(): DeployReceipt[] {
  return collected?.deploy ?? []
}

export function telemetryStatus(): { mode: '采集层' | '部分采集' | '平台推导'; generatedAt: string; sources: SourceStatus[] } {
  const c = collected
  const cards = npuCards()
  const services = inferenceServices()
  const keys = gatewayKeys()
  const apps = managedApps()
  const derived = c === null
  const at = c ? new Date(c.at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-').replace(/\b(\d)-/, '$1-0').replace(/ (\d):/, ' 0$1:').slice(0, 19) : `${engine.get().tick} 个采样周期内实时推导`
  const items: Record<SourceId, number> = { npu: cards.length, mindie: services.length, litellm: keys.length, dify: apps.filter((a) => a.platform === 'Dify').length, ragflow: apps.filter((a) => a.platform === 'RAGFlow').length, deploy: c?.deploy ? c.deploy.length : engine.get().orders.filter((o) => o.type === 'model_deploy' && o.status === 'external').length }
  const sources: SourceStatus[] = SOURCES.map((s) => {
    const err = c ? (c.errors[s.file] ?? c.errors[s.id]) : undefined
    return {
      id: s.id, name: s.name,
      ok: derived ? true : !err,
      at: derived ? '平台内推导' : (err ? '取数失败' : at),
      items: items[s.id],
      note: derived ? `未接采集层：由平台账本与推理引擎同源推导（${s.via.split('（')[0]}）` : (err ? `${err} · 本轮该来源回落平台推导` : `已接采集层：${s.via.split('（')[0]} · ${s.every}`),
    }
  })
  const failed = SOURCES.filter((s) => c && (c.errors[s.file] ?? c.errors[s.id])).length
  return { mode: derived ? '平台推导' : (failed ? '部分采集' : '采集层'), generatedAt: at, sources }
}

/** 页面用：当前取数来源与「哪些字段取不到」说明 */
export function sourceHint(id: SourceId) {
  const s = SOURCES.find((x) => x.id === id)!
  const st = telemetryStatus().sources.find((x) => x.id === id)!
  return { ...s, status: st }
}

let telV = 0
let telCache: { v: number; val: ReturnType<typeof telemetryStatus> } | null = null
function telNotify() { telV += 1; listeners.forEach((l) => l()) }

/** 快照做缓存：状态变了才重算，避免 React「getSnapshot should be cached」告警 */
export function useTelemetry() {
  const snap = () => {
    const v = telV * 100000 + engine.get().tick
    if (!telCache || telCache.v !== v) telCache = { v, val: telemetryStatus() }
    return telCache.val
  }
  return useSyncExternalStore(telemetryStore.subscribe, snap, snap)
}
