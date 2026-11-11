import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout, Tabs, fmtCN } from '../../components/ui'
import { models, lifecycleStages } from '../../data/mock'
import { useEngine, engine, TYPE_LABEL, BASIS_OPTS } from '../../engine/engine'
import { usePerm, useSession } from '../../engine/auth'

const TABS = ['全部', '运行中', '微调审核', '待下线']

const card = {
  border: '1px solid rgba(64,130,220,.18)',
  background: 'rgba(23,48,90,.28)',
  borderRadius: 10,
  padding: '10px 12px',
}

export default function Assets() {
  const st = useEngine()
  const engineModels = st.models
  const canGate = usePerm('gateway').manage
  const session = useSession()
  const [mSel, setMSel] = useState('Qwen3-32B')
  const [toVer, setToVer] = useState('v2.2')
  const [basis, setBasis] = useState('告警触发')
  const [reason, setReason] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const lifeOrders = st.orders.filter((o) => o.type === 'model_rollback' || o.type === 'model_retire')
  const act = (type: 'model_rollback' | 'model_retire') => {
    const r = engine.submit({ type, applicant: session?.name ?? '信息化管理部 · 平台管理员', dept: session?.dept ?? '信息化管理部', level: '高保', reason: reason || '（未填写理由）', spec: type === 'model_rollback' ? { model: mSel, toVersion: toVer, basis } : { model: mSel, basis } })
    setFlash(r.precheck.ok ? `${r.order.id} 已提交（${type === 'model_retire' ? '下线变更' : '版本回退'}），准入预检通过：${r.precheck.suggest ?? ''}` : `${r.order.id} 被准入校验驳回：${r.precheck.reason}`)
    setReason('')
  }
  const [tab, setTab] = useState('全部')
  const list = tab === '全部' ? models : models.filter((m) => m.stage === tab)
  const online = models.filter((m) => m.status === 'ok').length
  const tuning = models.filter((m) => m.stage === '微调审核').length
  const offline = models.filter((m) => m.stage === '待下线').length

  return (
    <div>
      <PageHead
        title="模型资产管理"
        desc="模型全生命周期 9 阶段管理 · 接入可管 / 调用可控 / 运行可视 / 安全可审（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">准入审查通过率 100%</Badge>
            <Badge tone="info">信创算力 3 厂商</Badge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="模型总数" value={models.length} unit="个" foot="核心 2 · 专业 2 · 基础 3 · 退役 1" />
        <Kpi label="在线运行" value={online} unit="个" foot="本地推理 + 厂商渠道接入" />
        <Kpi label="微调中 / 在审" value={tuning} unit="个" foot="LoRA 微调 · 制品审核放行中" />
        <Kpi label="待下线" value={offline} unit="个" foot="下线审批 · 配置快照可回退" />
      </div>

      <div className="mt14">
        <Panel title="生命周期九阶段" extra="场景一 6 阶段 · 场景二 9 阶段 · 阶段间流转须审批留痕">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            {lifecycleStages.map((s, i) => (
              <div key={s.stage} style={card}>
                <div className="row between">
                  <span className="mono" style={{ color: 'var(--cyan)' }}>{String(i + 1).padStart(2, '0')}</span>
                  <span className="muted small">{s.cur}</span>
                </div>
                <div className="strong" style={{ marginTop: 6 }}>{s.stage}</div>
                <div className="muted small" style={{ marginTop: 4 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Panel
          title="模型资产清单"
          extra={<Tabs items={TABS} active={tab} onChange={setTab} />}
          noPad
        >
          <div className="panel-body">
            <Table
              head={['模型', '底座', '阶段', '渠道', '副本（实时）', '版本', '利用率', '今日 Token', '状态']}
              rows={list.map((m) => [
                <span className="strong">{m.name}</span>,
                <span className="mono small">{m.base}</span>,
                m.stage,
                m.channel,
                (() => {
                  const em = engineModels.find((x) => m.base.includes(x.short))
                  return em ? <span className="num small">{em.replicas} × {em.perReplica} 卡</span> : <span className="tiny faint">未纳管副本</span>
                })(),
                <span className="mono small">{engineModels.find((x) => m.base.includes(x.short))?.ver ?? m.ver}</span>,
                <div style={{ minWidth: 90 }}>
                  <Progress value={m.util} tone={m.util > 85 ? 'warn' : ''} />
                  <div className="row between small" style={{ marginTop: 4 }}>
                    <span className="muted">{m.rpm}</span>
                    <span className="num">{m.util}%</span>
                  </div>
                </div>,
                m.tokens > 0 ? <span className="num">{fmtCN(m.tokens)}</span> : <span className="muted">—</span>,
                (() => {
                  const em = engineModels.find((x) => m.base.includes(x.short))
                  return em && em.state === '已下线' ? <Badge tone="muted">已下线 · 已摘除目录</Badge> : <State s={m.status} />
                })(),
              ])}
              minWidth={960}
            />
          </div>
        </Panel>
      </div>

      <Panel title="版本回退与下线变更（可操作）" extra="下线须审批 · 释放卡位归还资源池 · 识别受影响应用并推送通知 · 保留配置快照可回滚" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">模型</div>
              <select className="btn sm" style={{ marginTop: 4, maxWidth: 240 }} value={mSel} onChange={(e) => { setMSel(e.target.value); setToVer(engineModels.find((x) => x.short === e.target.value)?.versions[1] ?? '') }}>
                {engineModels.map((m) => <option key={m.short} value={m.short}>{m.name}（{m.ver} · {m.state}）</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">回退目标版本</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={toVer} onChange={(e) => setToVer(e.target.value)}>
                {(engineModels.find((x) => x.short === mSel)?.versions ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">依据</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={basis} onChange={(e) => setBasis(e.target.value)}>
                {BASIS_OPTS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="tiny faint">理由</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：v2.3 在长文本场景出现格式漂移，回退至 v2.2 并通知使用方" />
            </div>
            <button className="btn primary" disabled={!canGate} onClick={() => act('model_rollback')}>提交版本回退</button>
            <button className="btn danger" disabled={!canGate} onClick={() => act('model_retire')}>提交下线变更</button>
          </div>

          {flash ? (
            <div className="callout" style={{ marginTop: 12 }}>
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
              <div>{flash}</div>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <Table
              head={['工单', '类型 · 模型', '对象与影响', '状态', '轨迹与联动通知']}
              rows={lifeOrders.map((o) => [
                <span className="mono small">{o.id}</span>,
                <span className="small">{TYPE_LABEL[o.type as 'model_rollback']}<div className="tiny faint">{o.applicant}</div></span>,
                <span className="small">{o.target} · {o.amount}<div className="tiny faint">{String(o.spec.basis ?? '')}</div></span>,
                <State s={o.status === 'submitted' ? 'pending' : o.status === 'queued' ? 'queued' : o.status === 'running' ? 'run' : o.status === 'rejected' ? 'block' : o.status === 'rolled_back' ? 'rollback' : 'closed'} />,
                <span className="tiny faint" style={{ maxWidth: 340 }}>{o.trace.map((t) => t.action).join(' → ')}</span>,
              ])}
              minWidth={900}
            />
          </div>
          {canGate && lifeOrders.some((o) => o.status === 'submitted') ? (
            <div className="row gap6" style={{ marginTop: 10 }}>
              {lifeOrders.filter((o) => o.status === 'submitted').map((o) => (
                <span key={o.id} className="row gap6">
                  <button className="btn sm primary" onClick={() => engine.approve(o.id)}>审批通过并排队 {o.id}</button>
                  <button className="btn sm danger" onClick={() => engine.reject(o.id, '未提交下线影响评估，退回补充')}>驳回</button>
                </span>
              ))}
            </div>
          ) : null}
          {canGate && lifeOrders.some((o) => o.status === 'running') ? (
            <div className="row gap6" style={{ marginTop: 10 }}>
              <span className="small faint">生效中（可回滚恢复配置快照）</span>
              {lifeOrders.filter((o) => o.status === 'running').map((o) => <button key={o.id} className="btn sm" onClick={() => engine.rollback(o.id)}>回滚 {o.id}</button>)}
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="mt14">
        <Callout
          text={
            <>
              <b>场景一 · 直接部署</b>：选型引入 → 环境部署 → 上线配置 → 对外推理 → 运行运维 → 下线变更（6 阶段，跳过训练相关 3 阶段）；
              <b>场景二 · 微调后推理</b>：选型引入 → 训练数据治理 → 微调训练 → 微调模型审核 → 环境部署 → 上线配置 → 对外推理 → 运行运维 → 下线变更（全 9 阶段）。
              <b>微调制品未经审核放行，不得转入部署环节。</b>
            </>
          }
        />
      </div>
    </div>
  )
}
