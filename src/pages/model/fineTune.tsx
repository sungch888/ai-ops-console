import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout } from '../../components/ui'
import { datasets, trainTasks, fineTuneReviews } from '../../data/mock'

const card = {
  border: '1px solid rgba(64,130,220,.18)',
  background: 'rgba(23,48,90,.28)',
  borderRadius: 10,
  padding: '12px 14px',
}

export default function FineTune() {
  const finalCount = datasets.filter((d) => d.state === '已终审').length
  const reviewing = fineTuneReviews.filter((r) => r.state === 'review').length

  return (
    <div>
      <PageHead
        title="微调训练"
        desc="训练数据治理 · LoRA 微调 · 制品审核放行 —— 未审核数据不得训练，未放行制品不得部署（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">数据绑定核验 100%</Badge>
            <Badge tone="info">LoRA r=16~64</Badge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="纳管数据集" value={datasets.length} unit="个" foot="来源登记 · 版本固化 · 责任人明确" />
        <Kpi label="已终审数据" value={finalCount} unit="个" foot={<span className="up">✓ 可绑定训练任务</span>} />
        <Kpi label="训练任务" value={trainTasks.length} unit="个" foot="1 运行中 · 2 已完成" />
        <Kpi label="在审制品" value={reviewing} unit="个" foot="权重扫描 ✓ · 待安全审批签字" />
      </div>

      <div className="grid g-32 mt14">
        <Panel title="训练任务" extra="训练前强制绑定「已终审」数据版本" noPad>
          <div className="panel-body">
            <Table
              head={['任务', '方法', '绑定数据集', '算力', '进度', '状态']}
              rows={trainTasks.map((t) => [
                <span className="strong">{t.name}</span>,
                <span className="mono small">{t.method}</span>,
                t.data,
                <span className="mono small">{t.gpu}</span>,
                <div style={{ minWidth: 110 }}>
                  <Progress value={t.progress} tone={t.state === 'done' ? 'green' : ''} />
                  <div className="row between small" style={{ marginTop: 4 }}>
                    <span className="muted">{t.eta}</span>
                    <span className="num">{t.progress}%</span>
                  </div>
                </div>,
                <State s={t.state} />,
              ])}
              minWidth={760}
            />
          </div>
        </Panel>
        <Panel title="数据集治理" extra="四级管控：来源登记 → 版本固化 → 前置过滤 → 异常筛查" noPad>
          <div className="panel-body">
            <Table
              head={['数据集', '规模', '条数', '密级', '责任方', '审核状态']}
              rows={datasets.map((d) => [
                <span className="strong">{d.name}</span>,
                <span className="num">{d.size}</span>,
                <span className="num">{d.rows}</span>,
                d.cls === '敏感' ? <span className="tag red">敏感</span> : <span className="tag gray">{d.cls}</span>,
                d.owner,
                d.state === '已终审'
                  ? <Badge tone="good">已终审</Badge>
                  : d.state === '终审中'
                  ? <Badge tone="warn">终审中</Badge>
                  : <Badge tone="muted">前置过滤</Badge>,
              ])}
              minWidth={560}
            />
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Panel title="微调制品审核" extra="发布前核验：任务台账 · 数据版本 · 评测记录 · 审批单据">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            {fineTuneReviews.map((r) => (
              <div key={r.model} style={card}>
                <div className="row between">
                  <span className="strong">{r.model}</span>
                  {r.state === 'pass' ? <Badge tone="good">{r.verdict}</Badge> : <Badge tone="warn">{r.verdict}</Badge>}
                </div>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                  {r.items.map((it) => (
                    <span key={it} className="small" style={{ color: 'var(--info-text)' }}>{it}</span>
                  ))}
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>{r.approver}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          warn
          text={
            <>
              硬性约束：<b>未经终审的数据版本无法被调度训练</b>；微调制品须完成权重安全扫描、评测复核并经<b>安全审批人签字「已放行」</b>后方可转入部署环节；训练过程发现疑似脏数据 / 违规样本时自动暂停任务并告警，防止污染模型权重。
            </>
          }
        />
      </div>
    </div>
  )
}
