/**
 * 数据访问层（v2.2 起）
 *
 * 业务状态不再存浏览器本地存储：浏览器里只保留一份内存副本，权威副本在数据服务的数据库。
 *   读：hydrate() 启动时一次性从 /api/state 取回全部状态，填进内存副本
 *   写：先更新内存副本（界面立刻反映），再异步 PUT /api/state/<key> 落库
 *   失败：写队列带退避重试，失败次数与错误在界面上明确显示，不会假装已保存
 *
 * 本地不使用 localStorage / sessionStorage / IndexedDB。
 */
import { useSyncExternalStore } from 'react'

const BASE = String((import.meta as any).env?.VITE_API_BASE ?? '') + '/api'

export type DbStatus = 'connecting' | 'online' | 'saving' | 'failed' | 'offline'

interface Status {
  status: DbStatus
  lastError: string
  pending: number
  savedAt: string
  hydratedAt: string
}

const cache = new Map<string, string>()
const queue = new Map<string, string>()   // key -> 待写入的原始值（同键只保留最新）
const retried = new Map<string, number>()

let st: Status = { status: 'connecting', lastError: '', pending: 0, savedAt: '', hydratedAt: '' }
const listeners = new Set<() => void>()

function emit(patch: Partial<Status>) {
  st = { ...st, ...patch }
  listeners.forEach((f) => f())
}

export function subscribeDb(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function dbSnapshot(): Status {
  return st
}

export function useDbStatus(): Status {
  return useSyncExternalStore(subscribeDb, dbSnapshot, dbSnapshot)
}

const enc = encodeURIComponent

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(accountHeader() ? { 'X-Demo-Account': accountHeader() as string } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status)
  return json
}

/** 演示版：把当前演示账号随请求带上，供服务端审计列使用（不是安全认证） */
let account = ''
export function setAuditAccount(id: string) {
  account = id
}
function accountHeader(): string {
  // 只允许 ASCII 账号编号进入请求头（HTTP 头不支持中文）
  return /^[0-9A-Za-z_.-]{1,40}$/.test(account) ? account : ''
}

/** 启动水合：把数据库里的全部状态读进内存副本 */
export async function hydrate(): Promise<{ ok: boolean; error?: string; keys: number }> {
  try {
    const r = await req('GET', '/state')
    const state = (r && r.state) || {}
    let n = 0
    for (const [k, v] of Object.entries(state)) {
      cache.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      n++
    }
    emit({ status: 'online', lastError: '', hydratedAt: new Date().toISOString() })
    return { ok: true, keys: n }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ status: 'offline', lastError: '数据服务未连接：' + msg })
    return { ok: false, error: msg, keys: 0 }
  }
}

function toWire(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

/** 首次运行：库里还没有这个键时，把代码生成的初始演示数据写进去（之后一律以库为准） */
export function dbSeed(key: string, value: unknown) {
  if (!cache.has(key)) dbWrite(key, JSON.stringify(value))
}

/** 读：返回与旧 localStorage.getItem 相同的原始字符串；没有则 null（模块使用代码默认值） */
export function dbRead(key: string): string | null {
  const v = cache.get(key)
  return v === undefined ? null : v
}

/** 写：内存立即生效 + 异步落库 */
export function dbWrite(key: string, raw: string) {
  cache.set(key, raw)
  queue.set(key, raw)
  flush()
}

export function dbRemove(key: string) {
  cache.delete(key)
  queue.delete(key)
  req('DELETE', '/state/' + enc(key)).catch((e) => {
    emit({ status: 'failed', lastError: '删除失败：' + (e instanceof Error ? e.message : String(e)) })
  })
}

let pumping = false
async function flush() {
  if (pumping) return
  pumping = true
  emit({ pending: queue.size })
  try {
    while (queue.size) {
      const [key, raw] = queue.entries().next().value as [string, string]
      try {
        await req('PUT', '/state/' + enc(key), toWire(raw))
        queue.delete(key)
        retried.delete(key)
        emit({ status: 'online', lastError: '', savedAt: new Date().toISOString(), pending: queue.size })
      } catch (e) {
        const tries = (retried.get(key) || 0) + 1
        retried.set(key, tries)
        const msg = e instanceof Error ? e.message : String(e)
        emit({ status: 'failed', lastError: '未写入数据库（' + key + '）：' + msg, pending: queue.size })
        if (tries >= 4) {
          queue.delete(key)          // 放弃这一笔，但错误持续显示在界面上
          emit({ pending: queue.size })
        } else {
          await new Promise((r) => setTimeout(r, Math.min(9000, 800 * tries)))
        }
      }
    }
  } finally {
    pumping = false
    if (st.status === 'saving' || st.status === 'connecting') emit({ status: queue.size ? 'saving' : 'online' })
  }
}

/** 一键恢复初始演示数据：清空数据库再写入前端生成的初始状态 */
export async function resetDb(state: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await req('POST', '/reset', { state })
    for (const [k, v] of Object.entries(state)) cache.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    emit({ status: 'online', lastError: '', savedAt: new Date().toISOString() })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ status: 'failed', lastError: '重置失败：' + msg })
    return { ok: false, error: msg }
  }
}

export async function healthProbe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await req('GET', '/health')
    const rows = Object.values((r.counts || {}) as Record<string, number>).reduce((a, b) => a + Number(b || 0), 0)
    return { ok: true, detail: '数据库 ' + (r.db || '') + '，已存 ' + rows + ' 行' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export const DB_LABEL = '数据服务（SQLite）'
