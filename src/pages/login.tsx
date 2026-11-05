import React, { useState } from 'react'
import { Badge } from '../components/ui'
import { auth, DEMO_ACCOUNTS, ROLE_LABEL, type DemoAccount } from '../engine/auth'

export default function Login() {
  const [domain, setDomain] = useState<'用户域' | '数据域'>('用户域')
  const [picked, setPicked] = useState<string>('U-0001')
  const [ztc, setZtc] = useState(false)
  const [step, setStep] = useState(0)

  const accounts = DEMO_ACCOUNTS.filter((a) => a.domain === domain)
  const acc = accounts.find((a) => a.id === picked) ?? accounts[0]
  const needZtc = acc?.domain === '数据域'

  const doLogin = () => {
    if (needZtc && !ztc) {
      setStep(1)
      setTimeout(() => setStep(2), 700)
      setTimeout(() => setStep(3), 1400)
      setTimeout(() => { setZtc(true); auth.login(acc.id) }, 1900)
      return
    }
    auth.login(acc.id)
  }

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div className="panel" style={{ width: 760, maxWidth: '100%' }}>
        <div className="panel-head">
          <span className="ph-left">统一登录入口</span>
          <span className="extra">演示版免密 · 不收集真实口令</span>
        </div>
        <div className="panel-body">
          <div className="row between wrap" style={{ gap: 12 }}>
            <div className="row gap6">
              {(['用户域', '数据域'] as const).map((d) => (
                <button key={d} className={`btn sm ${domain === d ? 'primary' : 'ghost'}`} onClick={() => { setDomain(d); setPicked(DEMO_ACCOUNTS.find((a) => a.domain === d)!.id); setZtc(false); setStep(0) }}>
                  {d}{d === '数据域' ? '（零信任）' : '（SSO）'}
                </button>
              ))}
            </div>
            <span className="small faint">
              {domain === '用户域' ? '用户域支持单点登录（SSO）对接，演示版直接选择演示账号' : '数据域须申请注册或使用统一身份认证（零信任）账号登录'}
            </span>
          </div>

          <div className="divider" />

          <div style={{ display: 'grid', gap: 10 }}>
            {accounts.map((a: DemoAccount) => (
              <div
                key={a.id}
                onClick={() => { setPicked(a.id); setZtc(false); setStep(0) }}
                style={{
                  cursor: 'pointer', padding: '12px 14px', borderRadius: 11,
                  border: picked === a.id ? '1px solid rgba(34,211,238,.45)' : '1px solid var(--line)',
                  background: picked === a.id ? 'rgba(34,211,238,.08)' : 'rgba(23,48,90,.3)',
                }}
              >
                <div className="row between">
                  <span className="strong">{a.name} <span className="faint small mono">{a.id}</span></span>
                  <Badge tone={a.role === 'admin' ? 'bad' : a.role === 'ops' ? 'warn' : a.role === 'dev' ? 'info' : 'muted'}>{ROLE_LABEL[a.role]}</Badge>
                </div>
                <div className="small" style={{ color: '#8fb0d6', marginTop: 5 }}>{a.dept} · {a.org} · {a.note}</div>
              </div>
            ))}
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

          <div className="row between mt14" style={{ marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
            <button className="btn primary" onClick={doLogin}>
              {needZtc && !ztc ? '发起零信任校验并登录' : `以「${ROLE_LABEL[acc.role]}」身份登录`}
            </button>
            <span className="small faint">登录后左侧菜单、页面操作按钮与可见数据范围将按该角色权限矩阵真实生效</span>
          </div>

          <div className="divider" />
          <div className="small" style={{ color: '#7f9cc7', lineHeight: 1.9 }}>
            演示说明：本页面为选型演示用的登录入口模拟，不采集任何真实账号口令。生产环境将对接客户方侧统一身份认证（用户域 SSO / 数据域零信任），认证协议与账号来源为<b>待客户方确认项</b>，见「运营分析 · 外部对接清单」。
          </div>
        </div>
      </div>
    </div>
  )
}
