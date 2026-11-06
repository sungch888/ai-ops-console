/* =====================================================================
 * 处置指令台（v3.6 · 安全控制指令框架）
 *   框架：选目标 → dry-run 预检（算影响面，不产生任何外部调用）→ 二次确认下发 → 设备确认 / 失败
 *         → 超时未确认自动转「待人工兜底」并出兜底工单 → 反向指令回滚
 *   本期不接真实设备：目标都是虚拟模拟对象；控制接口的调用方式等客户方给材料后按同一框架接
 *   权限拆三档：security（看事件）/ security_issue（日常下发）/ security_emergency（紧急下发，不受变更窗口限制）
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Badge, Callout, Kpi, Panel, PageHead, Table } from '../../components/ui'
import { COMMAND_ACTIONS, TARGET_CLASSES, consoleStore, useConsole } from '../../engine/console'
import { flagsStore, usePerm } from '../../engine/auth'

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'> = {
  草稿: 'muted', 预检通过: 'info', 已下发: 'warn', 设备已确认: 'good', 失败: 'bad', 已回滚: 'muted', 待人工兜底: 'bad',
}

export default function OpsCommands() {
  const cons = useConsole()
  const viewPerm = usePerm('security')
  const issuePerm = usePerm('security_issue')
  const emgPerm = usePerm('security_emergency')
  const [cls, setCls] = useState(TARGET_CLASSES[0])
  const [act, setAct] = useState(COMMAND_ACTIONS[0])
  const [target, setTarget] = useState('hp')
  const [emergency, setEmergency] = useState(false)
  const [impact, setImpact] = useState<any | null>(null)
  const [preId, setPreId] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const cfg = flagsStore.get().config

  useEffect(() => { void consoleStore.refresh() }, [])

  const say = (ok: boolean, text: string) => setMsg({ ok, text })

  const dryRun = async () => {
    setBusy(true); setMsg(null)
    const r = await consoleStore.dryRun({ target_class: cls, target, action: act })
    setBusy(false)
    if (!r.ok) { setImpact(null); setPreId(''); say(false, '预检被拒：' + (r.error || '')); return }
    setImpact(r.impact); setPreId(r.id || '')
    say(true, '预检通过（演练模式，未产生外部调用）：影响 ' + ((r.impact && r.impact.affected_count) || 0) + ' 项，指令号 ' + r.id)
  }
  const issue = async () => {
    if (!preId) return
    setBusy(true); setMsg(null)
    const r = await consoleStore.issue(preId, emergency)
    setBusy(false)
    if (!r.ok) { say(false, '下发被拒：' + (r.error || '')); return }
    say(true, '已下发 ' + preId + '（等设备确认；超过 ' + (cfg['command-ack-timeout-min'] || '30') + ' 分钟未确认会自动转人工兜底）')
    setPreId(''); setImpact(null)
  }

  const cmdRows = cons.commands.map((c) => [
    <span className="tiny mono">{c.id}{c.rollback_of ? <span className="faint tiny"> ← {c.rollback_of}</span> : null}</span>,
    <span className="small">{c.target_class}<span className="tiny faint"> / {c.target || '不限'}</span></span>,
    <span className="small">{c.action}</span>,
    <span>{c.dry_run ? <Badge tone="purple">dry-run</Badge> : null}<Badge tone={STATUS_TONE[c.status] || 'info'}>{c.status}</Badge>{c.emergency ? <Badge tone="bad">紧急</Badge> : null}</span>,
    <span className="tiny">{c.issued_by || '—'}<br /><span className="faint tiny mono">{(c.issued_at || c.created_at || '').replace('T', ' ').replace('Z', '')}</span></span>,
    <span className="tiny">{c.ack_at ? ('已确认 ' + (c.ack_by || '')) : (c.fail_reason ? <span style={{ color: '#ff9a9a' }}>{c.fail_reason}</span> : '未确认')}</span>,
    <span className="row gap6">
      <button className="btn sm ghost" disabled={!issuePerm.manage || c.status !== '已下发'} onClick={() => void consoleStore.ack(c.id, true).then((r) => r.ok ? say(true, c.id + ' 设备已确认') : say(false, '被拒：' + (r.error || '')))}>模拟设备确认</button>
      <button className="btn sm ghost" disabled={!issuePerm.manage || c.status !== '已下发'} onClick={() => void consoleStore.ack(c.id, false, '设备侧拒绝（演练）').then((r) => r.ok ? say(true, c.id + ' 失败，已生成人工兜底工单') : say(false, '被拒：' + (r.error || '')))}>模拟失败</button>
      <button className="btn sm ghost" disabled={!issuePerm.manage || !['已下发', '设备已确认', '失败', '待人工兜底'].includes(c.status)} onClick={() => void consoleStore.rollback(c.id).then((r) => r.ok ? say(true, '已生成反向指令 ' + r.rollback_id) : say(false, '被拒：' + (r.error || '')))}>回滚</button>
    </span>,
  ])

  const fbRows = cons.fallbacks.map((f) => [
    <span className="tiny mono">{f.id}</span>,
    <span className="small">{f.title}</span>,
    <span className="tiny faint">{f.detail || '—'}</span>,
    <span>{f.status === '已接管' ? <Badge tone="warn">已接管</Badge> : f.status === '已关闭' ? <Badge tone="good">已关闭</Badge> : <Badge tone="bad">待接管</Badge>}</span>,
    <span className="tiny">{f.owner || '—'}</span>,
    <span className="row gap6">
      <button className="btn sm ghost" disabled={!viewPerm.manage || f.status !== '待接管'} onClick={() => void consoleStore.claimFallback(f.id, '已接管').then((r) => r.ok ? say(true, f.id + ' 已接管（人工处置）') : say(false, '被拒：' + (r.error || '')))}>人工接管</button>
      <button className="btn sm ghost" disabled={!viewPerm.manage || f.status === '已关闭'} onClick={() => void consoleStore.claimFallback(f.id, '已关闭').then((r) => r.ok ? say(true, f.id + ' 已关闭') : say(false, '被拒：' + (r.error || '')))}>关闭</button>
    </span>,
  ])

  const pre = impact && impact.precheck ? Object.entries(impact.precheck as Record<string, boolean>) : []

  return (
    <>
      <PageHead title="处置指令台 · 预检 / 下发 / 确认 / 回滚 / 人工兜底" desc="本期不接真实设备：同一套指令框架先把流程与留痕跑通，设备控制接口到位后按同样接口接" />

      <div className="grid g-4">
        <Kpi label="指令总数" value={String(cons.commands.length)} foot="含 dry-run 与已下发" />
        <Kpi label="等设备确认" value={String(cons.commands.filter((c) => c.status === '已下发').length)} foot={'超时线 ' + (cfg['command-ack-timeout-min'] || '30') + ' 分钟'} />
        <Kpi label="待人工兜底" value={String(cons.fallbacks.filter((f) => f.status === '待接管').length)} foot="失败或超时自动生成" />
        <Kpi label="你的处置权" value={emgPerm.manage ? '可紧急下发' : issuePerm.manage ? '可日常下发' : viewPerm.view ? '只能看' : '无'} foot="判定在服务端，改前端没用" />
      </div>

      {msg ? <div className="mt14"><Callout warn={!msg.ok} text={msg.text} /></div> : null}

      <Panel title="下一条指令（先预检，再确认下发）" className="mt14">
        <div className="row gap6 wrap">
          <select className="btn sm" style={{ minWidth: 170 }} value={cls} onChange={(e) => setCls(e.target.value)} disabled={!issuePerm.manage}>
            {TARGET_CLASSES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="btn sm" style={{ minWidth: 170 }} value={act} onChange={(e) => setAct(e.target.value)} disabled={!issuePerm.manage}>
            {COMMAND_ACTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="btn sm" style={{ width: 170 }} value={target} placeholder="目标（池 / 凭证 / 通道编号）" onChange={(e) => setTarget(e.target.value)} disabled={!issuePerm.manage} />
          <button className="btn sm primary" disabled={!issuePerm.manage || busy} onClick={() => void dryRun()}>{busy ? '预检中…' : '① 先做 dry-run 预检'}</button>
        </div>

        {impact ? (
          <div className="mt14">
            <div className="tiny strong">影响面清单（由平台台账推导，不是设备侧真实数据）：共 {impact.affected_count} 项</div>
            <Table minWidth={620} head={['台账类型', '编号', '名称']} rows={(impact.affected || []).slice(0, 12).map((a: any) => [
              <span className="tiny">{a.kind}</span>, <span className="tiny mono">{a.id}</span>, <span className="small">{a.name || '—'}</span>,
            ])} />
            <div className="row gap6 wrap" style={{ marginTop: 10 }}>
              {pre.map(([k, v]) => <Badge key={k} tone={v ? 'good' : 'bad'}>{k}：{v ? '通过' : '不通过'}</Badge>)}
              <Badge tone="muted">{impact.derived_from}</Badge>
            </div>
            <div className="row gap6 wrap" style={{ marginTop: 12 }}>
              <label className="row gap6 tiny">
                <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} disabled={!emgPerm.manage} />
                走紧急通道（不受变更窗口限制，需要「紧急处置」权限）
              </label>
              <button className="btn primary sm" disabled={!issuePerm.manage || busy || (emergency && !emgPerm.manage)} onClick={() => void issue()}>② 看过影响面，确认下发</button>
              <span className="tiny faint">没有这一步「确认下发」点不动：服务端要求二次确认，且必须已有预检记录。</span>
            </div>
          </div>
        ) : (
          <div className="tiny faint" style={{ marginTop: 10 }}>
            还没做预检。口径：任何处置指令都要先算影响面（哪些凭证 / 模型副本 / 纳管对象 / 通道会被牵连），预检不过不能下发。
            dry-run 只算不发，不产生任何外部调用。
          </div>
        )}
      </Panel>

      <Panel title="指令台账（下发前预检 / 下发后确认 / 反向指令回滚）" className="mt14" noPad>
        <div className="panel-body">
          {cons.error ? <Callout warn text={cons.error} /> : null}
          {cons.commands.length === 0 ? <div className="tiny faint">当前没有指令记录。</div> : (
            <Table minWidth={1180} head={['指令号', '目标类型 / 目标', '动作', '状态', '下发人 / 时间', '设备确认', '操作']} rows={cmdRows} />
          )}
          <div className="tiny faint" style={{ marginTop: 8 }}>
            状态机：草稿 → 预检通过 → 已下发 →（设备已确认 / 失败 / 待人工兜底）→ 已回滚。
            「模拟设备确认 / 模拟失败」是演示用的模拟：真实环境由设备侧回执经对接接口回写，回写幂等（同一指令号同一结果只生效一次）。
          </div>
        </div>
      </Panel>

      <Panel title="人工兜底工单（设备不认、接口没接、超时未确认，都先由我们接住）" className="mt14" noPad>
        <div className="panel-body">
          {cons.fallbacks.length === 0 ? <div className="tiny faint">当前没有兜底工单：一次下发失败或一次超时未确认就会自动生成。</div> : (
            <Table minWidth={1080} head={['工单号', '标题', '说明', '状态', '接管人', '操作']} rows={fbRows} />
          )}
          <div className="tiny faint" style={{ marginTop: 8 }}>
            兜底工单来源三类：指令下发失败、超时未获设备确认（{cfg['command-ack-timeout-min'] || '30'} 分钟，可在配置中心改）、审批超时未回写。
            每一张都会在事件流与审计里留一条记录，不会只在界面上闪一下。
          </div>
        </div>
      </Panel>
    </>
  )
}
