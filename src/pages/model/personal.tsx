/* =====================================================================
 * 个人模型中心视角（需求 模型 13）
 * 我的 Key / 我的用量 / 积分兑换额度 / 接入指导
 * 数据与组织视角同源：凭证台账 + 实时账本 + 工单引擎
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout, Progress } from '../../components/ui'
import { engine, useEngine } from '../../engine/engine'
import { ledgerOf } from '../../engine/ledger'
import { useSession, useMatrix, usePerm, ROLE_LABEL } from '../../engine/auth'
import { notifyStore } from '../../engine/ops'
import { gatewayEndpoints } from '../../data/mock'

const PACKAGES = [
  { name: '配额提升包', detail: '个人密钥 +20 RPM / 30 天', points: 400, kind: 'quota' as const },
  { name: 'TPM 提升包', detail: 'Token 分钟上限 +12 万 / 30 天', points: 600, kind: 'manual' as const },
  { name: '优先队列包', detail: '高保队列优先 30 天', points: 1200, kind: 'manual' as const },
  { name: '微调卡时包', detail: '训练微调 4 卡时', points: 1500, kind: 'manual' as const },
]

const maskKey = (id: string) => `sk-****${id.slice(-4).toLowerCase()}`

export default function Personal() {
  const st = useEngine()
  const acc = useSession()
  const matrix = useMatrix()
  const L = ledgerOf(st)
  const canApprove = usePerm('approve').manage
  const surname = (acc?.name ?? '').charAt(0)
  const mine = st.creds.filter((c) => c.holder.startsWith(surname))
  const me = L.perPerson.find((p) => p.name.startsWith(surname))
  const mineOrders = st.orders.filter((o) => String(o.applicant).startsWith(surname) || mine.some((c) => String(o.spec.credId ?? '') === c.id))
  const [flash, setFlash] = useState<string | null>(null)
  const [openHelp, setOpenHelp] = useState<string | null>(null)
  const cls = acc ? matrix[acc.role].cls.join(' / ') : '—'

  const redeem = (pkg: typeof PACKAGES[number]) => {
    const live = mine.find((c) => c.status !== 'off')
    if (pkg.kind === 'quota') {
      if (!live) { setFlash('兑换配额包需至少一个有效个人密钥，请先提交凭证申请'); return }
      if ((me?.points ?? 0) < pkg.points) { setFlash(`积分不足：需要 ${pkg.points} 分，当前 ${me?.points ?? 0} 分`); return }
      const r = engine.submit({ type: 'quota_adjust', applicant: acc?.name ?? '业务用户', dept: acc?.dept ?? '基层所队', level: '共享', reason: `积分兑换「${pkg.name}」：个人密钥配额由 ${live.rpm} 提升至 ${live.rpm + 20} RPM，需双人复核后生效`, spec: { credId: live.id, rpm: live.rpm + 20 } })
      setFlash(r.precheck.ok ? `兑换单 ${r.order.id} 已提交，准入通过：${r.precheck.suggest ?? ''} · 扣减积分 ${pkg.points} 分（待运营审批后生效）` : `兑换被准入拦截：${r.precheck.reason}`)
    } else {
      if ((me?.points ?? 0) < pkg.points) { setFlash(`积分不足：需要 ${pkg.points} 分，当前 ${me?.points ?? 0} 分`); return }
      notifyStore.push('一般', `积分兑换申请：${pkg.name}`, `${acc?.name ?? '业务用户'} 申请「${pkg.name}」（${pkg.detail}），扣减 ${pkg.points} 积分，待运营服务团队人工审核`, '模型中心 / 个人模型中心')
      engine.get().events.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5), level: '一般', text: `积分兑换申请已提交：${pkg.name}（${acc?.name ?? '业务用户'} · ${pkg.points} 积分）· 待人工审核` })
      engine.refresh()
      setFlash(`「${pkg.name}」兑换申请已提交（扣减 ${pkg.points} 积分），由运营服务团队人工审核后发放`)
    }
  }

  const applyCred = () => {
    const r = engine.submit({ type: 'credential_issue', applicant: acc?.name ?? '业务用户', dept: acc?.dept ?? '基层所队', level: '共享', reason: '个人使用需绑定模型渠道，申请个人密钥（默认低配额，IP 白名单限定本机）', spec: { kind: '个人密钥', holder: acc?.name ?? '业务用户', app: '个人使用', model: 'Qwen3-32B 微调', channel: 'ascend', rpm: 60, tpm: '12万' } })
    setFlash(r.precheck.ok ? `凭证申请 ${r.order.id} 已提交，准入通过：${r.precheck.suggest ?? ''}` : `凭证申请被拒：${r.precheck.reason}`)
  }

  const revoke = (credId: string) => {
    const r = engine.submit({ type: 'credential_revoke', applicant: acc?.name ?? '业务用户', dept: acc?.dept ?? '基层所队', level: '共享', reason: '本人主动吊销：疑似在公用终端使用，按要求吊销并重发', spec: { credId } })
    setFlash(r.precheck.ok ? `吊销申请 ${r.order.id} 已提交：${r.precheck.suggest ?? ''}（待运营审批执行）` : `吊销申请被拒：${r.precheck.reason}`)
  }

  return (
    <div>
      <PageHead
        title="个人模型中心"
        desc="我的 Key · 我的用量 · 积分兑换额度 · 接入指导（与组织视角同一套凭证与账本）"
        extra={<><Badge tone="info">{acc ? ROLE_LABEL[acc.role] : '未登录'}</Badge><Badge tone="muted">可见数据密级 {cls}</Badge></>}
      />

      {flash ? (
        <div className="callout" style={{ marginBottom: 14 }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div>{flash}</div>
        </div>
      ) : null}

      <div className="grid g-6">
        <Kpi label="我的账号" value={acc?.id ?? '—'} unit="" foot={`${acc?.name ?? '—'} · ${acc?.dept ?? '—'}`} />
        <Kpi label="我的今日调用" value={me ? (me.calls / 10000).toFixed(2) : '0.00'} unit="万次" foot={me ? `占全平台 ${me.share}% · ${me.rpm} RPM 配额` : '当前无有效凭证配额'} />
        <Kpi label="我的今日 Token" value={me ? me.tokens.toLocaleString('zh-CN') : '0'} unit="万" foot={`折算成本 ¥${(me?.cost ?? 0).toLocaleString('zh-CN')}`} />
        <Kpi label="我的积分" value={(me?.points ?? 0).toLocaleString('zh-CN')} unit="分" foot="每 1 万 Token 计 8 分 · 可用于兑换额度" />
        <Kpi label="我的凭证" value={mine.length} unit="个" foot={`有效 ${mine.filter((c) => c.status !== 'off').length} · 已吊销 ${mine.filter((c) => c.status === 'off').length} · 临期 ${me?.expSoon ?? 0}`} />
        <Kpi label="我的工单" value={mineOrders.length} unit="项" foot={`待审批 ${mineOrders.filter((o) => o.status === 'submitted').length} · 已闭环 ${mineOrders.filter((o) => o.status === 'closed').length}`} />
      </div>

      <Panel title="我的凭证（Key 已掩码展示）" extra="完整密钥不在界面与接口暴露；如需变更须走工单" className="mt14" noPad>
        <div className="panel-body">
          {mine.length === 0 ? (
            <Callout text="当前账号暂无个人密钥。可提交「个人密钥申请」，默认低配额（60 RPM / 12 万 TPM），IP 白名单限定本人终端；渠道配额占用不足会被准入直接拒绝。" />
          ) : (
            <Table
              minWidth={1020}
              head={['凭证', '类型', '绑定应用 / 模型 / 渠道', '配额', 'IP 白名单', '剩余有效期 / 最近使用', '状态', '操作']}
              rows={mine.map((c) => [
                <span className="mono small strong">{maskKey(c.id)}<div className="tiny faint">{c.id}</div></span>,
                <span className={`tag ${c.kind === '个人密钥' ? '' : 'green'}`}>{c.kind}</span>,
                <span className="small">{c.app}<div className="tiny faint">{c.model} · {st.channels.find((ch) => ch.id === c.channel)?.name.split('（')[0] ?? c.channel}</div></span>,
                <span className="num small">{c.rpm} RPM<div className="tiny faint">{c.tpm} TPM</div></span>,
                <span className="mono tiny">{c.ip}</span>,
                <span className="small num">{c.expDays} 天<div className="tiny faint">{c.lastUsedDays === 0 ? '今日已使用' : `最近使用 ${c.lastUsedDays} 天前`}</div></span>,
                c.status === 'off' ? <Badge tone="bad">已吊销</Badge> : c.status === 'warn' ? <Badge tone="warn">临期 / 需复核</Badge> : <State s="ok" />,
                <div className="row gap6">
                  <button className="btn sm ghost" onClick={() => setOpenHelp(openHelp === c.id ? null : c.id)}>{openHelp === c.id ? '收起接入示例' : '接入示例'}</button>
                  {c.status !== 'off' ? <button className="btn sm danger" onClick={() => revoke(c.id)}>申请吊销</button> : <span className="tiny faint">已吊销 · 需重新申请</span>}
                </div>,
              ])}
            />
          )}

          {openHelp ? (() => {
            const c = mine.find((x) => x.id === openHelp)!
            const ep = gatewayEndpoints[0]
            return (
              <div style={{ marginTop: 12, border: '1px dashed rgba(var(--line-rgb), .35)', borderRadius: 10, padding: 12 }}>
                <div className="small strong">接入示例 · {c.id}（{c.kind}）</div>
                <div className="tiny faint" style={{ marginTop: 4 }}>端点 {ep.api} · 模型 {c.model} · 渠道 {st.channels.find((ch) => ch.id === c.channel)?.name ?? c.channel} · 限额 {c.rpm} RPM / {c.tpm} TPM · 仅允许 {c.ip}</div>
                <pre className="mono small" style={{ marginTop: 8, background: 'rgba(8,18,34,.6)', border: '1px solid rgba(var(--line-rgb), .18)', borderRadius: 8, padding: 10, overflowX: 'auto' }}>{`curl -X POST https://ai-ops.gaj.local/api/v1/chat/completions \\\n  -H "Authorization: Bearer ${maskKey(c.id)}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${c.model}","messages":[{"role":"user","content":"生成 11-04 咨询记录摘要"}]}'`}</pre>
                <div className="small" style={{ color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.9 }}>
                  常见返回：<b>429</b> 触发配额限流 → 在下方用积分兑换配额包或提交提额工单；<b>403</b> 来源 IP 不在白名单 → 提交终端 IP 变更工单；<b>401</b> 凭证已吊销 → 重新申请并说明原因。密钥不得写入代码仓库、脚本或外发文档，发现外发迹象应立即申请吊销。
                </div>
              </div>
            )
          })() : null}

          <div className="row gap6" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={applyCred}>提交个人密钥申请</button>
            <span className="small faint">申请即进入工单流程：准入校验渠道配额 → 运营审批 → 发放并绑定 IP 白名单</span>
          </div>
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="积分与额度兑换" extra="积分按真实用量折算，兑换即生成工单或人工审核单" noPad>
          <div className="panel-body">
            <div className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>
              积分构成：本月 Token 消耗 <b>{(me?.tokens ?? 0).toLocaleString('zh-CN')} 万 × 8 分/万</b> = <b>{(me?.points ?? 0).toLocaleString('zh-CN')} 分</b>。
              兑换配额包会直接生成 <b>quota_adjust</b> 工单并过准入（个人密钥默认上限 120 RPM，超限直接拦截）；其余兑换包转运营人工审核。
            </div>
            <div className="divider" />
            <Table
              minWidth={720}
              head={['兑换包', '内容', '所需积分', '兑换后效果', '操作']}
              rows={PACKAGES.map((p) => [
                <span className="strong small">{p.name}</span>,
                <span className="small">{p.detail}</span>,
                <span className="num">{p.points.toLocaleString('zh-CN')} 分</span>,
                <span className="tiny faint">{p.kind === 'quota' ? '生成配额调整工单，审批后即时生效并影响渠道配额占用' : '转运营人工审核，审核通过后由平台配置'}</span>,
                <button className="btn sm primary" disabled={(me?.points ?? 0) < p.points} onClick={() => redeem(p)}>{(me?.points ?? 0) < p.points ? '积分不足' : '兑换'}</button>,
              ])}
            />
            {mine.some((c) => c.status !== 'off') ? (
              <div style={{ marginTop: 12 }}>
                <div className="small faint">当前配额占用（我的凭证）</div>
                {mine.filter((c) => c.status !== 'off').map((c) => {
                  const ch = st.channels.find((x) => x.id === c.channel)!
                  const used = Math.round((ch.allocatedRpm / ch.capacityRpm) * 100)
                  return (
                    <div key={c.id} style={{ marginTop: 8 }}>
                      <div className="row between small"><span>{c.id} → {ch.name.split('（')[0]}</span><span className="num">{c.rpm} RPM · 渠道已占用 {used}%</span></div>
                      <Progress value={used} tone={used > 85 ? 'warn' : ''} />
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="我的用量明细（近 24 小时）" extra="按我的凭证配额占比从同一账本拆分" noPad>
          <div className="panel-body">
            {me ? (
              <>
                {L.series.slice(-8).map((s) => (
                  <div key={s.hour} style={{ marginBottom: 9 }}>
                    <div className="row between small"><span className="mono">{s.hour}</span><span className="num">{Math.round((s.calls * me.share) / 100).toLocaleString('zh-CN')} 次 · {Math.round((s.tokens * me.share) / 100).toLocaleString('zh-CN')} 万 token</span></div>
                    <Progress value={Math.max(3, Math.round((s.calls / Math.max(1, Math.max(...L.series.map((x) => x.calls)))) * 100 * (me.share / 100)))} tone="" />
                  </div>
                ))}
                <div className="divider" />
                <div className="small" style={{ color: 'var(--text-dim)' }}>
                  我的配额占全平台 {(me.share / 100).toFixed(1)}%；本人调用全部进入调用审计检索，可按账号 <span className="mono">{acc?.id}</span> 与凭证 {mine.map((c) => c.id).join(' / ')} 追溯六节点链路。
                </div>
              </>
            ) : <Callout text="无有效凭证配额，暂无个人用量。申请凭证并发放后即可在此看到按配额拆分的个人用量。" />}
          </div>
        </Panel>
      </div>

      <Panel title="接入指导与可用能力" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={900}
            head={['能力端点', '用途', '我的可用性', '限额与要求']}
            rows={gatewayEndpoints.map((e, i) => [
              <span className="mono small strong">{e.api}</span>,
              <span className="small">{e.desc}</span>,
              mine.some((c) => c.status !== 'off') ? <Badge tone={i < 4 ? 'good' : 'warn'}>{i < 4 ? '可申请调用' : '需单位授权'}</Badge> : <Badge tone="muted">需先申请凭证</Badge>,
              <span className="tiny faint">{i < 4 ? `今日 ${e.today} 次调用 · 个人密钥在 ${60 * (i + 1)} RPM 内可用 · 须带业务用途说明` : '批量与离线任务仅平台代理凭证可调用'}</span>,
            ])}
          />
          <Callout text="个人视角与组织视角同源：本页凭证、配额、用量与「模型中心 · 凭证与配额」「运营分析」完全一致。个人密钥默认低配额 120 RPM 上限，提额须审批；调用日志与提示词不对外暴露，可按账号追溯。" />
        </div>
      </Panel>

      {mineOrders.length > 0 ? (
        <Panel title="我的工单与兑换记录" extra="含凭证申请、提额兑换与吊销申请" className="mt14" noPad>
          <div className="panel-body">
            <Table
              minWidth={900}
              head={['工单', '类型', '对象与数量', '状态', '轨迹']}
              rows={mineOrders.map((o) => [
                <span className="mono small strong">{o.id}</span>,
                <span className="small">{o.title.split(' · ')[0]}</span>,
                <span className="small">{o.target}<div className="tiny faint">{o.amount}</div></span>,
                <State s={o.status === 'submitted' ? 'pending' : o.status === 'queued' ? 'queued' : o.status === 'running' ? 'run' : o.status === 'rejected' ? 'block' : o.status === 'rolled_back' ? 'rollback' : 'closed'} />,
                <span className="tiny faint" style={{ maxWidth: 320 }}>{o.trace.map((t) => t.action).join(' → ')}{o.rejectReason ? ` · 驳回：${o.rejectReason}` : ''}</span>,
              ])}
            />
            {mineOrders.some((o) => o.status === 'submitted') && canApprove ? (
              <div className="row gap6" style={{ marginTop: 10 }}>
                <span className="small faint">当前角色可审批：</span>
                {mineOrders.filter((o) => o.status === 'submitted').map((o) => <button key={o.id} className="btn sm primary" onClick={() => engine.approve(o.id)}>通过 {o.id}</button>)}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
