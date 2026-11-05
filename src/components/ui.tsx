import React from 'react'

export function Kpi(props: {
  label: string
  value: React.ReactNode
  unit?: string
  foot?: React.ReactNode
  ico?: React.ReactNode
}) {
  const { label, value, unit, foot, ico } = props
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {foot ? <div className="k-foot">{foot}</div> : null}
      {ico ? <div className="k-ico">{ico}</div> : null}
    </div>
  )
}

export function Panel(props: {
  title?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClass?: string
  noPad?: boolean
}) {
  const { title, extra, children, className, bodyClass, noPad } = props
  return (
    <div className={`panel ${className ?? ''}`}>
      {title ? (
        <div className="panel-head">
          <span className="ph-left">{title}</span>
          {extra ? <span className="extra">{extra}</span> : null}
        </div>
      ) : null}
      <div className={`panel-body ${noPad ? 'tight' : ''} ${bodyClass ?? ''}`}>{children}</div>
    </div>
  )
}

export function Badge({ tone = 'info', children }: { tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'; children: React.ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  )
}

/** 状态 → 徽章 */
export function State({ s }: { s: string }) {
  const map: Record<string, { tone: 'good' | 'warn' | 'bad' | 'info' | 'muted'; label: string }> = {
    ok: { tone: 'good', label: '运行中' },
    run: { tone: 'info', label: '运行中' },
    busy: { tone: 'warn', label: '高负载' },
    fault: { tone: 'bad', label: '故障' },
    off: { tone: 'muted', label: '已下线' },
    warn: { tone: 'warn', label: '异常' },
    good: { tone: 'good', label: '正常' },
    done: { tone: 'good', label: '已完成' },
    pending: { tone: 'warn', label: '待处理' },
    review: { tone: 'info', label: '审核中' },
    pass: { tone: 'good', label: '已通过' },
    block: { tone: 'bad', label: '已拦截' },
    gray: { tone: 'muted', label: '灰度中' },
    zombie: { tone: 'muted', label: '僵尸' },
    queued: { tone: 'warn', label: '排队中' },
    closed: { tone: 'good', label: '已闭环' },
    rollback: { tone: 'warn', label: '已回滚' },
  }
  const m = map[s] ?? { tone: 'muted' as const, label: s }
  return <Badge tone={m.tone}>{m.label}</Badge>
}

export function Table(props: {
  head: (string | React.ReactNode)[]
  rows: React.ReactNode[][]
  minWidth?: number
}) {
  const { head, rows, minWidth } = props
  return (
    <div className="tbl-scroll">
      <table className="tbl" style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Progress({ value, tone }: { value: number; tone?: '' | 'warn' | 'bad' | 'green' }) {
  const t = tone ? ` ${tone}` : ''
  return (
    <div className={`progress${t}`} style={{ width: '100%' }}>
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function PageHead(props: { title: string; desc?: string; extra?: React.ReactNode }) {
  const { title, desc, extra } = props
  return (
    <div className="page-head">
      <div>
        <h2>{title}</h2>
        {desc ? <p className="desc">{desc}</p> : null}
      </div>
      {extra ? <div className="head-actions">{extra}</div> : null}
    </div>
  )
}

export function Tabs(props: {
  items: string[]
  active: string
  onChange: (t: string) => void
}) {
  const { items, active, onChange } = props
  return (
    <div className="tabs">
      {items.map((it) => (
        <span key={it} className={`tab ${it === active ? 'active' : ''}`} onClick={() => onChange(it)}>
          {it}
        </span>
      ))}
    </div>
  )
}

export function Callout({ text, warn, icon }: { text: React.ReactNode; warn?: boolean; icon?: React.ReactNode }) {
  return (
    <div className={`callout ${warn ? 'warn' : ''}`}>
      {icon ?? (
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.5" />
        </svg>
      )}
      <div>{text}</div>
    </div>
  )
}

/** 数字格式化：1234567 → 123.5万 */
export function fmt(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString('zh-CN')
}
