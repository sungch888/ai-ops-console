/**
 * 查询层：台账 / 事件 / 审计 / 数据库概览。
 * 这些数字不从前端内存取，而是直接问数据服务（服务端分页与过滤），
 * 演示时可以当场把 URL 打开给客户方看，界面与接口看到的是同一份数据。
 */
import { API_BASE } from './db'

export interface QueryPage<T> {
  ok: boolean
  total: number
  limit: number
  offset: number
  rows: T[]
}

export interface TableRow { table: string; rows: number; last_change: string }
export interface HealthInfo {
  ok: boolean; service: string; version: string; schema_version: string
  db: string; uptime_s: number; counts: Record<string, number>
}

export type Filters = Record<string, string | number | undefined>

function qs(f: Filters): string {
  const parts: string[] = []
  Object.keys(f).forEach((k) => {
    const v = f[k]
    if (v === '' || v === undefined || v === null) return
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
  })
  return parts.length ? '?' + parts.join('&') : ''
}

async function get<T>(path: string, f: Filters): Promise<T> {
  const res = await fetch(API_BASE + path + qs(f))
  const text = await res.text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { /* 非 JSON 走下面报错 */ }
  if (!res.ok) throw new Error(String(body.error || ('数据服务返回 ' + res.status)))
  return body as T
}

export function queryOrders(f: Filters) {
  return get<QueryPage<Record<string, any>>>('/orders', f)
}
export function queryEvents(f: Filters) {
  return get<QueryPage<Record<string, any>>>('/events', f)
}
export function queryAudit(f: Filters) {
  return get<QueryPage<Record<string, any>>>('/audit', f)
}
export function queryNotifications(f: Filters) {
  return get<QueryPage<Record<string, any>>>('/notifications', f)
}
export function queryEntities(f: Filters) {
  return get<QueryPage<Record<string, any>>>('/entities', f)
}
export function queryTables() {
  return get<{ ok: boolean; tables: TableRow[] }>('/tables', {})
}
export function queryHealth() {
  return get<HealthInfo>('/health', {})
}

/** 导出直接给一个链接：浏览器落盘的是服务端生成的 CSV（带 UTF-8 BOM） */
export function csvUrl(resource: string, f: Filters): string {
  return API_BASE + '/csv' + qs({ ...f, resource })
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  submitted: '待审批', approved: '已批准', queued: '排队待窗口', dispatched: '已下发',
  external: '待回执', running: '执行中', rejected: '已驳回', closed: '已关闭',
}
