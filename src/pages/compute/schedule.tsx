import React from 'react'
import { Kpi, Panel, PageHead, Badge, AlertBadge, State, Table, Progress, Callout } from '../../components/ui'
import { computeNodes } from '../../data/mock'
import { useEngine, engine, poolUtil, freeCards, totalAllocated, TYPE_LABEL, TOTAL_CARDS } from '../../engine/engine'
import { usePerm } from '../../engine/auth'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

/** 资源池告警口径（与总览 / 算力总览 / 卡监控同一套）：落到本页这个池的卡片 */
const poolJump = (id: string, label = '去资源池看这个池并处理卡位'): AlertJump =>
  ({ page: '/compute/schedule', pick: `pool-${id}`, label })

const POOL_BY_LABEL: Record<string, string> = { 高保集群: 'hp', 共享集群: 'shared', 训练池: 'train' }

const STRATEGIES = [
  { name: '优先级抢占', desc: '高保服务集群为核心业务保留算力，共享任务可被抢占让位', tone: 'good' as const, on: true },
  { name: '权重分流', desc: '按渠道权重把请求分散到多实例，均衡偏离度超 30% 触发优化建议', tone: 'info' as const, on: true },
  { name: '延迟优先', desc: '路由实时探测各端点 p95 延迟，优先派发至低延迟实例', tone: 'info' as const, on: true },
  { name: '业务分级路由', desc: '高保队列与共享队列分离，按业务等级差异化放行', tone: 'purple' as const, on: true },
  { name: '训练队列排队', desc: '长任务进入队列，资源紧张时暂停低优先级训练并告警', tone: 'warn' as const, on: true },
  { name: '扩缩协同', desc: '利用率持续超阈值时输出扩缩建议，经审批后在变更窗口执行', tone: 'muted' as const, on: false },
]

const AUTO_LEVELS = [
  ['资源运行指标采集 / 告警推送 / 状态监控', '算力资源调度', '自动化'],
  ['集群巡检 / 光链路探测 / 故障自动定位', 'AI 算力集群管理', '自动化'],
  ['资源池创建 / 节点增删 / 扩缩容执行', 'AI 算力集群管理', '半自动化'],
  ['推理实例启停 / 深度健康评估', 'AI 算力集群管理', '半自动化'],
  ['容量评估分析 / 资产盘点 / 报表分析', 'AI 训推服务存储管理', '人工操作'],
]

export default function ComputeSchedule() {
  const st = useEngine()
  const canApprove = usePerm('approve').manage
  const pick = useAlertPick()          // 资源池告警 / 工单告警跳进来：?pick=pool-hp 或 ?pick=<工单号>
  usePickFlash(pick)
  const queue = st.orders.filter((o) => o.type === 'pool_expand' || o.type === 'pool_release' || o.type === 'replica_scale')
  return (
    <div>
      <PageHead
        title="资源池与调度"
        desc="池化管理 · 分域隔离 · 业务分级保障 · 利用率最大化"
        extra={<><Badge tone="info">3 个资源池</Badge><Badge tone="good">调度引擎运行中</Badge></>}
      />

      <div className="grid g-4">
        <Kpi label="纳管算力卡" value={TOTAL_CARDS} unit="张" foot={`已分配 ${totalAllocated(st)} · 空闲 ${freeCards(st)}`} />
        <Kpi label="池化率" value={Math.round((totalAllocated(st) / TOTAL_CARDS) * 100)} unit="%" foot="空闲卡位可继续分配" />
        <Kpi label="在途调配工单" value={st.orders.filter((o) => o.status === 'submitted' || o.status === 'running').length} unit="项" foot="审批后可立即执行" />
        <Kpi label="高保业务保障" value="99.95" unit="%" foot="核心业务优先放行" />
      </div>

      <div className="grid g-3 mt14">
        {st.pools.map((p) => {
          const pct = poolUtil(st, p.id)
          return (
            <div key={p.id} className={`pool-card${pick === `pool-${p.id}` ? ' row-pick' : ''}`}
              style={pick === `pool-${p.id}` ? { borderRadius: 12, boxShadow: 'inset 3px 0 0 var(--amber), 0 0 0 1px var(--amber)' } : undefined}>
              <Panel title={p.name} extra={p.sla === '—' ? '训练池' : `SLA ${p.sla}`}>
              <div className="row between">
                <span className="muted small">卡位 / 需求</span>
                <span className="strong">{p.cards} 卡</span>
              </div>
              <div style={{ marginTop: 8 }}><Progress value={pct} tone={pct > 90 ? 'bad' : pct > 80 ? 'warn' : 'green'} jump={pct > 80 ? poolJump(p.id, `看「${p.name}」的卡位与扩缩队列`) : undefined} /></div>
              <div className="row between small faint" style={{ marginTop: 4 }}><span>利用率 {pct}%</span><span>空闲 {Math.max(0, p.cards - Math.round((pct / 100) * p.cards))} 卡</span></div>
              <div className="divider" />
              <div className="small" style={{ color: '#9db8dd', lineHeight: 1.7 }}>{p.policy}</div>
              </Panel>
            </div>
          )
        })}
      </div>

      <Panel title="扩缩协同队列" extra="超阈值自动生成 · 审批后在变更窗口执行" className="mt14" noPad>
        <div className="panel-body">
          {queue.length === 0 ? (
            <div className="empty">当前无扩缩建议 · 可在「资源调配工作台」提交申请</div>
          ) : (
            <Table
              minWidth={820}
              head={['工单', '类型', '对象', '数量', '触发条件', '状态', '操作']}
              rows={queue.slice(0, 8).map((o) => [
                <span className="mono small">{o.id}{o.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动</span> : null}</span>,
                <span className="small">{TYPE_LABEL[o.type]}</span>,
                <span className="strong small">{o.target}</span>,
                <span className="num small">{o.amount}</span>,
                <span className="muted small ellipsis" style={{ maxWidth: 240 }}>{o.reason}</span>,
                o.status === 'submitted' ? <AlertBadge tone="warn" jump={Jump.order(o.id, `去调配工作台审批这张工单 ${o.id}`)}>待审批</AlertBadge>
                  : o.status === 'rejected' ? <AlertBadge tone="bad" jump={Jump.order(o.id, `去调配工作台看这张被驳回的工单 ${o.id}`)}>已驳回</AlertBadge>
                  : o.status === 'rolled_back' ? <AlertBadge tone="warn" jump={Jump.order(o.id, `去调配工作台看这张已回滚的工单 ${o.id}`)}>已回滚</AlertBadge>
                  : <State s={o.status === 'running' ? 'run' : 'done'} />,
                o.status === 'submitted' ? (
                  canApprove ? (
                    <div className="row gap6">
                      <button className="btn sm primary" onClick={() => engine.approve(o.id)}>通过并执行</button>
                      <button className="btn sm danger" onClick={() => engine.reject(o.id, '当前业务优先级不足，暂缓扩容')}>驳回</button>
                    </div>
                  ) : <span className="tiny faint">待审批（无审批权）</span>
                ) : o.status === 'running' ? (canApprove ? <button className="btn sm ghost" onClick={() => engine.rollback(o.id)}>回滚</button> : <span className="tiny faint">执行中</span>) : <span className="tiny faint">{o.decidedBy ?? '—'}</span>,
              ])}
              rowKeys={queue.slice(0, 8).map((o) => o.id)} pick={pick}
            />
          )}
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="调度策略" extra="策略生效状态 · 可在控制台调整" noPad>
          <div className="panel-body">
            <Table
              minWidth={720}
              head={['策略', '说明', '生效范围', '状态']}
              rows={STRATEGIES.map((s) => [
                <span className="strong">{s.name}</span>,
                <span className="muted small">{s.desc}</span>,
                <span className="tag gray">全平台</span>,
                s.on ? <Badge tone="good">已启用</Badge> : <AlertBadge tone="warn" jump={Jump.alertRule('AR-01', `「${s.name}」待审批：去告警规则看生成建议工单的这条规则`)}>待审批</AlertBadge>,
              ])}
            />
          </div>
        </Panel>
        <Panel title="调度等级划分" extra="自动化 / 半自动 / 人工">
          <Table
            head={['功能', '等级']}
            rows={AUTO_LEVELS.map((r) => [
              <span className="small" style={{ color: 'var(--table-text)' }}>{r[0]}<div className="tiny faint">{r[1]}</div></span>,
              <Badge tone={r[2] === '自动化' ? 'good' : r[2] === '半自动化' ? 'info' : 'muted'}>{r[2]}</Badge>,
            ])}
          />
          <div className="callout mt14" style={{ marginTop: 14 }}>
            <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
            <div>半自动化项须由运营人员在控制台确认后执行，全过程审批留痕；自动化项由策略引擎触发，处置结果写入事件台账。</div>
          </div>
        </Panel>
      </div>

      <div className="grid g-12 mt14">
        <Panel title="节点资源池归属" extra="8 个节点">
          {['高保集群', '共享集群', '训练池'].map((pool) => {
            const nodes = computeNodes.filter((n) => n.pool.includes(pool))
            const avg = Math.round(nodes.reduce((s, n) => s + n.util, 0) / (nodes.length || 1))
            return (
              <div key={pool} style={{ marginBottom: 12 }}>
                <div className="row between small">
                  <span>{pool} <span className="faint">({nodes.length} 节点)</span></span>
                  <span className="muted">平均 {avg}%</span>
                </div>
                <div style={{ marginTop: 5 }}><Progress value={avg} tone={avg > 85 ? 'warn' : ''} jump={avg > 85 ? poolJump(POOL_BY_LABEL[pool] ?? 'hp', `看「${pool}」对应资源池的卡位与扩缩队列`) : undefined} /></div>
              </div>
            )
          })}
        </Panel>
        <Panel title="容量评估与变更约束" extra="由容量评估触发">
          <Table
            head={['约束项', '规则', '当前判定']}
            rows={[
              [<span className="strong">扩容上限</span>, <span className="small">不得超过全局空闲卡位 {freeCards(st)} 卡</span>, freeCards(st) < 4 ? <AlertBadge tone="warn" jump={Jump.alertRule('AR-05', '全局空闲卡位不足：去告警规则看这条口径（生成建议工单）')}>空闲 {freeCards(st)} 卡</AlertBadge> : <Badge tone="good">空闲 {freeCards(st)} 卡</Badge>],
              [<span className="strong">回收下限</span>, <span className="small">回收不得侵占在用资源（保留需求卡位）</span>, <Badge tone="info">按池需求核算</Badge>],
              [<span className="strong">副本安全线</span>, <span className="small">执行后池利用率不得超过 92%</span>, <Badge tone="warn">超线直接拒绝</Badge>],
              [<span className="strong">高保优先</span>, <span className="small">核心业务可申请抢占共享池资源</span>, <Badge tone="purple">需主管审批</Badge>],
            ]}
          />
          <Callout text="扩缩容建议在变更窗口内执行并支持回滚至变更前快照；容量评估报告按月/季度输出，是租赁费用结算与扩租谈判的依据。调配操作请在「运营分析 · 资源调配工作台」发起。" />
        </Panel>
      </div>
    </div>
  )
}
