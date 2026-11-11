import { Kpi, Panel, PageHead, Badge, State, AlertBadge, Table, Progress, Callout } from '../../components/ui'
import { datasets, trainTasks, fineTuneReviews } from '../../data/mock'
import { useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

export default function FineTune() {
  const finalCount = datasets.filter((d) => d.state === '已终审').length
  const reviewing = fineTuneReviews.filter((r) => r.state !== 'pass')
  const notFinal = datasets.filter((d) => d.state !== '已终审')
  const runningTask = trainTasks.find((t) => t.state === 'run')

  /* 告警直达口径（本页主键：训练任务名 / 数据集名 / 微调制品名）
     数据未终审 → 落「数据集治理」那一行（谁卡在终审 / 前置过滤，责任方就在同一行）
     制品未放行 → 落「微调制品审核」那一行（缺哪一项、等谁签字就在这一行）
     运行中任务 → 落「训练任务」那一行；要归还卡位去审批台训练台账那一行 */
  const pick = useAlertPick()
  usePickFlash(pick)
  const dataJump = (name: string, label: string): AlertJump => ({ page: '/model/fineTune', pick: name, label })
  const reviewJump = (model: string, label: string): AlertJump => ({ page: '/model/fineTune', pick: model, label })
  const taskJump = (name: string, label: string): AlertJump => ({ page: '/model/fineTune', pick: name, label })

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
        <Kpi label="训练任务" value={trainTasks.length} unit="个" foot={runningTask
          ? <span className="down">{`● ${runningTask.name} 占用 8 卡训练池，完成前不释放`}</span>
          : '1 运行中 · 2 已完成'}
          jump={runningTask ? taskJump(runningTask.name, '到这个运行中任务那一行：看进度与绑定的数据版本（卡时归还去审批台训练台账）') : undefined} />
        <Kpi label="在审制品" value={reviewing.length} unit="个" foot={reviewing.length
          ? <span className="down">{`● 权重扫描 ✓ · 待安全审批签字 ${reviewing.length} 个（未放行不得部署）`}</span>
          : '权重扫描 ✓ · 待安全审批签字'}
          jump={reviewing.length ? reviewJump(reviewing[0].model, '到这个未放行的制品那一行：看缺哪一项、等谁签字') : undefined} />
      </div>

      <div className="grid g-32 mt14">
        <Panel title="训练任务" extra="训练前强制绑定「已终审」数据版本" noPad>
          <div className="panel-body">
            <Table
              head={['任务', '方法', '绑定数据集', '算力', '进度', '状态']}
              rowKeys={trainTasks.map((t) => t.name)} pick={pick}
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
              rowKeys={datasets.map((d) => d.name)} pick={pick}
              rows={datasets.map((d) => [
                <span className="strong">{d.name}</span>,
                <span className="num">{d.size}</span>,
                <span className="num">{d.rows}</span>,
                d.cls === '敏感' ? <span className="tag red">敏感</span> : <span className="tag gray">{d.cls}</span>,
                d.owner,
                d.state === '已终审'
                  ? <Badge tone="good">已终审</Badge>
                  : d.state === '终审中'
                  ? <AlertBadge tone="warn" jump={dataJump(d.name, `这条数据还在终审（责任方 ${d.owner}）：终审完成前不得绑定训练任务`)}>终审中 · 不可训练</AlertBadge>
                  : <AlertBadge tone="warn" jump={dataJump(d.name, `这条数据只做到前置过滤（责任方 ${d.owner}）：未终审不得绑定训练任务`)}>前置过滤 · 不可训练</AlertBadge>,
              ])}
              minWidth={560}
            />
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Panel title="微调制品审核" extra="发布前核验：任务台账 · 数据版本 · 评测记录 · 审批单据">
          <Table
            minWidth={860}
            rowKeys={fineTuneReviews.map((r) => r.model)} pick={pick}
            head={['微调制品', '发布前核验（任务台账 / 数据版本 / 评测 / 权重扫描）', '审批签字', '判定']}
            rows={fineTuneReviews.map((r) => [
              <span className="strong">{r.model}</span>,
              <span className="small">{r.items.join(' · ')}</span>,
              <span className="small">{r.approver}</span>,
              r.state === 'pass'
                ? <Badge tone="good">{r.verdict}</Badge>
                : <AlertBadge tone="warn" jump={reviewJump(r.model, '到这个未放行的制品那一行：须安全审批人签字「已放行」才可转部署')}>{r.verdict}</AlertBadge>,
            ])}
          />
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          warn={reviewing.length > 0 || notFinal.length > 0}
          jump={reviewing.length
            ? reviewJump(reviewing[0].model, '到这个未放行的制品那一行：补齐签字再转部署')
            : notFinal.length
              ? dataJump(notFinal[0].name, `到这条未终审的数据那一行：先完成终审再绑定训练任务（当前未终审 ${notFinal.length} 个）`)
              : undefined}
          text={
            <>
              硬性约束：<b>未经终审的数据版本无法被调度训练</b>（当前未终审 {notFinal.length} 个数据集）；微调制品须完成权重安全扫描、评测复核并经<b>安全审批人签字「已放行」</b>后方可转入部署环节（当前待放行 {reviewing.length} 个）；训练过程发现疑似脏数据 / 违规样本时自动暂停任务并告警，防止污染模型权重。
            </>
          }
        />
      </div>
    </div>
  )
}
