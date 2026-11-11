import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isMinorPanel, useView } from '../engine/view'
import { alertHref, useAlertPick, type AlertJump } from '../engine/alertJump'

export function Kpi(props: {
  label: string
  value: React.ReactNode
  unit?: string
  foot?: React.ReactNode
  ico?: React.ReactNode
  /** 带 jump 时整张卡可点：告警数字本身就是入口 */
  jump?: AlertJump
}) {
  const { label, value, unit, foot, ico, jump } = props
  const nav = useNavigate()
  const view = useView()
  const footText = typeof foot === 'string' ? foot : ''
  return (
    <div className={`kpi${jump ? ' alert-jump' : ''}`}
      title={jump ? `${jump.label ?? '点击直达处置'}（${jump.page}）` : (!view.hints && footText ? footText : undefined)}
      {...(jump ? {
        role: 'link', tabIndex: 0,
        onClick: () => nav(alertHref(jump)),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(alertHref(jump)) } },
      } : {})}>
      <div className="k-label">{label}</div>
      <div className="k-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {foot && (view.hints || typeof foot !== 'string') ? <div className="k-foot">{foot}</div> : null}
      {ico ? <div className="k-ico">{ico}</div> : null}
      {jump ? <span className="go">›</span> : null}
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
  /** 明确标成重点：演示档也不折叠（不标时按「配置中心 · 演示视图」的白名单判） */
  focus?: boolean
}) {
  const { title, extra, children, className, bodyClass, noPad, focus } = props
  const view = useView()
  const [open, setOpen] = React.useState(false)
  const text = typeof title === 'string' ? title : ''
  const arrived = useAlertPick()
  const minor = !focus && !arrived && !!text && isMinorPanel(text)
  const extraText = typeof extra === 'string' ? extra : ''
  const showExtra = !!extra && (view.hints || !extraText)
  if (minor && !open) {
    return (
      <div className={`minor-fold ${className ?? ''}`}>
        <span className="tiny faint">次要内容 · {text}</span>
        <button className="btn sm ghost" onClick={() => setOpen(true)}>展开看</button>
      </div>
    )
  }
  return (
    <div className={`panel ${className ?? ''}`}>
      {title ? (
        <div className="panel-head">
          <span className="ph-left">{title}</span>
          {showExtra ? <span className="extra">{extra}</span> : null}
          {extraText && !view.hints ? <span className="hint-dot" title={extraText} /> : null}
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

/** 可点击的红 / 黄告警徽章：点它 = 直达能动手的那个地方（哪个页 + 哪一行） */
export function AlertBadge({ tone, jump, children }: {
  tone: 'warn' | 'bad'
  jump: AlertJump
  children: React.ReactNode
}) {
  return (
    <Link className={`badge ${tone} alert-jump`} to={alertHref(jump)}
      title={`${jump.label ?? '点击直达处置'}（${jump.page}${jump.pick ? ' · ' + jump.pick : ''}）`}>
      <span className="dot" />
      {children}
      <span className="go">›</span>
    </Link>
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
  /** 每行的定位主键（与 rows 同序）；配合 pick 做「跳进来高亮这一行」 */
  rowKeys?: string[]
  /** 要高亮的行主键（一般来自 ?pick=） */
  pick?: string
}) {
  const { head, rows, minWidth, rowKeys, pick } = props
  return (
    <div className="tbl-scroll">
      <table className="tbl" style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={rowKeys && pick && rowKeys[i] === pick ? 'row-pick' : undefined}>
              {r.map((c, j) => <td key={j}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 进度条：红 / 黄本身就是告警色，带 jump 时点它直达处置 */
export function Progress({ value, tone, jump }: { value: number; tone?: '' | 'warn' | 'bad' | 'green'; jump?: AlertJump }) {
  const nav = useNavigate()
  const t = tone ? ` ${tone}` : ''
  const alertTone = jump && (tone === 'warn' || tone === 'bad')
  return (
    <div className={`progress${t}${alertTone ? ' alert-jump' : ''}`} style={{ width: '100%' }}
      {...(alertTone ? {
        role: 'link', tabIndex: 0, title: `${jump!.label ?? '点击直达处置'}（${jump!.page}）`,
        onClick: () => nav(alertHref(jump!)),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(alertHref(jump!)) } },
      } : {})}>
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function PageHead(props: { title: string; desc?: string; extra?: React.ReactNode }) {
  const { title, desc, extra } = props
  const view = useView()
  return (
    <div className="page-head">
      <div>
        <h2>
          {title}
          {desc && !view.hints ? <span className="hint-dot" title={desc} aria-label={desc} /> : null}
        </h2>
        {desc && view.hints ? <p className="desc">{desc}</p> : null}
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

export function Tip({ text, label }: { text: string; label?: string }) {
  return <span className="tip" title={text}>{label || '说明'}</span>
}

/** 说明条；带 jump 时整条可点（红 / 黄告警口径：点它就落到操作点） */
export function Callout({ text, warn, icon, jump }: { text: React.ReactNode; warn?: boolean; icon?: React.ReactNode; jump?: AlertJump }) {
  const nav = useNavigate()
  const cls = `callout ${warn ? 'warn' : ''} ${jump ? 'alert-jump' : ''}`
  return (
    <div className={cls}
      {...(jump ? {
        role: 'link', tabIndex: 0, title: `${jump.label ?? '点击直达处置'}（${jump.page}）`,
        onClick: () => nav(alertHref(jump)),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(alertHref(jump)) } },
      } : {})}>
      {icon ?? (
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.5" />
        </svg>
      )}
      <div>{text}{jump ? <span className="go" style={{ marginLeft: 6 }}>›</span> : null}</div>
    </div>
  )
}

/** 数字格式化（中文单位）：1234567 → 123.5万
 *  非法值（NaN / Infinity / null / undefined）一律显示「—」，不把 NaN 印到界面上 */
export function fmtCN(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString('zh-CN')
}
