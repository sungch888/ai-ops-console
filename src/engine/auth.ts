/* =====================================================================
 * 身份与权限模型 v3.0
 *   - 登录走数据服务：POST /api/login，服务端校验账号口令（PBKDF2 存库），
 *     会话是 HttpOnly Cookie，前端拿不到 token，也改不了自己的角色
 *   - 写入权限在服务端判定：前端把界面灰掉只是体验，真正的拦截在 /api
 *   - 权限矩阵仍然可编辑并立即生效（改矩阵本身也要 matrix 权限）
 * 演示账号有口令（见 DEMO_LOGIN），正式版换统一身份认证 / LDAP / OAuth
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { API_BASE, dbRead, dbWrite, dbSeed, setAuditAccount, setCsrfToken, apiGet, apiSend } from './db'


export type Role = 'admin' | 'ops' | 'dev' | 'user'
export type PermKey = 'app' | 'agent' | 'kb' | 'tool' | 'cred' | 'personal' | 'compute' | 'workflow' | 'gateway' | 'security' | 'security_issue' | 'security_emergency' | 'audit' | 'matrix' | 'export' | 'integration' | 'analytics' | 'overview' | 'approve'

export const PERM_LABEL: Record<PermKey, string> = {
  overview: '运营总览', compute: '算力中心', gateway: '推理网关', cred: '凭证与配额', personal: '个人模型中心', workflow: '资源调配',
  app: '应用广场', agent: '智能体纳管', kb: '知识库纳管', tool: '工具生态', security: '安全事件',
  security_issue: '处置下发', security_emergency: '紧急处置',
  audit: '审计日志', matrix: '权限矩阵', export: '报表导出', integration: '外部对接', analytics: '运营分析',
  approve: '工单审批权',
}

/** 安全处置拆成三档：看事件 / 日常下发（要先预检 + 二次确认）/ 紧急下发（不受变更窗口限制） */
export const SECURITY_PERMS: PermKey[] = ['security', 'security_issue', 'security_emergency']

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
  { id: 'U-0003', name: '开发者 C（示例业务一部）', role: 'dev', dept: '示例业务一部', org: '省级单位', domain: '用户域', note: '只能看个人模型中心' },
  { id: 'U-0004', name: '用户 D（示范市02单位）', role: 'user', dept: '示范市02单位基层所队', org: '示范市02', domain: '数据域', note: '只能看个人模型中心' },
]

export interface MatrixRow { view: PermKey[]; manage: PermKey[]; cls: string[] }
export type Matrix = Record<Role, MatrixRow>

export const CLS_LEVELS = ['公开', '内部', '敏感']

const DEFAULT_MATRIX: Matrix = {
  admin: { view: ['overview', 'compute', 'gateway', 'cred', 'personal', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'security_issue', 'security_emergency', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'], manage: ['overview', 'compute', 'gateway', 'cred', 'personal', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'security_issue', 'security_emergency', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'], cls: ['公开', '内部', '敏感'] },
  ops: { view: ['overview', 'compute', 'gateway', 'cred', 'personal', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'security_issue', 'audit', 'export', 'integration', 'analytics', 'approve'], manage: ['compute', 'gateway', 'cred', 'personal', 'workflow', 'security', 'security_issue', 'export', 'analytics', 'approve'], cls: ['公开', '内部', '敏感'] },
  dev: { view: ['personal'], manage: ['workflow'], cls: ['公开', '内部'] },
  user: { view: ['personal'], manage: [], cls: ['公开'] },
}

const MATRIX_KEY = 'dsh-demo-matrix-v1'
const ACCOUNTS_KEY = 'dsh-demo-accounts-v1'

/** 演示口令：仅用于演示与选型交流，正式版必须改强口令并接真实身份源 */
export const DEMO_LOGIN: Record<string, { username: string; password: string }> = {
  'U-0001': { username: 'admin', password: 'admin123' },
  'U-0002': { username: 'ops', password: 'ops123' },
  'U-0003': { username: 'dev', password: 'dev123' },
  'U-0004': { username: 'user', password: 'user123' },
}

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

/* ---------------- 会话（服务端会话，前端只有内存副本） ---------------- */
let session: DemoAccount | null = null
let serverPerms: { view: string[]; manage: string[]; cls?: string[] } | null = null
const sessionListeners = new Set<() => void>()

/* v3.1：口令状态 / 来源配置（都来自服务端，前端只是显示） */
export interface PolicyInfo { min_len: number; max_age_days: number; reuse_check: number }
export interface ProviderInfo { label: string; ready: boolean; note: string }
export interface Flags {
  mustChange: boolean
  changeReason: string
  policy: PolicyInfo
  config: Record<string, string>
  providers: Record<string, ProviderInfo>
  labels: Record<string, string>
}
let flags: Flags = {
  mustChange: false, changeReason: '',
  policy: { min_len: 8, max_age_days: 90, reuse_check: 3 },
  config: {}, providers: {}, labels: {},
}
const flagListeners = new Set<() => void>()
function emitFlags() { flags = { ...flags }; flagListeners.forEach((f) => f()) }
export const flagsStore = {
  get: () => flags,
  subscribe: (l: () => void) => { flagListeners.add(l); return () => { flagListeners.delete(l) } },
}
export function useFlags() { return useSyncExternalStore(flagsStore.subscribe, flagsStore.get, flagsStore.get) }
function takeFlags(body: any) {
  if (!body) return
  setCsrfToken(String(body.csrf || ''))
  flags = {
    mustChange: !!body.must_change,
    changeReason: String(body.change_reason || ''),
    policy: (body.password_policy as PolicyInfo) || flags.policy,
    config: (body.config as Record<string, string>) || flags.config,
    providers: (body.providers as Record<string, ProviderInfo>) || flags.providers,
    labels: (body.labels as Record<string, string>) || flags.labels,
  }
  emitFlags()
}

/* 演示账号也入库存一份（正式版替换为真实用户表 / 统一身份认证） */
try { dbSeed(MATRIX_KEY, matrix) } catch { /* 落库失败已在数据层记录 */ }
try { dbWrite(ACCOUNTS_KEY, JSON.stringify(DEMO_ACCOUNTS)) } catch { /* 落库失败已在数据层记录 */ }

function emitSession() { sessionListeners.forEach((l) => l()) }

/** 统一用 text 再解析：数据服务返回非 JSON 时也不会抛 */
async function parseBody(res: Response): Promise<any> {
  try { return JSON.parse(await res.text()) } catch { return {} }
}

/** 服务端返回的用户行 → 前端账号对象（字段与 DEMO_ACCOUNTS 对齐） */
function toAccount(u: any): DemoAccount | null {
  if (!u) return null
  const known = DEMO_ACCOUNTS.find((a) => a.id === String(u.id))
  const role = (u.role as Role) || known?.role || 'user'
  return {
    id: String(u.id),
    name: String(u.name ?? known?.name ?? u.username ?? ''),
    role,
    dept: String(u.dept ?? known?.dept ?? ''),
    org: String(u.org ?? known?.org ?? ''),
    domain: u.domain === '数据域' ? '数据域' : '用户域',
    note: String(u.note ?? known?.note ?? ''),
  }
}

/** 启动时问一次服务端：这个浏览器还带着有效会话吗？ */
export async function restoreSession(): Promise<{ signedIn: boolean; error?: string }> {
  try {
    const res = await fetch(API_BASE + '/session')
    const body: any = await parseBody(res)
    session = body?.signed_in ? toAccount(body.user) : null
    serverPerms = body?.perms ?? null
    if (session) setAuditAccount(session.id)
    takeFlags(body)
    emitSession()
    return { signedIn: !!session }
  } catch (e) {
    session = null
    return { signedIn: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const auth = {
  get: () => session,
  subscribe: (l: () => void) => { sessionListeners.add(l); return () => { sessionListeners.delete(l) } },
  /** 服务端算出来的这个角色的权限点（用于对照前端矩阵） */
  serverPerms: () => serverPerms,
  async login(username: string, password: string): Promise<{ ok: boolean; error?: string; mustChange?: boolean; changeReason?: string }> {
    try {
      const res = await fetch(API_BASE + '/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body: any = await parseBody(res)
      if (!res.ok) return { ok: false, error: String(body?.error || ('登录失败（HTTP ' + res.status + '）')) }
      session = toAccount(body.user)
      serverPerms = body.perms ?? null
      if (session) setAuditAccount(session.id)
      takeFlags(body)
      emitSession()
      return { ok: true, mustChange: !!body.must_change, changeReason: String(body.change_reason || '') }
    } catch (e) {
      return { ok: false, error: '数据服务不可用，无法登录：' + (e instanceof Error ? e.message : String(e)) }
    }
  },
  async logout() {
    try { await fetch(API_BASE + '/logout', { method: 'POST' }) } catch { /* 服务不可用时也要清掉本地会话 */ }
    session = null
    serverPerms = null
    setCsrfToken('')
    emitSession()
  },
}

/* ---------------- v3.1：改口令 / 账号开关 / 会话列表 / 配置中心 / 影子同步 ---------------- */
export async function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string; needRelogin?: boolean }> {
  try {
    const body = await apiSend('POST', '/password/change', { old_password: oldPassword, new_password: newPassword })
    if (body?.need_relogin) { session = null; serverPerms = null; setCsrfToken(''); emitSession() }
    return { ok: true, needRelogin: !!body?.need_relogin }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function resetPassword(userId: string, tempPassword: string): Promise<{ ok: boolean; error?: string }> {
  try { await apiSend('POST', '/password/reset', { user_id: userId, temp_password: tempPassword }); return { ok: true } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function toggleAccount(userId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try { await apiSend('POST', '/account/toggle', { user_id: userId, enabled }); return { ok: true } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function listSessions(): Promise<{ rows: any[]; mineOnly: boolean; error?: string }> {
  try { const b = await apiGet('/sessions'); return { rows: b.rows || [], mineOnly: !!b.mine_only } }
  catch (e) { return { rows: [], mineOnly: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function revokeSession(ref: string): Promise<{ ok: boolean; error?: string }> {
  try { await apiSend('POST', '/session/revoke', { ref }); if (auth.get()) { session = null; setCsrfToken(''); emitSession() } return { ok: true } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function loadConfig(): Promise<{ ok: boolean; error?: string }> {
  try {
    const b = await apiGet('/config')
    flags = { ...flags, config: b.config || {}, providers: b.providers || {}, labels: b.labels || {} }
    emitFlags()
    return { ok: true }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function saveConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const b = await apiSend('PUT', '/config', { key, value })
    flags = { ...flags, config: b.config || flags.config }
    emitFlags()
    return { ok: true }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export async function syncLinks(provider: string, accounts: { external_id: string; name?: string; role?: string }[]): Promise<{ ok: boolean; total: number; matched: number; unmatched: number; error?: string }> {
  try {
    const b = await apiSend('POST', '/links/sync', { provider, accounts })
    return { ok: true, total: b.total || 0, matched: b.matched || 0, unmatched: b.unmatched || 0 }
  } catch (e) { return { ok: false, total: 0, matched: 0, unmatched: 0, error: e instanceof Error ? e.message : String(e) } }
}

export async function listLinks(provider = ''): Promise<{ rows: any[]; total: number; error?: string }> {
  try { const b = await apiGet('/links' + (provider ? '?provider=' + encodeURIComponent(provider) : '')); return { rows: b.rows || [], total: b.total || 0 } }
  catch (e) { return { rows: [], total: 0, error: e instanceof Error ? e.message : String(e) } }
}

export function flagsNow(): Flags { return flags }

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
