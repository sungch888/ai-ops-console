/* =====================================================================
 * 模型中心 · 模型部署与发布
 * 口径：平台只「发单 + 准入校验 + 审批」，真正的部署动作由容器平台在目标节点执行；
 *      工单 external（已下发·待回执）→ 执行回执到位 → 才执行生效（占用卡位、副本变化）。
 * 本页面只调用引擎既有 API：submit / approve / reject / dispatch / receipt / rollback / close
 * 权限点说明：权限矩阵（engine/auth.ts 的 PermKey）里没有「model」这一项，
 *            模型中心的功能点挂 gateway（与 model/assets、model/gateway 同源），
 *            这里用 usePerm('gateway') 取 { view, manage }。
 * ===================================================================== */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertBadge, Badge, Callout, PageHead, Panel, Progress, Table } from '../../components/ui'
import { connectorStore, readiness, useConnectors } from '../../engine/connectors'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'
import { currentAccount, usePerm } from '../../engine/auth'
import { deployReceipts, inferenceServices, sourceHint, useTelemetry } from '../../engine/telemetry'
import {
  EXTERNAL_TYPES, ORDER_STATUS_LABEL, TYPE_LABEL, engine, poolFree, poolUtil, useEngine,
  type Level, type Order, type OrderStatus, type PoolId,
} from '../../engine/engine'

const NEW_MODEL = 'DeepSeek-V3-R1'
const NEW_MODEL_LABEL = '新模型：DeepSeek-V3-R1（内网新部署）'
/** 「超时未回执」判定：下发后 30 分钟没有回执即在页面标出 */
const TIMEOUT_MS = 30 * 60 * 1000
const LEVELS: Level[] = ['高保', '共享', '灰度']
const GRAY_OPTS = [10, 30, 50, 100]

const STATUS_TONE: Record<OrderStatus, 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'purple'> = {
  to_biz: 'purple', submitted: 'warn', approved: 'info', queued: 'warn', external: 'purple',
  running: 'info', closed: 'good', rejected: 'bad', rolled_back: 'muted',
}
function utilTone(u: number): '' | 'warn' | 'bad' | 'green' { return u > 90 ? 'bad' : u > 75 ? 'warn' : 'green' }
function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 红 / 黄状态的工单徽章：带 jump 就可点，落到能动手的那一行（本页看板 / 工作台排期） */
function OrderBadge({ status, jump }: { status: OrderStatus; jump?: AlertJump }) {
  const tone = STATUS_TONE[status]
  const alert = jump && (tone === 'warn' || tone === 'bad') ? (tone as 'warn' | 'bad') : null
  return alert
    ? <AlertBadge tone={alert} jump={jump!}>{ORDER_STATUS_LABEL[status]}</AlertBadge>
    : <Badge tone={tone}>{ORDER_STATUS_LABEL[status]}</Badge>
}

/* ---------------- 看板行内的交互单元（各自持有行内输入状态） ---------------- */
function RejectCell({ id, manage }: { id: string; manage: boolean }) {
  const [txt, setTxt] = useState('部署参数或空闲卡位不足，请调整后重新提交')
  return (
    <div className="col gap6">
      <input className="btn sm" style={{ width: 200 }} value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="驳回理由" />
      <button className="btn sm danger" disabled={!manage || !txt.trim()} onClick={() => engine.reject(id, txt.trim())}>驳回工单</button>
    </div>
  )
}

/** approved → 下发容器平台（engine.dispatch 自带门禁：只有 model_deploy 且必须先是 approved） */
function DispatchCell({ id, manage }: { id: string; manage: boolean }) {
  const [note, setNote] = useState('')
  return (
    <div className="col gap6">
      <button
        className="btn sm primary"
        disabled={!manage}
        onClick={() => {
          const r = engine.dispatch(id)
          setNote(r.ok ? '已下发容器平台 · 等待执行回执（回执到位前卡位不占用、副本不变）' : `下发被拒：${r.reason}`)
        }}
      >
        下发容器平台
      </button>
      {note ? <span className="tiny" style={{ color: 'var(--text-dim)', maxWidth: 220 }}>{note}</span> : null}
    </div>
  )
}

/** external → 回执回填（成功才生效；失败只记台账、不动资源） */
function ReceiptCell({ o, manage }: { o: Order; manage: boolean }) {
  const [result, setResult] = useState('成功')
  const [detail, setDetail] = useState('容器平台已按工单参数完成部署，实例就绪并通过健康探针')
  const [inst, setInst] = useState(`mindie-${String(o.spec.model ?? 'model').toLowerCase().replace(/[^a-z0-9]/g, '-')}-0/1`)
  const [err, setErr] = useState('')
  return (
    <div className="col gap6">
      <select className="btn sm" value={result} onChange={(e) => setResult(e.target.value)} disabled={!manage}>
        <option value="成功">回执结果：成功</option>
        <option value="失败">回执结果：失败</option>
      </select>
      <input className="btn sm" style={{ width: 210 }} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="执行说明（回执必填）" />
      <input className="btn sm mono" style={{ width: 210 }} value={inst} onChange={(e) => setInst(e.target.value)} placeholder="实例清单" />
      <button
        className="btn sm primary"
        disabled={!manage || detail.trim().length === 0}
        onClick={() => {
          const r = engine.receipt(o.id, result === '成功', detail, inst)
          if (!r.ok) setErr(`回执回填被拒：${r.reason}`)
        }}
      >
        回填回执
      </button>
      {err ? <span className="tiny" style={{ color: 'var(--bad-text)', maxWidth: 220 }}>{err}</span> : null}
    </div>
  )
}

export default function ModelDeploy() {
  const st = useEngine()
  const tele = useTelemetry()
  useConnectors()
  const perm = usePerm('gateway')
  /* 告警直达口径（本页红 / 黄提示都落到具体那一行）
     部署工单（待审批 / 已驳回 / 回执超时）→ Jump.deployOrder(工单 id)：看板那一行有审批 / 下发 / 回填回执
     排队待窗口 → Jump.order(工单 id)：窗口排期在资源调配工作台做
     池卡位不足 → pick = 资源池 id（生效对照的池表那一行）
     通道未启用 / 接口待商定 / 前置未完 → Jump.connector('c-deploy') */
  const pick = useAlertPick()
  usePickFlash(pick)
  const account = currentAccount()
  const applicant = account?.name ?? '演示用户'
  const dept = account?.dept ?? '演示单位'

  const models = st.models
  const admitted = (st.artifacts ?? []).filter((a) => a.state === '准入通过')
  const [model, setModel] = useState('Qwen2.5-VL')
  const picked = models.find((m) => m.short === model)
  const [version, setVersion] = useState(picked?.ver ?? '')
  const [pool, setPool] = useState<PoolId>(picked?.pool ?? 'shared')
  const [replicas, setReplicas] = useState(1)
  const [perReplica, setPerReplica] = useState(picked?.perReplica ?? 2)
  const [gray, setGray] = useState(30)
  const [nodes, setNodes] = useState('AI-Infer-03 / AI-Infer-04')
  const [image, setImage] = useState('mindie:2.1.qwen3')
  const [level, setLevel] = useState<Level>('灰度')
  const [reason, setReason] = useState('灰度放量新增承载：按部署工单下发容器平台执行，回执到位后副本与卡位才生效')
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string; jump?: AlertJump } | null>(null)

  const pickModel = (v: string) => {
    setModel(v)
    const m = models.find((x) => x.short === v)
    if (m) {
      setVersion(m?.ver ?? '')
      setPool(m.pool ?? 'shared')
      setPerReplica(m.perReplica ?? 2)
      return
    }
    const a = admitted.find((x) => x.model === v)
    if (a) { setVersion(a.version); setPool('shared'); setPerReplica(1) }
  }

  const specOf = (patch?: Record<string, number | string>): Record<string, number | string> => ({
    pool, model, replicas, perReplica, version, gray, nodes, image, ...patch,
  })
  const showSubmitResult = (r: { order: Order; precheck: { ok: boolean; reason?: string; suggest?: string } }, tag: string) => {
    if (r.precheck.ok) setMsg({ tone: 'good', text: `${tag}${r.order.id} 已提交（申请方 ${applicant} · ${dept}）· 准入通过：${r.precheck.suggest ?? ''}`, jump: Jump.deployOrder(r.order.id, '到看板这一行审批 / 下发') })
    else setMsg({ tone: 'bad', text: `${tag}${r.order.id} 提交即被准入校验驳回：${r.precheck.reason ?? ''}`, jump: Jump.deployOrder(r.order.id, '到看板这一行看驳回理由，改参数重提') })
  }

  const doSubmit = () => showSubmitResult(engine.submit({ type: 'model_deploy', applicant, dept, level, reason, spec: specOf() }), '')

  /** 演示：故意提交不合格参数（版本不在版本清单 / 目标节点为空），把准入拒绝理由原样显示 */
  const demoBadParams = () => {
    const base = models[0] ?? picked
    const basePool = base?.pool ?? pool
    const r1 = engine.submit({
      type: 'model_deploy', applicant, dept, level,
      reason: '演示：故意把版本写成 v9.9（不在版本清单）',
      spec: { pool: basePool, model: base?.short ?? model, replicas: 1, perReplica: 1, version: 'v9.9', gray, nodes, image },
    })
    const r2 = engine.submit({
      type: 'model_deploy', applicant, dept, level,
      reason: '演示：故意不写目标节点（容器平台不知道在哪些节点执行）',
      spec: { pool: basePool, model: base?.short ?? model, replicas: 1, perReplica: 1, version: '', gray, nodes: '', image },
    })
    const text1 = r1.precheck.ok ? `准入却通过了（${r1.precheck.suggest ?? ''}）` : `准入拒绝：${r1.precheck.reason ?? ''}`
    const text2 = r2.precheck.ok ? `准入却通过了（${r2.precheck.suggest ?? ''}）` : `准入拒绝：${r2.precheck.reason ?? ''}`
    setMsg({ tone: 'bad', text: `演示 1 · ${r1.order.id} 版本 v9.9 → ${text1} ；演示 2 · ${r2.order.id} 节点留空 → ${text2}`, jump: Jump.deployOrder(r1.order.id, '到看板这一行看准入驳回理由') })
  }

  const deploys = st.orders.filter((o) => o.type === 'model_deploy')
  const bizPending = deploys.filter((o) => o.status === 'to_biz')
  const pending = deploys.filter((o) => o.status === 'submitted')
  const waitReceipt = deploys.filter((o) => o.status === 'external')
  const executing = deploys.filter((o) => o.status === 'running')
  const queuedAll = st.orders.filter((o) => o.status === 'queued')
  const conn = connectorStore.find('c-deploy')
  const connJump = Jump.connector('c-deploy', '去外部对接清单看「容器平台部署与执行回执」这条接入')
  const orderJump = (o: Order): AlertJump => (o.status === 'queued'
    ? Jump.order(o.id, '去资源调配工作台排这张工单的变更窗口')
    : Jump.deployOrder(o.id, '到看板这一行：审批 / 下发 / 回填回执'))
  const poolJump = (id: string): AlertJump => ({ page: '/model/deploy', pick: id, label: '看这个池还剩多少空闲卡位：换池或先提扩容' })
  const recs = deployReceipts()
  const recMismatch = recs.find((r) => !st.orders.find((o) => o.id === r.orderId))
  const applied = (id: string) => {
    const o = st.orders.find((x) => x.id === id)
    return o ? ORDER_STATUS_LABEL[o.status] : '工单不存在'
  }
  const hint = sourceHint('deploy')
  const services = inferenceServices()

  return (
    <div>
      <PageHead
        title="模型部署与发布"
        desc="平台发单 + 准入校验 + 审批；部署动作由容器平台执行，执行回执到位才生效"
        extra={
          <>
            {pending.length
              ? <AlertBadge tone="warn" jump={Jump.deployOrder(pending[0].id, '到看板这一行审批这张部署工单')}>待审批 {pending.length}</AlertBadge>
              : <Badge tone="good">待审批 0</Badge>}
            <Badge tone="purple">待回执 {waitReceipt.length}</Badge>
            <Badge tone="info">执行中 {executing.length}</Badge>
            <Badge tone={tele.mode === '采集层' ? 'good' : 'muted'}>取数来源：{tele.mode}</Badge>
          </>
        }
      />

      <Callout
        warn
        text={
          <>
            <b>口径说明：</b>平台不下发容器指令。工单流转为 提交 → 准入校验 → 审批 → <b>已下发·待回执</b> → 回执到位 → 执行生效（占用卡位、副本变化）→ 可回滚。
            <br />
            回执未到位前：<b>卡位不占用、副本不变</b>，本页面的「生效对照」不会变。需要回执的工单类型：{EXTERNAL_TYPES.map((t) => TYPE_LABEL[t]).join(' / ')}；
            执行通道配置见外部接入配置中心的「{conn?.name ?? '容器平台部署与执行回执'}」。
            <br />
            <span className="tiny">
              这类工单审批通过后<b>不会自动生效</b>：要么先下发再等回执，要么直接等采集层把回执取回来。回执到位后平台才做生效登记（不再占用变更窗口）；其他类型工单仍走变更窗口，排队工单可在 <Link to="/ops/workflow" className="btn sm ghost">资源调配工作台 / 变更窗口排期</Link> 处理。
            </span>
          </>
        }
      />

      {msg ? <div style={{ marginTop: 6 }}><Callout warn={msg.tone === 'bad'} text={msg.text} jump={msg.jump} /></div> : null}

      <Panel
        title="部署申请表单（平台发单）"
        extra={perm.manage ? `申请方 ${applicant} · ${dept}` : <span className="tiny faint">只读</span>}
        className="mt14"
      >
        <div className="grid g-21">
          <div className="col gap6">
            <div className="row gap6 wrap">
              <div>
                <div className="tiny faint">模型（简称 / 新模型）</div>
                <select className="btn sm" style={{ marginTop: 4, width: 260 }} disabled={!perm.manage} value={model} onChange={(e) => pickModel(e.target.value)}>
                  {models.map((m) => <option key={m.short} value={m.short}>{m.short}（{m.pool === 'hp' ? '高保集群' : m.pool === 'shared' ? '共享集群' : '训练池'} · {m.ver}）</option>)}
                  {admitted.filter((a) => !models.some((m) => m.short === a.model)).map((a) => <option key={a.id} value={a.model}>{a.model}（准入通过 {a.version} · 来自 {a.id}）</option>)}
                  <option value={NEW_MODEL}>{NEW_MODEL_LABEL}</option>
                </select>
              </div>
              <div>
                <div className="tiny faint">版本（留空 = 沿用当前版本；不在版本清单会被拒）</div>
                <input className="btn sm mono" style={{ marginTop: 4, width: 150 }} disabled={!perm.manage} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="如 v2.3" />
              </div>
              <div>
                <div className="tiny faint">资源池</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={pool} onChange={(e) => setPool(e.target.value as PoolId)}>
                  {st.pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">调度等级</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                  {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="row gap6 wrap">
              <div>
                <div className="tiny faint">副本数（1–8）</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" min={1} max={8} disabled={!perm.manage} value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} />
              </div>
              <div>
                <div className="tiny faint">每副本卡位</div>
                <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" min={1} max={8} disabled={!perm.manage} value={perReplica} onChange={(e) => setPerReplica(Number(e.target.value))} />
              </div>
              <div>
                <div className="tiny faint">灰度比例（1–100）</div>
                <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={gray} onChange={(e) => setGray(Number(e.target.value))}>
                  {GRAY_OPTS.map((g) => <option key={g} value={g}>{g}%</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">本次要占卡位</div>
                <span className="strong num" style={{ marginLeft: 6 }}>{replicas * (perReplica || 1)} 卡</span>
                <span className="tiny faint" style={{ marginLeft: 6 }}>目标池空闲 {poolFree(st, pool)} 卡 · 利用率 {poolUtil(st, pool)}%</span>
              </div>
            </div>
            <div className="row gap6 wrap">
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="tiny faint">目标节点（不能空 · 容器平台在这些节点执行）</div>
                <input className="btn sm mono" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={nodes} onChange={(e) => setNodes(e.target.value)} placeholder="AI-Infer-03 / AI-Infer-04" />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="tiny faint">镜像与版本（不能空 · 回执要能对上镜像）</div>
                <input className="btn sm mono" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={image} onChange={(e) => setImage(e.target.value)} placeholder="mindie:2.1.qwen3" />
              </div>
            </div>
            <div>
              <div className="tiny faint">申请理由（变更台账与审计要看）</div>
              <textarea className="btn sm" style={{ width: '100%', minHeight: 56 }} disabled={!perm.manage} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="row gap6 wrap">
              <button className="btn primary" disabled={!perm.manage} onClick={doSubmit}>提交部署工单</button>
              <button className="btn ghost" disabled={!perm.manage} onClick={demoBadParams}>演示：提交一个不合格参数</button>
              {!perm.manage ? <span className="tiny faint">只读</span> : null}
            </div>
          </div>

          <div className="col gap6">
            <div className="tiny faint">准入要看的键（引擎 model_deploy 实际校验项）</div>
            <div className="small muted">
              pool（hp / shared / train）· model（模型简称或新模型名）· replicas（1–8）· perReplica · version（可空，若在版本清单外会被拒）· gray（1–100）· nodes（不能空）· image（不能空）·
              <b> 新模型或清单外版本：必须有「准入通过」的权重登记</b>（训练台账登记权重 → 审批台准入审核 → 可部署清单，原文 2.4-1 / 2.5-1；下拉里标「准入通过」的即可直接选）
            </div>
            <div className="divider" />
            <div className="small">
              当前填写：{model}{version ? ` ${version}` : '（版本留空）'} → {st.pools.find((p) => p.id === pool)?.name ?? pool}<br />
              {replicas} 副本 × {perReplica || 1} 卡 = {replicas * (perReplica || 1)} 卡 · 灰度 {gray}%<br />
              节点 <span style={{ color: nodes.trim() ? undefined : 'var(--bad-text)' }}>{nodes.trim() ? nodes : '（未填）'}</span> · 镜像 <span style={{ color: image.trim() ? undefined : 'var(--bad-text)' }}>{image.trim() ? image : '（未填）'}</span>
            </div>
            <Callout warn={replicas * (perReplica || 1) > poolFree(st, pool)} text={`目标池空闲 ${poolFree(st, pool)} 卡；不足时准入直接拒绝，先做池扩容或换池。`}
              jump={replicas * (perReplica || 1) > poolFree(st, pool) ? poolJump(pool) : undefined} />
          </div>
        </div>
      </Panel>

      <Panel title="部署工单看板" extra={`共 ${deploys.length} 条 · 待业务确认 ${bizPending.length} · 待平台审批 ${pending.length} · 待回执 ${waitReceipt.length} · 执行中 ${executing.length}`} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1180}
            rowKeys={deploys.map((o) => o.id)} pick={pick}
            head={['工单', '模型 / 池', '参数', '状态', '下发与回执', '动作']}
            rows={deploys.map((o) => {
              const stale = o.status === 'external' && Date.now() - (o.decidedAt ?? o.createdAt) > TIMEOUT_MS
              const inst = o.spec.instances ? String(o.spec.instances) : ''
              const note = o.spec.receiptNote ? String(o.spec.receiptNote) : ''
              return [
                <span className="mono small strong">{o.id}</span>,
                <span className="small">
                  <span className="strong">{String(o.spec.model)}</span>
                  <div className="tiny faint">{st.pools.find((p) => p.id === String(o.spec.pool))?.name ?? String(o.spec.pool)} · {o.applicant}</div>
                  <div className="tiny faint mono">{o.spec.version ? String(o.spec.version) : '版本沿用当前'}</div>
                </span>,
                <span className="small">
                  {Number(o.spec.replicas)} 副本 × {Number(o.spec.perReplica) || 1} 卡
                  <div className="tiny faint">灰度 {Number(o.spec.gray ?? 100)}%</div>
                  <div className="tiny faint mono">{String(o.spec.nodes || '（未填节点）')} · {String(o.spec.image || '（未填镜像）')}</div>
                  {o.spec.resolvedVersion ? <div className="tiny faint">发起时锁定 · 审批与下发只判能否执行，改参数须驳回重提</div> : null}
                </span>,
                <div className="col gap6">
                  <OrderBadge status={o.status} jump={orderJump(o)} />
                  {o.status === 'queued' ? <AlertBadge tone="warn" jump={Jump.order(o.id, '去工作台看这张工单排第几位、窗口什么时候开放')}>窗口队列位次 {queuedAll.findIndex((q) => q.id === o.id) + 1}</AlertBadge> : null}
                  {o.decidedAt ? <span className="tiny faint mono">{fmtTime(o.decidedAt)} · {o.decidedBy ?? ''}</span> : null}
                </div>,
                <div className="col gap6">
                  {inst ? <span className="small mono">{inst}</span> : <span className="tag gray">未回执</span>}
                  {note ? <span className="tiny" style={{ color: 'var(--ok-text)', maxWidth: 220 }}>{note}</span> : null}
                  {stale ? <AlertBadge tone="bad" jump={Jump.deployOrder(o.id, '到这一行回填执行回执 / 看为什么没回执')}>回执超时</AlertBadge> : null}
                  {stale ? <span className="tiny" style={{ color: 'var(--bad-text)' }}>下发已超 {Math.round((Date.now() - (o.decidedAt ?? o.createdAt)) / 60000)} 分钟无回执，按告警口径通知容器平台归口</span> : null}
                </div>,
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  {o.status === 'to_biz' ? (
                    <>
                      <button
                        className="btn sm primary"
                        disabled={!perm.manage}
                        onClick={() => {
                          const r = engine.bizConfirm(o.id, applicant) as unknown as { ok: boolean; reason?: string }
                          setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${o.id} 业务管理审批通过（需求合理、归口与成本已确认）→ 转平台审批；平台只判能否满足执行，不再改需求参数` : `业务确认失败：${r.reason ?? ''}` })
                        }}
                      >
                        业务管理确认
                      </button>
                      <RejectCell id={o.id} manage={perm.manage} />
                      <span className="tiny faint">先业务后平台 · 顺序不可绕过</span>
                    </>
                  ) : null}
                  {o.status === 'submitted' ? (
                    <>
                      <button
                        className="btn sm primary"
                        disabled={!perm.manage}
                        onClick={() => {
                          const r = engine.approve(o.id) as unknown as { ok: boolean; hold?: boolean; reason?: string }
                          if (!r.ok) { setMsg({ tone: 'bad', text: `${o.id} 审批未通过：${r.reason ?? ''}${r.hold ? '（工单挂起保持待审批，未下发容器平台；资源到位可再审，要改参数请驳回重提）' : ''}` }); return }
                          const after = engine.get().orders.find((x) => x.id === o.id)
                          const s = after?.status ?? 'approved'
                          const tail = s === 'approved' ? '：下发时会再按最新资源重验一次，通过后下发容器平台等回执'
                            : s === 'queued' ? '：已进变更窗口队列，窗口开放后自动接续（可在资源调配工作台 / 变更窗口排期处理）'
                            : '：变更窗口空闲，引擎已直接接续执行并占用卡位（演示口径），可点「回滚」恢复'
                          setMsg({ tone: 'good', text: `${o.id} 审批通过（判定：当前能满足执行）→ 当前状态「${ORDER_STATUS_LABEL[s]}」${tail}` })
                        }}
                      >
                        审批通过
                      </button>
                      <RejectCell id={o.id} manage={perm.manage} />
                      <button
                        className="btn sm ghost"
                        disabled={!perm.manage}
                        onClick={() => {
                          const r = engine.dispatch(o.id)
                          setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${o.id} 已下发容器平台执行，等待回执（卡位仍不占用）` : `${o.id} 先下发被门禁拒绝：${r.reason}` })
                        }}
                      >
                        先试下发（看门禁）
                      </button>
                    </>
                  ) : null}
                  {o.status === 'approved' ? <DispatchCell id={o.id} manage={perm.manage} /> : null}
                  {o.status === 'external' ? <ReceiptCell o={o} manage={perm.manage} /> : null}
                  {o.status === 'queued' ? (
                    <>
                      <span className="tiny faint">排队待窗口 · 回执与执行都在窗口开放后接续</span>
                      <Link to="/ops/workflow" className="btn sm ghost">去排期 / 工作台</Link>
                    </>
                  ) : null}
                  {o.status === 'running' ? (
                    perm.manage ? (
                      <>
                        <button className="btn sm" onClick={() => { engine.rollback(o.id); setMsg({ tone: 'good', text: `${o.id} 已回滚：副本与版本恢复到部署前，卡位归还，路由与凭证不受影响` }) }}>回滚</button>
                        <button className="btn sm ghost" onClick={() => { engine.close(o.id); setMsg({ tone: 'good', text: `${o.id} 已闭环归档，变更窗口已释放` }) }}>闭环</button>
                      </>
                    ) : <span className="tiny faint">只读</span>
                  ) : null}
                  {o.status === 'closed' ? <span className="tiny faint">已闭环 · 台账保留</span> : null}
                  {o.status === 'rolled_back' ? <span className="tiny faint">已回滚 · 卡位已归还</span> : null}
                  {o.status === 'rejected' ? <AlertBadge tone="bad" jump={orderJump(o)}>{o.rejectReason ?? '已驳回'}</AlertBadge> : null}
                </div>,
              ]
            })}
          />
          {deploys.length === 0 ? <Callout text={`当前还没有部署工单。提交一条后，看板按 ${ORDER_STATUS_LABEL.submitted} → ${ORDER_STATUS_LABEL.external} → ${ORDER_STATUS_LABEL.running} 推进。`} /> : null}
        </div>
      </Panel>

      <Panel title="容器平台执行回执（采集层取回）" extra={`采集层 ${recs.length} 条 · 本页待回执 ${waitReceipt.length} 条`} className="mt14" noPad>
        <div className="panel-body">
          {recs.length === 0 ? (
            <div className="col gap6">
              <div className="small">采集层目前没有回执。</div>
              <div className="tiny faint">
                回执接口联调好之后（`collector/config.json` 里填 <span className="mono">deploy.base</span> 与 <span className="mono">env:DEPLOY_TOKEN</span>），每轮取数都会把结果落到这一栏；
                运维也可以把回执写进 <span className="mono">collector/receipts.json</span>（优先读这个文件）。现场没有接口时，用上方看板里的「回填执行回执」手工演示同一条流程。
              </div>
              <div className="tiny">回执字段约定：工单号原样回传 · 结果（成功 / 失败）· 实例清单 · 镜像 · 目标节点 · 完成时间 · 说明。</div>
            </div>
          ) : (
            <>
              <Table
                minWidth={1150}
                rowKeys={recs.map((r) => r.orderId)} pick={pick}
                head={['回执对应工单', '结果', '实例清单', '镜像', '目标节点', '完成时间', '工单当前状态', '动作']}
                rows={recs.map((r) => {
                  const o = st.orders.find((x) => x.id === r.orderId)
                  const canApply = o && o.status === 'external'
                  return [
                    <span className="small mono">{r.orderId}</span>,
                    r.result === '成功' ? <Badge tone="good">{r.result}</Badge> : <AlertBadge tone="bad" jump={Jump.deployOrder(r.orderId, '到看板这一行处理执行失败的回执（不占卡位、副本不变）')}>{r.result}</AlertBadge>,
                    <span className="tiny mono">{r.instances || '（回执未附实例清单）'}</span>,
                    <span className="tiny mono">{r.image || '—'}</span>,
                    <span className="tiny">{r.nodes || '—'}</span>,
                    <span className="tiny faint mono">{r.finishedAt || '—'}</span>,
                    <span className="small">{o ? <OrderBadge status={o.status} jump={orderJump(o)} /> : <span className="tag gray">工单不存在</span>}</span>,
                    canApply ? (
                      <button
                        className="btn sm"
                        disabled={!perm.manage}
                        onClick={() => {
                          const res = engine.receipt(r.orderId, r.result === '成功', r.note || '容器平台采集层回执（无附加说明）', r.instances)
                          setMsg({ tone: r.result === '成功' ? 'good' : 'bad', text: res.ok ? `${r.orderId} 已按采集层回执${r.result === '成功' ? '生效：副本与卡位已登记' : '记为执行失败：卡位未占用、副本未变'}${r.instances ? ` · 实例 ${r.instances}` : ''}` : `${r.orderId} 回执处理失败：${res.reason}` })
                        }}
                      >按这条回执{r.result === '成功' ? '生效' : '记失败'}</button>
                    ) : <span className="tiny faint">{o ? '该工单已处理过' : '工单号对不上，先对账'}</span>,
                  ]
                })}
              />
              <div style={{ marginTop: 8 }}>
                <Callout warn text={<>这一栏只写采集层真正取回来的回执，平台不猜、不编。工单号对不上（外部系统改了编号规则）会在这一栏直接暴露出来，选型阶段就要把「工单号原样回传」写进接口约定。{recMismatch ? <>当前就对不上：<span className="mono">{recMismatch.orderId}</span> 在这张看板里找不到 —— 点这条直接去接入配置核对回执字段约定。</> : null}</>}
                  jump={recMismatch ? connJump : undefined} />
              </div>
            </>
          )}
        </div>
      </Panel>

      <Panel title="生效对照（模型与卡位）" extra="回执到位执行后这里才变" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={900}
            head={['模型', '当前版本', '版本清单', '副本', '每副本卡位', '占用卡位', '池', '状态']}
            rows={models.map((m) => [
              <span className="small strong">{m.short}<div className="tiny faint">{m.name}</div></span>,
              <span className="mono small">{m.ver}</span>,
              <span className="mono tiny faint">{m.versions.join(' / ')}</span>,
              <span className="num">{m.replicas}</span>,
              <span className="num">{m.perReplica}</span>,
              <span className="num strong">{m.replicas * m.perReplica}</span>,
              <span className="small">{st.pools.find((p) => p.id === m.pool)?.name ?? m.pool}</span>,
              <Badge tone={m.state === '运行中' ? 'good' : 'muted'}>{m.state}</Badge>,
            ])}
          />
          <div style={{ marginTop: 6 }}>
            <Table
              minWidth={760}
              head={['资源池', '卡数', '空闲卡位', '利用率', '占用进度']}
              rowKeys={st.pools.map((p) => p.id)} pick={pick}
              rows={st.pools.map((p) => {
                const u = poolUtil(st, p.id)
                return [
                  <span className="small strong">{p.name}<div className="tiny faint mono">{p.id}</div></span>,
                  <span className="num">{p.cards}</span>,
                  <span className="num">{poolFree(st, p.id)}</span>,
                  <span className="num">{u}%</span>,
                  <Progress value={u} tone={utilTone(u)} jump={utilTone(u) === 'green' ? undefined : poolJump(p.id)} />,
                ]
              })}
            />
          </div>
          <Callout text="回执到位执行后这里才变：副本增加或新增模型条目、池空闲卡位减少、利用率上升。回滚会把副本与版本恢复到部署前，卡位归还，路由与凭证不受影响。" />
          <div style={{ marginTop: 6 }}>
            <div className="tiny faint">MindIE 侧实例视角（来源：{hint.file} 采集层，未接采集层时由平台模型与副本同源推导）</div>
            <div style={{ marginTop: 6 }}>
              <Table
                minWidth={860}
                head={['服务', '模型', '版本', '实例 / 就绪', '卡位', '首包 ttft', '错误率']}
                rows={services.map((s) => [
                  <span className="mono small">{s.service}</span>,
                  <span className="small">{s.model}</span>,
                  <span className="mono small">{s.version}</span>,
                  s.ready < s.instances ? <AlertBadge tone="warn" jump={Jump.monitorTarget(s.service, '到这个服务的监控行：副本未起，提交扩容')}>{s.instances} / {s.ready} 未就绪</AlertBadge> : <span className="num">{s.instances} / {s.ready}</span>,
                  <span className="num">{s.cards}</span>,
                  <span className="num">{s.ttftMs} ms</span>,
                  s.errPct >= 4 ? <AlertBadge tone="bad" jump={Jump.monitorTarget(s.service, '到这个服务的监控行看错误率并处置')}>{s.errPct}% 错误率</AlertBadge> : <span className="num">{s.errPct}%</span>,
                ])}
              />
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="容器平台执行通道" extra={conn ? `${conn.name} · v${conn.version} · 归口 ${conn.owner}` : '未找到通道配置'} className="mt14">
        {conn ? (
          <div className="col gap6">
            <div className="row gap6 wrap">
              <span className="small strong">{conn.name}</span>
              {(conn.enabled && conn.health === 'ok') ? <Badge tone="good">通道已启用</Badge>
  : <AlertBadge tone={conn.enabled ? 'warn' : 'bad'} jump={connJump}>{conn.enabled ? '通道健康异常' : '通道未启用'}</AlertBadge>}
              {(conn.status === '已定') ? <Badge tone="good">接口状态 {conn.status}</Badge>
                : conn.status === '待商定' ? <AlertBadge tone="warn" jump={connJump}>接口状态 {conn.status}</AlertBadge>
                : <Badge tone="muted">接口状态 {conn.status}</Badge>}
              <span className="tag gray">{conn.transport}</span>
              <span className="tag gray">{conn.mode === 'real' ? '真实接口' : '虚拟模拟'}</span>
              <span className="tag gray">{conn.direction}</span>
              <Link to="/ops/integrations" className="btn sm ghost">去外部接入配置中心</Link>
            </div>
            <div className="small">
              地址：<span className="mono">{conn.endpoint}</span> · 鉴权：{conn.auth} · 频率：{conn.intervalSec === 0 ? '工单触发' : `${conn.intervalSec} 秒`} · 超时 {conn.timeoutMs} ms · 重试 {conn.retries} · 降级：{conn.fallback}
            </div>
            <div className="small">采集项（回执要带回的内容）：{conn.dataItems}</div>
            <Callout warn jump={connJump} text={<>卡点 / 归口口径：{conn.blocking}（点这条落到外部对接清单里这条接入，卡点在配置层改）</>} />
            <div className="divider" />
            <div className="tiny faint">前置条件对照（全部完成才具备真实接入条件）</div>
            <div className="col gap6">
              {conn.prereq.map((p) => (
                <div key={p} className="row gap6">
                  {conn.prereqDone.includes(p) ? <Badge tone="good">已完</Badge> : <AlertBadge tone="warn" jump={connJump}>未完</AlertBadge>}
                  <span className="small">{p}</span>
                </div>
              ))}
            </div>
            <div className="tiny faint">切换真实接口前还缺：{readiness(conn).length ? readiness(conn).join(' / ') : '无（已就绪）'}</div>
            <div className="divider" />
            <div className="tiny faint">配置变更历史</div>
            <div className="col gap6">
              {conn.changes.map((c) => (
                <div key={`${c.time}-${c.text}`} className="small">
                  <span className="mono faint tiny">{c.time}</span> {c.text}
                </div>
              ))}
            </div>
            <Callout
              text={
                <>
                  真实环境要容器平台确认两件事：① 回执字段字典（result 结果 / instances 实例清单 / image 镜像 / nodes 节点 / finished_at 完成时间 + note），
                  与本页「回填回执」和 {hint.file} 的字段一一对应；② 「超时未回执」的告警口径（本平台按下发后 {Math.round(TIMEOUT_MS / 60000)} 分钟标「回执超时」并通知归口 {conn.owner}）。
                  平台侧门禁已就绪：未审批不可下发、未回执不生效、生效后可回滚。
                </>
              }
            />
          </div>
        ) : (
          <Callout warn text="未找到 c-deploy 接入配置：可在外部接入配置中心新增「容器平台部署与执行回执」通道后再演示。" jump={connJump} />
        )}
      </Panel>

      <Panel title="数据来源与接口清单（部署回执）" extra={`${hint.name} · ${hint.file}`} className="mt14">
        <div className="grid g-21">
          <div className="col gap6">
            <Table
              minWidth={760}
              head={['项', '内容']}
              rows={[
                [<span className="small strong">取数方式 via</span>, <span className="small">{hint.via}</span>],
                [<span className="small strong">鉴权 auth</span>, <span className="small">{hint.auth}</span>],
                [<span className="small strong">频率 every</span>, <span className="small">{hint.every}</span>],
                [<span className="small strong">字段 fields</span>, <span className="small mono">{hint.fields.join(' · ')}</span>],
                [
                  <span className="small strong">当前状态</span>,
                  <span className="small">
                    {hint.status.ok ? <Badge tone="good">可取数</Badge> : <AlertBadge tone="bad" jump={connJump}>取数失败</AlertBadge>}
                    <span className="tiny faint" style={{ marginLeft: 6 }}>{hint.status.at} · {hint.status.items} 条</span>
                    <div className="tiny faint">{hint.status.note}</div>
                  </span>,
                ],
              ]}
            />
          </div>
          <div className="col gap6">
            <div className="small">{hint.note}</div>
            <Callout
              text={
                <>
                  接真实环境时，采集层把容器平台回执写成 <span className="mono">{hint.file}</span>（dist/data/{hint.file}），
                  本页面「回填回执」的手动入口就可以换成真实回执读取：工单号对 {ORDER_STATUS_LABEL.external} 状态的工单，
                  回执到位即调用引擎回执口径生效，无需改页面代码。当前取数模式：{tele.mode}（{tele.generatedAt}）。
                </>
              }
            />
          </div>
        </div>
      </Panel>
    </div>
  )
}
