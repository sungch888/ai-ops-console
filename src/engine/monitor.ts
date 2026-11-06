/* =====================================================================
 * 监控探针（v3.7）：平台自己只读拉取外部推理服务的 /metrics 与 /health
 *   - 目标、间隔、窗口都在界面上配；库里只存「环境变量名」，密钥不进库不进前端
 *   - 采样权威副本在数据库 metric_samples；取数失败也留一条样本，断连看得见
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { apiGet, apiSend } from './db'

export interface MonitorTarget {
  id: string; name: string; base: string; api_key_env: string; pool: string; cards: number
  window_seconds: number; interval_seconds: number; metric_format: string; active_probe: number
  enabled: number; last_status: string; last_error: string; fail_streak: number; alert_state: string
}
export interface MetricSample {
  id: number; target: string; service: string; model: string; version: string; status: string
  instances: number; ready: number; cards: number; qps: number | null; tokens_per_sec: number | null
  ttft_ms: number | null; p99_ms: number | null; queue_depth: number | null; kv_hit_pct: number | null; hbm_pct: number | null
  err_pct: number | null; gpu_name: string | null; gpu_util: number | null; gpu_temp_c: number | null; gpu_power_w: number | null
  gpu_mem_used_mib: number; gpu_mem_total_mib: number; req_window: number; note: string; at: string
}
export interface GpuCardRow {
  id: string; target: string; node: string; model: string; util_pct: number | null
  mem_used_mib: number | null; mem_total_mib: number | null; temp_c: number | null; power_w: number | null
  cpu_pct: number | null; ram_used_mib: number | null; ram_total_mib: number | null
  health: string; note: string; updated_at: string
}
export interface MonitorState { thread: boolean; last_run_at: string; last_error: string; probes: number; failures: number; alerts?: Record<string, MonitorAlert>; last_recovery?: { notification_id: string; closed: number } }
export interface MonitorFallback { id: string; ref: string; title: string; status: string; owner: string;
  created_at: string; updated_at: string }

export interface MonitorAlert { notification_id: string; fallback_id: string; owner: string; level: string; streak: number }

interface MonitorStore {
  targets: MonitorTarget[]; latest: (MetricSample | null)[]; samples: MetricSample[]; cards: GpuCardRow[]
  state: MonitorState | null; keyEnvPresent: Record<string, boolean>; fallback: MonitorFallback[]; tick: number; retention: number
  total: number; fromServer: boolean; error: string; loading: boolean
}

const init: MonitorStore = {
  targets: [], latest: [], samples: [], cards: [], state: null, keyEnvPresent: {}, fallback: [], tick: 5, retention: 24,
  total: 0, fromServer: false, error: '', loading: false,
}
let st: MonitorStore = { ...init }
const listeners = new Set<() => void>()
const notify = () => { st = { ...st }; listeners.forEach((f) => f()) }

export const monitorStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => st,

  async refresh(samples = 60) {
    st.loading = true; notify()
    try {
      const m = await apiGet('/monitor')
      if (m && m.ok) {
        st.targets = (m.targets || []) as MonitorTarget[]
        st.latest = (m.latest || []) as (MetricSample | null)[]
        st.state = (m.state || null) as MonitorState | null
        st.keyEnvPresent = (m.key_env_present || {}) as Record<string, boolean>
        st.fallback = (m.fallback || []) as MonitorFallback[]
        st.tick = Number(m.tick_seconds || 5)
        st.retention = Number(m.retention_hours || 24)
        st.total = Number(m.total_samples || 0)
        st.fromServer = true; st.error = ''
      } else st.error = (m && m.error) || '监控接口没返回数据'
      const [sm, cd] = await Promise.all([
        apiGet('/samples?limit=' + samples),
        apiGet('/gpu_cards?limit=50'),
      ])
      if (sm && sm.ok) st.samples = (sm.rows || []) as MetricSample[]
      if (cd && cd.ok) st.cards = (cd.rows || []) as GpuCardRow[]
    } catch (e) {
      st.error = e instanceof Error ? e.message : '读不到监控数据'
    } finally { st.loading = false; notify() }
  },

  async saveTarget(t: Partial<MonitorTarget> & { name: string; base: string; probe?: boolean }) {
    try {
      const r = await apiSend('POST', '/monitor/target', {
        id: t.id, name: t.name, base: t.base, api_key_env: t.api_key_env || '',
        pool: t.pool || 'hp', cards: t.cards ?? 1, window_seconds: t.window_seconds ?? 300,
        interval_seconds: t.interval_seconds ?? 30, metric_format: t.metric_format || 'json',
        active_probe: !!t.active_probe, enabled: t.enabled !== 0, probe: !!t.probe,
      })
      await monitorStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '保存失败' } }
  },

  async decideFallback(id: string, action: 'take' | 'close', note = '') {
    try {
      const r = await apiSend('POST', '/api/monitor/fallback/decide', { id, action, note })
      await monitorStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '操作失败' } }
  },

  async probe(id = '') {
    try {
      const r = await apiSend('POST', '/monitor/probe', id ? { id } : {})
      await monitorStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '采集失败' } }
  },
}

/** 服务端存的是 UTC（Z 结尾）；界面按本机时间显示 */
export function sampleTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.replace('T', ' ').replace('Z', '')
  return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}

export function sampleClock(iso: string): string {
  const t = sampleTime(iso)
  return t.length >= 8 ? t.slice(-8) : t
}

/** 对方不开放的指标存 NULL，界面不能拿 0 冒充数据 */
export function metricNum(v: number | null | undefined, unit = ''): string {
  if (v === null || v === undefined) return '对方未开放'
  return `${v}${unit}`
}

export function useMonitor(): MonitorStore {
  return useSyncExternalStore(monitorStore.subscribe, monitorStore.get, monitorStore.get)
}
