/* =====================================================================
 * 运营分析 · 申请与审批台
 * 普通用户申请 Key / 申请训练算例；管理员审批 → 执行生效 → 到期归还，全程留痕。
 * 只调用引擎既有 API：submit / approve / reject / execute / rollback / close
 * 权限点说明：权限矩阵（engine/auth.ts 的 PermKey）里没有「ops」这一项，
 *            本页写操作挂 workflow（提交申请）、审批与执行挂 approve，
 *            等价于任务要求的 { view, manage }。
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Badge, Callout, Kpi, PageHead, Panel, Progress, Table } from '../../components/ui'
import { Link } from 'react-router-dom'
import { currentAccount, usePerm, ROLE_LABEL } from '../../engine/auth'
import { flagsStore } from '../../engine/auth'
import { consoleStore, useConsole } from '../../engine/console'
import { useTelemetry } from '../../engine/telemetry'
import {
  ORDER_STATUS_LABEL, TYPE_LABEL, engine, poolFree, poolUtil, useEngine,
  type Order, type OrderStatus, type OrderType, type TrainJob,
} from '../../engine/engine'

/** 本页受理的三类申请 */
const APPLY_TYPES: OrderType[] = ['credential_issue', 'train_reserve', 'model_deploy']
const PURPOSES = ['个人调试', '业务系统集成', '批处理任务']
const EXTRA_MODELS = ['DeepSeek-V3', 'GLM-4', 'Qwen3-32B 微调', 'BGE-M3']
const FRAMEWORKS = ['MindForm', 'MindForm + MindIE', '其它（PyTorch / Megatron）']
const DATA_LEVELS = ['内部', '已脱敏', '敏感（专用网络内）']
const EXP_DAYS = [30, 90, 180]

const STATUS_TONE: Record<OrderStatus, 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'> = {
  submitted: 'warn', approved: 'info', queued: 'warn', external: 'purple',
  running: 'info', closed: 'good', rejected: 'bad', rolled_back: 'muted',
}
function utilTone(u: number): '' | 'warn' | 'bad' | 'green' { return u > 90 ? 'bad' : u > 75 ? 'warn' : 'green' }
function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function OrderBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{ORDER_STATUS_LABEL[status]}</Badge>
}
/** 关键参数按类型显示 */
function keyParams(o: Order): string {
  if (o.type === 'credential_issue') return `${String(o.spec.kind)} · RPM ${String(o.spec.rpm)} / TPM ${String(o.spec.tpm)} / 期限 ${String(o.spec.expDays ?? 90)} 天 · 渠道 ${String(o.spec.channel)}`
  if (o.type === 'train_reserve') return `${String(o.spec.cards)} 卡 × ${String(o.spec.hours)} 小时 · ${String(o.spec.framework)} · 数据密级 ${String(o.spec.dataLevel)}`
  if (o.type === 'model_deploy') return `${String(o.spec.replicas)} 副本 × ${Number(o.spec.perReplica) || 1} 卡 · 灰度 ${Number(o.spec.gray ?? 100)}% · ${String(o.spec.nodes)}`
  return '—'
}

/* ---------------- 行内驳回（空理由不可提交） ---------------- */
function RejectCell({ id, manage, width }: { id: string; manage: boolean; width: number }) {
  const [txt, setTxt] = useState('用途或场景说明不充分，请补充后重新提交')
  return (
    <div className="col gap6">
      <input className="btn sm" style={{ width }} value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="驳回理由" />
      <button className="btn sm danger" disabled={!manage || !txt.trim()} onClick={() => engine.reject(id, txt.trim())}>驳回</button>
    </div>
  )
}

export default function OpsApply() {
  const st = useEngine()
  const tele = useTelemetry()
  const perm = usePerm('workflow')
  const canApprove = usePerm('approve').manage
  const cons = useConsole()
  const [extPick, setExtPick] = useState<{ orderId: string; ref: string; due: number }>({ orderId: '', ref: '', due: 30 })
  useEffect(() => { void consoleStore.refresh() }, [])
  const account = currentAccount()
  const applicant = account?.name ?? '演示用户'
  const dept = account?.dept ?? '演示单位'

  const trainPool = st.pools.find((p) => p.id === 'train')
  const trainUtil = poolUtil(st, 'train')
  const trainFree = poolFree(st, 'train')

  /* -------- 申请 Key -------- */
  const [appName, setAppName] = useState('示例业务六部话术问答助手')
  const [keyModel, setKeyModel] = useState('DeepSeek-V3')
  const [purpose, setPurpose] = useState(PURPOSES[0])
  const [channel, setChannel] = useState('vendor')
  const [rpm, setRpm] = useState(60)
  const [tpm, setTpm] = useState('12万')
  const [expDays, setExpDays] = useState(90)
  const [credReason, setCredReason] = useState('新应用接入需要调用授权模型，绑定应用标识与 IP 白名单，按配额发放密钥')
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const modelOpts = Array.from(new Set([...st.models.map((m) => m.short), ...EXTRA_MODELS]))
  const kindOf = (p: string): '个人密钥' | '平台代理' => (p === '个人调试' ? '个人密钥' : '平台代理')

  const submitCred = () => {
    const kind = kindOf(purpose)
    const r = engine.submit({
      type: 'credential_issue', applicant, dept, level: '共享', reason: credReason,
      spec: { kind, holder: applicant, app: appName, model: keyModel, channel, rpm, tpm, expDays },
    })
    if (r.precheck.ok) setMsg({ tone: 'good', text: `${r.order.id} Key 申请已提交（${kind} · ${applicant}）· 准入通过：${r.precheck.suggest ?? ''} · 待管理员审批` })
    else setMsg({ tone: 'bad', text: `${r.order.id} Key 申请被准入校验拒绝：${r.precheck.reason ?? ''}` })
  }

  /** 演示：个人密钥超 120 RPM 上限，展示准入拒绝理由 */
  const demoCredOverLimit = () => {
    const r = engine.submit({
      type: 'credential_issue', applicant, dept, level: '共享',
      reason: '演示：个人密钥直接申请 500 RPM（超单密钥上限）',
      spec: { kind: '个人密钥', holder: applicant, app: `${appName}（演示超上限）`, model: keyModel, channel, rpm: 500, tpm: '120万', expDays },
    })
    setMsg({
      tone: 'bad',
      text: r.precheck.ok
        ? `演示未达预期：${r.order.id} 竟然通过准入（${r.precheck.suggest ?? ''}）`
        : `演示 ${r.order.id} 准入拒绝：${r.precheck.reason ?? ''}（个人密钥上限 120 RPM · 平台代理上限按渠道配额）`,
    })
  }

  /* -------- 申请训练算例 -------- */
  const [jobName, setJobName] = useState('Qwen3-4B 示例业务三部领域微调')
  const [framework, setFramework] = useState(FRAMEWORKS[0])
  const [cards, setCards] = useState(4)
  const [hours, setHours] = useState(12)
  const [dataLevel, setDataLevel] = useState(DATA_LEVELS[0])
  const [jobReason, setJobReason] = useState('示例业务三部领域模型微调，需要训练卡位与训练数据密级核验，到期后按工单归还卡位')

  const submitJob = () => {
    const r = engine.submit({
      type: 'train_reserve', applicant, dept, level: '共享', reason: jobReason,
      spec: { name: jobName, cards, hours, framework, dataLevel },
    })
    if (r.precheck.ok) setMsg({ tone: 'good', text: `${r.order.id} 训练算例申请已提交 · 准入通过：${r.precheck.suggest ?? ''} · 待管理员审批` })
    else setMsg({ tone: 'bad', text: `${r.order.id} 训练算例申请被准入校验拒绝：${r.precheck.reason ?? ''}` })
  }

  /** 演示：单申请 12 卡超上限 */
  const demoJobOverLimit = () => {
    const r = engine.submit({
      type: 'train_reserve', applicant, dept, level: '共享',
      reason: '演示：一次申请 12 卡（超单申请上限）',
      spec: { name: `${jobName}（演示超上限）`, cards: 12, hours, framework, dataLevel },
    })
    setMsg({
      tone: 'bad',
      text: r.precheck.ok
        ? `演示未达预期：${r.order.id} 竟然通过准入（${r.precheck.suggest ?? ''}）`
        : `演示 ${r.order.id} 准入拒绝：${r.precheck.reason ?? ''}`,
    })
  }

  /* -------- 归还卡位（走工单，不直接删任务） -------- */
  const releaseJob = (j: TrainJob) => {
    const r = engine.submit({
      type: 'train_release', applicant, dept: j.dept, level: '共享',
      reason: `${j.name} 训练阶段性完成或需让出卡位，按工单归还 ${j.cards} 卡并闭环台账`,
      spec: { jobId: j.id },
    })
    if (!r.precheck.ok) {
      setMsg({ tone: 'bad', text: `${r.order.id} 归还申请被准入拒绝：${r.precheck.reason ?? ''}` })
      return
    }
    if (!canApprove) {
      setMsg({ tone: 'good', text: `${r.order.id} 归还工单已提交（当前角色无审批权，待管理员审批）：${r.precheck.suggest ?? ''}` })
      return
    }
    engine.approve(r.order.id)
    const after = engine.get().orders.find((x) => x.id === r.order.id)
    const s = after?.status ?? 'approved'
    setMsg({
      tone: 'good',
      text: `${r.order.id} 归还工单已提交并审批通过 → 当前状态「${ORDER_STATUS_LABEL[s]}」${
        s === 'queued' ? '：已进变更窗口队列，窗口开放后自动接续归还' : s === 'running' ? `：${j.name} 的 ${j.cards} 卡已归还，训练池空闲立即可见（当前空闲 ${poolFree(st, 'train')} 卡）` : ''
      }`,
    })
  }

  const mine = st.orders.filter((o) => o.applicant === applicant)
  const pending = st.orders.filter((o) => o.status === 'submitted' && APPLY_TYPES.includes(o.type))
  const decided = st.orders.filter((o) => APPLY_TYPES.includes(o.type) && (o.status === 'approved' || o.status === 'queued' || o.status === 'running' || o.status === 'closed')).slice(0, 8)
  const jobs = st.jobs ?? []
  const runningJobs = jobs.filter((j) => j.state === '运行中')
  const queuedAll = st.orders.filter((o) => o.status === 'queued')

  return (
    <div>
      <PageHead
        title="申请与审批台"
        desc="普通用户申请 Key、申请训练算例；管理员审批 → 生效 → 到期归还，全程留痕"
        extra={
          <>
            <Badge tone="warn">待审批 {pending.length}</Badge>
            <Badge tone="info">我的申请 {mine.length}</Badge>
            <Badge tone={trainUtil > 90 ? 'bad' : trainUtil > 75 ? 'warn' : 'good'}>训练池 {trainUtil}%</Badge>
            <Badge tone={tele.mode === '采集层' ? 'good' : 'muted'}>取数来源：{tele.mode}</Badge>
          </>
        }
      />

      {msg ? <Callout warn={msg.tone === 'bad'} text={msg.text} /> : null}

      <div className="grid g-2 mt14">
        <Panel
          title="申请 Key（凭证发放）"
          extra={perm.manage ? `申请方 ${applicant} · ${dept}` : <span className="tiny faint">只读</span>}
        >
          <div className="col gap6">
            <div className="row gap6 wrap">
              <span className="tiny faint">申请人（只读 · 由当前登录身份带入）</span>
              <span className="small strong">{applicant}</span>
              {account ? <span className="tag gray">{ROLE_LABEL[account.role]}</span> : null}
              <span className="tag gray">{dept}</span>
              {account ? null : <span className="tiny faint">未登录演示账号，按演示用户提交</span>}
            </div>
            <div className="row gap6 wrap">
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="tiny faint">应用名称（平台代理 Key 要绑定应用标识）</div>
                <input className="btn sm" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={appName} onChange={(e) => setAppName(e.target.value)} />
              </div>
              <div>
                <div className="tiny faint">模型</div>
                <select className="btn sm" style={{ marginTop: 4, width: 200 }} disabled={!perm.manage} value={keyModel} onChange={(e) => setKeyModel(e.target.value)}>
                  {modelOpts.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">用途（决定 Key 类型）</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">目标渠道</div>
                <select className="btn sm" style={{ marginTop: 4, width: 220 }} disabled={!perm.manage} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {st.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="row gap6 wrap">
              <div>
                <div className="tiny faint">RPM（个人密钥上限 120）</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" min={1} disabled={!perm.manage} value={rpm} onChange={(e) => setRpm(Number(e.target.value))} />
              </div>
              <div>
                <div className="tiny faint">TPM</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} disabled={!perm.manage} value={tpm} onChange={(e) => setTpm(e.target.value)} />
              </div>
              <div>
                <div className="tiny faint">期限（天）</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={expDays} onChange={(e) => setExpDays(Number(e.target.value))}>
                  {EXP_DAYS.map((d) => <option key={d} value={d}>{d} 天</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">Key 类型（由用途推导）</div>
                <div style={{ marginTop: 4 }}><Badge tone={kindOf(purpose) === '平台代理' ? 'purple' : 'info'}>{kindOf(purpose)}</Badge></div>
              </div>
            </div>
            <div>
              <div className="tiny faint">申请理由（审批与审计要看）</div>
              <textarea className="btn sm" style={{ width: '100%', minHeight: 56 }} disabled={!perm.manage} value={credReason} onChange={(e) => setCredReason(e.target.value)} />
            </div>
            <div className="row gap6 wrap">
              <button className="btn primary" disabled={!perm.manage} onClick={submitCred}>提交 Key 申请</button>
              <button className="btn ghost" disabled={!perm.manage} onClick={demoCredOverLimit}>演示：提交一个超上限的申请</button>
              {!perm.manage ? <span className="tiny faint">只读</span> : null}
            </div>
            <Callout text={`渠道配额：${st.channels.map((c) => `${c.name.split('（')[0]} ${c.allocatedRpm}/${c.capacityRpm} RPM`).join(' · ')}。发放前先算余量，溢出即准入拒绝。`} />
          </div>
        </Panel>

        <Panel
          title="申请训练算例（卡位预留）"
          extra={perm.manage ? `归口 ${dept}` : <span className="tiny faint">只读</span>}
        >
          <div className="col gap6">
            <div>
              <div className="tiny faint">任务名称（台账与成本归集要用）</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={jobName} onChange={(e) => setJobName(e.target.value)} />
            </div>
            <div className="row gap6 wrap">
              <div>
                <div className="tiny faint">训练框架</div>
                <select className="btn sm" style={{ marginTop: 4, width: 200 }} disabled={!perm.manage} value={framework} onChange={(e) => setFramework(e.target.value)}>
                  {FRAMEWORKS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">卡数（1–8）</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" min={1} max={8} disabled={!perm.manage} value={cards} onChange={(e) => setCards(Number(e.target.value))} />
              </div>
              <div>
                <div className="tiny faint">时长（小时 1–72）</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" min={1} max={72} disabled={!perm.manage} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
              </div>
              <div>
                <div className="tiny faint">训练数据密级</div>
                <select className="btn sm" style={{ marginTop: 4, width: 200 }} disabled={!perm.manage} value={dataLevel} onChange={(e) => setDataLevel(e.target.value)}>
                  {DATA_LEVELS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="tiny faint">申请理由</div>
              <textarea className="btn sm" style={{ width: '100%', minHeight: 56 }} disabled={!perm.manage} value={jobReason} onChange={(e) => setJobReason(e.target.value)} />
            </div>
            <div className="row gap6 wrap">
              <button className="btn primary" disabled={!perm.manage} onClick={submitJob}>提交训练算例申请</button>
              <button className="btn ghost" disabled={!perm.manage} onClick={demoJobOverLimit}>演示：申请 12 卡（超单申请上限）</button>
              {!perm.manage ? <span className="tiny faint">只读</span> : null}
            </div>
            <Callout warn={cards > trainFree} text={`训练池当前 ${trainPool?.cards ?? 0} 卡 · 空闲 ${trainFree} 卡 · 利用率 ${trainUtil}%。本次要 ${cards} 卡 × ${hours} 小时；不足时准入直接拒绝，可先排队或先归还其他任务卡位。`} />
          </div>
        </Panel>
      </div>

      <Panel title="我的申请" extra={`申请方 ${applicant} · 共 ${mine.length} 条 · 全程留痕`} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1000}
            head={['工单', '类型', '对象', '量', '状态', '提交时间', '驳回理由']}
            rows={mine.map((o) => [
              <span className="mono small strong">{o.id}{o.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动</span> : null}</span>,
              <span className="small">{TYPE_LABEL[o.type]}</span>,
              <span className="small">{o.target}<div className="tiny faint">{o.reason}</div></span>,
              <span className="num small">{o.amount}</span>,
              <OrderBadge status={o.status} />,
              <span className="mono tiny faint">{fmtTime(o.createdAt)}</span>,
              <span className="tiny" style={{ color: o.rejectReason ? 'var(--bad-text)' : 'var(--text-dim)', maxWidth: 240 }}>{o.rejectReason ?? '—'}</span>,
            ])}
          />
          {mine.length === 0 ? <Callout text={`当前身份「${applicant}」还没有提交过申请。`} /> : null}
        </div>
      </Panel>

      <Panel
        title="审批台（管理员）"
        extra={canApprove ? `待审批 ${pending.length} 项 · 审批前引擎已做准入计算` : <span className="tiny faint">只读</span>}
        className="mt14"
        noPad
      >
        <div className="panel-body">
          <Table
            minWidth={1180}
            head={['工单', '类型', '申请方', '对象', '量', '关键参数', '动作']}
            rows={pending.map((o) => [
              <span className="mono small strong">{o.id}</span>,
              <span className="small">{TYPE_LABEL[o.type]}<div className="tiny faint"><OrderBadge status={o.status} /></div></span>,
              <span className="small">{o.applicant}<div className="tiny faint">{o.dept} · {o.level}</div></span>,
              <span className="small">{o.target}</span>,
              <span className="num small">{o.amount}</span>,
              <span className="small" style={{ maxWidth: 260 }}>{keyParams(o)}<div className="tiny faint">{o.reason}</div></span>,
              <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn sm primary"
                  disabled={!canApprove}
                  onClick={() => {
                    engine.approve(o.id)
                    const after = engine.get().orders.find((x) => x.id === o.id)
                    const s = after?.status ?? 'approved'
                    setMsg({
                      tone: 'good',
                      text: `${o.id} 审批通过 → 当前状态「${ORDER_STATUS_LABEL[s]}」${
                        s === 'queued' ? '：已进变更窗口队列，窗口开放后自动接续（可在资源调配工作台 / 变更窗口排期处理）'
                        : s === 'rejected' ? `：执行前校验失败 —— ${after?.rejectReason ?? ''}`
                        : s === 'running' ? `：${TYPE_LABEL[o.type]}已执行生效（${o.target} ${o.amount}）`
                        : '：已审批待执行，可在「待执行与已生效」点执行'
                      }`,
                    })
                  }}
                >
                  审批通过
                </button>
                <RejectCell id={o.id} manage={canApprove} width={190} />
              </div>,
            ])}
          />
          {pending.length === 0 ? <Callout text={`当前没有待审批的申请。审批通过后：Key 与训练算例要执行才生效；模型部署要先点「下发容器平台」再等执行回执。`} /> : null}
          {!canApprove ? <Callout warn text="当前角色无审批权（approve）：可提交申请，不能审批或执行。" /> : null}
        </div>
      </Panel>

      <Panel title="审批来源与外部回写（审批来源是配置项，不是代码分支）" className="mt14" noPad>
        <div className="panel-body">
          <div className="tiny faint">
            当前审批来源：<b>{flagsStore.get().config['approval-source'] === 'external' ? '外部审批系统（本系统登记待回写并跟踪超时）' : '平台内审批（本页审批台）'}</b>。
            不论来源是哪边，工单状态机与审计是同一套；外部回写按「工单 + 外部单据号 + 决定」幂等，重复回写只生效一次。
          </div>
          <Table minWidth={1080} head={['工单', '审批来源', '外部单据号', '状态', '期望回写 / 判定时间', '备注与经办', '动作']} rows={cons.approvals.map((a) => [
            <span className="mono small strong">{a.order_id}</span>,
            <span className="tiny">{a.source === 'external' ? '外部审批系统' : '平台内'}</span>,
            <span className="tiny mono">{a.external_ref || '—'}</span>,
            <span>{a.state === '超时' ? <Badge tone="warn">超时未回写</Badge> : a.state === '已审' ? <Badge tone="good">已审</Badge> : a.state === '驳回' ? <Badge tone="bad">驳回</Badge> : <Badge tone="info">待审</Badge>}</span>,
            <span className="tiny mono">{(a.decided_at || a.due_at || a.at || '').replace('T', ' ').replace('Z', '')}</span>,
            <span className="tiny faint">{(a.note || '').slice(0, 60) || '—'}<div className="tiny faint">{a.actor || ''}</div></span>,
            <div className="row gap6" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" disabled={!canApprove} onClick={() => void consoleStore.decideApproval(a.order_id, 'approve', a.external_ref || 'MANUAL-' + a.order_id, '平台内人工审批（外部超时后接管）').then((r) => setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? (r.deduped ? `${a.order_id} 这条回写之前已生效，未重复计算` : `${a.order_id} 已由平台内审批通过（同时写入审计）`) : `回写被拒：${r.error || ''}` }))}>人工审批</button>
              <button className="btn sm ghost" disabled={!canApprove} onClick={() => void consoleStore.decideApproval(a.order_id, 'reject', a.external_ref || 'MANUAL-' + a.order_id, '平台内人工驳回').then((r) => setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${a.order_id} 已由平台内驳回（同时写入审计）` : `回写被拒：${r.error || ''}` }))}>人工驳回</button>
            </div>,
          ])} />
          {cons.approvals.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>当前没有外部审批登记：需要走外部审批时，在下面给某张工单登记「外部单据号 + 期望回写时间」。</div> : null}
          <div className="row gap6 wrap" style={{ marginTop: 10 }}>
            <select className="btn sm" style={{ minWidth: 220 }} value={extPick.orderId} onChange={(e) => setExtPick({ ...extPick, orderId: e.target.value })}>
              {st.orders.slice(0, 30).map((o) => <option key={o.id} value={o.id}>{o.id} · {o.title}</option>)}
            </select>
            <input className="btn sm" style={{ width: 170 }} value={extPick.ref} placeholder="外部单据号（如 OA-2026-0001）" onChange={(e) => setExtPick({ ...extPick, ref: e.target.value })} />
            <select className="btn sm" style={{ width: 120 }} value={extPick.due} onChange={(e) => setExtPick({ ...extPick, due: Number(e.target.value) })}>
              <option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={120}>2 小时</option><option value={1440}>24 小时</option>
            </select>
            <button className="btn sm primary" disabled={!canApprove} onClick={() => void consoleStore.createApproval(extPick.orderId, extPick.ref || ('OA-' + extPick.orderId), extPick.due, '走外部审批系统，超时未回写自动出兜底工单').then((r) => setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${extPick.orderId} 已登记外部审批待回写（期望 ${extPick.due} 分钟内）` : `登记被拒：${r.error || ''}` }))}>登记外部审批待回写</button>
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>
            超时未回写：这条审批在台账里标「超时」，同时生成一张人工兜底工单（处置指令台可见），并允许在平台内人工审批接管 —— 不会因为外部系统没回话就把业务卡死。
          </div>
        </div>
      </Panel>

      <Panel title="待执行与已生效" extra={`最近 ${decided.length} 条 · 受变更窗口约束`} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1000}
            head={['工单', '类型', '状态', '时间', '关键参数', '动作']}
            rows={decided.map((o) => [
              <span className="mono small strong">{o.id}<div className="tiny faint">{o.target}</div></span>,
              <span className="small">{TYPE_LABEL[o.type]}<div className="tiny faint">{o.applicant}</div></span>,
              <div className="col gap6">
                <OrderBadge status={o.status} />
                {o.status === 'queued' ? <span className="tiny" style={{ color: '#f5b83d' }}>队列位次 {queuedAll.findIndex((q) => q.id === o.id) + 1}</span> : null}
              </div>,
              <span className="mono tiny faint">{fmtTime(o.executedAt ?? o.decidedAt ?? o.createdAt)}</span>,
              <span className="small" style={{ maxWidth: 250 }}>{keyParams(o)}</span>,
              <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                {o.status === 'approved' ? (
                  <button
                    className="btn sm primary"
                    disabled={!canApprove}
                    onClick={() => {
                      engine.execute(o.id)
                      const after = engine.get().orders.find((x) => x.id === o.id)
                      const s = after?.status ?? 'approved'
                      setMsg({
                        tone: 'good',
                        text: s === 'queued'
                          ? `${o.id} 已进变更窗口队列（${ORDER_STATUS_LABEL.queued}），窗口开放后自动接续生效`
                          : s === 'rejected'
                          ? `${o.id} 执行前校验失败：${after?.rejectReason ?? ''}`
                          : `${o.id} 已执行生效：${o.target} ${o.amount}（当前状态「${ORDER_STATUS_LABEL[s]}」）`,
                      })
                    }}
                  >
                    执行
                  </button>
                ) : null}
                {o.status === 'queued' ? (
                  <>
                    <span className="tiny" style={{ color: '#f5b83d' }}>已进变更窗口队列，窗口开放后自动接续</span>
                    <Link to="/ops/workflow" className="btn sm ghost">去排期 / 工作台</Link>
                  </>
                ) : null}
                {o.status === 'running' ? (
                  canApprove ? (
                    <>
                      <button className="btn sm ghost" onClick={() => { engine.close(o.id); setMsg({ tone: 'good', text: `${o.id} 已闭环归档，变更窗口已释放` }) }}>闭环</button>
                      <button className="btn sm" onClick={() => { engine.rollback(o.id); setMsg({ tone: 'good', text: `${o.id} 已回滚到变更前快照（Key 撤销 / 卡位归还 / 副本恢复）` }) }}>回滚</button>
                    </>
                  ) : <span className="tiny faint">只读</span>
                ) : null}
                {o.status === 'closed' ? <span className="tiny faint">已闭环 · 台账保留</span> : null}
              </div>,
            ])}
          />
          {decided.length === 0 ? <Callout text="还没有已审批的工单。审批通过后这里会出现「待执行 / 排队 / 执行中」的工单。" /> : null}
          <div style={{ marginTop: 6 }}>
            <div className="row gap6 wrap">
              <span className="tiny faint">当前变更窗口：{engine.activeSlot() ? `${engine.activeSlot()?.id} ${engine.activeSlot()?.date} ${engine.activeSlot()?.from}-${engine.activeSlot()?.to} · ${engine.activeSlot()?.scope}` : '未开放（窗口外提交的变更会排队）'}</span>
              <span className="tiny faint">占用窗口的工单：{engine.windowOrder()?.id ?? '无'}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              <Table
                minWidth={620}
                head={['队列位次', '工单 / 类型', '状态', '提交时间']}
                rows={queuedAll.map((o, i) => [
                  <span className="num">{i + 1}</span>,
                  <span className="small mono">{o.id} · {TYPE_LABEL[o.type]}<div className="tiny faint">{o.target}</div></span>,
                  <OrderBadge status={o.status} />,
                  <span className="mono tiny faint">{fmtTime(o.createdAt)}</span>,
                ])}
              />
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="训练算例台账（卡位占用）" extra={`共 ${jobs.length} 项 · 运行中 ${runningJobs.length} · 归还走工单`} className="mt14" noPad>
        <div className="panel-body">
          <div style={{ padding: 14 }}>
            <div className="grid g-4">
              <Kpi label="训练池利用率" value={trainUtil} unit="%" foot={`在用 ${ (trainPool?.cards ?? 0) - trainFree } / ${trainPool?.cards ?? 0} 卡`} />
              <Kpi label="训练池空闲" value={trainFree} unit="卡" foot={trainFree <= 2 ? <span className="down">● 接近耗尽，先归还再申请</span> : '可预留给新算例'} />
              <Kpi label="运行中算例" value={runningJobs.length} unit="项" foot={`占用 ${runningJobs.reduce((s, j) => s + j.cards, 0)} 卡`} />
              <Kpi label="排队 / 已完成" value={`${jobs.filter((j) => j.state === '排队中').length} / ${jobs.filter((j) => j.state === '已完成').length}`} unit="项" foot="排队不占卡位 · 已完成卡位已归还" />
            </div>
            <div style={{ marginTop: 10 }}>
              <Progress value={trainUtil} tone={utilTone(trainUtil)} />
            </div>
          </div>
          <div style={{ padding: '0 0 14px' }}>
            <Table
              minWidth={1180}
              head={['任务号', '名称', '卡数', '归口 / 申请方', '框架', '数据密级', '时长', '到期时间', '状态', '动作']}
              rows={jobs.map((j) => [
                <span className="mono small strong">{j.id}</span>,
                <span className="small">{j.name}</span>,
                <span className="num">{j.cards}</span>,
                <span className="small">{j.dept}<div className="tiny faint">{j.applicant}</div></span>,
                <span className="small">{j.framework}</span>,
                <span className="small">{j.dataLevel}<div className="tiny faint">{j.dataLevel.includes('敏感') ? '须专用网络内 · 不得进共享池' : '可进共享 / 训练池'}</div></span>,
                <span className="num">{j.hours} 小时</span>,
                <span className="mono small">{j.dueAt}</span>,
                <Badge tone={j.state === '运行中' ? 'info' : j.state === '排队中' ? 'purple' : 'muted'}>{j.state}</Badge>,
                j.state === '运行中' ? (
                  <div className="col gap6">
                    <button className="btn sm" disabled={!perm.manage} onClick={() => releaseJob(j)}>归还卡位</button>
                    {!perm.manage ? <span className="tiny faint">只读</span> : null}
                  </div>
                ) : <span className="tiny faint">{j.state === '已完成' ? '卡位已归还' : '排队中 · 未占卡位'}</span>,
              ])}
            />
          </div>
          <Callout
            text={
              <>
                归还卡位走 <b>{TYPE_LABEL.train_release}</b> 工单（引擎只认 spec.jobId），不是直接删任务：提交 → 审批 → 窗口执行 → 台账置「已完成」。
                归还后训练池空闲立即可见（当前空闲 {trainFree} 卡）；误归还可在工单里回滚恢复任务状态。
              </>
            }
          />
        </div>
      </Panel>

      <Panel title="配额与安全口径" className="mt14">
        <div className="grid g-2">
          <div className="col gap6">
            <div className="small strong">密钥配额上限（准入即计算，超限即拒）</div>
            <div className="small muted">
              个人密钥默认低配额上限 <b>120 RPM</b>（超过须先走提额审批）；平台代理 Key 上限取决于所绑定渠道的剩余配额
              （当前渠道余量：{st.channels.map((c) => `${c.name.split('（')[0]} 剩 ${c.capacityRpm - c.allocatedRpm} RPM`).join(' · ')}），
              发放后渠道占用超 100% 即准入拒绝。异常渠道不得发放平台代理 Key。
            </div>
            <div className="divider" />
            <div className="small strong">Key 到期与回收</div>
            <div className="small muted">
              期限 {EXP_DAYS.join(' / ')} 天，默认 {expDays} 天；到期前 15 天与连续 90 天未使用（僵尸凭证）由凭证盘点自动生成回收建议工单，
              吊销后关联授权与路由一并清理。本页提交的申请只生成工单，发放动作在审批执行后生效（网关侧 Key 与配额由网关执行并回执）。
            </div>
          </div>
          <div className="col gap6">
            <div className="small strong">训练数据密级决定可用网络平面与池</div>
            <div className="small muted">
              密级「内部 / 已脱敏」可用训练资源池并可与共享池错峰；<b>敏感数据不得进共享池</b>，须在专用网络内训练并留痕。
              单算例 1–8 卡、1–72 小时，更大任务拆多笔申请便于逐笔回收；到期时间由任务号与时长推导，超长期占用要单独排期并走窗口审批。
            </div>
            <div className="divider" />
            <div className="small strong">接真实系统时要对齐的两件事</div>
            <Callout
              text={
                <>
                  真实环境这套审批要接客户方 <b>OA / 工单系统</b>（外部接入配置中心里的「OA / 工单系统」通道，双向：审批节点 ↔ 平台工单、办结状态回写）；
                  训练平台的任务事件与数据版本绑定走「模型训练平台」通道。接口清单已挂在外部接入配置中心，改配置即改平台能力，不改页面代码。
                </>
              }
            />
          </div>
        </div>
      </Panel>

      <Panel title="数据来源与流程留痕" extra={`当前取数模式：${tele.mode} · ${tele.generatedAt}`} className="mt14">
        <div className="grid g-21">
          <div className="col gap6">
            <Table
              minWidth={820}
              head={['环节', '本页怎么来', '接真实系统时要提供的接口']}
              rows={[
                [
                  <span className="small strong">申请人身份</span>,
                  <span className="small">演示账号（本地权限矩阵）· 当前 {applicant}（{dept}）</span>,
                  <span className="small">统一身份认证 / 零信任（OIDC / CAS 票据）+ 组织与地市口径（账号、组织、角色映射）</span>,
                ],
                [
                  <span className="small strong">审批人与权限</span>,
                  <span className="small">权限矩阵 approve / workflow 两点决定按钮可用性（当前可审批：{canApprove ? '是' : '否'}）</span>,
                  <span className="small">审批人名单与角色映射（谁可审批哪一类、限额分级）、双人复核记录回写</span>,
                ],
                [
                  <span className="small strong">工单流转</span>,
                  <span className="small">平台内工单引擎（提交 / 准入 / 审批 / 执行 / 回滚 / 闭环 + 逐条轨迹）</span>,
                  <span className="small">OA 工单双向同步：审批节点 ↔ 平台工单状态、办结与驳回理由回写</span>,
                ],
                [
                  <span className="small strong">生效动作</span>,
                  <span className="small">Key 发放与训练卡位由平台执行并写台账；模型部署等容器平台回执</span>,
                  <span className="small">网关 Key 下发回执、训练平台任务创建与卡位回执、容器平台部署回执（deploy.json）</span>,
                ],
                [
                  <span className="small strong">数据密级校验</span>,
                  <span className="small">申请时由申请人填写密级标签，准入按密级与空闲卡位计算</span>,
                  <span className="small">训练数据密级校验来源（数据目录 / 密级标签权威源 + 网络平面白名单）</span>,
                ],
              ]}
            />
          </div>
          <div className="col gap6">
            <Callout
              text={
                <>
                  本页数据全部平台内闭环（当前取数模式：{tele.mode}）：工单、Key、训练台账、卡位与配额都来自平台自己的账本与工单引擎，
                  不依赖外部系统也能完整演示申请 → 审批 → 生效 → 归还。
                  接真实系统时按左列接口清单对接，字段口径在外部接入配置中心里逐条确认。
                </>
              }
            />
            <div className="tiny faint">本页工单类型：{APPLY_TYPES.map((t) => TYPE_LABEL[t]).join(' / ')}（+ 归还卡位 {TYPE_LABEL.train_release}）</div>
            <div className="small">
              当前统计：我的申请 {mine.length} · 待审批 {pending.length} · 已审批/执行 {decided.length} · 排队 {queuedAll.length}
            </div>
            <div className="row gap6">
              <Link to="/ops/workflow" className="btn sm ghost">资源调配工作台</Link>
              <Link to="/ops/integrations" className="btn sm ghost">外部接入配置中心</Link>
              <Link to="/model/credentials" className="btn sm ghost">凭证与配额</Link>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
