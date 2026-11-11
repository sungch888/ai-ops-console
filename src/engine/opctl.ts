/* =====================================================================
 * 操作控制 · 前端客户端（v3.11 起判定在服务端）
 *
 * 口径：这个文件**不再做判定**。所有门禁（g0 归属 / g1 工单 / g2 权限项 / g3 预检 / g4 审批 /
 *   g5 双人复核 / g6 窗口 / g7 执行归属 / g8 分段成功 / g9 效果验证 / g10 通知留痕）都在
 *   server/opctl.py 里按服务端会话账号判定，前端改参数、改按钮都没用（原文 1.3）。
 *   前端只负责：表单、展示、把动作发给服务端、把服务端返回的最新状态铺到页面上。
 *
 * 读不到数据时明确显示「读不到」，不用代码默认值假装有数据（沿用 console.ts 的口径）。
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { apiGet, apiSend } from './db'

export type ExecMode = '人工' | '平台自动' | '外部执行需回执' | '待确认'
export type Priority = 'P0' | 'P1' | 'P2'
export type TicketKind = '服务申请单' | '变更单' | '故障处理单' | '问题分析单' | '运营任务单'
export type OpStatus =
  | '草稿' | '待审批' | '待复核' | '待窗口' | '执行中' | '待回执'
  | '部分成功' | '已生效' | '已验证' | '已闭环' | '已驳回' | '失败' | '待人工兜底' | '已回滚'

export const STATUS_LABEL: Record<OpStatus, string> = {
  草稿: '草稿（预检未过）', 待审批: '待审批', 待复核: '待复核', 待窗口: '排队待窗口', 执行中: '执行中',
  待回执: '已下发·待回执', 部分成功: '部分成功', 已生效: '已生效', 已验证: '已验证', 已闭环: '已闭环',
  已驳回: '已驳回', 失败: '执行失败', 待人工兜底: '待人工兜底', 已回滚: '已回滚',
}
export const STATUS_TONE: Record<OpStatus, 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'> = {
  草稿: 'muted', 待审批: 'warn', 待复核: 'purple', 待窗口: 'warn', 执行中: 'info', 待回执: 'purple',
  部分成功: 'bad', 已生效: 'info', 已验证: 'good', 已闭环: 'good', 已驳回: 'bad', 失败: 'bad',
  待人工兜底: 'bad', 已回滚: 'muted',
}
export const STATUS_ALERT: Partial<Record<OpStatus, 'warn' | 'bad'>> = {
  待审批: 'warn', 待复核: 'warn', 待窗口: 'warn', 待回执: 'warn',
  部分成功: 'bad', 失败: 'bad', 待人工兜底: 'bad',
}

/** 表单元数据（label / options）留在前端：只影响输入框，不参与判定 */
export interface OpField { key: string; label: string; options?: string[] }
export interface OpDef {
  code: string; group: string; action: string; resource: string
  ticketKind: TicketKind; execMode: ExecMode
  needsDual: boolean; selfApprove: boolean; autoAllowed: boolean; urgentAllowed: boolean
  priority: Priority; external: string; sourceRef: string
  stages: string[]; impactKinds: string[]; fields: OpField[]
  owner: '本单元' | '应用中心'
}

export const OP_CATALOG: OpDef[] = [
  { code: 'OC-A-03', group: '模型资产', action: '完整性校验与安全扫描', resource: '模型版本', ticketKind: '服务申请单', execMode: '平台自动', needsDual: false, selfApprove: false, autoAllowed: true, urgentAllowed: false, priority: 'P1', external: '安全扫描', sourceRef: '原文 2.1-3', stages: ['实际文件哈希计算', '安全扫描', '报告归档'], impactKinds: ['模型版本', '准入工单'], owner: '本单元', fields: [{ key: 'artifact', label: '制品形态', options: ['权重文件', '部署镜像包'] }] },
  { code: 'OC-B-01', group: '部署上线', action: '发起模型部署', resource: '模型名称', ticketKind: '服务申请单', execMode: '人工', needsDual: false, selfApprove: true, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: '无', sourceRef: '原文 2.5-1', stages: ['部署工单审批'], impactKinds: ['模型服务', '算力卡位', '网关渠道'], owner: '本单元', fields: [{ key: 'model', label: '已准入模型', options: ['Qwen2.5-VL-7B', 'DeepSeek-V3-R1', 'BGE-M3-Embedding'] }] },
  { code: 'OC-B-02', group: '部署上线', action: '自动部署并接入网关', resource: '推理服务', ticketKind: '变更单', execMode: '外部执行需回执', needsDual: false, selfApprove: false, autoAllowed: true, urgentAllowed: false, priority: 'P0', external: '容器调度平台 / 推理网关', sourceRef: '原文 2.5-2', stages: ['实例健康检查', '网关注册', '路由生效', '经网关试调用'], impactKinds: ['推理实例', '网关路由', '调用方凭证'], owner: '本单元', fields: [{ key: 'model', label: '目标模型', options: ['Qwen2.5-VL-7B', 'DeepSeek-V3-R1', 'BGE-M3-Embedding'] }] },
  { code: 'OC-B-06', group: '部署上线', action: '模型下线', resource: '模型版本', ticketKind: '变更单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: true, priority: 'P0', external: '推理网关 / MCP 注册中心', sourceRef: '原文 2.10-2/3', stages: ['入口停止', '路由清理', '关联授权清理', '台账更新'], impactKinds: ['调用方凭证', 'MCP 依赖', '业务应用'], owner: '本单元', fields: [{ key: 'model', label: '下线模型', options: ['LLaMA-3-8B-灰度', 'Qwen2.5-VL-7B'] }] },
  { code: 'OC-C-03', group: '网关配置', action: '路由策略调整', resource: '路由策略', ticketKind: '变更单', execMode: '人工', needsDual: false, selfApprove: false, autoAllowed: false, urgentAllowed: true, priority: 'P1', external: '推理网关', sourceRef: '原文 2.7-2 / 2.8-2', stages: ['策略下发', '分流验证'], impactKinds: ['渠道', '业务应用', '凭证'], owner: '本单元', fields: [{ key: 'policy', label: '策略类型', options: ['权重分流', '固定优先级', '按延迟', '按业务等级'] }, { key: 'weight', label: '主渠道权重', options: ['100', '70', '50', '30'] }] },
  { code: 'OC-D-03', group: '凭证配额', action: '发放模型 API Key', resource: 'API Key', ticketKind: '服务申请单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: '推理网关', sourceRef: '原文 2.6-3', stages: ['生成 Key-ID 与访问 URL', '按审批配置配额', '双人复核'], impactKinds: ['调用方应用', '网关配额', '台账'], owner: '本单元', fields: [{ key: 'kind', label: 'Key 类型', options: ['Personal Key', 'Service Account Key'] }, { key: 'model', label: '授权模型范围', options: ['Qwen2.5-VL-7B', '全部已上线模型', 'BGE-M3-Embedding'] }, { key: 'rpm', label: 'RPM 上限', options: ['60', '300', '600'] }] },
  { code: 'OC-D-05', group: '凭证配额', action: '调整 Key 额度', resource: 'API Key', ticketKind: '变更单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: '推理网关', sourceRef: '原文 4.1-3 / 2.6-4', stages: ['网关配置下发', '复核生效'], impactKinds: ['调用方应用', '网关配额', '成本归口'], owner: '本单元', fields: [{ key: 'key', label: '目标 Key', options: ['SK-示例业务一部-07', 'SA-信息化管理部-02', 'SK-示范市02-11'] }, { key: 'rpm', label: '申请 RPM', options: ['300', '600', '1200'] }] },
  { code: 'OC-D-08', group: '凭证配额', action: '泄露应急吊销', resource: 'API Key', ticketKind: '变更单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: true, priority: 'P1', external: '推理网关', sourceRef: '原文 2.6-4 / 2.9-2', stages: ['吊销凭证', '验证旧凭证失效'], impactKinds: ['调用方应用', '安全事件'], owner: '本单元', fields: [{ key: 'key', label: '泄露 Key', options: ['SK-示范市02-11', 'SA-信息化管理部-02'] }] },
  { code: 'OC-E-04', group: '算力训练', action: '分配训练算力', resource: '训练任务', ticketKind: '服务申请单', execMode: '外部执行需回执', needsDual: false, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: '训练平台 / 容器调度', sourceRef: '原文 2.3-2', stages: ['算力预占', '节点分配', '平台回执'], impactKinds: ['训练资源池', '推理可分配余量', '排队队列'], owner: '本单元', fields: [{ key: 'cards', label: '卡数', options: ['4', '8', '12'] }, { key: 'days', label: '申请时长（天）', options: ['7', '14', '30'] }] },
  { code: 'OC-E-08', group: '算力训练', action: '到期自动停止与回收', resource: '训练任务', ticketKind: '运营任务单', execMode: '平台自动', needsDual: false, selfApprove: false, autoAllowed: true, urgentAllowed: false, priority: 'P1', external: '训练平台', sourceRef: '原文 1.1-11 / 2.3-5', stages: ['任务停止', '算力回收', '留痕'], impactKinds: ['训练资源池', '权重存储'], owner: '本单元', fields: [{ key: 'task', label: '到期任务', options: ['FT-2026-118（示例业务一部）', 'FT-2026-131（示范市02）'] }] },
  { code: 'OC-E-11', group: '算力训练', action: '发放可回收训练算力额度（含三属性）', resource: '训练额度', ticketKind: '服务申请单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: 'CubeStudio / K8s 配额', sourceRef: '池借还规则 P2/P4', stages: ['写入可回收额度', '生效校验'], impactKinds: ['训练资源池', '弹性预留余量', '回收队列'], owner: '本单元', fields: [{ key: 'reclaim_cards', label: '可回收卡数（≤8）', options: ['1', '2', '4'] }, { key: 'queue', label: '训练资源组', options: ['train-general', 'train-finetune'] }] },
  { code: 'OC-F-01', group: '运行弹性', action: '指标驱动自动扩缩容', resource: '推理服务', ticketKind: '变更单', execMode: '平台自动', needsDual: false, selfApprove: false, autoAllowed: true, urgentAllowed: false, priority: 'P0', external: '容器调度平台', sourceRef: '原文 1.1-9 / 2.8-4', stages: ['执行前建变更工单', '调度扩容', '实例健康', '效果验证'], impactKinds: ['推理实例', '算力卡位', '网关路由'], owner: '本单元', fields: [{ key: 'svc', label: '目标服务', options: ['Qwen2.5-VL-7B', 'DeepSeek-V3-R1'] }, { key: 'to', label: '目标副本数', options: ['4', '6', '8'] }] },
  { code: 'OC-F-08', group: '运行弹性', action: '弹性算力借还（预约-借-还）', resource: '算力卡（跨池）', ticketKind: '运营任务单', execMode: '平台自动', needsDual: false, selfApprove: false, autoAllowed: true, urgentAllowed: false, priority: 'P0', external: 'CubeStudio / GPUWorks', sourceRef: '池借还规则 F1/F2 与 R2-R5', stages: ['预约', '挂起与checkpoint', '排空', '入推理池', '台账回写'], impactKinds: ['训练任务', '推理扩容', '容量台账'], owner: '本单元', fields: [{ key: 'cards', label: '借用卡数（≤8）', options: ['1', '2', '4'] }, { key: 'grace', label: '宽限期（秒）', options: ['300', '600', '900'] }] },
  { code: 'OC-F-09', group: '运行弹性', action: '节点换池（入池/出池）', resource: '算力节点', ticketKind: '变更单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P1', external: 'GPUWorks / CubeStudio', sourceRef: '池借还规则 F3 与 R6/R7', stages: ['排空与预约核对', '原池下线', '新池注册与标签', '台账pool_type变更'], impactKinds: ['推理池容量', '训练池容量', '调度域'], owner: '本单元', fields: [{ key: 'node', label: '目标节点', options: ['sim-cubestudio-03', 'sim-gpuworks-02'] }, { key: 'direction', label: '换池方向', options: ['训练池 → 推理池', '推理池 → 训练池'] }] },
  { code: 'OC-G-03', group: '应用与MCP', action: '异常 MCP 服务移出路由', resource: 'MCP 服务', ticketKind: '故障处理单', execMode: '人工', needsDual: false, selfApprove: false, autoAllowed: false, urgentAllowed: true, priority: 'P1', external: 'MCP 注册中心 / 推理网关', sourceRef: '原文 4.2.2-1', stages: ['移出路由', '应用侧状态交接'], impactKinds: ['消费侧应用', '网关路由'], owner: '本单元', fields: [{ key: 'svc', label: '目标 MCP 服务', options: ['人脸比对 v2.3', '文书抽取 v1.4'] }] },
  { code: 'OC-G-05', group: '应用与MCP', action: '应用发布（上架与消费授权在应用中心）', resource: '智能体应用', ticketKind: '变更单', execMode: '待确认', needsDual: false, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P2', external: '应用中心', sourceRef: '原文 4.2 引言 / 6-6', stages: ['配置下发', '版本切换'], impactKinds: ['消费侧目录', '模型渠道'], owner: '应用中心', fields: [{ key: 'app', label: '目标应用', options: ['业务事件智能体 v3', '记录摘要助手 v2'] }] },
  { code: 'OC-H-02', group: '平台配置', action: '逐账号权限项开关', resource: '账号权限项', ticketKind: '变更单', execMode: '人工', needsDual: true, selfApprove: false, autoAllowed: false, urgentAllowed: false, priority: 'P0', external: '无', sourceRef: '原文 1.3', stages: ['权限项变更', '生效校验'], impactKinds: ['账号入口', '审计范围'], owner: '本单元', fields: [{ key: 'acc', label: '目标账号', options: ['开发者 C（示例业务一部）', '用户 D（示范市02单位）'] }, { key: 'perm', label: '权限项', options: ['train.request（训练算力申请）', 'key.request（Key 申请）', 'export.raw（原文导出）'] }, { key: 'val', label: '设为', options: ['开启', '关闭'] }] },
]

export const OP_GROUPS = Array.from(new Set(OP_CATALOG.map((d) => d.group)))
export const opDef = (code: string): OpDef | undefined => OP_CATALOG.find((d) => d.code === code)
export const ownerOf = (d: OpDef): '本单元' | '应用中心' => d.owner ?? '本单元'
export const OUT_OF_SCOPE_MSG = '该动作归应用中心：上架审批、使用目录与消费权限都在应用中心办理，本单元只接收发布后的状态交接与回执（原文 4.2 引言：技术登记不等于消费侧获权）'
export const OP_JUDGE = 'g0 归属边界 · g1 工单绑定 · g2 权限项 · g3 预检 · g4 审批 · g5 双人复核 · g6 变更窗口 · g7 执行归属 · g8 分段判定 · g9 效果验证 · g10 通知与台账'

/** 服务端返回的目录元数据（判定字段以它为准，前端只补表单字段） */
export interface CatalogFromServer {
  code: string; group: string; action: string; resource: string; ticketKind: TicketKind
  execMode: ExecMode; needsDual: boolean; selfApprove: boolean; autoAllowed: boolean
  urgentAllowed: boolean; priority: Priority; external: string; sourceRef: string
  stages: string[]; impact: string[]; owner: string
}

export interface StageState { name: string; state: '待执行' | '执行中' | '通过' | '失败'; reason?: string; at?: string }
export interface TraceRow { at: string; actor: string; gate: string; action: string; result: '通过' | '拦下' | '失败' | '记录'; reason?: string; detail?: string }
export interface NotifyRow { to: string; channel: string; at: string; state: '已发送' | '已送达' | '未送达' }
export interface OpRun {
  id: string; code: string; target: string; params: Record<string, string>
  ticketId: string; ticketKind: TicketKind; status: OpStatus
  requestedBy: string; requestedAt: string
  approvedBy?: string; approvedAt?: string; approvalNote?: string
  executedBy?: string; executedAt?: string; reviewedBy?: string; reviewedAt?: string
  execMode: ExecMode; precheckId?: string; impact: string[]
  beforeSnap: string; afterSnap?: string
  stages: StageState[]; failStage?: string
  queuePos?: number | null; windowId?: string
  urgent: boolean; externalRef?: string; receiptNote?: string
  emergency?: { dueAt: string; state: '待补审' | '已补审' } | null
  rollbackOf?: string
  notify: NotifyRow[]
  trace: TraceRow[]
}
export interface OpWindow { id: string; scope: string; from: string; to: string; reason: string; status: '已预约' | '使用中' | '已结束'; by: string }
export interface FallbackRow { id: string; opId: string; title: string; detail: string; status: '在途' | '已接管' | '已关闭'; owner: string; at: string }
export interface AutoPolicy { id: string; name: string; scope: string; ver: string; approved: boolean; metric: string; threshold: string; sustain: string; min: number; max: number; cooldown: string }
export interface PermItem { code: string; label: string; domain: string; kind: string }
export interface PermGrant { account: string; accountId: string; perm: string; scope: string; grantedBy: string; ticketId: string; at: string }
export interface PermChange { at: string; account: string; accountId: string; perm: string; before: string; after: string; actor: string; ticketId: string }
export interface PermAccount { id: string; name: string; role: string; note: string }
export interface PermsPayload { items: PermItem[]; grants: PermGrant[]; changes: PermChange[]; accounts: PermAccount[] }

export interface OpState {
  ops: OpRun[]; windows: OpWindow[]; fallbacks: FallbackRow[]; policies: AutoPolicy[]
  denied: number; catalog: CatalogFromServer[]; perms: PermsPayload
  loading: boolean; error: string; fromServer: boolean
}

const EMPTY_PERMS: PermsPayload = { items: [], grants: [], changes: [], accounts: [] }
let st: OpState = {
  ops: [], windows: [], fallbacks: [], policies: [], denied: 0, catalog: [], perms: EMPTY_PERMS,
  loading: true, error: '', fromServer: false,
}
const listeners = new Set<() => void>()
function emit() { st = { ...st, perms: { ...st.perms } }; listeners.forEach((l) => l()) }

/** 服务端状态整体覆盖（所有写动作都会带回最新状态，避免多一次往返） */
function apply(state: any) {
  if (!state) return
  const prevCatalog = st.catalog
  const prevPerms = st.perms
  st = {
    ops: state.ops ?? st.ops,
    windows: state.windows ?? st.windows,
    fallbacks: state.fallbacks ?? st.fallbacks,
    policies: state.policies ?? st.policies,
    denied: typeof state.denied === 'number' ? state.denied : st.denied,
    catalog: state.catalog ?? prevCatalog,
    perms: state.perms ?? prevPerms,
    loading: false, error: '', fromServer: true,
  }
  emit()
}

type Res = { ok: boolean; reason?: string; [k: string]: any }

async function post(action: string, body: Record<string, unknown> = {}): Promise<Res> {
  try {
    const r = await apiSend('POST', '/opctl/' + action, body)
    if (r && r.state) apply(r.state)
    if (r && r.perms && !r.state) { st = { ...st, perms: r.perms }; emit() }
    if (r && r.ok === false) {
      // 服务端拒绝时也会带回原因；把它当成正常返回，不抛异常
      return { ok: false, reason: r.reason || r.error || '被服务端拦下' }
    }
    return { ok: true, ...(r || {}) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    st = { ...st, error: msg, loading: false }
    emit()
    return { ok: false, reason: '服务端读不到：' + msg + '（判定在服务端，本地不会假装成功）' }
  }
}

export const opctlStore = {
  get: () => st,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },

  /** 页面挂载时拉一次全量状态（操作 / 窗口 / 兜底 / 策略 / 目录 / 权限） */
  async refresh(): Promise<void> {
    st = { ...st, loading: true }
    emit()
    try {
      const r = await apiGet('/opctl/state')
      apply(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      st = { ...st, loading: false, error: msg, fromServer: false }
      emit()
    }
  },

  async precheck(code: string, target: string, params: Record<string, string>): Promise<Res> {
    const r = await post('precheck', { code, target, params })
    return r.ok ? { ok: true, precheckId: r.precheckId, impact: r.impact ?? [], reasons: r.reasons ?? [] }
      : { ok: false, reason: (r.reasons ?? []).join('；') || r.reason, reasons: r.reasons ?? [] }
  },
  submit: (code: string, target: string, params: Record<string, string>, precheckId: string, urgent = false) =>
    post('submit', { code, target, params, precheckId, urgent }),
  approve: (id: string, note: string) => post('approve', { id, note }),
  reject: (id: string, reason: string) => post('reject', { id, reason }),
  execute: (id: string) => post('execute', { id }),
  review: (id: string) => post('review', { id }),
  receipt: (id: string, ok: boolean, note: string) => post('receipt', { id, ok, note }),
  stage: (id: string, ok: boolean, reason = '') => post('stage', { id, ok, reason }),
  verify: (id: string, evidence: string) => post('verify', { id, evidence }),
  close: (id: string) => post('close', { id }),
  rollback: (id: string) => post('rollback', { id }),
  emergency: (id: string) => post('emergency', { id }),
  complement: (id: string) => post('complement', { id }),
  autoscale: (policyId: string, buildFail: boolean) => post('autoscale', { policyId, buildFail }),
  openWindow: (id: string) => post('window', { id, action: 'open' }),
  closeWindow: (id: string) => post('window', { id, action: 'close' }),
  takeover: (opId: string) => post('takeover', { opId }),
  permToggle: (account: string, perm: string) => post('perm/toggle', { account, perm }),
  permScope: (account: string, perm: string, scope: string) => post('perm/scope', { account, perm, scope }),
}

export function useOpctl(): OpState {
  return useSyncExternalStore(opctlStore.subscribe, opctlStore.get, opctlStore.get)
}
