/* =====================================================================
 * 账号与安全（v3.1）
 *   - 改口令：策略由数据服务判定（长度 / 字母+数字 / 弱口令表 / 不复用当前与最近 3 次 / 90 天有效）
 *   - 会话：看自己当前所有会话（管理员看全部），可撤销；口令一改，旧会话全部失效
 *   - 演示账号可停用：停用即撤销该账号全部会话，登录直接拒（试运行期间的账号开关）
 * 口径：内部管理系统的安全基线；本期不做等保测评与密评，但口令、会话、CSRF、审计不放水
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Badge, Callout, Kpi, Panel, PageHead, Table } from '../components/ui'
import {
  DEMO_ACCOUNTS, ROLE_LABEL, auth, changePassword, flagsNow, listSessions, resetPassword,
  revokeSession, toggleAccount, useFlags, useSession, usePerm,
} from '../engine/auth'

export default function AccountSecurity() {
  const acc = useSession()
  const flags = useFlags()
  const matrixPerm = usePerm('matrix')
  const [rows, setRows] = useState<any[]>([])
  const [mineOnly, setMineOnly] = useState(true)
  const [listErr, setListErr] = useState('')
  const [old, setOld] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [acctMsg, setAcctMsg] = useState('')
  const pol = flags.policy

  const reload = async () => {
    const r = await listSessions()
    setRows(r.rows)
    setMineOnly(r.mineOnly)
    setListErr(r.error || '')
  }
  useEffect(() => { void reload() }, [])

  const doChange = async () => {
    setBusy(true); setPwMsg(null)
    if (pw1 !== pw2) { setPwMsg({ ok: false, text: '两次输入的新口令不一致' }); setBusy(false); return }
    const r = await changePassword(old, pw1)
    setBusy(false)
    if (!r.ok) { setPwMsg({ ok: false, text: r.error || '改口令失败' }); return }
    setOld(''); setPw1(''); setPw2('')
    setPwMsg({ ok: true, text: '口令已更换，旧口令立刻不能再登录；请重新登录（新口令有效期 ' + pol.max_age_days + ' 天）' })
  }

  const toggle = async (id: string, enabled: boolean) => {
    setAcctMsg('')
    const r = await toggleAccount(id, enabled)
    setAcctMsg(r.ok ? (enabled ? '账号已开通' : '账号已停用，该账号的会话同时撤销') : ('被拒：' + (r.error || '')))
  }
  const resetPw = async (id: string, temp: string) => {
    setAcctMsg('')
    const r = await resetPassword(id, temp)
    setAcctMsg(r.ok ? '已重置 ' + id + ' 的临时口令，该账号下次登录必须先改口令（会话已全部撤销）' : ('被拒：' + (r.error || '')))
  }

  if (!acc) return <Callout text="请先登录后再查看账号与安全。" />
  const live = rows.filter((r) => !r.revoked && !r.expired)

  return (
    <>
      <PageHead title="账号与安全" desc="口令、会话、演示账号开关 —— 判定都在数据服务里，前端只能显示" />

      <div className="grid g-4">
        <Kpi label="当前账号" value={acc.name} foot={acc.id + ' · ' + ROLE_LABEL[acc.role]} />
        <Kpi label="口令状态" value={flags.mustChange ? '必须更换' : '正常'} foot={flags.mustChange ? (flags.changeReason || '') : '可正常做写操作'} />
        <Kpi label="有效会话" value={String(live.length)} foot={mineOnly ? '只看自己的会话' : '管理员可见全部会话'} />
        <Kpi label="口令策略" value={'≥' + pol.min_len + ' 位'} foot={'字母+数字 · 不复用最近 ' + pol.reuse_check + ' 次 · ' + pol.max_age_days + ' 天有效'} />
      </div>

      {flags.mustChange ? (
        <div className="mt14"><Callout warn text={'这个账号还没换口令（' + (flags.changeReason || '首次登录必须改口令') + '）。换口令前只能改口令，不能做任何写操作 —— 这条拦截在数据服务的守卫里，越权写请求直接 403。'} /></div>
      ) : null}

      <Panel title="更换口令" className="mt14">
        <div className="row gap6 wrap">
          <input className="btn sm" style={{ width: 200 }} type="password" value={old} placeholder="当前口令" onChange={(e) => setOld(e.target.value)} />
          <input className="btn sm" style={{ width: 220 }} type="password" value={pw1} placeholder={'新口令（≥' + pol.min_len + ' 位，字母 + 数字）'} onChange={(e) => setPw1(e.target.value)} />
          <input className="btn sm" style={{ width: 200 }} type="password" value={pw2} placeholder="再输一遍新口令" onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doChange() }} />
          <button className="btn primary sm" disabled={busy} onClick={() => void doChange()}>{busy ? '提交中…' : '更换口令'}</button>
        </div>
        <div className="tiny faint" style={{ marginTop: 8 }}>
          服务端校验顺序：长度 → 字母与数字 → 常见弱口令表 → 是否等于账号 → 是否等于当前口令或最近 {pol.reuse_check} 次用过的口令。
          口令在库里是 PBKDF2-HMAC-SHA256（12 万次迭代）+ 每账号随机盐，接口永不返回口令字段；改口令成功后当前会话被撤销，需要重新登录。
        </div>
        {pwMsg ? <div className="tiny" style={{ marginTop: 8, color: pwMsg.ok ? '#7ee2b8' : '#ff9a9a' }}>{pwMsg.text}</div> : null}
      </Panel>

      <Panel title={'当前会话（' + (mineOnly ? '本人可见' : '管理员可见全部') + '）'} className="mt14" noPad>
        <div className="panel-body">
          {listErr ? <Callout warn text={'会话读不到：' + listErr} /> : null}
          <Table minWidth={900} head={['会话编号', '账号', '角色', '来源 IP', '建立时间', '最近活动', '剩余', '状态', '操作']} rows={rows.map((r) => [
            <span className="tiny mono">{r.ref || '—'}</span>,
            <span className="small">{r.name}<span className="faint tiny mono"> {r.username}</span></span>,
            <span className="tiny">{ROLE_LABEL[(r.role as any) as keyof typeof ROLE_LABEL] || r.role}</span>,
            <span className="tiny mono">{r.ip || '—'}</span>,
            <span className="tiny mono">{(r.created_at || '').replace('T', ' ').replace('Z', '')}</span>,
            <span className="tiny mono">{(r.last_seen || '').replace('T', ' ').replace('Z', '')}</span>,
            <span className="tiny">{r.revoked ? '已撤销' : r.expired ? '已过期' : r.expires_left_min + ' 分钟'}</span>,
            <span>{r.revoked ? <Badge tone="muted">已撤销</Badge> : r.expired ? <Badge tone="muted">已过期</Badge> : r.current ? <Badge tone="good">当前会话</Badge> : <Badge tone="info">有效</Badge>}</span>,
            <button className="btn sm ghost" disabled={r.revoked || r.expired} onClick={() => void revokeSession(r.ref).then(reload)}>撤销</button>,
          ])} />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            会话是 HttpOnly Cookie（前端读不到令牌），有效期 {Math.round(8 * 60)} 分钟、每次访问滑动续期；撤销会话后该 Cookie 立即失效。
            撤销别人的会话需要「权限矩阵」查看权；没有这个权限时服务端直接 403。
          </div>
        </div>
      </Panel>

      <Panel title="演示账号开关（试运行期间的账号管理）" className="mt14" noPad>
        <div className="panel-body">
          {!matrixPerm.manage ? <div className="tiny faint" style={{ marginBottom: 8 }}>你现在的角色不能改账号状态（需要「权限矩阵」操作权）。下面按钮只是灰掉，真正的拦截在服务端。</div> : null}
          <Table minWidth={860} head={['账号', '角色 / 归口', '状态', '临时口令重置', '账号开关']} rows={DEMO_ACCOUNTS.map((a) => [
            <span className="small strong">{a.name}<span className="faint tiny mono"> {a.id}</span></span>,
            <span className="tiny">{ROLE_LABEL[a.role]} · {a.dept} · {a.org}</span>,
            <Badge tone="info">{rows.some((r) => r.user_id === a.id && !r.revoked && !r.expired) ? '有有效会话' : '无有效会话'}</Badge>,
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void resetPw(a.id, 'Reset' + a.id.slice(-2) + '2026demo')}>重置为临时口令</button>,
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void toggle(a.id, false)}>停用</button>,
          ])} />
          {acctMsg ? <div className="tiny" style={{ marginTop: 8, color: '#7ee2b8' }}>{acctMsg}</div> : null}
          <div className="tiny faint" style={{ marginTop: 8 }}>
            停用 = 登录被拒（403）+ 该账号会话全部撤销；重新开通后仍是「必须改口令」状态。
            切到外部身份源之后，本地账号只保留运维兜底用途，账号来源改由「配置中心 → 身份来源与账号映射」的影子同步核对。
          </div>
        </div>
      </Panel>

      <Panel title="这一页对应的口径" className="mt14">
        <Callout text={'当前身份来源：' + (flags.config['auth-provider'] || 'local') + '（' + (flags.config['auth_provider_label'] || '平台内建账号') + '）' + (flags.config['auth_provider_ready'] ? '' : ' · 该适配器还没配好，登录仍走内建账号') + '。'} />
        <div className="tiny faint" style={{ marginTop: 8 }}>
          本期定位是内部管理系统：不做等保测评与密评，但口令策略、会话管理、CSRF、写权限判定、操作留痕按可交付基线做；
          外部统一身份认证（用户域 SSO / 数据域零信任）等客户方侧材料到位后，按「影子同步 → 双写核对 → 切主源」迁移，不改业务代码。
        </div>
      </Panel>
    </>
  )
}
