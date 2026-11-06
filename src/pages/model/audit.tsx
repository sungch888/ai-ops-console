import { useMemo, useState } from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout } from '../../components/ui'
import { auditLog, AUDIT_FILTER_OPTIONS, type AuditEntry } from '../../data/auditLog'
import { engine } from '../../engine/engine'
import { usePerm } from '../../engine/auth'
import { downloadCsv } from '../../engine/ops'

const WINDOWS = [
  { k: '1h', label: '近 1 小时', ms: 3600_000 },
  { k: '24h', label: '近 24 小时', ms: 86_400_000 },
  { k: '7d', label: '近 7 天', ms: 604_800_000 },
]
const tone = (r: AuditEntry['result']) => (r === '拦截' || r === '网关拒绝' ? 'bad' : r === '脱敏放行' || r === '限流' ? 'warn' : 'good')

export default function ModelAudit() {
  const rows = auditLog()
  const exportPerm = usePerm('export')
  const [q, setQ] = useState('')
  const [win, setWin] = useState('24h')
  const [person, setPerson] = useState('全部')
  const [app, setApp] = useState('全部')
  const [model, setModel] = useState('全部')
  const [city, setCity] = useState('全部')
  const [result, setResult] = useState('全部')
  const [credKind, setCredKind] = useState('全部')
  const [open, setOpen] = useState<string | null>(null)

  const credCodes = useMemo(() => Array.from(new Set(rows.map((r) => r.cred))).sort(), [rows])
  const filtered = useMemo(() => {
    const now = Date.now()
    const span = WINDOWS.find((w) => w.k === win)?.ms ?? 86_400_000
    const kw = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (now - r.ts > span) return false
      if (person !== '全部' && `${r.person}（${r.jobNo}）` !== person) return false
      if (app !== '全部' && r.app !== app) return false
      if (model !== '全部' && r.model !== model) return false
      if (city !== '全部' && r.city !== city) return false
      if (result !== '全部' && r.result !== result) return false
      if (credKind !== '全部' && r.credKind !== credKind) return false
      if (kw && !(`${r.person}${r.jobNo}${r.org}${r.app}${r.cred}${r.traceId}${r.model}${r.channel}${r.risk}`.toLowerCase().includes(kw))) return false
      return true
    })
  }, [rows, q, win, person, app, model, city, result, credKind])

  const stats = useMemo(() => {
    const blocked = filtered.filter((r) => r.result === '拦截' || r.result === '网关拒绝').length
    const masked = filtered.filter((r) => r.result === '脱敏放行' || r.result === '限流').length
    const persons = new Set(filtered.map((r) => r.jobNo)).size
    const apps = new Set(filtered.map((r) => r.app)).size
    const tokens = filtered.reduce((s, r) => s + r.tokens, 0)
    const lowTrust = filtered.filter((r) => r.identityGrade === '低信任 · 自建工具').length
    return { blocked, masked, persons, apps, tokens, lowTrust }
  }, [filtered])

  const exportCsv = () => {
    downloadCsv(
      `调用审计_${win}_${filtered.length}条`,
      ['时间', 'traceId', '调用人员', '工号', '单位', '地市', '应用', '访问入口', '凭证', '凭证类型', '模型', '渠道', 'Token', 'p95延迟(ms)', '处置结果', '安全命中', '人员标识来源'],
      filtered.map((r) => [r.time, r.traceId, r.person, r.jobNo, r.org, r.city, r.app, r.entry, r.cred, r.credKind, r.model, r.channel, r.tokens, r.latency, r.result, r.risk, r.identityGrade]),
    )
  }

  const sel = (label: string, value: string, set: (v: string) => void, opts: string[]) => (
    <div>
      <div className="tiny faint">{label}</div>
      <select className="btn sm" style={{ marginTop: 4, maxWidth: 190 }} value={value} onChange={(e) => set(e.target.value)}>
        {['全部', ...opts].map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )

  return (
    <div>
      <PageHead
        title="模型中心 · 调用审计检索"
        desc="按人员 / 应用 / 凭证 / 模型 / 地市 / 时间窗口多维检索 · 还原「人员—入口—智能体—知识库—工具—模型渠道」完整链路 · 支持导出"
        extra={
          <>
            <Badge tone="info">日志留存 186 条 / 近 7 天</Badge>
            <Badge tone={stats.blocked ? 'bad' : 'good'}>拦截与拒绝 {stats.blocked}</Badge>
            <button className="btn sm primary" disabled={!exportPerm.manage || filtered.length === 0} onClick={exportCsv}>导出检索结果 CSV</button>
          </>
        }
      />

      <div className="grid g-6">
        <Kpi label="检索命中" value={filtered.length} unit="条" foot={`全量 ${rows.length} 条`} />
        <Kpi label="拦截 / 网关拒绝" value={stats.blocked} unit="条" foot="含提示词注入与标识缺失" />
        <Kpi label="脱敏 / 限流" value={stats.masked} unit="条" foot="已留处置痕迹" />
        <Kpi label="涉及人员" value={stats.persons} unit="人" foot={`涉及应用 ${stats.apps} 个`} />
        <Kpi label="Token 合计" value={stats.tokens > 10000 ? `${(stats.tokens / 10000).toFixed(2)}万` : stats.tokens} unit="" foot="按检索结果聚合" />
        <Kpi label="低信任来源标注" value={stats.lowTrust} unit="条" foot="开发者自建工具 · 分级审计" />
      </div>

      <Panel title="检索条件" extra="条件为真实过滤 · 也可用关键字跨字段模糊检索（工号 / 应用 / 凭证 / traceId）" className="mt14">
        <div className="row wrap gap12">
          <div>
            <div className="tiny faint">关键字</div>
            <input className="btn sm" style={{ marginTop: 4, width: 230 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="如 U-1188 / 图像审核 / SA-1011 / TR-" />
          </div>
          <div>
            <div className="tiny faint">时间窗口</div>
            <select className="btn sm" style={{ marginTop: 4 }} value={win} onChange={(e) => setWin(e.target.value)}>
              {WINDOWS.map((w) => <option key={w.k} value={w.k}>{w.label}</option>)}
            </select>
          </div>
          {sel('调用人员', person, setPerson, AUDIT_FILTER_OPTIONS.persons)}
          {sel('应用', app, setApp, AUDIT_FILTER_OPTIONS.apps)}
          {sel('凭证', credKind, setCredKind, ['平台代理', '个人密钥'])}
          {sel('模型', model, setModel, AUDIT_FILTER_OPTIONS.models)}
          {sel('地市', city, setCity, AUDIT_FILTER_OPTIONS.cities)}
          {sel('处置结果', result, setResult, AUDIT_FILTER_OPTIONS.results)}
          <button className="btn sm ghost" onClick={() => { setQ(''); setPerson('全部'); setApp('全部'); setModel('全部'); setCity('全部'); setResult('全部'); setCredKind('全部'); setWin('24h') }}>清空条件</button>
        </div>
        <div className="row wrap gap6" style={{ marginTop: 10 }}>
          <span className="tag blue">凭证台账已选 {credCodes.length} 个活跃凭证</span>
          <span className="tag gray">检索为客户端演示数据源 · 生产环境由推理网关日志与调用日志服务提供</span>
        </div>
      </Panel>

      <Panel title="调用记录" extra={`共 ${filtered.length} 条 · 点击 traceId 展开链路还原`} className="mt14" noPad>
        <div className="panel-body">
          {filtered.length === 0 ? (
            <Callout text="当前条件下无匹配记录。可放宽时间窗口或清空条件后重试。" />
          ) : (
            <Table
              minWidth={1180}
              head={['时间', 'traceId', '调用人员 / 归属', '应用 · 入口', '凭证', '模型 · 渠道', 'Token / 延迟', '处置结果 · 标识来源']}
              rows={filtered.slice(0, 60).map((r) => [
                <span className="mono small">{r.time}</span>,
                <button className="btn sm ghost" style={{ padding: '2px 8px', fontFamily: 'var(--mono, monospace)' }} onClick={() => setOpen(open === r.id ? null : r.id)}>{r.traceId}</button>,
                <span className="small">{r.person}<div className="tiny faint">{r.jobNo} · {r.org} · {r.city}</div></span>,
                <span className="small">{r.app}<div className="tiny faint">{r.entry}</div></span>,
                <span className="mono small">{r.cred}<div className="tiny faint">{r.credKind}</div></span>,
                <span className="small">{r.model}<div className="tiny faint">{r.channel}</div></span>,
                <span className="num small">{r.tokens}<div className="tiny faint">{r.latency} ms</div></span>,
                <span>
                  <Badge tone={tone(r.result)}>{r.result}</Badge>
                  <div className="tiny faint" style={{ maxWidth: 220 }}>{r.risk}</div>
                  <div className="tiny" style={{ color: r.identityGrade === '低信任 · 自建工具' || r.identityGrade === '标识缺失' ? 'var(--bad-text)' : '#7f9dc4' }}>{r.identityGrade}</div>
                </span>,
              ])}
            />
          )}
          {filtered.length > 60 ? <div className="tiny faint" style={{ marginTop: 8 }}>仅显示前 60 条，导出 CSV 可获取全部 {filtered.length} 条。</div> : null}
        </div>
      </Panel>

      {open ? (() => {
        const r = filtered.find((x) => x.id === open) as AuditEntry
        return (
          <Panel title={`链路还原 · ${r.traceId}`} extra={`${r.time} · 处置结果 ${r.result}`} className="mt14">
            <div className="grid g-3">
              {r.chain.map((n, i) => (
                <div key={n.label} style={{ border: '1px solid rgba(var(--line-rgb), .18)', borderRadius: 10, padding: '10px 12px', background: 'rgba(23,48,90,.28)' }}>
                  <div className="tiny faint">节点 {i + 1} · {n.label}</div>
                  <div className="small strong" style={{ marginTop: 4 }}>{n.name}</div>
                  <div className="tiny" style={{ color: 'var(--text-dim)', marginTop: 4 }}>{n.note}</div>
                </div>
              ))}
            </div>
            <Callout text={`安全处置：${r.risk}。人员标识来源等级「${r.identityGrade}」，审计以凭证 ${r.cred}（${r.credKind}）责任人为辅；本次调用消耗 ${r.tokens} Token，p95 延迟 ${r.latency} ms。`} warn={r.result === '拦截' || r.result === '网关拒绝'} />
          </Panel>
        )
      })() : null}
    </div>
  )
}
