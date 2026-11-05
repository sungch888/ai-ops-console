/* =====================================================================
 * 演示版身份与权限模型（真实生效：控制页面可见性、按钮可用性、数据范围）
 * 角色：平台管理员 / 运营值班 / 业务开发者 / 业务用户
 * 权限矩阵可编辑并立即生效；登录为演示账号免密（不收集真实口令）
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { dbRead, dbWrite, dbRemove, dbSeed, setAuditAccount } from './db'


export type Role = 'admin' | 'ops' | 'dev' | 'user'
export type PermKey = 'app' | 'agent' | 'kb' | 'tool' | 'cred' | 'compute' | 'workflow' | 'gateway' | 'security' | 'audit' | 'matrix' | 'export' | 'integration' | 'analytics' | 'overview' | 'approve'

export const PERM_LABEL: Record<PermKey, string> = {
  overview: '运营总览', compute: '算力中心', gateway: '推理网关', cred: '凭证与配额', workflow: '资源调配',
  app: '应用广场', agent: '智能体纳管', kb: '知识库纳管', tool: '工具生态', security: '安全事件',
  audit: '审计日志', matrix: '权限矩阵', export: '报表导出', integration: '外部对接', analytics: '运营分析',
  approve: '工单审批权',
}

export const ROLE_LABEL: Record<Role, string> = { admin: '平台管理员', ops: '运营值班', dev: '业务开发者', user: '业务用户' }

export interface DemoAccount {
  id: string
  name: string
  role: Role
  dept: string
  org: string
  domain: '用户域' | '数据域'
  note: string
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: 'U-0001', name: '管理员 A（信息化管理部）', role: 'admin', dept: '信息化管理部', org: '省级单位', domain: '用户域', note: '全部权限 · 可编辑权限矩阵 · 可审批与执行' },
  { id: 'U-0002', name: '运营 B（运营服务团队）', role: 'ops', dept: '运营服务', org: '省级单位', domain: '用户域', note: '可提交/执行/回滚/导出，不可改权限矩阵' },
  { id: 'U-0003', name: '开发者 C（示例业务一部）', role: 'dev', dept: '示例业务一部', org: '省级单位', domain: '用户域', note: '只看本单位业务线，可提交申请，不可审批' },
  { id: 'U-0004', name: '用户 D（示范市02单位）', role: 'user', dept: '示范市02单位基层所队', org: '示范市02', domain: '数据域', note: '仅应用广场与个人用量，低权限个人密钥' },
]

export interface MatrixRow { view: PermKey[]; manage: PermKey[]; cls: string[] }
export type Matrix = Record<Role, MatrixRow>

export const CLS_LEVELS = ['公开', '内部', '敏感']

const DEFAULT_MATRIX: Matrix = {
  admin: { view: ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'], manage: ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'], cls: ['公开', '内部', '敏感'] },
  ops: { view: ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'audit', 'export', 'integration', 'analytics', 'approve'], manage: ['compute', 'gateway', 'cred', 'workflow', 'security', 'export', 'analytics', 'approve'], cls: ['公开', '内部', '敏感'] },
  dev: { view: ['overview', 'app', 'agent', 'kb', 'tool', 'workflow', 'cred', 'analytics'], manage: ['workflow', 'agent'], cls: ['公开', '内部'] },
  user: { view: ['app', 'cred'], manage: [], cls: ['公开'] },
}

const MATRIX_KEY = 'dsh-demo-matrix-v1'
const SESSION_KEY = 'dsh-demo-session-v1'
const ACCOUNTS_KEY = 'dsh-demo-accounts-v1'

/* ---------------- 权限矩阵存储 ---------------- */
let matrix: Matrix = loadMatrix()
const matrixListeners = new Set<() => void>()

function loadMatrix(): Matrix {
  try {
    const raw = dbRead(MATRIX_KEY)
    if (!raw) return structuredClone(DEFAULT_MATRIX)
    const p = JSON.parse(raw) as Matrix
    if (!p.admin || !p.user) return structuredClone(DEFAULT_MATRIX)
    return p
  } catch { return structuredClone(DEFAULT_MATRIX) }
}
function saveMatrix() { try { dbWrite(MATRIX_KEY, JSON.stringify(matrix)) } catch { /* 落库失败已在数据层记录 */ } }
function emitMatrix() { matrix = { ...matrix }; matrixListeners.forEach((l) => l()) }

export const matrixStore = {
  get: () => matrix,
  subscribe: (l: () => void) => { matrixListeners.add(l); return () => { matrixListeners.delete(l) } },
  reset() { matrix = structuredClone(DEFAULT_MATRIX); saveMatrix(); emitMatrix() },
  toggleView(role: Role, key: PermKey) {
    const row = { ...matrix[role] }
    row.view = row.view.includes(key) ? row.view.filter((k) => k !== key) : [...row.view, key]
    // 取消可见时同时取消可操作
    row.manage = row.manage.filter((k) => row.view.includes(k))
    matrix = { ...matrix, [role]: row }
    saveMatrix(); emitMatrix()
  },
  toggleManage(role: Role, key: PermKey) {
    const row = { ...matrix[role] }
    if (row.manage.includes(key)) row.manage = row.manage.filter((k) => k !== key)
    else { if (!row.view.includes(key)) row.view = [...row.view, key]; row.manage = [...row.manage, key] }
    matrix = { ...matrix, [role]: row }
    saveMatrix(); emitMatrix()
  },
  toggleCls(role: Role, cls: string) {
    const row = { ...matrix[role] }
    row.cls = row.cls.includes(cls) ? row.cls.filter((c) => c !== cls) : [...row.cls, cls]
    matrix = { ...matrix, [role]: row }
    saveMatrix(); emitMatrix()
  },
}

export function useMatrix() {
  return useSyncExternalStore(matrixStore.subscribe, matrixStore.get, matrixStore.get)
}

/* ---------------- 会话 ---------------- */
let session: DemoAccount | null = loadSession()
const sessionListeners = new Set<() => void>()

/* 演示账号也入库存一份（正式版替换为真实用户表 / 统一身份认证） */
try { dbSeed(MATRIX_KEY, matrix) } catch { /* 落库失败已在数据层记录 */ }
try { dbWrite(ACCOUNTS_KEY, JSON.stringify(DEMO_ACCOUNTS)) } catch { /* 落库失败已在数据层记录 */ }

function loadSession(): DemoAccount | null {
  try {
    const raw = dbRead(SESSION_KEY)
    if (!raw) return null
    const id = JSON.parse(raw) as string
    const acc = DEMO_ACCOUNTS.find((a) => a.id === id) ?? null
    if (acc) setAuditAccount(acc.id)
    return acc
  } catch { return null }
}
function emitSession() { sessionListeners.forEach((l) => l()) }

export const auth = {
  get: () => session,
  subscribe: (l: () => void) => { sessionListeners.add(l); return () => { sessionListeners.delete(l) } },
  login(id: string) {
    const acc = DEMO_ACCOUNTS.find((a) => a.id === id) ?? null
    session = acc
    setAuditAccount(acc?.id ?? '')
    try { dbWrite(SESSION_KEY, JSON.stringify(acc?.id ?? '')) } catch { /* 落库失败已在数据层记录 */ }
    emitSession()
  },
  logout() {
    session = null
    try { dbRemove(SESSION_KEY) } catch { /* 落库失败已在数据层记录 */ }
    emitSession()
  },
}

export function useSession() {
  return useSyncExternalStore(auth.subscribe, auth.get, auth.get)
}

/** 当前会话对某权限点的可见 / 可操作判定 */
export function usePerm(key: PermKey): { view: boolean; manage: boolean } {
  const acc = useSession()
  const m = useMatrix()
  if (!acc) return { view: false, manage: false }
  const row = m[acc.role]
  return { view: row.view.includes(key), manage: row.manage.includes(key) }
}
export function clsAllowed(cls: string): boolean {
  const acc = auth.get()
  if (!acc) return false
  return matrix[acc.role].cls.includes(cls)
}
export function currentAccount() { return auth.get() }
