import React, { useState } from 'react'
import { Badge } from '../components/ui'
import { auth, DEMO_ACCOUNTS, DEMO_LOGIN, ROLE_LABEL, type DemoAccount } from '../engine/auth'

export default function Login() {
  const [domain, setDomain] = useState<'用户域' | '数据域'>('用户域')
  const [picked, setPicked] = useState<string>('U-0001')
  const [ztc, setZtc] = useState(false)
  const [step, setStep] = useState(0)
  const [username, setUsername] = useState(DEMO_LOGIN['U-0001'].username)
  const [password, setPassword] = useState(DEMO_LOGIN['U-0001'].password)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const accounts = DEMO_ACCOUNTS.filter((a) => a.domain === domain)
  const acc = accounts.find((a) => a.id === picked) ?? accounts[0]
  const needZtc = acc?.domain === '数据域'

  const pick = (id: string) => {
    setPicked(id)
    setZtc(false)
    setStep(0)
    setErr('')
    const cred = DEMO_LOGIN[id]
    if (cred) { setUsername(cred.username); setPassword(cred.password) }
  }

  const submit = async () => {
    if (needZtc && !ztc) {
      setStep(1)
      setTimeout(() => setStep(2), 700)
      setTimeout(() => setStep(3), 1400)
      setTimeout(() => setZtc(true), 1900)
      return
    }
    setBusy(true)
    setErr('')
    const r = await auth.login(username.trim(), password)
    setBusy(false)
    if (!r.ok) setErr(r.error || '登录失败')
  }

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div className="panel" style={{ width: 780, maxWidth: '100%' }}>
        <div className="panel-head">
          <span className="ph-left">统一登录入口</span>
          <span className="extra">登录由数据服务校验 · 会话是 HttpOnly Cookie（前端拿不到也改不了）</span>
        </div>
        <div className="panel-body">
          <div className="row between wrap" style={{ gap: 12 }}>
            <div className="row gap6">
              {(['用户域', '数据域'] as const).map((d) => (
                <button key={d} className={`btn sm ${domain === d ? 'primary' : 'ghost'}`} onClick={() => { setDomain(d); pick(DEMO_ACCOUNTS.find((a) => a.domain === d)!.id) }}>
                  {d}{d === '数据域' ? '（零信任）' : '（SSO）'}
                </button>
              ))}
            </div>
            <span className="small faint">
              {domain === '用户域' ? '用户域：单点登录（SSO）对接位置已留好，演示用账号 + 口令' : '数据域：须使用统一身份认证（零信任）账号，演示里先走一遍校验流程'}
            </span>
          </div>

          <div className="divider" />

          <div style={{ display: 'grid', gap: 10 }}>
            {accounts.map((a: DemoAccount) => (
              <div
                key={a.id}
                onClick={() => pick(a.id)}
                style={{
                  cursor: 'pointer', padding: '12px 14px', borderRadius: 11,
                  border: picked === a.id ? '1px solid rgba(34,211,238,.45)' : '1px solid var(--line)',
                  background: picked === a.id ? 'rgba(34,211,238,.08)' : 'rgba(23,48,90,.3)',
                }}
              >
                <div className="row between">
                  <span className="strong">{a.name} <span className="faint small mono">{a.id}</span> <span className="faint small mono">{DEMO_LOGIN[a.id]?.username}</span></span>
                  <Badge tone={a.role === 'admin' ? 'bad' : a.role === 'ops' ? 'warn' : a.role === 'dev' ? 'info' : 'muted'}>{ROLE_LABEL[a.role]}</Badge>
                </div>
                <div className="small" style={{ color: '#8fb0d6', marginTop: 5 }}>{a.dept} · {a.org} · {a.note}</div>
              </div>
            ))}
          </div>

          <div className="row gap6" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <input
              className="btn sm" style={{ width: 190 }} value={username} placeholder="登录名"
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="btn sm" style={{ width: 190 }} type="password" value={password} placeholder="口令"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            />
            <span className="small faint">选上面任一演示账号会自动填好登录名与演示口令；也可以手输</span>
          </div>

          {needZtc ? (
            <div className="mt14" style={{ marginTop: 14 }}>
              <div className="callout">
                <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
                <div>
                  数据域零信任校验（演示）：{step === 0 ? '未校验' : step === 1 ? '终端环境核验…' : step === 2 ? '身份源核验…' : '授权策略核验… 通过'}
                  {ztc ? <Badge tone="good" >校验通过</Badge> : null}
                </div>
              </div>
            </div>
          ) : null}

          {err ? (
            <div className="mt14" style={{ marginTop: 14 }}>
              <div className="callout warn">
                <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg>
                <div>登录被拒：{err}（这条判定发生在数据服务里，改前端没用）</div>
              </div>
            </div>
          ) : null}

          <div className="row between mt14" style={{ marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
            <button className="btn primary" disabled={busy} onClick={() => void submit()}>
              {needZtc && !ztc ? '发起零信任校验' : busy ? '登录中…' : `以「${ROLE_LABEL[acc.role]}」身份登录`}
            </button>
            <span className="small faint">登录后菜单、按钮与可见数据范围按该角色权限矩阵生效；<b>写入与查询权限同时由数据服务判定</b>，越权请求直接 403</span>
          </div>

          <div className="divider" />
          <div className="small" style={{ color: '#7f9cc7', lineHeight: 1.9 }}>
            演示口令（仅演示用，正式版必须改强口令）：<span className="mono">admin/admin123 · ops/ops123 · dev/dev123 · user/user123</span>。
            口令在库里是 PBKDF2-HMAC-SHA256 + 每账号随机盐，接口不返回口令字段；会话 8 小时、每次访问滑动续期；同一账号 5 分钟内连错 5 次暂时拒绝登录，登录成功与失败都进 <span className="mono">login_log</span>。
            生产环境接客户方侧统一身份认证（用户域 SSO / 数据域零信任），认证协议与账号来源为<b>待客户方确认项</b>，见「运营分析 · 外部对接清单」。
          </div>
        </div>
      </div>
    </div>
  )
}
