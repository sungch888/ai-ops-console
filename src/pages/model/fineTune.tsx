import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge, PageHead, Panel } from '../../components/ui'
import { currentAccount, usePerm } from '../../engine/auth'
import { engine, useEngine, type TrainJob } from '../../engine/engine'
import './admission.css'

const datasetFields = [
  ['name', '数据集名称'], ['version', '数据集版本'], ['source', '来源与授权依据'],
  ['owner', '数据责任人'], ['purpose', '微调用途'],
] as const

function field(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim()
}

function TrainingRecord({ job, applicant }: { job: TrainJob; applicant: string }) {
  const [status, setStatus] = useState<'运行中' | '失败' | '已完成'>('运行中')
  const [feedback, setFeedback] = useState('')
  const execution = job.execution
  const editable = job.applicant === applicant && !!job.deadline && job.deadline > Date.now() && job.state === '运行中'
  const terminal = execution?.status === '已完成' || execution?.status === '失败'

  function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const artifact = status === '已完成' && execution ? {
      version: field(data, 'version'), location: field(data, 'location'), sha256: field(data, 'sha256').toLowerCase(),
    } : undefined
    const ok = engine.recordTraining(job.id, applicant, {
      reference: execution?.reference ?? field(data, 'reference'),
      parameters: execution?.parameters ?? field(data, 'parameters'),
      status: execution ? status : '已登记',
      evidence: field(data, 'evidence'),
      artifact,
    })
    setFeedback(ok ? '已登记至原算力工单。' : '登记失败，请核对授权期限、任务状态和回执字段。')
  }

  function extend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const reason = field(data, 'reason')
    if (!reason || !job.reserveId) return
    const result = engine.submit({
      type: 'train_extend', applicant, dept: job.dept, level: '共享', reason,
      spec: { jobId: job.id, reserveId: job.reserveId, hours: Number(data.get('hours')) },
    })
    setFeedback(result.precheck.ok ? `${result.order.id} 已提交，待审批` : result.precheck.reason ?? '无法提交延期')
  }

  return <details className="admission-order">
    <summary>
      <span className="admission-order-title"><strong>{job.name}</strong><span>{job.id} · {job.cards} 卡 · {job.state === '运行中' ? '占用中' : job.state}</span></span>
      <Badge tone={terminal ? execution?.status === '已完成' ? 'good' : 'bad' : 'muted'}>{execution?.status ?? '待登记'}</Badge>
    </summary>
    <div className="admission-order-body">
      <p>原算力工单 {job.reserveId} · 截止 {job.dueAt}</p>
      {execution && <p>外部任务 {execution.reference} · 参数 {execution.parameters} · 回执 {execution.evidence}</p>}
      {execution?.artifact && <>
        <p>产物 {execution.artifact.version} · {execution.artifact.location}</p>
        <p>SHA-256 {execution.artifact.sha256}</p>
        <Link className="btn ghost admission-link mt8" to={`/model/admission?trainingJob=${encodeURIComponent(job.id)}`}>前往产物准入</Link>
      </>}
      {editable && !terminal && <form className="admission-review mt14" onSubmit={record}>
        {execution ? <label className="admission-field"><span>外部任务状态</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option>运行中</option><option>失败</option><option>已完成</option>
          </select>
        </label> : <div className="admission-fields">
          <label className="admission-field"><span>外部训练任务编号</span><input name="reference" required maxLength={160} /></label>
          <label className="admission-field"><span>训练参数</span><input name="parameters" required maxLength={600} /></label>
        </div>}
        <label className="admission-field"><span>任务或状态回执依据</span><input name="evidence" required maxLength={600} /></label>
        {execution && status === '已完成' && <div className="admission-fields">
          <label className="admission-field"><span>产物版本</span><input name="version" required maxLength={160} /></label>
          <label className="admission-field"><span>产物内网位置</span><input name="location" required maxLength={600} /></label>
          <label className="admission-field admission-field-wide"><span>训练端计算的实际权重 SHA-256</span><input name="sha256" required pattern="[a-fA-F0-9]{64}" /></label>
        </div>}
        <div><button className="btn primary">登记训练回执</button></div>
      </form>}
      {editable && <form className="admission-review mt14" onSubmit={extend}>
        <div className="admission-fields">
          <label className="admission-field"><span>申请延长小时数</span><input type="number" name="hours" min="1" max="72" required /></label>
          <label className="admission-field"><span>延期事由</span><input name="reason" required maxLength={600} /></label>
        </div>
        <div><button className="btn ghost">申请算力延期</button></div>
      </form>}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  </details>
}

export default function FineTune() {
  const state = useEngine()
  const account = currentAccount()
  const workflow = usePerm('workflow')
  const approval = usePerm('approve')
  const [feedback, setFeedback] = useState('')
  const canReview = workflow.manage && approval.manage
  const datasets = state.orders.filter((order) => order.type === 'training_dataset' && (canReview || order.applicant === account?.name))
  const jobs = state.jobs.filter((job) => !!job.reserveId && (canReview || job.applicant === account?.name))

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account || !workflow.manage) return
    const form = event.currentTarget
    const data = new FormData(form)
    const spec = Object.fromEntries(datasetFields.map(([key]) => [key, field(data, key)]))
    if (Object.values(spec).some((value) => !value)) return
    const result = engine.submit({
      type: 'training_dataset', applicant: account.name, dept: account.dept, level: '共享', reason: spec.purpose,
      spec: { ...spec, dataLevel: field(data, 'dataLevel') },
    })
    setFeedback(result.precheck.ok ? `${result.order.id} 已提交，等待数据检测报告。` : result.precheck.reason ?? '数据登记失败')
    if (result.precheck.ok) form.reset()
  }

  return <div className="admission-page">
    <PageHead title="微调训练" desc="登记数据集版本，申请算力，跟踪外部训练回执与产物。"
      extra={<Link className="btn ghost admission-link" to="/ops/apply">申请算力与查看审批 →</Link>} />
    <div className="admission-workspace">
      <Panel title="训练数据使用申请" bodyClass="admission-form-body">
        <form onSubmit={register}>
          <div className="admission-fields">
            {datasetFields.map(([key, label]) => <label key={key} className="admission-field">
              <span>{label}</span><input name={key} required maxLength={600} />
            </label>)}
            <label className="admission-field"><span>密级</span>
              <select name="dataLevel"><option>内部</option><option>已脱敏</option><option>敏感</option></select>
            </label>
          </div>
          <div className="admission-submit mt14">
            <p role="status">{feedback || '检测报告登记通过后，该版本才能用于算力申请。'}</p>
            <button className="btn primary" disabled={!workflow.manage}>提交数据使用申请</button>
          </div>
        </form>
      </Panel>
      <Panel title="数据版本台账" extra={`${datasets.length} 笔`}>
        {datasets.length === 0 && <div className="admission-empty">暂无数据使用申请</div>}
        {datasets.map((order) => <details key={order.id} className="admission-order">
          <summary>
            <span className="admission-order-title"><strong>{order.target}</strong><span>{order.id} · {String(order.spec.dataLevel)}</span></span>
            <Badge tone={order.status === 'closed' ? 'good' : order.status === 'rejected' ? 'bad' : 'warn'}>
              {order.status === 'closed' ? '版本已固化' : order.status === 'rejected' ? '未通过' : '待检测报告'}
            </Badge>
          </summary>
          <div className="admission-order-body">
            <p>来源 {String(order.spec.source)} · 责任人 {String(order.spec.owner)} · 申请人 {order.applicant}</p>
            <p>微调用途 {order.reason}</p>
            {order.spec.report && <p>检测报告 {String(order.spec.report)}</p>}
            {order.rejectReason && !order.spec.report && <p>{order.rejectReason}</p>}
            {order.status === 'submitted' && canReview && account && <form className="admission-review" onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              engine.recordDatasetResult(order.id, account.name, field(data, 'result') === '通过', field(data, 'report'))
            }}>
              <label className="admission-field"><span>外部自动检测报告编号与摘要</span><input name="report" required maxLength={600} /></label>
              <label className="admission-field"><span>报告结论</span><select name="result" required>
                <option value="">按报告选择</option><option>通过</option><option>未通过</option>
              </select></label>
              <div><button className="btn ghost">登记检测报告</button></div>
            </form>}
          </div>
        </details>)}
      </Panel>
    </div>
    <Panel title="训练任务与产物" className="mt14" extra={`${jobs.length} 项`}>
      <p className="admission-hint">此处登记训练平台返回的任务编号、状态和权重哈希。算力审批、排期和归还在申请与审批台处理。</p>
      {jobs.length === 0 && <div className="admission-empty mt8">暂无已分配算力的训练任务</div>}
      {jobs.map((job) => <TrainingRecord key={job.id} job={job} applicant={workflow.manage ? account?.name ?? '' : ''} />)}
    </Panel>
  </div>
}
