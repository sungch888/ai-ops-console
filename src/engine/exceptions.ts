/* =====================================================================
 * 算力资源例外监控与阻断
 * 检测依据：接入配置、接管登记、资源账本、渠道与凭证状态、推理容器
 * 关键口径：阻断切的是「例外接入来源」（接入通道 / 凭证 / 应用调用入口 / 目录入口），
 *          资源本身不停、不回收、不下线；要动资源走「资源侧缓解」并进变更窗口。
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine, poolUtil, totalReplicas, rentInfo, DIRECTORY_KINDS, type EngineState } from './engine'
import { connectorStore, llmChannelConfig, LLM_CHANNEL_ID, RENT_ID } from './connectors'
import { governViews } from './govern'
import { containersOf } from './inference'
import { ledgerOf } from './ledger'
import { rectifyStore } from './rectify'
import { PROBE_IDS, PROBE_LABEL } from './connectors'
import { dbRead, dbWrite, dbSeed } from './db'


export type ExcKind = '旁路接入' | '旁路调用' | '接管缺口' | '资源异常' | '配额越界' | '目录不一致'
export type ExcSeverity = '紧急' | '高' | '中'
export type ExcStatus = '待分析' | '已阻断' | '已缓解' | '已放行'
export type OptionKind = '阻断接入' | '资源侧缓解' | '整改引导'
export type BlockAction = 'access_block' | 'access_restore' | 'containment' | 'credential_revoke' | 'quota_adjust' | 'pool_release' | 'preempt' | 'rollback' | 'guide'

export interface ExcOption { action: BlockAction; label: string; detail: string; kind: OptionKind }
export interface ExcSource { label: string; from: string; detail: string }
export interface ExceptionRec {
  key: string
  ref?: { connectorId?: string; credId?: string; managedId?: string }
  kind: ExcKind
  title: string
  target: string
  owner: string
  severity: ExcSeverity
  evidence: string[]
  impact: string
  sources: ExcSource[]
  options: ExcOption[]
  mitigations: ExcOption[]
  active: boolean
}
export interface ExcView extends ExceptionRec {
  status: ExcStatus
  firstSeen: string
  lastSeen: string
  hits: number
  actionLabel?: string
  orderId?: string
  note?: string
  handledAt?: string
}

export const MONITOR_RULES: { kind: ExcKind; name: string; detect: string; threshold: string; block: string; notBlock: string }[] = [
  { kind: '旁路接入', name: '未确认即接入 / 未登记算力直连', detect: '通道已启用但前置条件未确认、地址未填、共享账号、或出现未登记的算力直连', threshold: '前置完成数 = 0 或游离接入', block: '阻断这条接入通道（停采集与调用）', notBlock: '不动它对应的算力池与模型' },
  { kind: '旁路调用', name: '已隔离对象仍在被调用', detect: '纳管对象已暂停 / 隔离 / 禁用但仍有调用量', threshold: '调用量 > 0', block: '双侧摘除目录入口、吊销其可用凭证', notBlock: '不下线对象所在资源' },
  { kind: '接管缺口', name: '算力资源未彻底接管', detect: '算力平台 / 算力资源类登记对象接管深度低于 L4', threshold: '深度 < L4', block: '接管未到位前先停该对象的对外调用入口', notBlock: '不回收卡位、不停用资源' },
  { kind: '资源异常', name: '卡位吃紧 / 渠道异常 / 超额扩租 / 容器重启', detect: '池利用率、渠道健康与错误率、扩租用量、推理容器重启', threshold: '利用率 ≥ 92% · 错误率 ≥ 4% · 扩租超额度 · 重启 > 0', block: '限流或切断超额调用来源（凭证 / 应用 / 外部渠道）', notBlock: '回收、抢占、扩容属资源侧缓解，走变更窗口' },
  { kind: '配额越界', name: '凭证配额或外部 Token 超上限', detect: '凭证 RPM 超上限、外部 Token 日用量超配置配额', threshold: 'RPM > 上限 · Token > 配额', block: '吊销或限流该凭证，必要时阻断外部渠道接入', notBlock: '不回收本地卡位' },
  { kind: '目录不一致', name: '技术目录与使用目录状态不一致', detect: 'MCP / 插件 / Skill 两个目录的在架状态不一致', threshold: 'tech ≠ biz', block: '双侧同步摘除目录入口', notBlock: '不摘除服务与算力本身' },
]

const HANDLED_KEY = 'dsh-demo-monitor-handled-v1'
const SETTINGS_KEY = 'dsh-demo-monitor-v1'
const CRED_CAP: Record<string, number> = { 个人密钥: 120, 平台代理: 400 }
const nowTime = () => new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

interface HandledRec { key: string; kind: ExcKind; title: string; target: string; owner: string; severity: ExcSeverity; status: ExcStatus; actionLabel: string; orderId?: string; note?: string; time: string; restore?: '接入' | '来源' }
interface MonitorSettings { intervalSec: number; autoBlockUrgent: boolean; notifyAll: boolean }

function loadHandled(): Record<string, HandledRec> {
  try { const r = dbRead(HANDLED_KEY); if (r) return JSON.parse(r) as Record<string, HandledRec> } catch { /* 落库失败已在数据层记录 */ }
  return {}
}
function loadSettings(): MonitorSettings {
  try { const r = dbRead(SETTINGS_KEY); if (r) return JSON.parse(r) as MonitorSettings } catch { /* 落库失败已在数据层记录 */ }
  return { intervalSec: 20, autoBlockUrgent: false, notifyAll: true }
}

let cache: ExcView[] | null = null
let cache2: ExcView[] | null = null
let handled: Record<string, HandledRec> = loadHandled()
let settings: MonitorSettings = loadSettings()
dbSeed(SETTINGS_KEY, settings)
let round = 0
let lastScanAt = '未开始'
const raised = new Set<string>()
const listeners = new Set<() => void>()

function persistHandled() { try { dbWrite(HANDLED_KEY, JSON.stringify(handled)) } catch { /* 落库失败已在数据层记录 */ } }
function persistSettings() { try { dbWrite(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 落库失败已在数据层记录 */ } }
function emit() { cache = null; cache2 = null; listeners.forEach((l) => l()) }

const callsNum = (s: string) => (s.includes('万') ? Math.round(parseFloat(s) * 10000) : parseInt(s.replace(/[^\d]/g, ''), 10) || 0)
const key = (kind: ExcKind, target: string) => `${kind}|${target}`

/** 消耗来源归因：要切哪里的接入，靠这几条线索定位 */
function topConsumers(st: EngineState) {
  const L = ledgerOf(st)
  const apps = [...L.perApp].sort((a, b) => b.calls - a.calls).slice(0, 3)
  const models = [...L.perModel].sort((a, b) => b.cost - a.cost).slice(0, 3)
  const creds = st.creds.filter((c) => c.status !== 'off').sort((a, b) => b.rpm - a.rpm).slice(0, 3)
  return { L, apps, models, creds }
}
const APP_SUFFIX = /(助手|问答|审核|筛选|检索|抽取|校验|规范化|库)$/
const overlap = (a: string, b: string) => {
  const x = a.replace(APP_SUFFIX, ''), y = b.replace(APP_SUFFIX, '')
  if (!x || !y) return 0
  if (x.includes(y) || y.includes(x)) return Math.max(x.length, y.length)
  let best = 0
  for (let i = 0; i < x.length - 1; i++) for (let j = i + 2; j <= x.length; j++) { const seg = x.slice(i, j); if (seg.length >= 2 && y.includes(seg)) best = Math.max(best, seg.length) }
  return best
}
/** 台账里有调用量、但不在纳管目录的应用：这就是要核查的旁路入口线索 */
export function unmanagedConsumers(st: EngineState) {
  const { apps } = topConsumers(st)
  return apps.filter((a) => !st.managed.some((m) => overlap(m.name, a.name) >= 3))
}
/** 台账应用与纳管应用对齐后的最高消耗纳管应用 */
export function topManagedConsumer(st: EngineState) {
  const { apps } = topConsumers(st)
  let best: { name: string; calls: number; matched?: string } | null = null
  for (const a of apps) {
    const hit = st.managed.find((m) => m.kind === '智能体应用' && overlap(m.name, a.name) >= 3)
    if (hit) return { name: hit.name, calls: a.calls, matched: a.name }
  }
  const fallback = st.managed.find((m) => m.kind === '智能体应用')
  if (fallback) best = { name: fallback.name, calls: apps[0]?.calls ?? 0 }
  return best
}
function consumerSources(st: EngineState): ExcSource[] {
  const { apps, creds, models } = topConsumers(st)
  const out: ExcSource[] = models.map((m) => ({ label: `模型 ${m.name}`, from: '模型承载归因', detail: `${m.calls.toLocaleString('zh-CN')} 次/日 · ${(m.tokens / 10000).toFixed(1)} 万 token · ${m.cost.toLocaleString('zh-CN')} 元` }))
  apps.forEach((a) => out.push({ label: `应用「${a.name}」`, from: '调用量归因', detail: `${a.calls.toLocaleString('zh-CN')} 次/日 · 成本 ${a.cost.toLocaleString('zh-CN')} 元` }))
  creds.forEach((c) => out.push({ label: `凭证 ${c.id}（${c.holder}）`, from: '凭证配额归因', detail: `${c.rpm} RPM · ${c.kind} · 渠道 ${c.channel} · IP ${c.ip}` }))
  unmanagedConsumers(st).forEach((a) => out.push({ label: `未纳管调用来源「${a.name}」`, from: '台账比对', detail: `${a.calls.toLocaleString('zh-CN')} 次/日，但不在纳管目录 → 需核查是不是绕行入口` }))
  return out
}

/* ---------- 规则扫描 ---------- */
export function scan(st: EngineState = engine.get()): ExceptionRec[] {
  const out: ExceptionRec[] = []
  const connectors = connectorStore.get()

  // 1) 旁路接入
  for (const c of connectors) {
    if (!c.enabled) continue
    const missPrereq = c.prereq.filter((p) => !c.prereqDone.includes(p))
    const noAddr = c.endpoint === '（未填）'
    const sharedAuth = c.auth.includes('共享账号') || c.auth === '无需鉴权'
    const unregistered = c.name.includes('未登记')
    const isResource = c.kind === '外部算力资源' || c.kind === '外部模型渠道'
    const depends = connectorStore.dependentsOf(c.id)
    const orphan = depends.length === 0
    const severity: ExcSeverity = unregistered || sharedAuth || (isResource && noAddr) ? '紧急' : c.mode === 'real' && noAddr ? '高' : '中'
    if (!(unregistered || sharedAuth || (isResource && noAddr) || (c.mode === 'real' && noAddr) || (c.prereqDone.length === 0 && orphan))) continue
    out.push({
      key: key('旁路接入', c.id), kind: '旁路接入', target: c.name, owner: c.owner, severity, active: true, ref: { connectorId: c.id },
      title: depends.some((d) => d.includes('未登记')) ? '疑似未登记的算力直连接入' : `接入通道未确认前置条件即启用：${c.name}`,
      evidence: [
        `通道状态：已启用 · 健康 ${c.health} · 接入方式 ${c.mode === 'real' ? '真实接口' : '虚拟模拟'}`,
        `地址：${c.endpoint} · 鉴权 ${c.auth}`,
        `前置条件未完成 ${missPrereq.length} 项${missPrereq.length ? `：${missPrereq.join(' / ')}` : ''}`,
        `采集项：${c.dataItems}`,
        c.quota ? `额度：${c.quota.cards ?? c.quota.tokensWanPerDay ?? c.quota.tb}${c.quota.pricePerCardDay ? ` · ${c.quota.pricePerCardDay} 元/卡/日` : ''}` : '无配额约定',
      ],
      impact: depends.length ? `该接入支撑 ${depends.length} 项登记对象（${depends.slice(0, 3).join('、')}${depends.length > 3 ? ' 等' : ''}）；接入来源不可核实等于存在旁路算力` : '该接入未绑定任何登记对象，属于游离接入',
      sources: [
        { label: `接入通道 ${c.id}`, from: '外部接入配置中心', detail: `${c.transport} · ${c.endpoint} · ${c.intervalSec ? `每 ${c.intervalSec} 秒` : '事件触发'}` },
        ...depends.map((d) => ({ label: `登记对象「${d}」`, from: '统一接管登记册', detail: '该对象经这条接入获取运行数据' })),
      ],
      options: [
        { action: 'access_block', label: '阻断这条接入通道', detail: `停止 ${c.name} 的采集与调用；它对应的算力池、模型与业务照常运行，只是这条接入不再通`, kind: '阻断接入' },
        { action: 'credential_revoke', label: '吊销这条接入在用的凭证', detail: '若它通过凭证调用外部资源，先吊销凭证切断调用链路', kind: '阻断接入' },
      ],
      mitigations: [{ action: 'guide', label: '补齐前置条件后再接入', detail: '在外部接入配置中心确认接口状态、填地址、勾选前置条件，就绪后重新启用这条配置', kind: '整改引导' }],
    })
  }

  // 2) 旁路调用
  for (const m of st.managed) {
    if (m.status !== '暂停' && m.status !== '隔离' && m.status !== '禁用') continue
    if (callsNum(m.calls) <= 0) continue
    out.push({
      key: key('旁路调用', m.id), kind: '旁路调用', target: m.name, owner: m.owner, severity: '紧急', active: true, ref: { managedId: m.id },
      title: `${m.kind}「${m.name}」已置为 ${m.status} 但仍有调用量`,
      evidence: [`纳管状态：${m.status}`, `调用量：${m.calls}`, `成功率 ${m.success}% · 失败率 ${m.failRate}%`, DIRECTORY_KINDS.includes(m.kind) ? `目录状态：技术注册目录${m.tech ? '在架' : '已摘除'} / 业务使用目录${m.biz ? '在架' : '已摘除'}` : '不在双目录范围'],
      impact: `处置没真正生效：业务仍能从旁路入口调用它 · 归口 ${m.owner}`,
      sources: [
        { label: '业务使用目录入口', from: '应用中心 · 目录联动', detail: DIRECTORY_KINDS.includes(m.kind) ? (m.biz ? '使用目录仍在架 → 要切的就是这条入口' : '使用目录已摘除，旁路在别处（直连或缓存路由）') : '该对象不在双目录范围，入口在应用侧直连' },
        ...st.creds.filter((c) => c.status !== 'off' && (c.app.includes(m.name.slice(0, 4)) || c.model.includes(m.name.slice(0, 4)))).slice(0, 2).map((c) => ({ label: `凭证 ${c.id}（${c.holder}）`, from: '凭证归因', detail: `${c.rpm} RPM · 应用 ${c.app} · 渠道 ${c.channel}` })),
      ],
      options: [
        { action: 'containment', label: '双侧摘除目录入口并重新阻断', detail: '两个目录同时摘除并断开调用路由；对象所在算力与模型不动', kind: '阻断接入' },
        { action: 'credential_revoke', label: '吊销仍在调用它的凭证', detail: '切断旁路调用所用的调用凭证，作为目录之外的兜底', kind: '阻断接入' },
      ],
      mitigations: [{ action: 'guide', label: '与归口核对旁路入口在哪', detail: '若旁路是应用直连或缓存路由，需归口确认后在应用侧关闭入口', kind: '整改引导' }],
    })
  }

  // 3) 接管缺口
  for (const g of governViews()) {
    if (g.domain !== '算力平台' && g.domain !== '算力资源') continue
    if (g.depth >= 4) continue
    out.push({
      key: key('接管缺口', g.id), kind: '接管缺口', target: g.name, owner: g.owner, severity: g.depth === 1 ? '高' : '中', active: true,
      title: `${g.domain}「${g.name}」未彻底接管（当前 ${g.depth} 级）`,
      evidence: [`当前深度 L${g.depth}（目标 L4 可调度）`, g.why, `接入配置：${g.connectorName} · ${g.mode}`, `规模：${g.scale}${g.cards ? ` · ${g.cards} 卡` : ''}`],
      impact: g.depth === 1 ? '只能登记在册：卡位与状态靠人工填报，异常发现不了，旁路也切不掉' : g.depth === 2 ? '可度量但下不去处置：出报表可以，止损要人工' : '可处置但不可调度：扩容与抢占覆盖不到它',
      sources: [{ label: `接入配置 ${g.connectorName}`, from: '外部接入配置中心', detail: `${g.mode} · 就绪程度决定接管深度` }, { label: `登记对象 ${g.name}`, from: '统一接管登记册', detail: `归口 ${g.owner} · 密级 ${g.cls}` }],
      options: [{ action: 'containment', label: '先停该对象的对外调用入口', detail: '接管未到位前按最小权限先停调用（须归口确认）；资源本身继续运行', kind: '阻断接入' }],
      mitigations: [{ action: 'guide', label: '补齐接入升到 L4', detail: '在接入配置中心确认为「已定」、填地址、勾选执行回执类前置条件，深度自动升到 L4', kind: '整改引导' }],
    })
  }

  // 4) 资源异常：切来源，不动资源
  for (const p of st.pools) {
    const u = poolUtil(st, p.id)
    if (u < 92) continue
    const { creds } = topConsumers(st)
    const managedTop = topManagedConsumer(st)
    out.push({
      key: key('资源异常', `pool-${p.id}`), kind: '资源异常', target: p.name, owner: '信息化管理部', severity: u >= 98 ? '紧急' : '高', active: true,
      ref: { ...(creds[0] ? { credId: creds[0].id } : {}), ...(managedTop ? { managedId: st.managed.find((m) => m.name === managedTop.name)?.id ?? '' } : {}) },
      title: `${p.name} 卡位利用率 ${u}%`,
      evidence: [`卡位 ${p.cards} 卡 · 利用率 ${u}%`, `副本总数 ${totalReplicas(st)}`, `保障策略：${p.policy}`, `训练资源池当前 ${st.pools.find((x) => x.id === 'train')?.cards ?? 0} 卡（可作资源侧缓解）`],
      impact: '继续加压会排队与超时，高保业务首当其冲',
      sources: consumerSources(st).slice(0, 5),
      options: [
        creds[0]
          ? { action: 'quota_adjust' as BlockAction, label: `限流最高配额凭证 ${creds[0].id}`, detail: `把 ${creds[0].holder} 的 ${creds[0].rpm} RPM 压回 ${CRED_CAP[creds[0].kind] ?? 400} RPM 上限内，先压住超额来源`, kind: '阻断接入' as OptionKind }
          : { action: 'guide' as BlockAction, label: '无可定位凭证，先做来源核查', detail: '需要接入侧流量数据才能定位超额来源', kind: '整改引导' as OptionKind },
        managedTop
          ? { action: 'containment' as BlockAction, label: `对高消耗应用「${managedTop.name}」做限流保护`, detail: `台账口径 ${managedTop.calls.toLocaleString('zh-CN')} 次/日${managedTop.matched ? `（对应调用来源「${managedTop.matched}」）` : '（按台账最高消耗匹配）'}：先限流，不停服务`, kind: '阻断接入' as OptionKind }
          : { action: 'guide' as BlockAction, label: '无可限流的纳管应用', detail: '最高消耗来源不在纳管目录，需归口核查入口在哪个应用里', kind: '整改引导' as OptionKind },
        { action: 'access_block' as BlockAction, label: '阻断外部模型渠道接入', detail: '外部渠道不可控时切断这条接入，流量回本地渠道；本地卡位不受影响', kind: '阻断接入' as OptionKind },
      ],
      mitigations: [
        { action: 'pool_release', label: '回收训练池卡位补高保', detail: '资源侧缓解：走回收工单并在变更窗口内执行，不属于阻断', kind: '资源侧缓解' },
        { action: 'preempt', label: '高保优先抢占', detail: '资源侧缓解：按等级抢占共享 / 灰度卡位，被抢占方自动通知', kind: '资源侧缓解' },
      ],
    })
  }
  for (const c of st.channels) {
    if (c.health !== 'fault' && c.err < 4) continue
    const users = st.creds.filter((x) => x.status !== 'off' && x.channel === c.id).slice(0, 2)
    out.push({
      key: key('资源异常', `ch-${c.id}`), kind: '资源异常', target: c.name, owner: c.kind === '本地' ? '信息化管理部' : '外部厂商', severity: c.health === 'fault' ? '高' : '中', active: true,
      ref: c.kind === '外部' ? { connectorId: LLM_CHANNEL_ID } : (users[0] ? { credId: users[0].id } : undefined),
      title: `推理渠道异常：${c.name}`,
      evidence: [`健康：${c.health === 'fault' ? '故障' : c.health === 'warn' ? '降级观察' : '正常'}`, `错误率 ${c.err}% · 时延 ${c.latency} ms`, `权重 ${c.weight}% · 承载 ${c.allocatedRpm}/${c.capacityRpm} RPM`, `副本 ${c.replicas}`],
      impact: `该渠道承接 ${c.weight}% 流量，异常未处理会把失败传导到依赖它的应用`,
      sources: [
        { label: `渠道 ${c.name}`, from: '推理网关', detail: `${c.kind}渠道 · 承载 ${c.allocatedRpm} RPM · ${c.replicas} 副本` },
        ...users.map((u) => ({ label: `凭证 ${u.id}（${u.holder}）`, from: '凭证归因', detail: `${u.rpm} RPM 走该渠道 · 应用 ${u.app}` })),
      ],
      options: [
        c.kind === '外部'
          ? { action: 'access_block' as BlockAction, label: '阻断该外部渠道的接入配置', detail: '切断外部渠道这条接入（配置层），本地渠道与卡位不受影响', kind: '阻断接入' as OptionKind }
          : { action: 'quota_adjust' as BlockAction, label: `限流走该渠道的凭证 ${users[0]?.id ?? '（无）'}`, detail: users[0] ? `把 ${users[0].holder} 的 ${users[0].rpm} RPM 压回上限内，减少异常渠道压力` : '当前无凭证走该渠道，需从应用侧入口限流', kind: '阻断接入' as OptionKind },
        { action: 'credential_revoke' as BlockAction, label: '吊销该渠道在用凭证', detail: users[0] ? `吊销 ${users[0].id}（${users[0].holder}）切断其调用；渠道本身继续运行` : '当前无在用凭证可吊销', kind: '阻断接入' as OptionKind },
      ],
      mitigations: [
        { action: 'rollback', label: '回滚最近一次路由 / 副本变更', detail: '资源侧缓解：把渠道配置恢复到变更前快照', kind: '资源侧缓解' },
        { action: 'guide', label: '下调异常渠道权重并回切本地渠道', detail: '在推理网关做权重调整（走变更窗口），不属于阻断', kind: '整改引导' },
      ],
    })
  }
  const rent = rentInfo(st)
  if (rent.used > rent.quota) {
    const live = connectors.filter((c) => c.kind === '外部算力资源' && c.enabled)
    out.push({
      key: key('资源异常', 'rent-over'), kind: '资源异常', target: '外部扩租卡位', owner: '客户方侧 + 资源方', severity: '紧急', active: true,
      ref: { connectorId: live[0]?.id ?? RENT_ID },
      title: `外部扩租已用 ${rent.used} 卡，超出配置额度 ${rent.quota} 卡`,
      evidence: [`已开扩租卡位 ${rent.used} 卡`, `接入配置额度 ${rent.quota} 卡 · ${rent.price} 元/卡/日`, '超额部分无合同依据且按外部成本入账'],
      impact: '计费不可控；根因是这条扩租接入没有额度校验入口',
      sources: live.map((c) => ({ label: `扩租接入 ${c.name}`, from: '外部接入配置中心', detail: `额度 ${c.quota?.cards ?? 0} 卡 · ${c.quota?.pricePerCardDay ?? 0} 元/卡/日 · ${c.status}` })),
      options: [{ action: 'access_block', label: '阻断超额扩租这条接入通道', detail: '切断这条扩租接入，不再开新卡；已开卡位不动，收回到额度内走回收工单', kind: '阻断接入' }],
      mitigations: [
        { action: 'pool_release', label: '回收到配置额度内', detail: '资源侧缓解：提交回收工单，把在用卡位收回到额度内', kind: '资源侧缓解' },
        { action: 'guide', label: '提高接入额度并补审批', detail: '在接入配置中心把额度调到实际用量并补审批记录', kind: '整改引导' },
      ],
    })
  }
  const restarted = containersOf(st).filter((c) => c.restarts > 0)
  if (restarted.length) {
    out.push({
      key: key('资源异常', 'container-restart'), kind: '资源异常', target: `推理容器重启 ${restarted.length} 个`, owner: '信息化管理部', severity: '中', active: true,
      ref: { connectorId: 'i-train' },
      title: `${restarted.length} 个推理容器出现重启`,
      evidence: restarted.slice(0, 4).map((c) => `${c.model} · ${c.instance}：重启 ${c.restarts} 次 · 显存 ${c.vramGB}/${c.vramTotal} GB · 状态 ${c.state}`),
      impact: '重启会清空前缀缓存，命中率与首字时延同步劣化',
      sources: [
        ...restarted.slice(0, 3).map((c) => ({ label: `容器 ${c.instance}（${c.model}）`, from: '推理引擎容器视图', detail: `重启 ${c.restarts} 次 · 运行 ${c.uptimeMin} 分钟` })),
        { label: '训练任务提交接入（i-train）', from: '外部接入配置中心', detail: '重启多由训练任务或模型变更挤占，先核查这条接入的提交量' },
      ],
      options: [{ action: 'access_block', label: '暂停训练任务提交接入', detail: '阻断训练提交这条接入（配置层）；推理容器与卡位不动，先稳住缓存', kind: '阻断接入' }],
      mitigations: [
        { action: 'rollback', label: '回滚最近的副本 / 配置变更', detail: '资源侧缓解：把模型副本恢复到变更前快照', kind: '资源侧缓解' },
        { action: 'guide', label: '登记一次容器巡检并复核显存', detail: '在推理引擎指标页做容器巡检，确认显存与并发上限', kind: '整改引导' },
      ],
    })
  }

  // 5) 配额越界
  for (const c of st.creds) {
    const cap = CRED_CAP[c.kind] ?? 400
    if (c.rpm <= cap) continue
    out.push({
      key: key('配额越界', c.id), kind: '配额越界', target: `${c.holder} · ${c.id}`, owner: c.holder, severity: '高', active: true, ref: { credId: c.id },
      title: `凭证 ${c.id} 配额 ${c.rpm} RPM 超上限 ${cap} RPM`,
      evidence: [`凭证类型：${c.kind}`, `配额 ${c.rpm} RPM · 上限 ${cap} RPM`, `IP 白名单 ${c.ip}`, `最近使用 ${c.lastUsedDays} 天前 · 状态 ${c.status === 'off' ? '已吊销' : c.status === 'warn' ? '临期' : '正常'}`],
      impact: '单凭证超限会挤占共享渠道容量，且无法定位使用方',
      sources: [
        { label: `凭证 ${c.id}`, from: '凭证与配额', detail: `${c.kind} · 应用 ${c.app} · 模型 ${c.model} · 渠道 ${c.channel}` },
        { label: `使用方 ${c.holder}`, from: '凭证归属', detail: `IP ${c.ip} · 到期 ${c.expDays} 天` },
      ],
      options: [
        { action: 'credential_revoke', label: '吊销该凭证', detail: '切断这条调用入口并清理关联授权；模型与卡位不受影响', kind: '阻断接入' },
        { action: 'quota_adjust', label: `限流到 ${cap} RPM 上限内`, detail: '不吊销，只把这条凭证的配额压回上限内', kind: '阻断接入' },
      ],
      mitigations: [{ action: 'guide', label: '核查配额是怎么超上去的', detail: '看发放与配额调整工单，确认是申请错误还是绕行发放', kind: '整改引导' }],
    })
  }
  const L = ledgerOf(st)
  const extTokensWan = Math.round(L.tokensToday * (L.externalShare > 1 ? L.externalShare / 100 : L.externalShare))
  const extQuota = llmChannelConfig().quotaTokensWan
  if (extTokensWan > extQuota && extQuota > 0) {
    const heavy = st.creds.filter((c) => c.status !== 'off').sort((a, b) => b.rpm - a.rpm)[0]
    out.push({
      key: key('配额越界', 'llm-quota'), kind: '配额越界', target: '外部模型渠道 Token 配额', owner: '客户方侧', severity: '高', active: true, ref: { connectorId: LLM_CHANNEL_ID },
      title: `外部 Token 日用量 ${extTokensWan.toLocaleString('zh-CN')} 万超过配额 ${extQuota.toLocaleString('zh-CN')} 万`,
      evidence: ['外部渠道 Token 用量按路由权重分摊后统计', `配额来源：外部接入配置（${llmChannelConfig().name}）`, `超限 ${Math.round(((extTokensWan - extQuota) / extQuota) * 100)}%`],
      impact: '超限部分按外部成本入账，费用与合同口径不一致',
      sources: [
        { label: `接入配置 ${llmChannelConfig().name}`, from: '外部接入配置中心', detail: `配额 ${extQuota.toLocaleString('zh-CN')} 万 token/日 · ${llmChannelConfig().price} 元/万 token · ${llmChannelConfig().enabled ? '已启用' : '未启用'}` },
        ...(heavy ? [{ label: `凭证 ${heavy.id}（${heavy.holder}）`, from: '凭证归因', detail: `${heavy.rpm} RPM · 渠道 ${heavy.channel}` }] : []),
      ],
      options: [
        { action: 'access_block', label: '阻断外部模型渠道接入', detail: '切断这条外部接入配置，流量回本地渠道；本地算力与卡位不受影响', kind: '阻断接入' },
        ...(heavy ? [{ action: 'quota_adjust' as BlockAction, label: `限流最高配额凭证 ${heavy.id}`, detail: `把 ${heavy.rpm} RPM 压到 ${CRED_CAP[heavy.kind] ?? 400} RPM 上限内`, kind: '阻断接入' as OptionKind }] : []),
      ],
      mitigations: [{ action: 'guide', label: '下调外部权重或调高配额并补审批', detail: '在推理网关做权重调整（走窗口），或在接入配置中心调配额并留审批记录', kind: '整改引导' }],
    })
  }

  // 6) 外部检测数据源喂入的旁路（探针未接入时不产出，接上配置就有）
  const probes = connectorStore.get().filter((c) => PROBE_IDS.includes(c.id) && c.enabled && c.health !== 'fault')
  const node = connectorStore.find('n-node')
  for (const pr of probes) {
    if (pr.id === 'p-flow' && node) {
      const hits = [
        { ip: '10.42.7.18', sev: '紧急' as ExcSeverity, detail: '与高保推理节点建立 6 卡会话 · 持续 41 分钟 · 不在入网白名单', item: '卡位会话 6 条 · 端口 8000 / 8010' },
        { ip: '10.42.9.77', sev: '高' as ExcSeverity, detail: '以非常规端口 8501 直连共享推理集群 · 24 小时内 187 次 · 不在入网白名单', item: '端口 8501 · 请求 187 次' },
      ]
      for (const h of hits) {
        out.push({
          key: key('旁路接入', `probe-flow-${h.ip}`), kind: '旁路接入', target: `流量探针检出 · ${h.ip}`, owner: '网运 + 信息化管理部', severity: h.sev, active: true, ref: { connectorId: node.id },
          title: `未登记来源直连算力节点：${h.ip}`,
          evidence: [`数据来源：${PROBE_LABEL[pr.id]}（${pr.name} · ${pr.transport} · 每 ${pr.intervalSec} 秒）`, h.item, h.detail, `入网通道：${node.name} · 该来源不在入网白名单`],
          impact: '该来源在平台审批与凭证体系之外使用算力，卡位与成本无法归口，处置指令也下不去',
          sources: [
            { label: `来源 IP ${h.ip}`, from: '流量探针', detail: h.detail },
            { label: `入网通道 ${node.name}`, from: '外部接入配置中心', detail: `${node.transport} · ${node.endpoint} · 可按来源 IP 部分阻断` },
          ],
          options: [
            { action: 'access_block', label: `按来源 IP 部分阻断（${h.ip}）`, detail: `只切断 ${h.ip} 的入网会话；节点其余访问、采集与业务不受影响`, kind: '阻断接入' },
            { action: 'credential_revoke', label: '吊销该来源可能借用的凭证', detail: '若该来源借用了平台代理凭证调用，从调用侧一起切断', kind: '阻断接入' },
          ],
          mitigations: [
            { action: 'access_block', label: '全通道阻断入网通道（范围最大）', detail: `整条 ${node.name} 停止，节点对外访问全停：仅在探针确认大面积直连时使用`, kind: '资源侧缓解' },
            { action: 'guide', label: '交换机 / 防火墙 ACL 由网运执行并回执', detail: '平台侧阻断之外，网络侧策略要网运下发并回执行动结果', kind: '整改引导' },
          ],
        })
      }
    }
    if (pr.id === 'p-syslog' && node) {
      out.push({
        key: key('接管缺口', 'probe-syslog'), kind: '接管缺口', target: '机房未纳管 GPU 设备（Syslog 检出）', owner: '机房运维 + 厂商', severity: '高', active: true, ref: { connectorId: node.id },
        title: '机房侧发现 2 台未纳管 GPU 设备',
        evidence: [`数据来源：${PROBE_LABEL[pr.id]}（${pr.name}）`, '设备：昇腾 910B ×2 · 序列号 910B-2431 / 2432', '位置：B3 机柜 12 / 13 槽位 · 上电时间 10-31 21:40', '带外管理地址 10.43.9.21 / 10.43.9.22（不在入网白名单）'],
        impact: '8 卡算力在平台账本之外运行：既不计成本也不受处置，卡位统计与例外监控都覆盖不到',
        sources: [
          { label: '设备 Syslog 上报', from: '机房设备', detail: '上电入网事件与设备序列号 · 每 120 秒批量' },
          { label: `入网通道 ${node.name}`, from: '外部接入配置中心', detail: '带外地址不在白名单，可先按来源 IP 部分阻断' },
        ],
        options: [{ action: 'access_block', label: '按来源 IP 部分阻断（10.43.9.21）', detail: '先切断带外管理地址的访问，防止未经审批的配置变更；设备侧下电要机房执行', kind: '阻断接入' }],
        mitigations: [{ action: 'guide', label: '补登记并纳入接管（登记 → 配接入 → 升到 L4）', detail: '在统一接管登记册新增这两台设备并绑定接入配置，走就绪门禁', kind: '整改引导' }],
      })
    }
    if (pr.id === 'p-cmdb') {
      out.push({
        key: key('接管缺口', 'probe-cmdb'), kind: '接管缺口', target: 'CMDB 台账与平台账本差 6 卡', owner: '客户方侧 + 信息化管理部', severity: '高', active: true,
        title: '资产台账 94 卡 · 平台账本 88 卡 · 差 6 卡（3 台设备）',
        evidence: [`数据来源：${PROBE_LABEL[pr.id]}（${pr.name} · ${pr.transport}）`, '台账有 / 平台无：910B-1102（2 卡）、910B-1147（2 卡）、T4-0310（2 卡）', '平台有 / 台账无：无', '对账口径待客户方确认（按序列号还是按机柜位）'],
        impact: '卡位总量与成本对不上：扩容审批依据失真，退役设备可能仍在通电',
        sources: [{ label: 'CMDB 卡位台账', from: 'CMDB 视图', detail: '94 卡 · 3 台设备无对应平台账本记录' }, { label: '平台资源账本', from: '统一资源账本', detail: '88 卡 · 全部有纳管模型或任务占用' }],
        options: [],
        mitigations: [{ action: 'guide', label: '逐台核对：纳管 / 退役 / 移出机房', detail: '三台设备分别确认归属：纳管的补登记与接入配置，退役的出机房并留处置记录', kind: '整改引导' }],
      })
    }
  }

  // 7) 未纳管调用来源（台账有调用量，纳管目录里没有）
  for (const a of unmanagedConsumers(st).slice(0, 2)) {
    const cred = st.creds.find((c) => c.status !== 'off' && overlap(c.app, a.name) >= 3)
    out.push({
      key: key('旁路接入', `unmanaged-${a.name}`), kind: '旁路接入', target: `未纳管调用来源「${a.name}」`, owner: cred?.holder ?? '归口待定', severity: '高', active: true,
      ref: cred ? { credId: cred.id } : undefined,
      title: `调用台账有量但不在纳管目录：${a.name}`,
      evidence: [`资源账本统计：${a.calls.toLocaleString('zh-CN')} 次/日 · 成本 ${a.cost.toLocaleString('zh-CN')} 元`, '统一纳管目录（知识库 / 智能体 / MCP / 插件 / Skill）里没有同名对象', cred ? `可疑调用凭证：${cred.id} · ${cred.holder} · ${cred.rpm} RPM · 渠道 ${cred.channel}` : '未匹配到凭证，需从网关侧核对来源'],
      impact: '这部分调用没有归口、没有纳管状态，也不受处置动作覆盖，属于运行侧旁路',
      sources: [
        { label: `调用来源「${a.name}」`, from: '台账与纳管目录比对', detail: `${a.calls.toLocaleString('zh-CN')} 次/日 · 不在纳管目录` },
        ...(cred ? [{ label: `凭证 ${cred.id}`, from: '凭证归因', detail: `${cred.holder} · ${cred.app} · ${cred.rpm} RPM` }] : []),
      ],
      options: cred ? [
        { action: 'credential_revoke', label: `吊销该来源在用的凭证 ${cred.id}`, detail: '从调用侧切断这条未纳管调用；模型与卡位不受影响，须通知使用方', kind: '阻断接入' },
        { action: 'quota_adjust', label: `限流该凭证到 ${CRED_CAP[cred.kind] ?? 400} RPM 内`, detail: '不吊销，先压住用量，给归口登记留出时间', kind: '阻断接入' },
      ] : [],
      mitigations: [{ action: 'guide', label: '纳入纳管目录并指定归口', detail: '在应用中心登记该应用与归口，纳管后例外监控才能对它做处置', kind: '整改引导' }],
    })
  }

  // 8) 目录不一致
  for (const m of st.managed) {
    if (!DIRECTORY_KINDS.includes(m.kind) || m.tech === m.biz) continue
    out.push({
      key: key('目录不一致', m.id), kind: '目录不一致', target: m.name, owner: m.owner, severity: '高', active: true, ref: { managedId: m.id },
      title: `${m.kind}「${m.name}」两个目录状态不一致`,
      evidence: [`技术注册目录：${m.tech ? '在架' : '已摘除'}`, `业务使用目录：${m.biz ? '在架' : '已摘除'}`, `纳管状态：${m.status}`, `调用量 ${m.calls}`],
      impact: '一侧在架即可被调用，隔离结论不可信；跨侧审计对不上',
      sources: [
        { label: '业务使用目录入口', from: '应用中心 · 工具目录', detail: m.biz ? '仍在架：业务侧仍可见可调用 → 要切这条' : '已摘除' },
        { label: '技术注册目录入口', from: '模型中心 · 目录联动', detail: m.tech ? '仍在架：调用路由仍可达 → 要切这条' : '已摘除' },
      ],
      options: [{ action: 'containment', label: '双侧同步摘除目录入口', detail: '两个目录同时摘除并断开调用路由；背后的服务与算力不停', kind: '阻断接入' }],
      mitigations: [{ action: 'containment', label: '整改后双侧同步重新纳入', detail: '确认整改完成后同时上架，须归口确认', kind: '资源侧缓解' }],
    })
  }

  // 已被阻断或部分阻断的接入，自动给出对应的恢复手段（同样要过整改门禁）
  for (const e of out) {
    const cid = e.ref?.connectorId
    if (!cid) continue
    const c = connectorStore.find(cid)
    if (!c) continue
    if (c.blockedScope) {
      e.options.push({ action: 'access_restore', label: `解除部分阻断（${c.blockedScope}：${c.blockedValue}）`, detail: '整改复核通过后解除这条限制，该接入全量采集与调用恢复', kind: '阻断接入' })
    } else if (!c.enabled && c.blocking.startsWith('已阻断')) {
      e.options.push({ action: 'access_restore', label: '提交恢复工单（先做就绪校验）', detail: '整改复核通过后恢复这条接入；接口状态、地址与前置条件未闭环不让恢复', kind: '阻断接入' })
    }
  }

  return out
}

/* ---------- 合并处置状态 ---------- */
export function exceptions(): ExcView[] {
  if (cache) return cache
  const list = scan()
  const seen = nowTime()
  const merged: ExcView[] = list.map((e) => {
    const h = handled[e.key]
    const status: ExcStatus = h && (h.status === '已阻断' || h.status === '已缓解' || h.status === '已放行') ? h.status : '待分析'
    return { ...e, status, firstSeen: h?.time ?? seen, lastSeen: seen, hits: h ? 2 : 1, actionLabel: h?.actionLabel, orderId: h?.orderId, note: h?.note, handledAt: h?.time }
  })
  const keys = new Set(list.map((e) => e.key))
  for (const h of Object.values(handled)) {
    if (keys.has(h.key)) continue
    merged.push({
      // 风险来源已被我们的处置压住：沿用处置结论，不显示成「风险已消除」
      key: h.key, kind: h.kind, title: h.title, target: h.target, owner: h.owner, severity: h.severity,
      evidence: ['例外对应的接入来源已被处置或已消失', `处置动作：${h.actionLabel}${h.orderId ? ` · 工单 ${h.orderId}` : ''}`],
      impact: h.status === '已阻断' ? '这条接入来源当前处于阻断状态（通道停用或调用入口已切断）；资源本身未停用，整改完成后走恢复工单'
        : h.status === '已缓解' ? '已做资源侧缓解（回收 / 抢占 / 回滚），接入来源未切断，仍需整改闭环' : '已人工放行并留痕',
      active: false, sources: [],
      options: h.status !== '已阻断' ? [] : h.restore === '来源'
        ? [{ action: 'guide', label: '整改后重新申请（走审批）', detail: '这条例外切的不是接入通道，而是凭证或目录入口；恢复要走原申请流程并附整改说明，不支持一键恢复工单', kind: '整改引导' }]
        : [{ action: 'access_restore', label: '提交恢复工单（先做就绪校验）', detail: '整改闭环后恢复这条接入；未闭环不让恢复', kind: '阻断接入' }],
      mitigations: [],
      status: h.status, firstSeen: h.time, lastSeen: nowTime(), hits: 2, actionLabel: h.actionLabel, orderId: h.orderId, note: h.note, handledAt: h.time,
    })
  }
  const rank: Record<ExcSeverity, number> = { 紧急: 0, 高: 1, 中: 2 }
  merged.sort((a, b) => rankOpen(a.status) - rankOpen(b.status) || rank[a.severity] - rank[b.severity])
  cache = merged
  return merged
}
function rankOpen(s: ExcStatus) { return s === '待分析' ? 0 : s === '已阻断' ? 1 : s === '已缓解' ? 2 : 3 }

export function monitorSummary() {
  const list = exceptions()
  const open = list.filter((e) => e.status === '待分析')
  return {
    total: list.length, open: open.length,
    urgent: open.filter((e) => e.severity === '紧急').length,
    high: open.filter((e) => e.severity === '高').length,
    blocked: list.filter((e) => e.status === '已阻断').length,
    mitigated: list.filter((e) => e.status === '已缓解').length,
    passed: list.filter((e) => e.status === '已放行').length,
    gap: list.filter((e) => e.kind === '接管缺口' && e.status === '待分析').length,
    bypass: list.filter((e) => e.kind === '旁路接入' || e.kind === '旁路调用').length,
    round, lastScanAt, settings,
    rect: rectifyStore.stats(),
    partial: connectorStore.get().filter((c) => Boolean(c.blockedScope)).map((c) => ({ name: c.name, scope: String(c.blockedScope), value: String(c.blockedValue) })),
    probes: connectorStore.get().filter((c) => PROBE_IDS.includes(c.id)).map((c) => ({ id: c.id, name: c.name, label: PROBE_LABEL[c.id] ?? c.name, enabled: c.enabled, health: c.health, status: c.status, owner: c.owner, miss: c.prereq.filter((x) => !c.prereqDone.includes(x)).length })),
    probesOn: connectorStore.get().filter((c) => PROBE_IDS.includes(c.id) && c.enabled && c.health !== 'fault').length,
    byKind: (['旁路接入', '旁路调用', '接管缺口', '资源异常', '配额越界', '目录不一致'] as ExcKind[]).map((k) => ({ kind: k, n: list.filter((e) => e.kind === k).length, open: list.filter((e) => e.kind === k && e.status === '待分析').length })),
  }
}

/* ---------- 处置：阻断切来源，缓解动资源 ---------- */
export const monitorStore = {
  get: exceptions,
  summary: monitorSummary,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  settings: () => settings,

  scanAndRaise() {
    round += 1
    lastScanAt = nowTime()
    rectifyStore.tick()
    const list = scan()
    const fresh = list.filter((e) => !handled[e.key] && !raised.has(e.key) && (settings.notifyAll || e.severity !== '中') && (e.severity === '紧急' || e.severity === '高'))
    fresh.forEach((e) => raised.add(e.key))
    for (const e of fresh) {
      const cuts = e.options.filter((o) => o.kind === '阻断接入').map((o) => o.label)
      engine.announce(e.severity === '紧急' ? '紧急' : '重要', `例外监控第 ${round} 轮检出【${e.kind}】${e.title} · 可切断来源：${cuts.join(' / ') || '（无接入可切断，走资源侧缓解）'} · ${e.impact}`)
      if (settings.autoBlockUrgent && e.severity === '紧急' && e.options.some((o) => o.kind === '阻断接入')) {
        monitorStore.block(e.key, e.options.find((o) => o.kind === '阻断接入')!.action, '自动阻断（例外监控）')
      }
    }
    emit()
    return fresh.length
  },

  block(excKey: string, action: BlockAction, by = '例外监控', patch?: { scope?: string; value?: string }) {
    const e = exceptions().find((x) => x.key === excKey)
    if (!e) return { ok: false as const, reason: '未找到该例外' }
    const opt = [...e.options, ...e.mitigations].find((o) => o.action === action && o.kind !== '整改引导')
    if (!opt) return { ok: false as const, reason: `该例外的可用动作是 ${[...e.options, ...e.mitigations].map((o) => o.label).join(' / ')}；「${action}」不在其中` }
    const st = engine.get()
    let res: { order: { id: string }; precheck: { ok: boolean; reason?: string } } | null = null

    if (action === 'access_block' || action === 'access_restore') {
      const conn = (e.ref?.connectorId ? connectorStore.find(e.ref.connectorId) : undefined) ?? connectorStore.get().find((c) => c.name === e.target) ?? connectorStore.get().find((c) => e.title.includes(c.name))
      if (!conn) return { ok: false as const, reason: '该例外没有对应的接入配置，无法做接入阻断' }
      if (action === 'access_restore') {
        const rc = rectifyStore.for(e.key)
        if (rc && rc.status !== '待复核' && rc.status !== '已关闭') return { ok: false as const, reason: `整改未闭环（整改单「${rc.status}」· 责任人 ${rc.assignee} ${rc.phone}）：先完成整改并提交复核，复核通过后才允许恢复接入` }
      }
      res = engine.submit({ type: action, applicant: by, dept: '运营', level: '高保', reason: `【${e.kind}】${e.title}：${e.impact}`, spec: { connectorId: conn.id, basis: '告警触发', note: e.title, scope: patch?.scope ?? '全通道', value: patch?.value ?? '' } })
    } else if (action === 'containment') {
      let managed = e.ref?.managedId ? st.managed.find((m) => m.id === e.ref!.managedId) : undefined
      if (!managed) managed = st.managed.find((m) => m.name === e.target || e.title.includes(m.name))
      if (!managed && opt.label.includes('「')) managed = st.managed.find((m) => opt.label.includes(m.name))
      if (!managed) {
        const appSrc = e.sources.find((s) => s.label.startsWith('应用'))
        const name = appSrc ? appSrc.label.replace(/^应用「/, '').replace(/」$/, '') : ''
        managed = name ? st.managed.find((m) => m.name.includes(name.slice(0, 4))) : undefined
      }
      if (!managed) return { ok: false as const, reason: '该例外没有对应的纳管对象，无法切断调用入口' }
      const restore = opt.kind === '资源侧缓解'
      const act = restore ? '重新纳入'
        : managed.status === '正常'
          ? (DIRECTORY_KINDS.includes(managed.kind) ? '隔离出目录' : managed.kind === '知识库' ? '暂停入库' : '限流保护')
          : (DIRECTORY_KINDS.includes(managed.kind) ? (managed.tech !== managed.biz ? '隔离出目录' : '禁用') : '限流保护')
      res = engine.submit({ type: 'containment', applicant: by, dept: '运营', level: managed.level, reason: `【${e.kind}】${e.title}：${e.impact}（例外监控${restore ? '整改纳入' : '切断调用入口'}，须通知归口 ${managed.owner}）`, spec: { kind: managed.kind, name: managed.name, action: act, basis: '告警触发' } })
    } else if (action === 'credential_revoke') {
      const credId = e.ref?.credId ?? e.target.split(' · ').pop() ?? e.target
      res = engine.submit({ type: 'credential_revoke', applicant: by, dept: '运营', level: '共享', reason: `【${e.kind}】${e.title}：${e.impact}`, spec: { credId } })
    } else if (action === 'quota_adjust') {
      const cred = e.ref?.credId ? st.creds.find((c) => c.id === e.ref!.credId) : st.creds.find((c) => e.title.includes(c.id))
      if (!cred) return { ok: false as const, reason: '未定位到要限流的凭证' }
      const cap = CRED_CAP[cred.kind] ?? 400
      if (cred.rpm <= cap) return { ok: false as const, reason: `凭证 ${cred.id} 当前 ${cred.rpm} RPM 未超上限 ${cap} RPM，限流无意义` }
      res = engine.submit({ type: 'quota_adjust', applicant: by, dept: '运营', level: '共享', reason: `【${e.kind}】${e.title}：把该凭证配额压回 ${cap} RPM 上限内`, spec: { credId: cred.id, rpm: cap } })
    } else if (action === 'pool_release') {
      const train = st.pools.find((p) => p.id === 'train')
      res = engine.submit({ type: 'pool_release', applicant: by, dept: '运营', level: '高保', reason: `【${e.kind}】${e.title}：资源侧缓解，把卡位补到高保侧`, spec: { pool: 'hp', cards: Math.max(2, train ? Math.min(4, train.cards) : 2) } })
    } else if (action === 'preempt') {
      res = engine.submit({ type: 'preempt', applicant: by, dept: '运营', level: '高保', reason: `【${e.kind}】${e.title}：资源侧缓解，按等级抢占卡位`, spec: { from: 'shared', to: 'hp', cards: 2 } })
    } else if (action === 'rollback') {
      const running = st.orders.find((o) => o.status === 'running' && (o.type === 'weight_adjust' || o.type === 'replica_scale' || o.type === 'pool_expand'))
      if (!running) return { ok: false as const, reason: '当前没有可回滚的路由 / 副本 / 卡位变更' }
      engine.rollback(running.id)
      handled[e.key] = { key: e.key, kind: e.kind, title: e.title, target: e.target, owner: e.owner, severity: e.severity, status: '已缓解', actionLabel: `回滚工单 ${running.id}`, orderId: running.id, time: nowTime(), restore: '来源' }
      rectifyStore.open({ key: e.key, excKind: e.kind, excTitle: e.title, target: e.target, owner: e.owner, severity: e.severity, actionLabel: `回滚工单 ${running.id}`, orderId: running.id })
      persistHandled(); emit()
      engine.announce('重要', `例外监控已回滚 ${running.id}（${running.title}），资源配置恢复至变更前快照`)
      return { ok: true as const, orderId: running.id, status: 'rolled_back' as const, kind: opt.kind }
    }

    if (!res) return { ok: false as const, reason: '不支持的处置动作' }
    if (!res.precheck.ok) {
      engine.announce('一般', `例外监控处置未生效（${e.kind} · ${e.target}）：${res.precheck.reason}`)
      return { ok: false as const, reason: res.precheck.reason ?? '准入未通过' }
    }
    engine.approve(res.order.id)
    engine.execute(res.order.id)
    const done = engine.get().orders.find((o) => o.id === res!.order.id)!
    if (done.status === 'queued') {
      engine.announce('一般', `例外监控已提交${opt.kind === '阻断接入' ? '接入阻断' : '资源侧缓解'}工单 ${done.id}（${done.title}），进入变更窗口队列等待执行，执行完成后再记处置`)
      return { ok: true as const, orderId: done.id, status: 'queued' as const, kind: opt.kind, pending: true as const }
    }
    const status: ExcStatus = opt.kind === '阻断接入' ? '已阻断' : '已缓解'
    handled[e.key] = { key: e.key, kind: e.kind, title: e.title, target: e.target, owner: e.owner, severity: e.severity, status, actionLabel: done.title, orderId: done.id, time: nowTime(), restore: action === 'access_block' ? '接入' : '来源' }
    if (action !== 'access_restore') rectifyStore.open({ key: e.key, excKind: e.kind, excTitle: e.title, target: e.target, owner: e.owner, severity: e.severity, actionLabel: `${opt.kind === '阻断接入' ? '切断接入' : '资源侧缓解'}：${opt.label}`, orderId: done.id })
    persistHandled(); emit()
    return { ok: true as const, orderId: done.id, status: done.status, kind: opt.kind }
  },

  pass(excKey: string, note: string) {
    const e = exceptions().find((x) => x.key === excKey)
    if (!e) return { ok: false as const, reason: '未找到该例外' }
    if (note.trim().length < 6) return { ok: false as const, reason: '放行必须写明理由（不少于 6 字），审计要能看到依据' }
    handled[e.key] = { key: e.key, kind: e.kind, title: e.title, target: e.target, owner: e.owner, severity: e.severity, status: '已放行', actionLabel: '人工放行', note, time: nowTime(), restore: '来源' }
    rectifyStore.remove(e.key)
    persistHandled(); emit()
    engine.announce('一般', `例外监控【${e.kind}】${e.title} 已人工放行：${note}`)
    return { ok: true as const }
  },

  clearHandled() { handled = {}; raised.clear(); persistHandled(); rectifyStore.reset(); emit() },
  setSettings(patch: Partial<MonitorSettings>) { settings = { ...settings, ...patch }; persistSettings(); emit() },

  seedBypass() {
    const id = 'r-bypass-demo'
    if (connectorStore.find(id)) return { ok: false as const, reason: '演示旁路接入已存在' }
    connectorStore.add({ name: '未登记 GPU 直连（演示旁路）', kind: '外部算力资源', transport: '数据库视图 / 定时导入', auth: '共享账号（无独立凭证）', dataItems: '卡位与任务提交（未经平台审批）', intervalSec: 0, owner: '来源待核', quota: { cards: 6, pricePerCardDay: 260 }, prereq: ['确认接入来源与责任方', '补齐独立凭证与 IP 白名单', '纳管卡位与成本口径'] })
    const c = connectorStore.find(id) ?? connectorStore.get().find((x) => x.name === '未登记 GPU 直连（演示旁路）')
    if (!c) return { ok: false as const, reason: '演示接入创建失败' }
    connectorStore.setEnabled(c.id, true)
    return { ok: true as const, id: c.id, name: c.name }
  },
}

function getSnapshot() { if (!cache2) cache2 = exceptions(); return cache2 }
function invalidateAll() { cache = null; cache2 = null; listeners.forEach((l) => l()) }
engine.subscribe(invalidateAll)
connectorStore.subscribe(invalidateAll)

export function useExceptions() {
  return useSyncExternalStore(monitorStore.subscribe, getSnapshot, getSnapshot)
}
