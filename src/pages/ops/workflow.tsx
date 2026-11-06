import React, { useEffect, useState } from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Progress, Callout, State } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import {
  useEngine, engine, poolUtil, freeCards, totalAllocated, totalReplicas, activeCreds,
  TYPE_LABEL, SCENARIO_LABEL, rentInfo, type ScenarioId, type OrderType, type Order, type Level, TOTAL_CARDS,
} from '../../engine/engine'
import { Link } from 'react-router-dom'

const TYPE_OPTS: OrderType[] = ['pool_expand', 'pool_release', 'preempt', 'replica_scale', 'weight_adjust', 'credential_issue', 'credential_revoke', 'quota_adjust']

import { usePerm } from '../../engine/auth'
import { consoleStore, useConsole } from '../../engine/console'

export default function OpsWorkflow() {
  const st = useEngine()
  const rent = rentInfo(st)
  const canApprove = usePerm('approve').manage
  const cons = useConsole()
  useEffect(() => { void consoleStore.refresh() }, [])
  const [type, setType] = useState<OrderType>('pool_expand')
  const [level, setLevel] = useState<Level>('高保')
  const [pool, setPool] = useState<'hp' | 'shared' | 'train'>('hp')
  const [preemptFrom, setPreemptFrom] = useState<'hp' | 'shared' | 'train'>('shared')
  const [cards, setCards] = useState(4)
  const [modelShort, setModelShort] = useState('Qwen3-32B')
  const [delta, setDelta] = useState(2)
  const [weights, setWeights] = useState('60/30/10')
  const [credId, setCredId] = useState('PK-2399')
  const [rpm, setRpm] = useState(120)
  const [kind, setKind] = useState<'个人密钥' | '平台代理'>('平台代理')
  const [channel, setChannel] = useState('ascend')
  const [holder, setHolder] = useState('示例业务六部 · 示例××')
  const [app, setApp] = useState('示例业务六部话术问答助手')
  const [reason, setReason] = useState('')
  const [auto, setAuto] = useState(false)
  const [flash, setFlash] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [sDate, setSDate] = useState(new Date().toISOString().slice(0, 10))
  const [sFrom, setSFrom] = useState('22:00')
  const [sTo, setSTo] = useState('23:30')
  const [sScope, setSScope] = useState<'全平台' | '高保集群' | '共享集群'>('全平台')
  const [sReason, setSReason] = useState('')
  const [scenario, setScenario] = useState<{ title: string; steps: string[] } | null>(null)

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => engine.tickSimulate(), 4000)
    return () => clearInterval(t)
  }, [auto])

  const buildSpec = (): Record<string, number | string> => {
    switch (type) {
      case 'pool_expand': return { pool, cards }
      case 'pool_release': return { pool, cards }
      case 'preempt': return { from: preemptFrom, to: 'hp', cards }
      case 'replica_scale': return { model: modelShort, delta }
      case 'weight_adjust': return { weights: weights.replace(/\//g, ',') }
      case 'credential_issue': return { kind, holder, app, model: channel === 'vendor' ? 'DeepSeek-V3' : channel === 'cambricon' ? 'GLM-4-9B' : 'Qwen3-32B 微调', channel, rpm, tpm: `${Math.round(rpm * 5000 / 10000)}万` }
      case 'credential_revoke': return { credId }
      case 'quota_adjust': return { credId, rpm }
      default: return {}
    }
  }

  const submit = () => {
    const r = engine.submit({ type, applicant: '演示申请 · 业务方', dept: '演示', level, reason: reason || '（未填写业务理由）', spec: buildSpec() })
    if (r.precheck.ok) setFlash({ tone: 'good', text: `${r.order.id} 已提交，准入预检通过：${r.precheck.suggest ?? ''}` })
    else setFlash({ tone: 'bad', text: `${r.order.id} 提交即被准入校验驳回：${r.precheck.reason}${r.precheck.suggest ? ' · ' + r.precheck.suggest : ''}` })
    setReason('')
  }

  const pending = st.orders.filter((o) => o.status === 'submitted')
  const running = st.orders.filter((o) => o.status === 'running')
  const windowOrder = running[0]
  const slots = engine.slotList()
  const activeSlot = engine.activeSlot()
  const queued = st.orders.filter((o) => o.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  const done = st.orders.filter((o) => o.status === 'approved' || o.status === 'closed' || o.status === 'rolled_back')
  const rejected = st.orders.filter((o) => o.status === 'rejected')
  const selectedOrder = st.orders.find((o) => o.status === 'running' || o.status === 'queued' || o.status === 'submitted') ?? st.orders[0]

  const utilOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    legend: { data: ['高保集群', '共享集群', '训练池'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: { type: 'category', boundaryGap: false, data: st.history.map((h) => h.time), axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 11 } },
    yAxis: { type: 'value', name: '利用率 %', max: 120, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '高保集群', type: 'line', smooth: true, symbolSize: 5, data: st.history.map((h) => h.util.hp), lineStyle: { width: 2.4 }, markLine: { silent: true, symbol: 'none', lineStyle: { color: '#ff6b6b', type: 'dashed' }, label: { color: '#ffb3b3', formatter: '告警阈值 90%' }, data: [{ yAxis: 90 }] } },
      { name: '共享集群', type: 'line', smooth: true, symbolSize: 5, data: st.history.map((h) => h.util.shared), lineStyle: { width: 2, color: '#2fd6a3' }, itemStyle: { color: '#2fd6a3' } },
      { name: '训练池', type: 'line', smooth: true, symbolSize: 5, data: st.history.map((h) => h.util.train), lineStyle: { width: 2, color: '#a78bfa' }, itemStyle: { color: '#a78bfa' } },
    ],
  }

  const OrderRow = ({ o }: { o: Order }) => (
    <tr>
      <td>
        <span className="mono small">{o.id}</span>
        {o.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动建议</span> : null}
      </td>
      <td>
        <span className="strong small">{TYPE_LABEL[o.type]}</span>
        <div className="tiny faint">{o.title}</div>
      </td>
      <td className="small">{o.target}<div className="tiny faint">{o.applicant}</div></td>
      <td className="num small">{o.amount}</td>
      <td><span className={`tag ${o.level === '高保' ? 'green' : 'gray'}`}>{o.level}</span></td>
      <td>
        <State s={o.status === 'submitted' ? 'pending' : o.status === 'approved' ? 'pass' : o.status === 'queued' ? 'queued' : o.status === 'rejected' ? 'block' : o.status === 'running' ? 'run' : o.status === 'rolled_back' ? 'rollback' : o.status === 'closed' ? 'closed' : 'done'} />
        {o.status === 'queued' ? <div className="tiny" style={{ color: '#f5b83d' }}>变更队列位次 {queued.findIndex((q) => q.id === o.id) + 1}</div> : null}
        {o.rejectReason ? <div className="tiny" style={{ color: '#ffb3b3', maxWidth: 200 }}>{o.rejectReason}</div> : null}
        {o.type === 'preempt' && o.spec.affected ? <div className="tiny" style={{ color: '#8fb0d6', maxWidth: 220 }}>被抢占：{String(o.spec.affected)}</div> : null}
      </td>
      <td>
        <div className="row gap6" style={{ flexWrap: 'wrap' }}>
          {o.status === 'submitted' ? (
            canApprove ? (
              <>
                <button className="btn sm primary" onClick={() => engine.approve(o.id)}>{windowOrder ? '通过并排队' : '通过并执行'}</button>
                <button className="btn sm danger" onClick={() => engine.reject(o.id, '业务必要性不足，请补充场景与预期并发后重新提交')}>驳回</button>
              </>
            ) : <span className="tiny faint">待审批（当前角色无审批权）</span>
          ) : null}
          {o.status === 'queued' ? (
            canApprove ? <button className="btn sm ghost" onClick={() => engine.reject(o.id, '申请方主动撤回，退出变更窗口队列')}>撤回队列</button> : <span className="tiny faint">排队中</span>
          ) : null}
          {o.status === 'running' ? (
            canApprove ? (
              <>
                <button className="btn sm" onClick={() => engine.rollback(o.id)}>回滚</button>
                <button className="btn sm ghost" onClick={() => engine.close(o.id)}>闭环归档并释放窗口</button>
              </>
            ) : <span className="tiny faint">变更窗口内（当前角色无执行权）</span>
          ) : null}
          {o.status === 'approved' || o.status === 'closed' || o.status === 'rolled_back' || o.status === 'rejected' ? <span className="tiny faint">{o.decidedBy ?? '—'}</span> : null}
        </div>
      </td>
    </tr>
  )

  return (
    <div>
      <PageHead
        title="资源调配工作台"
        desc="申请 → 准入校验 → 审批 → 执行 → 生效验证 → 回收，全过程真实计算与留痕"
        extra={
          <>
            <button className="btn sm" onClick={() => engine.tickSimulate()}>采样一次</button>
            <button className="btn sm" onClick={() => engine.runScenario()}>演示冲击场景</button>
            <button className="btn sm ghost" onClick={() => engine.scanCreds()}>凭证盘点扫描</button>
            <button className="btn sm ghost" onClick={() => setAuto((a) => !a)}>{auto ? '停止自动采样' : '开启自动采样'}</button>
            <button className="btn sm ghost" onClick={() => engine.reset()}>重置演示数据</button>
          </>
        }
      />

      {flash ? <div className={`callout ${flash.tone === 'bad' ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
        <div>{flash.text}</div>
      </div> : null}

      <div className="grid g-8">
        <Kpi label="全局算力卡位" value={TOTAL_CARDS} unit="张" foot={`已分配 ${totalAllocated(st)} · 空闲 ${freeCards(st)}`} />
        <Kpi label="可分配余量" value={freeCards(st)} unit="张" foot={freeCards(st) < 4 ? '接近耗尽，触发扩租评估' : '可用于扩容与副本增加'} />
        <Kpi label="待审批工单" value={pending.length} unit="项" foot={<span className="down">● {pending.filter((o) => o.auto).length} 项自动建议</span>} />
        <Kpi label="执行中变更" value={running.length} unit="项" foot={windowOrder ? `窗口占用：${windowOrder.id}` : '变更窗口空闲'} />
        <Kpi label="变更队列深度" value={queued.length} unit="项" foot={queued.length ? <span className="down">● 串行执行 · 按提交顺序</span> : '无排队工单'} />
        <Kpi label="推理副本" value={totalReplicas(st)} unit="个" foot={`${st.models.length} 个在线模型`} />
        <Kpi label="活跃凭证" value={activeCreds(st)} unit="个" foot={`已闭环 ${done.length} · 已驳回 ${rejected.length}`} />
        <Kpi label="变更窗口" value={activeSlot ? activeSlot.id : '未开放'} unit="" foot={activeSlot ? `${activeSlot.date} ${activeSlot.from}-${activeSlot.to} · ${activeSlot.scope}` : <span className="down">● 窗口外提交的变更将排队顺延</span>} />
      </div>

      <Panel title="变更窗口排期" extra="预约窗口 → 开启窗口（排队工单按序执行）→ 结束窗口（剩余工单顺延至下一预约）" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">预约日期</div>
              <input className="btn sm" style={{ marginTop: 4 }} type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} />
            </div>
            <div>
              <div className="tiny faint">开始</div>
              <input className="btn sm" style={{ marginTop: 4 }} type="time" value={sFrom} onChange={(e) => setSFrom(e.target.value)} />
            </div>
            <div>
              <div className="tiny faint">结束</div>
              <input className="btn sm" style={{ marginTop: 4 }} type="time" value={sTo} onChange={(e) => setSTo(e.target.value)} />
            </div>
            <div>
              <div className="tiny faint">影响范围</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={sScope} onChange={(e) => setSScope(e.target.value as '全平台' | '高保集群' | '共享集群')}>
                <option value="全平台">全平台</option>
                <option value="高保集群">高保集群</option>
                <option value="共享集群">共享集群</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="tiny faint">变更事由</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} value={sReason} onChange={(e) => setSReason(e.target.value)} placeholder="如：夜间窗口内执行共享池扩容与 Qwen2.5-VL 副本调整" />
            </div>
            <button className="btn primary" disabled={!canApprove} onClick={() => {
              const r = engine.bookSlot({ date: sDate, from: sFrom, to: sTo, scope: sScope, reason: sReason, by: '运营值班' })
              setFlash({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `变更窗口 ${r.id} 已预约：${sDate} ${sFrom}-${sTo} · ${sScope}` : `预约失败：${r.reason}` })
            }}>预约变更窗口</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <Table
              minWidth={900}
              head={['窗口编号', '日期与时段', '影响范围', '事由 / 申请人', '状态', '操作']}
              rows={slots.map((x) => [
                <span className="mono small strong">{x.id}</span>,
                <span className="small">{x.date}<div className="tiny faint mono">{x.from} - {x.to}</div></span>,
                <span className="tag gray">{x.scope}</span>,
                <span className="small" style={{ maxWidth: 280 }}>{x.reason}<div className="tiny faint">{x.by}</div></span>,
                x.status === '使用中' ? <Badge tone="good">使用中</Badge> : x.status === '已预约' ? <Badge tone="info">已预约</Badge> : x.status === '已结束' ? <Badge tone="muted">已结束</Badge> : <Badge tone="bad">已取消</Badge>,
                <div className="row gap6">
                  {x.status === '已预约' && canApprove ? <button className="btn sm primary" onClick={() => { const r = engine.openSlot(x.id); setFlash({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `窗口 ${x.id} 已开启 · 排队工单开始按序执行` : `开启失败：${r.reason}` }) }}>开启窗口</button> : null}
                  {x.status === '使用中' && canApprove ? <button className="btn sm" onClick={() => { const r = engine.closeSlot(x.id); setFlash({ tone: 'good', text: `窗口 ${x.id} 已结束 · 剩余排队工单${queued.length ? `顺延至下一预约窗口（当前排队 ${queued.length} 项）` : '（无排队工单）'}` }) }}>结束窗口</button> : null}
                  {x.status === '已预约' && canApprove ? <button className="btn sm ghost" onClick={() => engine.cancelSlot(x.id)}>取消预约</button> : null}
                </div>,
              ])}
            />
          </div>

          <Callout text={activeSlot
            ? `窗口开放中（${activeSlot.id} · ${activeSlot.from}-${activeSlot.to}）：窗口内提交的变更可立即进入执行；同一时刻只允许一项变更执行，其余按提交顺序排队。`
            : `当前无开放变更窗口：新提交的扩容 / 回收 / 抢占 / 副本 / 权重 / 配额类变更会被拒绝执行并排入队列（位次保留），待预约窗口开启后自动按序接续；暂停入库、限流、暂停应用、工具隔离、插件禁用属紧急处置通道，不受窗口限制。`} />
        </div>
      </Panel>

      <Panel title="演示场景包（一键预置）" extra="汇报现场先把平台推到某个可讲解的状态，再逐项拆解" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap6">
            {(Object.keys(SCENARIO_LABEL) as ScenarioId[]).map((id) => (
              <button key={id} className="btn sm primary" disabled={!canApprove} onClick={() => setScenario({ title: SCENARIO_LABEL[id], steps: engine.applyScenario(id).steps })}>{SCENARIO_LABEL[id]}</button>
            ))}
            <button className="btn sm ghost" onClick={() => { engine.reset(); setScenario(null) }}>恢复初始演示数据</button>
          </div>
          {scenario ? (
            <div style={{ marginTop: 12, border: '1px dashed rgba(64,130,220,.35)', borderRadius: 10, padding: 12 }}>
              <div className="small strong">已执行：{scenario.title}</div>
              <ul className="small" style={{ margin: '8px 0 0 16px', lineHeight: 1.9, color: '#a9c4e8' }}>
                {scenario.steps.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
          ) : (
            <Callout text="场景包只走真实工单与处置流程（提交 → 审批 → 执行 → 生效验证 → 通知），不会跳过准入：被拒绝的动作会如实显示拒绝原因，正好用来演示「平台会拦什么」。每个场景执行前建议先「恢复初始演示数据」，保证结果可复现。" />
          )}
        </div>
      </Panel>

      <Panel
        title="变更窗口与执行队列"
        extra={windowOrder ? `窗口占用中：${windowOrder.id}（${TYPE_LABEL[windowOrder.type]}）` : '窗口空闲 · 可立即执行'}
        className="mt14"
        noPad
      >
        <div className="panel-body">
          <div className="row wrap gap12">
            <div className="row gap6">
              <span className="small faint">当前窗口</span>
              {windowOrder ? <State s="run" /> : <State s="good" />}
              <span className="small">{windowOrder ? `${windowOrder.id} · ${windowOrder.target} ${windowOrder.amount}` : '无变更在执行'}</span>
            </div>
            <div className="row gap6">
              <span className="small faint">排队工单</span>
              <Badge tone={queued.length ? 'warn' : 'muted'}>{queued.length} 项</Badge>
            </div>
            {windowOrder && canApprove ? <button className="btn sm ghost" onClick={() => engine.close(windowOrder.id)}>闭环并释放窗口</button> : null}
          </div>

          {queued.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <Table
                minWidth={1000}
                head={['位次', '工单', '类型 / 对象', '准入预检', '审批来源 / 外部回写', '状态']}
                rows={queued.map((q, i) => {
                  const ap = cons.approvals.filter((a) => a.order_id === q.id)
                  return [
                  <span className="num strong">{i + 1}</span>,
                  <span className="mono small">{q.id}{q.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动建议</span> : null}</span>,
                  <span className="small">{TYPE_LABEL[q.type]} · {q.target} {q.amount}</span>,
                  <span className="tiny faint" style={{ maxWidth: 260 }}>{String(q.spec.affected ?? q.reason).slice(0, 70)}</span>,
                  <span className="tiny">{ap.length === 0 ? <Badge tone="muted">平台内审批</Badge> : ap.map((a) => <span key={a.id} style={{ marginRight: 6 }}>{a.state === '超时' ? <Badge tone="warn">外部超时未回写</Badge> : a.state === '已审' ? <Badge tone="good">已回写</Badge> : a.state === '驳回' ? <Badge tone="bad">已驳回</Badge> : <Badge tone="info">等外部回写</Badge>}<span className="faint tiny mono"> {a.external_ref}</span></span>)}{ap.length > 0 ? <div className="tiny faint">可在「申请与审批台」人工接管</div> : null}</span>,
                  <State s="queued" />,
                  ]
                })}
              />
            </div>
          ) : null}

          <Callout text="变更窗口同一时刻只允许一项变更实际执行：后审批通过的工单进入队列排队，窗口释放（闭环或回滚）后按提交顺序自动开始执行，无需再次审批。抢占类变更还会把被抢占业务方写入工单轨迹并生成通知。" />
        </div>
      </Panel>

      <Panel title="外部算力资源接入（新增资源走配置，不改代码）" extra="额度 / 单价 / 开关都在外部接入配置中心，引擎按配置准入" className="mt14" noPad>
        <div className="panel-body">
          <div className="row between wrap" style={{ gap: 12 }}>
            <div className="row gap6 wrap">
              <Badge tone={rent.enabled ? 'good' : 'warn'}>扩租通道{rent.enabled ? '已启用' : '未启用'}</Badge>
              <Badge tone="info">配置额度 {rent.quota} 卡 · 已启用部分 {rent.liveQuota} 卡 · 已开 {rent.used} 卡 · 可用 {rent.available} 卡</Badge>
              <Badge tone="muted">{rent.price} 元 / 卡 / 日 · 计费方式 {rent.mode}</Badge>
              <Badge tone={rent.status === '已定' ? 'good' : 'warn'}>接口状态 {rent.status}</Badge>
              <span className="small faint">本地空闲 {freeCards(st)} 卡（本地 {TOTAL_CARDS} 卡已分配 {totalAllocated(st)} 卡）</span>
            </div>
            <div className="row gap6">
              <button className="btn sm" onClick={() => { setType('pool_expand'); setPool('shared'); setCards(freeCards(st) + 6); setLevel('灰度'); setReason('演示：申请量超出本地空闲，观察准入是否走外部扩租') }}>预填一笔超出空闲的扩容</button>
              <Link to="/ops/integrations" className="btn sm ghost">改额度 / 单价 / 开关</Link>
              <Link to="/ops/integrations" className="btn sm ghost">新增一条外部资源接入</Link>
            </div>
          </div>
          <div className="divider" />
          <Table
            minWidth={920}
            head={['情形', '准入结果', '平台怎么算']}
            rows={[
              [<span className="small">本地空闲够</span>, <Badge tone="good">直接通过</Badge>, <span className="small">全部用本地卡位，成本按本地卡单价入账</span>],
              [<span className="small">本地不够、扩租通道已启用且剩余额度够</span>, <Badge tone="good">通过并自动混用</Badge>, <span className="small">本地 {freeCards(st)} 卡 + 外部扩租补足；工单标注扩租卡位，外部成本按 {rent.price} 元/卡/日 入账，回滚时额度退回</span>],
              [<span className="small">本地不够、扩租通道未启用</span>, <Badge tone="bad">直接拒绝</Badge>, <span className="small">{rent.blocked || `外部算力扩租通道未启用（额度 ${rent.quota} 卡 · ${rent.status}）；开通后本地不足时可扩租最多 ${rent.quota} 卡`}</span>],
              [<span className="small">本地不够、扩租额度也不够</span>, <Badge tone="bad">拒绝并给差额</Badge>, <span className="small">提示还差多少卡，建议先回收训练池卡位或错峰降载</span>],
            ]}
          />
          <Callout text="新增外部算力不需要改平台：在外部接入配置中心新增一条「外部算力资源」配置（额度、单价、协议、前置条件），启用后这里的准入与成本立即按新配置计算；真实资源到位后把接入方式改为真实接口即可。" />
        </div>
      </Panel>

      <div className="grid g-32 mt14">
        <Panel title="发起调配申请" extra="提交即触发准入计算，不足会被直接拒绝">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">申请类型</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={type} onChange={(e) => setType(e.target.value as OrderType)}>
                {TYPE_OPTS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">业务等级</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                {(['高保', '共享', '灰度'] as Level[]).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            {(type === 'pool_expand' || type === 'pool_release') ? (
              <>
                <div>
                  <div className="tiny faint">目标资源池</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={pool} onChange={(e) => setPool(e.target.value as 'hp' | 'shared' | 'train')}>
                    {st.pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">卡位数量</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" min={1} value={cards} onChange={(e) => setCards(Number(e.target.value))} />
                </div>
              </>
            ) : null}
            {type === 'preempt' ? (
              <>
                <div>
                  <div className="tiny faint">抢占来源池</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={preemptFrom} onChange={(e) => setPreemptFrom(e.target.value as 'hp' | 'shared' | 'train')}>
                    {st.pools.filter((p) => p.id !== 'hp').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">抢占卡位（目标：高保集群）</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" min={1} value={cards} onChange={(e) => setCards(Number(e.target.value))} />
                </div>
                <div className="small" style={{ maxWidth: 240, color: '#8fb0d6' }}>
                  触发条件：高保集群利用率 &gt; 90% 且全局空闲不足；来源池在用卡位不可侵占。
                </div>
              </>
            ) : null}
            {type === 'replica_scale' ? (
              <>
                <div>
                  <div className="tiny faint">模型</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={modelShort} onChange={(e) => setModelShort(e.target.value)}>
                    {st.models.map((m) => <option key={m.short} value={m.short}>{m.short}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">副本增减</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} />
                </div>
              </>
            ) : null}
            {type === 'weight_adjust' ? (
              <div>
                <div className="tiny faint">渠道权重（合计须 100）</div>
                <input className="btn sm" style={{ marginTop: 4, width: 130 }} value={weights} onChange={(e) => setWeights(e.target.value)} />
              </div>
            ) : null}
            {(type === 'credential_issue') ? (
              <>
                <div>
                  <div className="tiny faint">凭证类型</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={kind} onChange={(e) => setKind(e.target.value as '个人密钥' | '平台代理')}>
                    <option value="平台代理">平台代理密钥</option>
                    <option value="个人密钥">个人密钥</option>
                  </select>
                </div>
                <div>
                  <div className="tiny faint">绑定渠道</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
                    {st.channels.map((c) => <option key={c.id} value={c.id}>{c.name.split('（')[0]}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">申请 RPM</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
                </div>
                <div>
                  <div className="tiny faint">使用主体</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 150 }} value={holder} onChange={(e) => setHolder(e.target.value)} />
                </div>
                <div>
                  <div className="tiny faint">绑定应用</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 150 }} value={app} onChange={(e) => setApp(e.target.value)} />
                </div>
              </>
            ) : null}
            {(type === 'credential_revoke' || type === 'quota_adjust') ? (
              <>
                <div>
                  <div className="tiny faint">凭证编号</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={credId} onChange={(e) => setCredId(e.target.value)}>
                    {st.creds.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.holder}</option>)}
                  </select>
                </div>
                {type === 'quota_adjust' ? (
                  <div>
                    <div className="tiny faint">调整 RPM</div>
                    <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="mt14" style={{ marginTop: 14 }}>
            <div className="tiny faint">业务理由（写入审批单与台账）</div>
            <input className="btn sm" style={{ marginTop: 4, width: '100%' }} placeholder="例：违法图像审核进入灰度放量，需提升并发承载" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row gap12 mt14" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={submit}>提交申请</button>
            <span className="small faint">校验规则：卡位不足 / 副本超安全上限 / 渠道配额溢出 / 异常渠道权重 &gt;20% / 个人密钥超 120 RPM → 直接拒绝</span>
          </div>
        </Panel>

        <Panel title="资源账本（实时）" extra="所有数字由引擎计算" noPad>
          <div className="panel-body">
            {st.pools.map((p) => {
              const u = poolUtil(st, p.id)
              return (
                <div key={p.id} style={{ marginBottom: 12 }}>
                  <div className="row between small">
                    <span>{p.name} <span className="faint">({p.cards} 卡)</span></span>
                    <span className={u > 90 ? 'strong' : 'muted'} style={{ color: u > 90 ? '#ffb3b3' : undefined }}>{u}%</span>
                  </div>
                  <div style={{ marginTop: 5 }}><Progress value={u} tone={u > 90 ? 'bad' : u > 80 ? 'warn' : 'green'} /></div>
                </div>
              )
            })}
            <div className="divider" />
            <Table
              head={['模型', '副本', '卡/副本', '占用']}
              rows={st.models.map((m) => [
                <span className="small">{m.short}</span>,
                <span className="num">{m.replicas}</span>,
                <span className="num">{m.perReplica}</span>,
                <span className="num">{m.replicas * m.perReplica} 卡</span>,
              ])}
            />
            <div className="divider" />
            <Table
              head={['渠道', '权重', '配额占用']}
              rows={st.channels.map((c) => [
                <span className="small">{c.name.split('（')[0]} <State s={c.health} /></span>,
                <div style={{ minWidth: 90 }}><Progress value={c.weight} /></div>,
                <span className="num small">{c.allocatedRpm} / {c.capacityRpm} RPM</span>,
              ])}
            />
          </div>
        </Panel>
      </div>

      <Panel title="资源池利用率趋势" extra={auto ? `自动采样中 · 第 ${st.tick} 个周期` : `已采样 ${st.tick} 个周期`} className="mt14">
        <Chart option={utilOpt} height={240} />
      </Panel>

      <Panel title="工单队列" extra={`待审批 ${pending.length} · 执行中 ${running.length} · 已处理 ${done.length + rejected.length}`} className="mt14" noPad>
        <div className="panel-body">
          {st.orders.length === 0 ? <div className="empty">暂无工单</div> : (
            <div className="tbl-scroll">
              <table className="tbl" style={{ minWidth: 900 }}>
                <thead><tr><th>工单号</th><th>类型</th><th>对象 / 申请方</th><th>数量</th><th>等级</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {st.orders.slice(0, 14).map((o) => <OrderRow key={o.id} o={o} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="工单轨迹（审批与执行留痕）" extra={selectedOrder ? `${selectedOrder.id} · ${selectedOrder.title}` : ''} noPad>
          <div className="panel-body">
            {selectedOrder ? (
              <ul className="tl">
                {selectedOrder.trace.map((t, i) => (
                  <li key={i}>
                    <div className="tl-time mono">{t.time} · {t.actor}</div>
                    <div className="row gap6" style={{ marginBottom: 3 }}>
                      <Badge tone={t.tone}>{t.action}</Badge>
                      <span className="tiny faint">{TYPE_LABEL[selectedOrder.type]}</span>
                    </div>
                    <div className="small" style={{ color: '#b9cbe6', lineHeight: 1.6 }}>{t.detail}</div>
                  </li>
                ))}
              </ul>
            ) : <div className="empty">暂无工单</div>}
          </div>
        </Panel>
        <Panel title="运行事件流" extra="调度引擎自动产生">
          {st.events.slice(0, 8).map((e, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div className="row gap6">
                {e.level === '紧急' ? <Badge tone="bad">紧急</Badge> : e.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>}
                <span className="mono tiny faint">{e.time}</span>
              </div>
              <div className="small" style={{ color: '#a9c4e8', marginTop: 3, lineHeight: 1.6 }}>{e.text}</div>
            </div>
          ))}
        </Panel>
      </div>

      <Callout warn text="闭环演示要点：提交「+8 卡」会因空闲不足被拒；点「演示冲击场景」会看到负载上升 → 引擎自动生成扩容建议 → 审批后卡位与利用率真实变化 → 回滚可恢复变更前快照。所有变更写入工单轨迹与事件台账。" />
    </div>
  )
}
