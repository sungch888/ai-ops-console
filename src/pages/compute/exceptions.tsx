/* =====================================================================
 * 算力资源例外监控与阻断
 * 口径：阻断 = 切断「例外接入来源」（接入通道 / 凭证 / 应用调用入口 / 目录入口）
 *      资源本身不停、不回收、不下线；动资源走「资源侧缓解」并进变更窗口
 * 闭环：处置 → 自动开整改单派给当班角色 → 接单 / 整改 / 复核 → 复核通过才允许恢复接入
 * ===================================================================== */
import React, { useEffect, useState } from 'react'
import {Kpi, Panel, PageHead, Badge, AlertBadge, Table, Callout, Tip} from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { Link } from 'react-router-dom'
import { monitorStore, monitorSummary, exceptions, MONITOR_RULES, type ExcView, type BlockAction } from '../../engine/exceptions'
import { rectifyStore, dutyRosterView, dutyRoutesLive, useRectify } from '../../engine/rectify'
import { consoleStore, useConsole } from '../../engine/console'
import { connectorStore } from '../../engine/connectors'
import { BLOCK_SCOPES, useEngine, engine, poolUtil } from '../../engine/engine'
import { usePerm } from '../../engine/auth'
import { useAlertPick, usePickFlash, Jump } from '../../engine/alertJump'

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'
const SEV_TONE: Record<string, 'bad' | 'warn' | 'info'> = { 紧急: 'bad', 高: 'warn', 中: 'info' }
/** 严重度里要人立即动手的两档（紧急 / 高）才做成可点徽章；「中」是分级不是告警 */
const SEV_ALERT: Record<string, 'warn' | 'bad'> = { 紧急: 'bad', 高: 'warn' }
const STATUS_TONE: Record<string, Tone> = { 待分析: 'bad', 已阻断: 'warn', 已缓解: 'info', 已放行: 'muted' }
/** 还没闭环、要人接着办的状态（待分析 / 已阻断）才做成可点徽章 */
const STATUS_ALERT: Record<string, 'warn' | 'bad'> = { 待分析: 'bad', 已阻断: 'warn' }
const RECT_TONE: Record<string, Tone> = { 已升级: 'bad', 待接单: 'warn', 整改中: 'info', 待复核: 'purple', 已关闭: 'good' }
/** 整改单里在喊「要有人动手」的状态：已升级（超时没人接单）/ 待接单（还没人接） */
const RECT_ALERT: Record<string, 'warn' | 'bad'> = { 已升级: 'bad', 待接单: 'warn' }

export default function ComputeExceptions() {
  const list = exceptions()
  const st = useEngine()
  const sum = monitorSummary()
  const rect = useRectify()
  const cons = useConsole()
  const dutyRoster = dutyRosterView()
  const dutyRoutes = dutyRoutesLive()
  const perm = usePerm('compute')
  const [sel, setSel] = useState('')
  const pick = useAlertPick()          // 从任何红/黄告警点过来：?pick=<例外 key>
  usePickFlash(pick)
  /* 本页主键 = 例外 key（与 Jump.exceptionKey 同一口径）。
     本页的红 / 黄徽章点了以后：既把 ?pick=<key> 写进地址（高亮 + 滚到中间），也立刻把这条载进右边「分析与处置」面板 */
  const excJump = (key: string, label: string) => Jump.exceptionKey(key, label)
  const openExc = list.filter((e) => e.status === '待分析')
  const urgentExc = openExc.find((e) => e.severity === '紧急') ?? openExc[0]
  const blockedExc = list.find((e) => e.status === '已阻断')
  const escRect = rect.find((r) => r.status === '已升级') ?? rect.find((r) => r.status !== '已关闭' && r.dueAt < Date.now())
  const [note, setNote] = useState('')
  const [scope, setScope] = useState('来源 IP')
  const [scopeValue, setScopeValue] = useState('10.42.7.18')
  const [rectNote, setRectNote] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  useEffect(() => { if (pick) setSel(pick) }, [pick])
  const cur = list.find((e) => e.key === sel || e.key === pick) ?? list[0]
  const curRect = cur ? rectifyStore.for(cur.key) : undefined
  const curConn = cur?.ref?.connectorId ? connectorStore.find(cur.ref.connectorId) : undefined
  const settings = monitorStore.settings()
  const duty = rectifyStore.settings()
  const blockOrders = st.orders.filter((o) => o.type === 'access_block' || o.type === 'access_restore')
  const cutActions = cur ? cur.options.filter((o) => o.kind === '阻断接入') : []
  const softActions = cur ? cur.mitigations.filter((o) => o.kind === '资源侧缓解') : []
  const guides = [...(cur?.options ?? []), ...(cur?.mitigations ?? [])].filter((o) => o.kind === '整改引导')

  useEffect(() => {
    consoleStore.refresh()          // 排班 / 派单映射从服务端读
    monitorStore.scanAndRaise()
    if (settings.intervalSec <= 0) return
    const t = setInterval(() => monitorStore.scanAndRaise(), settings.intervalSec * 1000)
    return () => clearInterval(t)
  }, [settings.intervalSec])

  const barOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: GRID,
    xAxis: { type: 'category', data: sum.byKind.map((k) => k.kind), axisLabel: { color: AXIS_COLOR, fontSize: 11 } },
    yAxis: { type: 'value', name: '例外数', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '未闭环', type: 'bar', stack: 'a', barWidth: 26, data: sum.byKind.map((k) => k.open) },
      { name: '已处置', type: 'bar', stack: 'a', data: sum.byKind.map((k) => k.n - k.open) },
    ],
  }

  const doAction = (action: BlockAction, label: string, kind: string, patch?: { scope?: string; value?: string }) => {
    const r = monitorStore.block(cur.key, action, '例外监控', patch)
    if (!r.ok) { setMsg({ tone: 'bad', text: `「${label}」未执行：${r.reason}` }); return }
    if ('pending' in r && r.pending) {
      setMsg({ tone: 'good', text: `已提交${kind === '阻断接入' ? '接入阻断' : '资源侧缓解'}工单 ${'orderId' in r ? r.orderId : ''}，进入变更窗口队列等待执行；执行完成后才记入处置与整改记录（接入侧止损不受窗口限制，立即执行）。` })
      return
    }
    setMsg({
      tone: 'good',
      text: kind === '阻断接入'
        ? `已切断接入来源：「${label}」${'orderId' in r && r.orderId ? ` · 工单 ${r.orderId}（${(r as { status?: string }).status}）` : ''} · 资源未停用 · 已自动开整改单派给当班角色，复核通过前不允许恢复接入。`
        : `已做资源侧缓解：「${label}」${'orderId' in r && r.orderId ? ` · 工单 ${r.orderId}（${(r as { status?: string }).status}）` : ''} · 接入来源未切断，状态记为「已缓解」，仍需整改闭环。`,
    })
  }

  const poolRows = st.pools.map((p) => {
    const u = poolUtil(st, p.id)
    return [
      <span className="small strong">{p.name}</span>,
      <span className="num">{p.cards} 卡</span>,
      <div style={{ minWidth: 150 }}><span className="num small">{u}%</span>{u >= 92 ? <AlertBadge tone={u >= 98 ? 'bad' : 'warn'} jump={{ page: '/compute/schedule', pick: `pool-${p.id}`, label: `${p.name} 利用率 ${u}% 已触阈值：去算力排布这一行做回收 / 抢占 / 扩容（资源侧缓解走变更窗口，不在本页切接入）` }}>触阈值</AlertBadge> : <Badge tone="muted">正常</Badge>}</div>,
      <span className="tiny faint">{p.policy}</span>,
      <span className="tiny faint">{p.sla}</span>,
    ]
  })

  const probeRows = sum.probes.map((p) => [
    <span className="small strong">{p.label}</span>,
    <span className="tiny" style={{ maxWidth: 240 }}>{p.name}<div className="tiny faint">归口 {p.owner} · 就绪缺 {p.miss} 项</div></span>,
    p.enabled && p.health === 'fault' ? <AlertBadge tone="bad" jump={Jump.connector(p.id, `检测数据源「${p.name}」已断开：去外部对接清单这一行重新启用它（依赖它的检出项会随之回来）`)}>已断开</AlertBadge> : <Badge tone={p.enabled ? 'good' : 'muted'}>{p.enabled ? '已接入喂数' : '未接入'}</Badge>,
    <span className="tiny faint">{p.enabled ? '本轮起产出检出结果（演示为模拟喂数）' : '这三类旁路目前检不到'}</span>,
    perm.manage ? <button className={`btn sm ${p.enabled ? 'ghost' : ''}`} onClick={() => {
      connectorStore.setProbe(p.id, !p.enabled)
      monitorStore.scanAndRaise()
      setMsg({ tone: 'good', text: p.enabled ? `${p.label}已断开：依赖它的检出项随之消失（可以看到监控覆盖边界）` : `${p.label}已接入：下一轮扫描会多出它检出的旁路` })
    }}>{p.enabled ? '断开数据源' : '接入数据源'}</button> : <span className="tiny faint">只读</span>,
  ])

  const rectRows = rect.map((r) => {
    const left = Math.round((r.dueAt - Date.now()) / 60000)
    const val = rectNote[r.key] ?? ''
    return [
      <span className="small strong">{r.excKind}<div className="tiny faint" style={{ maxWidth: 240 }}>{r.target}</div></span>,
      <span className="tiny">{r.actionLabel}<div className="tiny faint mono">{r.orderId ?? '无工单'}</div></span>,
      <span className="tiny">{r.role}<div className="tiny faint">{r.assignee} · {r.phone}</div></span>,
      RECT_ALERT[r.status] ? <AlertBadge tone={RECT_ALERT[r.status]} jump={excJump(r.key, `整改单「${r.status}」（${r.excKind} · ${r.target} → ${r.assignee}）：点过去落到这一行，接单 / 提交复核 / 复核通过都在这一行`)}>{r.status}</AlertBadge> : <Badge tone={RECT_TONE[r.status] ?? 'info'}>{r.status}</Badge>,
      <span className="tiny faint mono">{left > 0 ? `剩 ${left} 分` : `超期 ${-left} 分`}</span>,
      <div className="col gap6" style={{ minWidth: 280 }}>
        <div className="row gap6">
          {(r.status === '待接单' || r.status === '已升级') ? <button className="btn sm" disabled={!perm.manage} onClick={() => { rectifyStore.ack(r.key); setMsg({ tone: 'good', text: `${r.assignee} 已接单，整改单进入「整改中」` }) }}>接单</button> : null}
          {(r.status === '整改中' || r.status === '已升级') ? <button className="btn sm ghost" disabled={!perm.manage} onClick={() => { const res = rectifyStore.submitReview(r.key, val || '整改已完成，附核验依据'); setMsg({ tone: res.ok ? 'good' : 'bad', text: res.ok ? '已提交复核，等值班长结论；复核通过后才允许提交恢复工单' : `提交失败：${res.reason}` }) }}>提交复核</button> : null}
          {r.status === '待复核' ? <>
            <button className="btn sm" disabled={!perm.manage} onClick={() => { const res = rectifyStore.review(r.key, true, val || '核对整改依据一致，同意闭环'); setMsg({ tone: res.ok ? 'good' : 'bad', text: res.ok ? '复核通过并关闭：现在可以提交恢复工单（引擎仍会再做就绪校验）' : `复核失败：${res.reason}` }) }}>复核通过</button>
            <button className="btn sm ghost" disabled={!perm.manage} onClick={() => { const res = rectifyStore.review(r.key, false, val || '依据不足，退回补充'); setMsg({ tone: res.ok ? 'good' : 'bad', text: res.ok ? `复核退回 ${r.assignee}，整改期限顺延 ${duty.dueMin} 分钟` : `复核失败：${res.reason}` }) }}>复核退回</button>
          </> : null}
        </div>
        <input className="btn sm" style={{ width: '100%' }} disabled={!perm.manage} value={val} placeholder={r.status === '待复核' ? '复核结论与依据' : '整改进展 / 复核结论'} onChange={(e) => setRectNote({ ...rectNote, [r.key]: e.target.value })} />
        {(r.status === '整改中' || r.status === '已升级') ? <button className="btn sm ghost" disabled={!perm.manage} onClick={() => { const res = rectifyStore.progress(r.key, val); setMsg({ tone: res.ok ? 'good' : 'bad', text: res.ok ? '整改进展已写入台账（复核人可追溯）' : `写入失败：${res.reason}` }) }}>记整改进展</button> : null}
        <div className="tiny faint" style={{ maxWidth: 320 }}>{r.log.slice(0, 2).map((l, i) => <div key={i}>{l.time} {l.actor}：{l.text}</div>)}</div>
      </div>,
    ]
  })

  return (
    <div>
      <PageHead
        title="算力资源例外监控与阻断"
        desc="阻断切的是例外接入来源（通道 / 凭证 / 应用调用入口 / 目录入口）· 处置后自动派整改单，复核通过才允许恢复接入"
        extra={
          <>
            {openExc.length ? <AlertBadge tone="bad" jump={excJump(openExc[0].key, `未闭环的第一条例外【${openExc[0].kind}】${openExc[0].target}（${openExc[0].severity}）：点过去落到这一行分析 / 阻断`)}>未闭环 {sum.open}</AlertBadge> : <Badge tone="good">未闭环 0</Badge>}
            {blockedExc ? <AlertBadge tone="warn" jump={excJump(blockedExc.key, `已阻断接入的第一条【${blockedExc.kind}】${blockedExc.target}：点过去落到这一行看整改单与恢复接入的前提`)}>已阻断接入 {sum.blocked}</AlertBadge> : <Badge tone="muted">已阻断接入 0</Badge>}
            <Badge tone="purple">整改单未闭环 {sum.rect.open}</Badge>
            <Badge tone="info">第 {sum.round} 轮 · {sum.lastScanAt}</Badge>
            <button className="btn sm" disabled={!perm.manage} onClick={() => { const n = monitorStore.scanAndRaise(); setMsg({ tone: 'good', text: `已扫描一轮：新增报警 ${n} 项 · 超时未接单累计升级 ${rectifyStore.stats().escalated} 张` }) }}>立即扫描一轮</button>
          </>
        }
      />

      <Callout warn text="两条口径：① 阻断只切断这条例外的接入来源（接入通道 / 调用凭证 / 应用调用入口 / 目录入口），算力池、卡位、模型副本、业务都不停不回收；要动资源走「资源侧缓解」，那是变更工单、进变更窗口。② 阻断只是止损：每笔处置自动开整改单派给当班角色，整改闭环并经值班长复核通过后，才允许提交恢复接入工单。" />

      {msg ? (
        <div className={`callout ${msg.tone === 'bad' ? 'warn' : ''}`} style={{ margin: '14px 0 0' }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div>{msg.text}</div>
        </div>
      ) : null}

      <div className="grid g-6" style={{ marginTop: 14 }}>
        <Kpi label="未闭环例外" value={sum.open} unit="项" foot={<>{sum.urgent ? <span className="down">● 紧急 {sum.urgent} 项需立即处置</span> : <span className="up">✔ 无紧急项</span>} · 高 {sum.high} 项</>} jump={urgentExc ? excJump(urgentExc.key, `紧急例外【${urgentExc.kind}】${urgentExc.target}：点过去落到这一行，可切断的接入来源与阻断手段都在这一行`) : undefined} />
        <Kpi label="已阻断接入" value={sum.blocked} unit="项" foot={`其中部分阻断 ${sum.partial.length} 条 · 资源侧缓解 ${sum.mitigated} 项 · 工单可回滚`} jump={blockedExc ? excJump(blockedExc.key, `已阻断的第一条【${blockedExc.kind}】${blockedExc.target}：点过去落到这一行看恢复接入的前提（整改复核通过才允许恢复）`) : undefined} />
        <Kpi label="整改单未闭环" value={sum.rect.open} unit="张" foot={`待接单 ${sum.rect.wait} · 整改中 ${sum.rect.doing} · 待复核 ${sum.rect.review} · 已关闭 ${sum.rect.closed}`} jump={sum.rect.wait ? excJump(rect.find((r) => r.status === '待接单')!.key, `还有 ${sum.rect.wait} 张整改单没人接单：点过去落到这一行「接单」按钮所在的地方`) : undefined} />
        <Kpi label="超时升级 / 超期" value={sum.rect.escalated + sum.rect.overdue} unit="张" foot={`接单时限 ${duty.responseMin} 分 · 整改期限 ${duty.dueMin} 分 · 升级至值班长`} jump={escRect ? excJump(escRect.key, `超时升级 / 超期的整改单【${escRect.excKind}】${escRect.target} → ${escRect.assignee}：点过去落到这一行接着办（接单 / 提交复核都在这一行）`) : undefined} />
        <Kpi label="旁路类 / 接管缺口" value={sum.bypass + sum.gap} unit="项" foot={`旁路 ${sum.bypass} · 缺口 ${sum.gap} · 检测数据源 ${sum.probesOn}/3 已接入`} />
        <Kpi label="后台轮扫" value={settings.intervalSec > 0 ? settings.intervalSec : '手动'} unit={settings.intervalSec > 0 ? '秒/轮' : ''} foot={`已扫 ${sum.round} 轮 · 上次 ${sum.lastScanAt} · 自动阻断${settings.autoBlockUrgent ? '已开' : '未开'}`} />
      </div>

      <div className="row gap6" style={{ margin: '14px 0 10px' }}>
        <button className="btn sm ghost" disabled={!perm.manage} onClick={() => { const r = monitorStore.seedBypass(); setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `已造例：${r.name}（未登记 GPU 直连，已启用）→ 下一轮扫描报「旁路接入 · 紧急」，可当场阻断这条接入` : r.reason }) }}>造一条旁路接入（演示）</button>
        <button className="btn sm ghost" disabled={!perm.manage} onClick={() => {
          const r = engine.submit({ type: 'pool_release', applicant: '例外监控', dept: '运营', level: '高保', reason: '演示：回收高保池空闲卡位，触发卡位吃紧例外', spec: { pool: 'hp', cards: 2 } })
          if (!r.precheck.ok) { setMsg({ tone: 'bad', text: `造例未成立：${r.precheck.reason}` }); return }
          engine.get().orders.filter((o) => o.status === 'running').forEach((o) => engine.close(o.id))
          engine.approve(r.order.id); engine.execute(r.order.id)
          monitorStore.scanAndRaise()
          const hp = engine.get().pools.find((p) => p.id === 'hp')!
          setMsg({ tone: 'good', text: `已造例：${hp.name} 回收至 ${hp.cards} 卡 · 利用率 ${poolUtil(engine.get(), 'hp')}% → 可用手段是「限流凭证 / 限流应用 / 阻断外部渠道」，不是停这个池` })
        }}>造一次卡位吃紧（演示）</button>
        <span className="small faint">造例只用于演示检出与闭环；真实环境的例外来自实际采集。</span>
      </div>

      <div className="grid g-21">
        <Panel title="例外台账" extra={`${list.length} 项 · 「可切断的接入来源」就是要切的地方`} noPad>
          <div className="panel-body">
            <Table
              minWidth={1300}
              head={['严重度', '例外类型', '例外（对象 / 证据）', '可切断的接入来源', '可用阻断手段', '状态', '整改单', '处置']}
              rowKeys={list.map((e: ExcView) => e.key)} pick={sel || pick}
              rows={list.map((e: ExcView) => {
                const rc = rectifyStore.for(e.key)
                return [
                  <span onClick={() => setSel(e.key)}>{SEV_ALERT[e.severity] ? <AlertBadge tone={SEV_ALERT[e.severity]} jump={excJump(e.key, `这条例外是「${e.severity}」级【${e.kind}】${e.target}：点过去选中这一行，可切断的接入来源与阻断手段就在这一行`)}>{e.severity}</AlertBadge> : <Badge tone={SEV_TONE[e.severity]}>{e.severity}</Badge>}</span>,
                  <span className="tag gray">{e.kind}</span>,
                  <span className="small strong" style={{ maxWidth: 300 }}>{e.target}<div className="tiny faint">{e.evidence.slice(0, 2).map((x, i) => <div key={i}>{x}</div>)}</div></span>,
                  <span className="tiny" style={{ maxWidth: 240 }}>{e.sources.length ? e.sources.slice(0, 2).map((s, i) => <div key={i}>{s.label}</div>) : <span className="faint">—（已处置）</span>}</span>,
                  <span className="tiny">{e.options.filter((o) => o.kind === '阻断接入').map((o) => o.label).join(' / ') || <span className="faint">无接入可切断</span>}</span>,
                  <span onClick={() => setSel(e.key)}>{STATUS_ALERT[e.status] ? <AlertBadge tone={STATUS_ALERT[e.status]} jump={excJump(e.key, `这条例外「${e.status}」【${e.kind}】${e.target}：点过去选中这一行，分析 / 阻断 / 恢复接入的入口都在这一行`)}>{e.status}</AlertBadge> : <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>}</span>,
                  rc ? <span onClick={() => setSel(e.key)}>{RECT_ALERT[rc.status] ? <AlertBadge tone={RECT_ALERT[rc.status]} jump={excJump(e.key, `这条例外的整改单「${rc.status}」（派给 ${rc.assignee}）：点过去选中这一行，下面的整改台账里接单 / 复核`)}>{rc.status}<div className="tiny faint">{rc.assignee.split('（')[0]}</div></AlertBadge> : <Badge tone={RECT_TONE[rc.status] ?? 'info'}>{rc.status}<div className="tiny faint">{rc.assignee.split('（')[0]}</div></Badge>}</span> : <span className="tiny faint">—</span>,
                  perm.manage ? (
                    <div className="row gap6">
                      <button className="btn sm" onClick={() => { setSel(e.key); setMsg(null) }}>分析</button>
                      {e.status === '待分析' && e.options.some((o) => o.kind === '阻断接入')
                        ? <button className="btn sm danger" onClick={() => { const o = e.options.find((x) => x.kind === '阻断接入')!; setSel(e.key); doAction(o.action, o.label, o.kind) }}>阻断接入</button>
                        : null}
                    </div>
                  ) : <span className="tiny faint">只读</span>,
                ]
              })}
            />
          </div>
        </Panel>

        <div>
          <Panel title={`分析与处置：${cur.target}`} extra={`${cur.kind} · ${cur.severity} · ${cur.status}`} noPad>
            <div className="panel-body">
              <div className="col gap6">
                <div className="small strong">{cur.title}</div>
                <div className="tiny faint">归口 {cur.owner} · 首次 {cur.firstSeen} → 最近 {cur.lastSeen} · 检出 {cur.hits} 次{curConn ? ` · 关联接入 ${curConn.name}` : ''}</div>
                <div className="divider" />
                <div className="small strong">检出证据</div>
                <ul className="tiny" style={{ margin: '6px 0 0 16px', lineHeight: 1.9, color: 'var(--text-dim)' }}>
                  {cur.evidence.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
                <div className="tiny" style={{ color: '#ffc9c9', marginTop: 8 }}>影响：{cur.impact}</div>

                <div className="divider" />
                <div className="small strong">消耗 / 接入来源归因（切哪里）</div>
                {cur.sources.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>该例外已处置，来源视图已归档。</div> : (
                  <div style={{ marginTop: 6 }}>
                    <Table minWidth={520} head={['来源', '归因口径', '线索']} rows={cur.sources.map((s) => [
                      <span className="small strong">{s.label}</span>,
                      <span className="tag gray">{s.from}</span>,
                      <span className="tiny faint">{s.detail}</span>,
                    ])} />
                  </div>
                )}

                {curConn ? (
                  <>
                    <div className="divider" />
                    <div className="small strong">部分阻断（范围可控：只停采集项 / 时段 / 来源 IP）</div>
                    <div className="tiny faint" style={{ marginTop: 4 }}>
                      当前通道：{curConn.name} · {curConn.enabled ? '已启用' : '已停用'} · 健康 {curConn.health}{curConn.blockedScope ? ` · 已有部分阻断：${curConn.blockedScope}：${curConn.blockedValue}` : ' · 无部分阻断'}
                      <div>可停的采集项：{curConn.dataItems}</div>
                    </div>
                    <div className="row gap6 wrap" style={{ marginTop: 6 }}>
                      <select className="btn sm" style={{ minWidth: 110 }} disabled={!perm.manage} value={scope} onChange={(e) => setScope(e.target.value)}>
                        {BLOCK_SCOPES.filter((x) => x !== '全通道').map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      <input className="btn sm" style={{ minWidth: 170 }} disabled={!perm.manage} value={scopeValue} placeholder={scope === '时段' ? '02:00-06:00' : scope === '来源 IP' ? '10.42.7.18' : '采集项名称'} onChange={(e) => setScopeValue(e.target.value)} />
                      <button className="btn sm danger" disabled={!perm.manage} onClick={() => doAction('access_block', `部分阻断（${scope}：${scopeValue}）`, '阻断接入', { scope, value: scopeValue })}>按范围阻断</button>
                      {curConn.blockedScope ? <button className="btn sm ghost" disabled={!perm.manage} onClick={() => doAction('access_restore', '解除部分阻断', '阻断接入')}>解除部分阻断</button> : null}
                    </div>
                    <div className="tiny faint" style={{ marginTop: 4 }}>部分阻断不停这条接入的其余采集，也不停任何算力资源；「全通道阻断」在下面的一键阻断里。</div>
                  </>
                ) : null}

                <div className="divider" />
                <div className="small strong">阻断手段（只切接入，每步生成工单、可回滚）</div>
                {cutActions.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>这条例外没有可切断的接入来源 —— 只能走资源侧缓解或整改引导。</div> : (
                  <div className="col gap6" style={{ marginTop: 6 }}>
                    {cutActions.map((o) => (
                      <div key={o.label} className="row gap6" style={{ alignItems: 'flex-start' }}>
                        <button className="btn sm danger" disabled={!perm.manage} style={{ minWidth: 176 }} onClick={() => doAction(o.action, o.label, o.kind)}>{o.label}</button>
                        <span className="tiny faint" style={{ flex: 1 }}>{o.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="divider" />
                <div className="small strong">资源侧缓解（不是阻断：动资源，走变更窗口）</div>
                {softActions.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>这条例外不需要动资源。</div> : (
                  <div className="col gap6" style={{ marginTop: 6 }}>
                    {softActions.map((o) => (
                      <div key={o.label} className="row gap6" style={{ alignItems: 'flex-start' }}>
                        <button className="btn sm ghost" disabled={!perm.manage} style={{ minWidth: 176 }} onClick={() => doAction(o.action, o.label, o.kind)}>{o.label}</button>
                        <span className="tiny faint" style={{ flex: 1 }}>{o.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {guides.length ? (
                  <>
                    <div className="divider" />
                    <div className="small strong">整改引导（要客户方 / 厂商确认的动作）</div>
                    {guides.map((o) => <div key={o.label} className="tiny" style={{ marginTop: 6 }}><span className="strong">{o.label}：</span>{o.detail}</div>)}
                  </>
                ) : null}

                <div className="divider" />
                <div className="small strong">人工放行（留痕，不阻断）</div>
                <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 48 }} disabled={!perm.manage} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：已确认该站点由属地运维季度巡检覆盖，风险可接受，下一周期复核" />
                <div className="row gap6" style={{ marginTop: 8 }}>
                  <button className="btn sm" disabled={!perm.manage || note.trim().length < 6} onClick={() => {
                    const r = monitorStore.pass(cur.key, note)
                    setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? '已放行并留痕（理由写入审计与事件流，整改单一并撤销）' : `放行失败：${r.reason}` })
                    if (r.ok) setNote('')
                  }}>标记放行</button>
                  <button className="btn sm ghost" onClick={() => { setSel(''); setNote(''); setMsg(null) }}>清空选择</button>
                </div>

                {cur.status === '已阻断' ? <Callout warn text={`这条接入当前处于阻断状态：采集与调用已停，算力资源、模型与业务照常运行；该对象接管深度退回 L1。整改单责任人 ${curRect?.assignee ?? '待派单'}（${curRect?.phone ?? '—'}）· 状态 ${curRect?.status ?? '无'} —— 复核通过后才能提交恢复工单，引擎还会再做一次就绪校验。`} /> : null}
                {cur.status === '已缓解' ? <Callout text="已做资源侧缓解但接入未切断：这条例外仍算未闭环，整改单照常派单与跟踪。" /> : null}
              </div>
            </div>
          </Panel>

          <Panel title="例外分布" className="mt14">
            <Chart option={barOpt} height={200} />
          </Panel>
        </div>
      </div>

      <Panel title="整改闭环台账（处置只是止损，复核通过才算闭环）" className="mt14" noPad>
        <div className="panel-body">
          {rect.length === 0 ? <div className="tiny faint">当前没有整改单：做一次阻断处置就会自动开单并派给对应值班角色。
            <Tip label="派单映射" text="旁路接入 → 网络与接入值班 · 接管缺口 / 资源异常 → 算力资源值班 · 配额越界 → 安全值班 · 旁路调用 / 目录不一致 → 应用与智能体值班（映射在值班派单页可改）" /></div> : (
            <Table minWidth={1260} head={['例外', '处置动作 / 工单', '派给（当班）', '整改状态', '期限', '整改动作与记录']} rowKeys={rect.map((r) => r.key)} pick={pick} rows={rectRows} />
          )}
          <div className="tiny faint" style={{ marginTop: 8 }}>派单口径（可在「配置中心 → 排班与派单」改）：{dutyRoutes.map((r) => `${r.kind} → ${r.duty_role}`).join(' · ')}。超时未接单自动升级到该例外类型设定的升级岗位，超整改期限在台账与事件流里同时标出。</div>
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="值班表与派单时限（排班可配：试运行由建设团队安排）" noPad>
          <div className="panel-body">
            <Table minWidth={720} head={['值班角色', '当班人', '内线', '上级', '负责范围']} rows={dutyRoster.map((r) => [
              <span className="small strong">{r.role}</span>,
              <span className="small">{r.name}</span>,
              <span className="tiny mono">{r.phone}</span>,
              <span className="tiny faint">{r.lead}</span>,
              <span className="tiny">{r.scope}</span>,
            ])} />
            <div className="row gap6 wrap" style={{ marginTop: 10 }}>
              <div>
                <div className="tiny faint">接单时限（超时升级）</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={duty.responseMin} onChange={(e) => rectifyStore.setSettings({ responseMin: Number(e.target.value) })}>
                  <option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={0}>立即（演示用）</option>
                </select>
              </div>
              <div>
                <div className="tiny faint">整改期限</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={duty.dueMin} onChange={(e) => rectifyStore.setSettings({ dueMin: Number(e.target.value) })}>
                  <option value={30}>30 分钟</option><option value={90}>90 分钟</option><option value={480}>8 小时</option><option value={1440}>24 小时</option>
                </select>
              </div>
              <div className="tiny faint" style={{ flex: 1 }}>
                当前统计：待接单 {sum.rect.wait} · 整改中 {sum.rect.doing} · 待复核 {sum.rect.review} · 已关闭 {sum.rect.closed} · 已升级 {sum.rect.escalated} · 超期 {sum.rect.overdue}
                <div>真实环境的值班表与派单通道由客户方值班系统提供，这里是可配置的映射。</div>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="后台监控设置" noPad>
          <div className="panel-body">
            <div className="col gap6">
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">扫描间隔</div>
                  <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={settings.intervalSec} onChange={(e) => monitorStore.setSettings({ intervalSec: Number(e.target.value) })}>
                    <option value={10}>10 秒 / 轮</option><option value={20}>20 秒 / 轮</option><option value={60}>60 秒 / 轮</option><option value={0}>停止轮扫（只手动扫描）</option>
                  </select>
                </div>
                <div>
                  <div className="tiny faint">报警级别下限</div>
                  <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={settings.notifyAll ? '1' : '0'} onChange={(e) => monitorStore.setSettings({ notifyAll: e.target.value === '1' })}>
                    <option value="0">只报紧急与高</option><option value="1">紧急 / 高 / 中都报</option>
                  </select>
                </div>
              </div>
              <label className="row gap6 small">
                <input type="checkbox" disabled={!perm.manage} checked={settings.autoBlockUrgent} onChange={(e) => monitorStore.setSettings({ autoBlockUrgent: e.target.checked })} />
                紧急例外自动阻断接入（默认关闭：先报警，由值班分析后处置）
              </label>
              <div className="tiny faint">报警去向：通知中心 · 投屏汇报首页 · 运营总览事件流。同一例外只报一次；整改单的派单 / 接单 / 复核结论也进事件流。</div>
              <div className="row gap6">
                <button className="btn sm ghost" disabled={!perm.manage} onClick={() => { monitorStore.clearHandled(); setMsg({ tone: 'good', text: '处置记录与整改台账已清空（演示复位用）' }) }}>清空处置与整改记录</button>
                <Link to="/ops/notifications" className="btn sm ghost">去通知中心看报警</Link>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="检测数据源（这三项接不接，决定能检出哪几类旁路）" className="mt14" noPad>
        <div className="panel-body">
          <Table minWidth={900} head={['数据源', '配置与归口', '接入状态', '对检出的作用', '操作']} rows={probeRows} />
          <Callout warn text="平台内可见状态（接入配置 / 接管登记 / 资源账本 / 渠道与凭证）一直在检；上面三项接上之后才会产出对应检出结果。演示版这三项喂的是模拟数据：接入即出现示例旁路，断开即消失，用来演示监控覆盖边界与接口清单。真实环境的字段、网段与留存期在外部接入配置中心按配置商定，不改平台代码。" />
          <div className="row gap6" style={{ marginTop: 10 }}>
            <Link to="/ops/integrations" className="btn sm ghost">去外部接入配置中心看这三条配置</Link>
            <Link to="/govern" className="btn sm ghost">去接管登记册看未纳管设备怎么补登记</Link>
          </div>
        </div>
      </Panel>

      <Panel title="算力池水位（资源异常类的实时依据）" className="mt14" noPad>
        <div className="panel-body">
          <Table minWidth={760} head={['资源池', '卡位', '利用率（阈值 92%）', '保障策略', 'SLA']} rows={poolRows} />
          <div className="row gap6" style={{ marginTop: 10 }}>
            <Link to="/ops/workflow" className="btn sm ghost">去资源调配工作台做回收 / 抢占</Link>
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>这里的回收 / 抢占 / 扩容属于资源侧缓解：走变更窗口，不算阻断；例外监控只负责把超额来源找出来并切断接入。</div>
        </div>
      </Panel>

      <Panel title="监控规则（阈值与「切什么 / 不切什么」写死在这里，便于与客户方确认）" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1100}
            head={['例外类型', '规则', '检测依据', '触发阈值', '阻断切什么', '明确不切什么']}
            rows={MONITOR_RULES.map((r) => [
              <span className="tag gray">{r.kind}</span>,
              <span className="small strong">{r.name}</span>,
              <span className="tiny" style={{ maxWidth: 300 }}>{r.detect}</span>,
              <span className="tiny mono">{r.threshold}</span>,
              <span className="tiny" style={{ maxWidth: 260, color: 'var(--bad-text)' }}>{r.block}</span>,
              <span className="tiny faint" style={{ maxWidth: 220 }}>{r.notBlock}</span>,
            ])}
          />
        </div>
      </Panel>

      <Panel title="处置与整改记录（接入阻断 / 资源缓解 / 人工放行分开留痕）" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1000}
            head={['例外', '处置性质', '处置动作 / 工单', '处置时间', '整改单与说明']}
            rows={list.filter((e) => e.status === '已阻断' || e.status === '已缓解' || e.status === '已放行').map((e) => {
              const rc = rectifyStore.for(e.key)
              return [
                <span className="small strong">{e.kind}<div className="tiny faint">{e.target}</div></span>,
                e.status === '已阻断' ? <AlertBadge tone="warn" jump={excJump(e.key, `这条例外已切断接入但还没闭环【${e.kind}】${e.target}：点过去落到例外台账这一行，看整改单与恢复接入的前提`)}>切断接入</AlertBadge> : <Badge tone={e.status === '已缓解' ? 'info' : 'muted'}>{e.status === '已缓解' ? '资源侧缓解' : '人工放行'}</Badge>,
                <span className="small mono">{e.actionLabel ?? '—'}<div className="tiny faint">{e.orderId ? `工单 ${e.orderId}` : '（无工单）'}</div></span>,
                <span className="tiny faint mono">{e.handledAt ?? e.lastSeen}</span>,
                <span className="tiny" style={{ maxWidth: 340 }}>{rc ? `${rc.status} · ${rc.assignee} · ${rc.log[0]?.text ?? ''}` : (e.note ?? e.impact)}</span>,
              ]
            })}
          />
          {blockOrders.length ? <div className="tiny faint" style={{ marginTop: 8 }}>接入类工单 {blockOrders.length} 笔，均可在「资源调配工作台 · 工单轨迹」里回滚；回滚只把这条接入恢复到处置前状态，资源侧不受影响。</div> : <div className="tiny faint" style={{ marginTop: 8 }}>当前没有接入阻断类工单。</div>}
        </div>
      </Panel>
    </div>
  )
}
