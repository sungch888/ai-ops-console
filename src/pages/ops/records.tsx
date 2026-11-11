import React from 'react'
import { PageHead, Panel, Table, Badge, Tabs, Callout, Kpi, AlertBadge } from '../../components/ui'
import {
  queryOrders, queryEvents, queryAudit, queryTables, queryHealth, csvUrl, ORDER_STATUS_LABEL,
  type Filters, type TableRow, type HealthInfo, type QueryPage,
} from '../../engine/query'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

type Tab = '工单台账' | '运行事件' | '写入审计' | '数据库概览'
const TABS: Tab[] = ['工单台账', '运行事件', '写入审计', '数据库概览']

const STATUSES = ['', 'to_biz', 'submitted', 'approved', 'queued', 'dispatched', 'external', 'running', 'rejected', 'closed']
const LEVELS = ['', '一般', '重要', '紧急']
const ACTIONS = ['', 'state_put', 'state_bulk', 'state_delete', 'reset', 'seed']
const LIMITS = [20, 50, 100]

const emptyPage: QueryPage<Record<string, any>> = { ok: true, total: 0, limit: 20, offset: 0, rows: [] }

export default function RecordsPage() {
  const [tab, setTab] = React.useState<Tab>('工单台账')
  const [status, setStatus] = React.useState('')
  const [type, setType] = React.useState('')
  const [level, setLevel] = React.useState('')
  const [actor, setActor] = React.useState('')
  const [action, setAction] = React.useState('')
  const [q, setQ] = React.useState('')
  const [limit, setLimit] = React.useState(20)
  const [offset, setOffset] = React.useState(0)
  const [page, setPage] = React.useState<QueryPage<Record<string, any>>>(emptyPage)
  const [tables, setTables] = React.useState<TableRow[]>([])
  const [health, setHealth] = React.useState<HealthInfo | null>(null)
  const [err, setErr] = React.useState('')
  const [lastUrl, setLastUrl] = React.useState('')
  const [stamp, setStamp] = React.useState('')
  /** 别处点过来：?pick=<工单号> → 自动切到「工单台账」并高亮那一行 */
  const pick = useAlertPick()
  usePickFlash(pick)
  React.useEffect(() => { if (/^WO-/.test(pick)) setTab('工单台账') }, [pick])
  const orderRow = (id: string): AlertJump => ({ page: '/ops/records', pick: id, label: '去台账看这条记录：状态、决定人、驳回理由都在这一行' })

  const filters = React.useMemo<Filters>(() => {
    if (tab === '工单台账') return { status, type, q, limit, offset }
    if (tab === '运行事件') return { level, q, limit, offset }
    if (tab === '写入审计') return { actor, action, limit, offset }
    return {}
  }, [tab, status, type, level, actor, action, q, limit, offset])

  const resource = tab === '工单台账' ? 'orders' : tab === '运行事件' ? 'events' : 'audit'

  const load = React.useCallback(async () => {
    setErr('')
    try {
      const run = tab === '工单台账' ? queryOrders : tab === '运行事件' ? queryEvents : queryAudit
      const res = await run(filters)
      setPage(res)
      setLastUrl('/api/' + resource + '?' + Object.keys(filters)
        .filter((k) => String(filters[k] ?? '') !== '')
        .map((k) => k + '=' + encodeURIComponent(String(filters[k]))).join('&'))
      setStamp(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [tab, filters, resource])

  const loadMeta = React.useCallback(async () => {
    try {
      const [t, h] = await Promise.all([queryTables(), queryHealth()])
      setTables(t.tables); setHealth(h)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  React.useEffect(() => { setOffset(0) }, [tab, status, type, level, actor, action, q, limit])
  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => { void loadMeta() }, [loadMeta])

  const csvFilters: Filters = tab === '工单台账' ? { status, type, q, limit: 5000 }
    : tab === '运行事件' ? { level, q, limit: 5000 } : { actor, action, limit: 5000 }

  const total = page.total
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + page.rows.length)

  const ctl = (label: string, node: React.ReactNode) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="small faint">{label}</span>
      {node}
    </span>
  )

  return (
    <div className="page">
      <PageHead
        title="台账与审计（数据服务查询）"
        desc="工单、运行事件、写入审计都从数据服务的数据库里查，服务端分页与过滤；本页不读前端内存，也不读浏览器本地存储。"
        extra={<span className="mono">最近查询 {stamp || '—'}</span>}
      />

      <div className="grid g-4">
        <Kpi label="工单" value={String(page.total)} unit={tab === '工单台账' ? '条（当前条件）' : '条'} />
        <Kpi label="运行事件" value={String(health?.counts?.events ?? 0)} unit="条（库内累计）" />
        <Kpi label="写入审计" value={String(health?.counts?.audit_log ?? 0)} unit="条（库内累计）" />
        <Kpi label="状态快照键" value={String(health?.counts?.kv_store ?? 0)} unit="个" />
      </div>

      <Tabs items={TABS} active={tab} onChange={(t) => setTab(t as Tab)} />

      {err && <Callout warn text={`查询失败：${err}（数据服务未连接或接口不可用）`} />}

      {tab !== '数据库概览' && (
        <Panel title="查询条件" extra={<span className="extra">接口 <span className="mono">{lastUrl || '—'}</span></span>}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {tab === '工单台账' && (
              <>
                {ctl('状态', (
                  <select className="btn sm" value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s ? ORDER_STATUS_LABEL[s] : '全部状态'}</option>)}
                  </select>
                ))}
                {ctl('类型关键字', (
                  <input className="btn sm" value={type} placeholder="如 deploy / credential_issue" onChange={(e) => setType(e.target.value)} />
                ))}
              </>
            )}
            {tab === '运行事件' && (
              <>
                {ctl('级别', (
                  <select className="btn sm" value={level} onChange={(e) => setLevel(e.target.value)}>
                    {LEVELS.map((s) => <option key={s} value={s}>{s || '全部级别'}</option>)}
                  </select>
                ))}
              </>
            )}
            {tab === '写入审计' && (
              <>
                {ctl('账号', (
                  <input className="btn sm" value={actor} placeholder="如 U-0001" onChange={(e) => setActor(e.target.value)} />
                ))}
                {ctl('动作', (
                  <select className="btn sm" value={action} onChange={(e) => setAction(e.target.value)}>
                    {ACTIONS.map((s) => <option key={s} value={s}>{s || '全部动作'}</option>)}
                  </select>
                ))}
              </>
            )}
            {tab !== '写入审计' && (
              <>
                {ctl('关键词', (
                  <input className="btn sm" value={q} placeholder="在标题 / 对象 / 内容里检索" onChange={(e) => setQ(e.target.value)} />
                ))}
              </>
            )}
            {ctl('每页', (
              <select className="btn sm" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            ))}
            <button className="btn sm" onClick={() => void load()}>重新查询</button>
            <a className="btn sm" href={csvUrl(resource, csvFilters)}>导出 CSV（服务端生成）</a>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            共 {total} 条 · 当前显示第 {from}–{to} 条 ·
            {' '}<button className="btn sm" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - limit))}>上一页</button>{' '}
            <button className="btn sm" disabled={to >= total} onClick={() => setOffset(offset + limit)}>下一页</button>
            {' '}<span className="mono">{`/api/${resource}?limit=${limit}&offset=${offset}`}</span>
          </div>
        </Panel>
      )}

      {tab === '工单台账' && (
        <Panel title="工单台账" extra={<span className="extra">{page.rows.length} 行</span>}>
          <Table
            minWidth={980}
            head={['工单号', '类型', '标题', '申请人 / 单位', '状态', '对象', '规模', '决定人', '创建时间', '更新时间']}
            rows={page.rows.map((r) => [
              <span className="mono">{String(r.id)}</span>,
              <span className="mono">{String(r.type)}</span>,
              String(r.title ?? ''),
              `${String(r.applicant ?? '')}${r.dept ? ' · ' + String(r.dept) : ''}`,
              <Badge tone={r.status === 'rejected' ? 'bad' : r.status === 'closed' ? 'muted' : r.status === 'external' ? 'warn' : 'info'}>
                {ORDER_STATUS_LABEL[String(r.status)] ?? String(r.status)}
              </Badge>,
              String(r.target ?? ''),
              String(r.amount ?? ''),
              String(r.decided_by ?? ''),
              <span className="mono">{String(r.created_at ?? '')}</span>,
              <span className="mono">{String(r.updated_at ?? '')}</span>,
            ])}
          />
          {page.rows.some((r) => r.reject_reason) && (
            <div className="muted" style={{ marginTop: 6 }}>
              驳回理由已入库：<span className="mono">{page.rows.filter((r) => r.reject_reason).map((r) => `${r.id} → ${r.reject_reason}`).slice(0, 2).join(' ｜ ')}</span>
            </div>
          )}
        </Panel>
      )}

      {tab === '运行事件' && (
        <Panel title="运行事件（长期留存）" extra={<span className="extra">界面上只留最近 80 条，库里按时间与内容去重累积</span>}>
          <Table
            minWidth={760}
            head={['时间', '级别', '内容', '来源']}
            rows={page.rows.map((r) => [
              <span className="mono">{String(r.time ?? '')}</span>,
              <Badge tone={r.level === '紧急' ? 'bad' : r.level === '重要' ? 'warn' : 'muted'}>{String(r.level ?? '')}</Badge>,
              String(r.text ?? ''),
              <span className="mono">{String(r.source ?? '')}</span>,
            ])}
          />
        </Panel>
      )}

      {tab === '写入审计' && (
        <Panel title="写入审计（服务端留痕）" extra={<span className="extra">每一次落库都记一行：谁、什么时候、动了哪个对象</span>}>
          <Table
            minWidth={860}
            head={['时间', '账号', '动作', '对象', '明细']}
            rows={page.rows.map((r) => [
              <span className="mono">{String(r.at ?? '')}</span>,
              <span className="mono">{String(r.actor ?? '')}</span>,
              <span className="mono">{String(r.action ?? '')}</span>,
              <span className="mono">{String(r.target ?? '')}</span>,
              String(r.detail ?? ''),
            ])}
          />
        </Panel>
      )}

      {tab === '数据库概览' && (
        <>
          <Panel title="数据库概览" extra={<span className="extra mono">{health ? `${health.db} · ${health.version} · schema ${health.schema_version} · 已运行 ${health.uptime_s}s` : '数据服务未连接'}</span>}>
            <Table
              minWidth={620}
              head={['表', '行数', '最近变更']}
              rows={tables.map((t) => [
                <span className="mono">{t.table}</span>,
                String(t.rows),
                <span className="mono">{t.last_change || '—'}</span>,
              ])}
            />
          </Panel>
          <Callout
            text={<>
              这些行数可以直接用浏览器打开核对：<span className="mono">/api/tables</span>、<span className="mono">/api/health</span>、
              <span className="mono">/api/orders?status=submitted</span>、<span className="mono">/api/csv?resource=audit</span>。
              界面看到的和接口查到的是同一份数据库内容。
            </>}
          />
        </>
      )}
    </div>
  )
}
