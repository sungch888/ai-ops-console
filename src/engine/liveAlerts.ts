/* =====================================================================
 * 真实告警：数据服务写进库里的通知（监控断连 / 兜底升级 / 取数恢复）
 * 顶栏铃铛与通知中心都读这一份 —— 值班员第一眼看到的是真实告警，
 * 不是页面演示推导的通知。库里的 id 前缀：N-MON…（断连 / 恢复）· N-ESCL…（兜底升级）
 * ===================================================================== */
import React from 'react'
import { apiGet, apiSend } from './db'

export interface ServerAlert {
  id: string; time: string; level: string; title: string; body: string; source: string
  read_flag: number; handled: number; handled_by?: string | null
}

const REAL_ID = /^N-(MON|ESCL)/
const LEVEL_ORDER: Record<string, number> = { 紧急: 0, 重要: 1, 一般: 2 }

function sortRows(rows: ServerAlert[]): ServerAlert[] {
  return [...rows].sort((a, b) => (a.handled - b.handled)
    || ((LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9))
    || String(b.time).localeCompare(String(a.time)))
}

let alerts: ServerAlert[] = []
let lastError = ''
let loadedAt = ''
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

export const liveAlertStore = {
  async refresh() {
    try {
      const r = await apiGet('/notifications?limit=60')
      const rows = (((r && r.rows) || []) as any[]).filter((x) => REAL_ID.test(String(x && x.id)))
      alerts = sortRows(rows as ServerAlert[])
      lastError = ''
      loadedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    } catch (e) {
      lastError = e instanceof Error ? e.message : '通知接口没有返回数据'
    }
    emit()
    return alerts
  },
  async ack(id: string, note = '') {
    try {
      const r = await apiSend('POST', '/api/monitor/notification/ack', { id, note })
      await liveAlertStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '处置失败' } }
  },
  list: () => alerts,
  error: () => lastError,
  loadedAt: () => loadedAt,
  unhandled: () => alerts.filter((a) => !a.handled).length,
  urgentUnhandled: () => alerts.filter((a) => !a.handled && a.level === '紧急').length,
  latest: () => alerts[0] || null,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
}

let timer: number | null = null
export function startLiveAlertPoll(seconds = 20) {
  void liveAlertStore.refresh()
  if (timer === null) timer = window.setInterval(() => void liveAlertStore.refresh(), Math.max(5, seconds) * 1000)
}

export function useLiveAlerts() {
  return React.useSyncExternalStore(liveAlertStore.subscribe, liveAlertStore.list, liveAlertStore.list)
}
export function useLiveAlertBadge() {
  return React.useSyncExternalStore(liveAlertStore.subscribe, liveAlertStore.unhandled, liveAlertStore.unhandled)
}
