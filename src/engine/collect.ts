/* =====================================================================
 * 资源接入（v3.8）：采集源在系统里配，不改代码也不改文件
 *   - 配置存 data_sources（密钥只写 "env:环境变量名" 引用，值由启动环境给）
 *   - 数据服务内置采集线程按各自间隔只读拉取，结果入 collect_payloads 供各页面主表格读
 *   - 打开配置项 data-source-approval 后，新增/变更要先走资源接入工单，审批通过才生效
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { apiGet, apiSend } from './db'

export const COLLECT_KINDS = [
  { v: 'services', label: '推理服务（模型服务）' },
  { v: 'cards', label: '算力卡（GPU / NPU Exporter）' },
  { v: 'gateway', label: '推理网关 / API 网关' },
  { v: 'routes', label: '路由与分流配置' },
  { v: 'apps', label: '上层应用（智能体 / 知识库）' },
  { v: 'deploy', label: '部署与版本台账' },
] as const

export interface DataSource {
  id: string; kind: string; name: string; config_json: string; interval_seconds: number
  enabled: number; last_status: string; last_error: string; fail_streak: number; alert_state: string; last_run_at: string
  approval_state: string; order_id: string; created_at: string; updated_at: string
}
export interface CollectStatus { items: number; error: string; sources: number; at: string }
export interface CollectState { thread: boolean; last_run_at: string; last_error: string; runs: number; failures: number }

interface CollectStore {
  sources: DataSource[]; status: Record<string, CollectStatus>; state: CollectState | null
  approvalMode: string; fromServer: boolean; error: string; loading: boolean
}

const init: CollectStore = {
  sources: [], status: {}, state: null, approvalMode: 'off', fromServer: false, error: '', loading: false,
}
let st: CollectStore = { ...init }
const listeners = new Set<() => void>()
const notify = () => { st = { ...st }; listeners.forEach((f) => f()) }

export const collectStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => st,

  async refresh() {
    st.loading = true; notify()
    try {
      const r = await apiGet('/collect')
      if (r && r.ok) {
        st.sources = (r.sources || []) as DataSource[]
        st.status = (r.status || {}) as Record<string, CollectStatus>
        st.state = (r.state || null) as CollectState | null
        st.approvalMode = String(r.approval_mode || 'off')
        st.fromServer = true; st.error = ''
      } else st.error = (r && r.error) || '采集接口没返回数据'
    } catch (e) {
      st.error = e instanceof Error ? e.message : '读不到资源接入配置'
    } finally { st.loading = false; notify() }
  },

  async saveSource(src: { id?: string; kind: string; name: string; config: Record<string, unknown>;
                         interval_seconds: number; enabled?: boolean; collect?: boolean }) {
    try {
      const r = await apiSend('POST', '/collect/source', src)
      await collectStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '保存失败' } }
  },

  async deleteSource(id: string) {
    try {
      const r = await apiSend('POST', '/collect/source/delete', { id })
      await collectStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '删除失败' } }
  },

  async run(kind = '') {
    try {
      const r = await apiSend('POST', '/collect/run', kind ? { kind } : {})
      await collectStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '采集失败' } }
  },

  async importFile() {
    try {
      const r = await apiSend('POST', '/collect/import', {})
      await collectStore.refresh()
      return r
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '导入失败' } }
  },
}

export function useCollect(): CollectStore {
  return useSyncExternalStore(collectStore.subscribe, collectStore.get, collectStore.get)
}

/** 界面只暴露常用字段，其余（Prometheus 指标名、每副本卡数等）走「附加配置」 */
export function buildSourceConfig(form: { base: string; api_key_env: string; format: string; extra: string }) {
  const cfg: Record<string, unknown> = {}
  if (form.base) cfg.base = form.base
  if (form.api_key_env) cfg.api_key = 'env:' + form.api_key_env
  if (form.format) cfg.format = form.format
  const extra = (form.extra || '').trim()
  if (extra) {
    const parsed = JSON.parse(extra)
    if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) throw new Error('附加配置要写成 JSON 对象')
    Object.assign(cfg, parsed)
  }
  return cfg
}
