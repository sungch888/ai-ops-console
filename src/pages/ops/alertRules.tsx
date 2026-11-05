import React, { useMemo, useState } from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout } from '../../components/ui'
import { useAlertRules, ruleStore, evaluateRules, METRIC_BY_DIM, METRIC_UNIT, type AlertDim, type AlertMetric, type AlertMode, type AlertAction, type AlertLevel } from '../../engine/alerts'
import { engine } from '../../engine/engine'
import { usePerm } from '../../engine/auth'
import { useNotifs } from '../../engine/ops'

const DIMS: AlertDim[] = ['渠道', '资源池', '全局', '凭证', '应用']
const LEVELS: AlertLevel[] = ['一般', '重要', '紧急']
const ACTIONS: AlertAction[] = ['仅告警', '生成建议工单', '自动切换渠道', '自动凭证盘点', '自动暂停或隔离']

export default function OpsAlertRules() {
  const rules = useAlertRules()
  const notifs = useNotifs()
  const perm = usePerm('analytics')
  const [dim, setDim] = useState<AlertDim>('资源池')
  const [metric, setMetric] = useState<AlertMetric>('利用率')
  const [obj, setObj] = useState('高保服务集群')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<AlertMode>('固定阈值')
  const [op, setOp] = useState<'>' | '<'>('>')
  const [threshold, setThreshold] = useState(90)
  const [level, setLevel] = useState<AlertLevel>('重要')
  const [action, setAction] = useState<AlertAction>('生成建议工单')
  const [flash, setFlash] = useState<string | null>(null)

  const samples = ruleStore.samplesNow()
  const objs = useMemo<Record<AlertDim, string[]>>(() => ({
    渠道: ['全部', ...engine.get().channels.map((c) => c.name)],
    资源池: ['全部', ...engine.get().pools.map((p) => p.name)],
    全局: ['算力资源池'],
    凭证: ['临期 / 僵尸凭证'],
    应用: ['全部', ...engine.get().managed.map((m) => m.name)],
  }), [samples])
  const baselines = ruleStore.baselines()
  const enabled = rules.filter((r) => r.enabled).length
  const fired = rules.reduce((s, r) => s + r.fired, 0)
  const autoActions = notifs.filter((n) => n.text.includes('处置：')).length

  const create = () => {
    if (!name.trim()) { setFlash('规则名称不能为空'); return }
    ruleStore.create({ name: name.trim(), dim, metric, obj, mode, op, threshold, level, action })
    setFlash(`规则已创建并启用：${dim} · ${obj} · ${metric} ${op} ${threshold}${METRIC_UNIT[metric]}`)
    setName('')
  }

  return (
    <div>
      <PageHead
        title="告警规则管理"
        desc="按渠道 / 资源池 / 全局 / 凭证维度配置告警规则 · 支持固定阈值与基线偏离两种模式 · 触发即通知并可挂自动处置"
        extra={
          <>
            <Badge tone="info">{enabled} / {rules.length} 条启用</Badge>
            <Badge tone={fired ? 'warn' : 'muted'}>累计触发 {fired}</Badge>
            <button className="btn sm primary" onClick={() => { const r = evaluateRules(); setFlash(r.fired ? `立即评估：触发 ${r.fired} 项\n${r.log.join('\n')}` : '立即评估：当前无规则命中') }}>立即评估一次</button>
            <button className="btn sm ghost" onClick={() => ruleStore.reset()}>恢复默认规则</button>
          </>
        }
      />

      {flash ? (
        <div className="callout" style={{ marginBottom: 14 }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div style={{ whiteSpace: 'pre-line' }}>{flash}</div>
        </div>
      ) : null}

      <div className="grid g-4">
        <Kpi label="规则总数" value={rules.length} unit="条" foot={`启用 ${enabled} · 停用 ${rules.length - enabled}`} />
        <Kpi label="累计触发" value={fired} unit="次" foot="同一规则 25 秒内不重复触发" />
        <Kpi label="自动处置动作" value={autoActions} unit="次" foot="生成工单 / 切换渠道 / 凭证盘点" />
        <Kpi label="采样巡检" value={samples.length} unit="项指标" foot="引擎每次状态变化自动评估" />
      </div>

      <Panel title="规则清单" extra={perm.manage ? '阈值与处置可现场调整，立即生效' : '只读（当前角色无配置权）'} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1080}
            head={['规则', '维度 · 对象', '判定条件', '等级', '自动处置', '触发', '启停']}
            rows={rules.map((r) => [
              <span className="strong small">{r.id}<div className="tiny faint">{r.name}</div></span>,
              <span className="small">{r.dim} · {r.obj}<div className="tiny faint">{r.metric}</div></span>,
              perm.manage ? (
                <div className="row gap6">
                  <span className="small">{r.mode === '基线偏离' ? '偏离 >' : ''}</span>
                  <select className="btn sm" style={{ padding: '3px 8px' }} disabled={!perm.manage} value={r.op} onChange={(e) => ruleStore.setOp(r.id, e.target.value as '>' | '<')}>
                    <option value=">">大于</option>
                    <option value="<">小于</option>
                  </select>
                  <input className="btn sm" style={{ width: 74, padding: '3px 8px' }} type="number" disabled={!perm.manage} value={r.threshold} onChange={(e) => ruleStore.setThreshold(r.id, Number(e.target.value))} />
                  <span className="tiny faint">{METRIC_UNIT[r.metric]}{r.mode === '基线偏离' ? ' · 基线偏离%' : ''}</span>
                </div>
              ) : <span className="small">{r.op === '>' ? '大于' : '小于'} {r.threshold}{METRIC_UNIT[r.metric]}{r.mode === '基线偏离' ? '（基线偏离）' : ''}</span>,
              perm.manage ? (
                <select className="btn sm" style={{ padding: '3px 8px' }} value={r.level} onChange={(e) => ruleStore.setLevel(r.id, e.target.value as AlertLevel)}>
                  {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              ) : r.level === '紧急' ? <Badge tone="bad">紧急</Badge> : r.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>,
              perm.manage ? (
                <select className="btn sm" style={{ padding: '3px 8px', maxWidth: 150 }} value={r.action} onChange={(e) => ruleStore.setAction(r.id, e.target.value as AlertAction)}>
                  {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              ) : <span className="small">{r.action}</span>,
              <span className="small">{r.fired} 次<div className="tiny faint">{r.lastFired || '未触发'}</div></span>,
              <div className="row gap6">
                <button className={`btn sm ${r.enabled ? 'primary' : 'ghost'}`} disabled={!perm.manage} onClick={() => ruleStore.toggle(r.id)}>{r.enabled ? '启用中' : '已停用'}</button>
                {perm.manage ? <button className="btn sm danger" style={{ padding: '3px 8px' }} onClick={() => ruleStore.remove(r.id)}>删除</button> : null}
              </div>,
            ])}
          />
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="新建告警规则" extra="创建后默认启用 · 下一次采样即参与评估">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">规则名称</div>
              <input className="btn sm" style={{ marginTop: 4, width: 210 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：共享集群显存超阈" />
            </div>
            <div>
              <div className="tiny faint">维度</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={dim} onChange={(e) => { const d = e.target.value as AlertDim; setDim(d); setMetric(METRIC_BY_DIM[d][0]); setObj(objs[d][1] ?? '全部') }}>
                {DIMS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">对象</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={obj} onChange={(e) => setObj(e.target.value)}>
                {objs[dim].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">指标</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={metric} onChange={(e) => { setMetric(e.target.value as AlertMetric); setThreshold(e.target.value === 'p95延迟' ? 200 : e.target.value === '空闲卡位' ? 4 : 85) }}>
                {METRIC_BY_DIM[dim].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">模式</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={mode} onChange={(e) => setMode(e.target.value as AlertMode)}>
                {(['固定阈值', '基线偏离'] as AlertMode[]).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">方向 / 阈值</div>
              <div className="row gap6" style={{ marginTop: 4 }}>
                <select className="btn sm" value={op} onChange={(e) => setOp(e.target.value as '>' | '<')}>
                  <option value=">">大于</option>
                  <option value="<">小于</option>
                </select>
                <input className="btn sm" style={{ width: 82 }} type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                <span className="tiny faint">{METRIC_UNIT[metric]}</span>
              </div>
            </div>
            <div>
              <div className="tiny faint">等级</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={level} onChange={(e) => setLevel(e.target.value as AlertLevel)}>
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">自动处置</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={action} onChange={(e) => setAction(e.target.value as AlertAction)}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <button className="btn primary" disabled={!perm.manage} onClick={create}>创建规则</button>
          </div>
          <Callout text="基线偏离模式：以最近 12 次采样的均值为基线，按偏离百分比判定（适合环比突增、持续劣化）。固定阈值模式：直接按指标值判定。触发后写入通知中心（按等级路由渠道）并计入事件流；处置动作可选自动生成交调工单、切换渠道或执行凭证盘点。" />
        </Panel>

        <Panel title="实时指标快照" extra="当前采样值与基线" noPad>
          <div className="panel-body">
            <Table
              minWidth={420}
              head={['对象 · 指标', '当前值', '基线均值', '偏离']}
              rows={samples.map((s) => {
                const hist = baselines[s.key] ?? []
                const base = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0
                const dev = base ? ((s.value - base) / base) * 100 : 0
                return [
                  <span className="small">{s.obj} · {s.metric}</span>,
                  <span className="num">{s.value}{s.unit}</span>,
                  <span className="num faint small">{base ? `${base.toFixed(1)}${s.unit}` : '样本不足'}</span>,
                  <span className={`num small ${Math.abs(dev) > 30 ? 'strong' : 'muted'}`}>{base ? `${dev > 0 ? '+' : ''}${dev.toFixed(0)}%` : '—'}</span>,
                ]
              })}
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}
