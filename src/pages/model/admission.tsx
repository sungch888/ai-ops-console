import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, PageHead, Panel } from '../../components/ui'
import { currentAccount, usePerm } from '../../engine/auth'
import { engine, useEngine, type Order } from '../../engine/engine'
import './admission.css'

const sections = [
  {
    title: '模型与制品',
    hint: '来源依据填写外部可信链接，或原训练任务编号与产物版本。',
    fields: [
      { key: 'model', label: '模型名称', example: '例如 Qwen3-8B' },
      { key: 'version', label: '模型版本', example: '例如 v1.2.0' },
      { key: 'owner', label: '模型责任人', example: '姓名或值守账号' },
      { key: 'provenance', label: '来源依据', example: '链接或训练任务编号' },
      { key: 'location', label: '内网制品位置与交接记录', example: '内网路径与交接单号', wide: true },
    ],
  },
  {
    title: '核验与评测证据',
    hint: '填写外部工具生成的证据和结论，供审批人员核查。',
    fields: [
      { key: 'integrity', label: '文件完整性', example: '实际文件哈希、比对依据与结果', wide: true },
      { key: 'scan', label: '安全扫描', example: '报告编号与结论', wide: true },
      { key: 'evaluation', label: '安全评测', example: '安全边界与违规输出评测报告及结论', wide: true },
    ],
  },
  {
    title: '部署预设',
    hint: '工单入库后，部署页会带入本版本的镜像和目标节点。',
    fields: [
      { key: 'image', label: '部署镜像', example: '例如 registry.intra/model:v1.2.0' },
      { key: 'nodes', label: '目标节点', example: '例如 AI-Infer-03' },
    ],
  },
] satisfies {
  title: string
  hint?: string
  fields: { key: string; label: string; example: string; wide?: boolean }[]
}[]

const stages = [
  { title: '登记材料', description: '填写制品来源、核验依据和部署预设' },
  { title: '核验入库', description: '审批人员查看证据，确认入库或驳回' },
  { title: '选择部署', description: '从部署页选用已入库的模型版本' },
]

function statusOf(order: Order) {
  if (order.status === 'closed') return { label: '已入库', tone: 'good' } as const
  if (order.status === 'rejected') return { label: '已驳回', tone: 'bad' } as const
  return { label: '待审核', tone: 'warn' } as const
}

export default function ModelAdmission() {
  const state = useEngine()
  const account = currentAccount()
  const [params] = useSearchParams()
  const [trainingJobId, setTrainingJobId] = useState(params.get('trainingJob') ?? '')
  const [source, setSource] = useState(trainingJobId ? '平台内微调模型' : '外部获取模型')
  const artifacts = state.jobs.filter((job) => !!job.execution?.artifact)
  const internal = source === '平台内微调模型'
  const artifact = internal ? artifacts.find((job) => job.id === trainingJobId)?.execution?.artifact : undefined
  const gateway = usePerm('gateway')
  const workflow = usePerm('workflow')
  const approval = usePerm('approve')
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})
  const canSubmit = gateway.manage && workflow.manage && !!account
  const canReview = canSubmit && approval.manage
  const orders = state.orders.filter((order) => order.type === 'model_admission')
  const pending = orders.filter((order) => order.status === 'submitted').length
  const admitted = orders.filter((order) => order.status === 'closed').length

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || !account) return
    const form = event.currentTarget
    const spec = Object.fromEntries(Array.from(new FormData(form), ([key, value]) => [key, String(value).trim()]))
    if (artifact) {
      spec.version = artifact.version
      spec.location = artifact.location
      spec.provenance = trainingJobId
      spec.artifactHash = (spec.artifactHash ?? '').toLowerCase()
    }
    const { order, precheck } = engine.submit({
      type: 'model_admission', applicant: account.name, dept: account.dept, level: '共享',
      reason: '登记模型准入材料，等待证据审核', spec,
    })
    setMessage({
      ok: precheck.ok,
      text: precheck.ok ? `${order.id} 已登记，可在准入台账查看。` : `${order.id} 已驳回：${precheck.reason}`,
    })
    if (precheck.ok) {
      form.reset()
      setSource('外部获取模型')
      setTrainingJobId('')
    }
  }

  return <div className="admission-page">
    <PageHead
      title="模型准入与评测"
      desc="外部模型和平台内微调产物共用同一套准入流程。"
      extra={<Link className="btn ghost admission-link" to="/model/deploy">前往模型部署 <span aria-hidden="true">→</span></Link>}
    />

    <ol className="admission-stages" aria-label="模型准入流程">
      {stages.map((stage, index) => <li key={stage.title}>
        <span className="admission-step" aria-hidden="true">0{index + 1}</span>
        <div><strong>{stage.title}</strong><p>{stage.description}</p></div>
      </li>)}
    </ol>

    <div className="admission-workspace">
      <Panel title="登记准入材料" extra="全部字段必填" bodyClass="admission-form-body">
        <form onSubmit={submit}>
          {sections.map((section, index) => <fieldset key={section.title} className="admission-section">
            <legend>{section.title}</legend>
            {'hint' in section && <p className="admission-hint">{section.hint}</p>}
            <div className="admission-fields">
              {index === 0 && <>
                <label className="admission-field">
                  <span>来源类型</span>
                  <select name="source" value={source} onChange={(event) => setSource(event.target.value)}><option>外部获取模型</option><option>平台内微调模型</option></select>
                </label>
                <label className="admission-field">
                  <span>制品形态</span>
                  <select name="artifact"><option>权重文件</option><option>部署镜像包</option></select>
                </label>
              </>}
              {index === 0 && internal && <label className="admission-field admission-field-wide">
                <span>原训练任务与产物</span>
                <select name="trainingJobId" value={trainingJobId} onChange={(event) => setTrainingJobId(event.target.value)} required>
                  <option value="">选择已登记产物</option>
                  {artifacts.map((job) => <option key={job.id} value={job.id}>{job.id} · {job.name} · {job.execution?.artifact?.version}</option>)}
                </select>
              </label>}
              {index === 1 && internal && <label className="admission-field admission-field-wide">
                <span>实际制品 SHA-256</span>
                <input name="artifactHash" required pattern="[A-Fa-f0-9]{64}" placeholder="输入对实际制品重新计算的 SHA-256" />
              </label>}
              {section.fields.map((field) => <label
                key={field.key}
                className={`admission-field${'wide' in field && field.wide ? ' admission-field-wide' : ''}`}
              >
                <span>{field.label}</span>
                {internal && ['version', 'location', 'provenance'].includes(field.key)
                  ? <input readOnly value={(field.key === 'version' ? artifact?.version : field.key === 'location' ? artifact?.location : trainingJobId) ?? ''} />
                  : <input name={field.key} placeholder={field.example} required maxLength={600} />}
              </label>)}
            </div>
          </fieldset>)}
          <div className="admission-submit">
            <p role="status" data-error={message?.ok === false}>
              {message?.text ?? (canSubmit ? '提交后，工单进入准入台账等待审核。' : '当前账号没有提交权限。')}
            </p>
            <button className="btn primary" disabled={!canSubmit || (internal && !artifact)}>提交模型准入工单</button>
          </div>
        </form>
      </Panel>

      <Panel title="准入台账" extra={`${orders.length} 笔工单`} bodyClass="admission-queue">
        <dl className="admission-counts">
          <div><dt>待审核</dt><dd>{pending}</dd></div>
          <div><dt>已入库</dt><dd>{admitted}</dd></div>
          <div><dt>已驳回</dt><dd>{orders.filter((order) => order.status === 'rejected').length}</dd></div>
        </dl>
        {orders.length === 0 && <div className="admission-empty">
          <strong>暂无准入工单</strong>
          <p>提交后，可在这里查看材料、审核状态和处理结果。</p>
        </div>}
        {orders.map((order) => {
          const status = statusOf(order)
          return <details key={order.id} className="admission-order">
            <summary>
              <span className="admission-order-title">
                <strong>{String(order.spec.model)}</strong>
                <span>{order.id} · {String(order.spec.version)}</span>
              </span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </summary>
            <div className="admission-order-body">
              <p>{order.applicant} · {String(order.spec.source)} · {String(order.spec.artifact)}</p>
              <dl className="admission-evidence">
                {sections.flatMap((section) => section.fields).map(({ key, label }) =>
                  <div key={key}><dt>{label}</dt><dd>{String(order.spec[key] ?? '—')}</dd></div>)}
              </dl>
              {order.rejectReason && <p className="admission-reject-note">驳回理由：{order.rejectReason}</p>}
              {order.decidedBy && <p>处理人：{order.decidedBy}</p>}
              {order.status === 'closed' && <Link className="btn ghost admission-link" to="/model/deploy">前往模型部署 →</Link>}
              {order.status === 'submitted' && canReview && account && <div className="admission-review">
                <p>核对完整性、扫描和评测证据后，确认入库；如材料不合格，请填写理由后驳回。</p>
                <label className="admission-field">
                  <span>驳回理由</span>
                  <input aria-label={`${order.id} 驳回理由`} value={decisionNotes[order.id] ?? ''} onChange={(event) => {
                    const value = event.target.value
                    setDecisionNotes((notes) => ({ ...notes, [order.id]: value }))
                  }} />
                </label>
                <div className="admission-review-actions">
                  <button className="btn primary" onClick={() => engine.approve(order.id, account.name)}>确认入库</button>
                  <button className="btn danger" disabled={!decisionNotes[order.id]?.trim()} onClick={() => engine.reject(order.id, decisionNotes[order.id].trim())}>驳回</button>
                </div>
              </div>}
            </div>
          </details>
        })}
      </Panel>
    </div>
  </div>
}
