import React, { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { secEvents, secDefenses } from '../../data/mock'
import { engine, useEngine, KIND_ACTIONS, BASIS_OPTS, type ContainKind, type ContainAction } from '../../engine/engine'
import { usePerm, useSession, useMatrix } from '../../engine/auth'
import { usePolicies } from '../../engine/policies'

const ACTIONS = [
  { name: '凭证吊销', desc: '即时吊销并重发，15 分钟内完成', tone: 'bad' as const },
  { name: '权限冻结', desc: '冻结账号或角色授权，须审批留痕', tone: 'warn' as const },
  { name: '路由隔离', desc: '从调用路由摘除异常模型渠道 / MCP 服务', tone: 'info' as const },
  { name: '工具 / 应用下线', desc: '临时下线并提前通知受影响用户', tone: 'purple' as const },
]

export default function AppSecurity() {
  const st = useEngine()
  const matrix = useMatrix()
  const { policies, changes, prompts } = usePolicies()
  const session = useSession()
  const canAct = usePerm('security').manage
  const [kind, setKind] = useState<ContainKind>('知识库')
  const [name, setName] = useState(st.managed.find((m) => m.kind === '知识库')?.name ?? '')
  const [action, setAction] = useState<ContainAction>('暂停入库')
  const [basis, setBasis] = useState('告警触发')
  const [reason, setReason] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const containments = st.orders.filter((o) => o.type === 'containment')

  const submitAction = () => {
    const r = engine.submit({ type: 'containment', applicant: session?.name ?? '运营值班', dept: session?.dept ?? '应用中心', level: st.managed.find((m) => m.name === name)?.level ?? '共享', reason: reason || '（未填写业务影响说明）', spec: { kind, name, action, basis } })
    setFlash(r.precheck.ok ? `${r.order.id} 已提交，准入预检通过：${r.precheck.suggest ?? ''}` : `${r.order.id} 被准入校验驳回：${r.precheck.reason}`)
    setReason('')
  }

  const eventOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['一般', '重要', '紧急'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: { type: 'category', data: ['10-29', '10-30', '10-31', '11-01', '11-02', '11-03', '11-04'], axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 11 } },
    yAxis: { type: 'value', name: '起', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '一般', type: 'bar', stack: 'e', barWidth: 18, itemStyle: { color: '#3d8bfd' }, data: [3, 4, 2, 1, 5, 4, 3] },
      { name: '重要', type: 'bar', stack: 'e', itemStyle: { color: '#f5b83d' }, data: [1, 2, 1, 0, 2, 3, 2] },
      { name: '紧急', type: 'bar', stack: 'e', itemStyle: { color: '#ff6b6b', borderRadius: [5, 5, 0, 0] }, data: [0, 1, 0, 0, 1, 1, 2] },
    ],
  }

  return (
    <div>
      <PageHead
        title="安全事件处置"
        desc="四条防护域值守 · 分析定级 · 应急处置 · 复盘改进"
        extra={<><Badge tone="bad">1 起紧急处置中</Badge><Badge tone="good">闭环率 80%</Badge></>}
      />

      <div className="grid g-5">
        <Kpi label="今日事件" value={5} unit="起" foot="紧急 1 · 重要 1 · 一般 3" />
        <Kpi label="平均定级时效" value="4" unit="分钟" foot="目标 ≤ 5 分钟" />
        <Kpi label="紧急处置时效" value="12" unit="分钟" foot="目标 ≤ 15 分钟" />
        <Kpi label="近 7 日事件" value={26} unit="起" foot={<><span className="down">▼ 8%</span> 环比上周</>} />
        <Kpi label="误报标记" value={3} unit="起" foot="已闭环并说明原因" />
      </div>

      <div className="grid g-32 mt14">
        <Panel title="事件等级分布（近 7 日）" extra="按日堆叠">
          <Chart option={eventOpt} height={270} />
        </Panel>
        <Panel title="四条防线态势" extra="告警 / 已处置">
          {secDefenses.map((d) => (
            <div key={d.name} style={{ marginBottom: 12 }}>
              <div className="row between small">
                <span>{d.name}</span>
                <span className="muted">{d.handled} / {d.alerts} · {d.rate}</span>
              </div>
              <div style={{ marginTop: 5 }}><Progress value={parseFloat(d.rate)} tone={d.rate === '100%' ? 'green' : 'warn'} /></div>
            </div>
          ))}
        </Panel>
      </div>

      <Panel title="安全事件台账" extra="触发 → 分析 → 处置 → 闭环" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={940}
            head={['事件编号', '时间', '等级', '类型', '事件描述', '处置措施', '状态']}
            rows={secEvents.map((e) => [
              <span className="mono small">{e.id}</span>,
              <span className="mono small">{e.time}</span>,
              e.level === '紧急' ? <Badge tone="bad">紧急</Badge> : e.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>,
              <span className="strong small">{e.type}</span>,
              <span className="muted small" style={{ maxWidth: 260 }}>{e.desc}</span>,
              <span className="small" style={{ color: '#a9c4e8' }}>{e.action}</span>,
              e.status === '处置中' ? <Badge tone="warn">处置中</Badge> : <Badge tone="good">已闭环</Badge>,
            ])}
          />
        </div>
      </Panel>

      <Panel title="处置动作执行（可操作）" extra="提交 → 准入校验（依据与业务影响）→ 审批 → 生效并通知归口；处置结果实时反映在纳管页面" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">处置对象类型</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={kind} onChange={(e) => { const k = e.target.value as ContainKind; setKind(k); setName(st.managed.find((m) => m.kind === k)?.name ?? ''); setAction(KIND_ACTIONS[k][0]) }}>
                {(Object.keys(KIND_ACTIONS) as ContainKind[]).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">纳管对象</div>
              <select className="btn sm" style={{ marginTop: 4, maxWidth: 220 }} value={name} onChange={(e) => setName(e.target.value)}>
                {st.managed.filter((m) => m.kind === kind).map((m) => <option key={m.id} value={m.name}>{m.name}（{m.status}）</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">处置动作</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={action} onChange={(e) => setAction(e.target.value as ContainAction)}>
                {KIND_ACTIONS[kind].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">处置依据</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={basis} onChange={(e) => setBasis(e.target.value)}>
                {BASIS_OPTS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="tiny faint">理由（须写明业务影响与影响范围）</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：解析失败率连续超阈值，暂停入库并通知归口部门，恢复窗口待复核" />
            </div>
            <button className="btn primary" disabled={!canAct} onClick={submitAction}>提交处置</button>
          </div>

          {flash ? (
            <div className="callout" style={{ marginTop: 12 }}>
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
              <div>{flash}</div>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <Table
              head={['处置工单', '对象 · 动作', '依据', '状态', '生效结果与通知']}
              rows={containments.map((o) => [
                <span className="mono small">{o.id}{o.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动</span> : null}</span>,
                <span className="small">{o.target}<div className="tiny faint">{o.applicant} · {o.dept}</div></span>,
                <span className="tag amber">{String(o.spec.basis ?? '—')}</span>,
                <State s={o.status === 'submitted' ? 'pending' : o.status === 'queued' ? 'queued' : o.status === 'running' ? 'run' : o.status === 'rejected' ? 'block' : o.status === 'rolled_back' ? 'rollback' : 'closed'} />,
                <span className="tiny faint" style={{ maxWidth: 320 }}>{o.trace.map((t) => t.action).join(' → ')}</span>,
              ])}
              minWidth={900}
            />
          </div>
          {containments.some((o) => o.status === 'submitted') && canAct ? (
            <div className="row gap6" style={{ marginTop: 10 }}>
              <span className="small faint">待审批处置</span>
              {containments.filter((o) => o.status === 'submitted').map((o) => (
                <span key={o.id} className="row gap6">
                  <button className="btn sm primary" onClick={() => engine.approve(o.id)}>通过并执行 {o.id}</button>
                  <button className="btn sm danger" onClick={() => engine.reject(o.id, '影响面未评估完整，要求补充受影响应用清单后重新提交')}>驳回</button>
                </span>
              ))}
            </div>
          ) : null}
          {containments.some((o) => o.status === 'running') ? (
            <div className="row gap6" style={{ marginTop: 10 }}>
              <span className="small faint">生效中处置（可回滚恢复原状态）</span>
              {containments.filter((o) => o.status === 'running').map((o) => <button key={o.id} className="btn sm" onClick={() => engine.rollback(o.id)}>回滚 {o.id}</button>)}
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="应急处置动作库" extra="凭证吊销与权限收回在工作台 / 权限矩阵执行；本页承载应用侧动作" noPad>
          <div className="panel-body">
            <Table
              head={['动作', '适用对象', '执行位置', '授权要求']}
              rows={[
                ['暂停入库 / 恢复入库', '向量知识库', '本页（可执行）', '须处置依据 · 归口通知'],
                ['限流保护 / 暂停应用 / 恢复应用', '智能体应用', '本页（可执行）', '高保对象须告警或客户方指令依据'],
                ['隔离出目录 / 重新纳入', 'MCP 工具', '本页（可执行）', '须与模型侧技术注册目录联动'],
                ['禁用 / 启用', '插件', '本页（可执行）', '合规抽查或告警依据'],
                ['凭证吊销 / 配额冻结', '凭证与密钥', '模型中心 · 凭证与配额（可执行）', '双人复核'],
                ['路由权重降权 / 渠道切换', '推理网关渠道', '模型中心 · 推理网关（可执行）', '变更窗口内 · 可回滚'],
                ['权限冻结 / 角色收回', '账号与角色', '应用中心 · 权限矩阵（可编辑生效）', '管理员'],
                ['设备侧联动拦截 / 阻断', '6 类安全设备', '待商定：联动接口与执行主体', '不在演示范围'],
              ].map((r) => [
                <Badge tone={r[2].includes('可执行') || r[2].includes('可编辑') ? 'good' : 'muted'}>{r[0]}</Badge>,
                <span className="small">{r[1]}</span>,
                <span className="small" style={{ color: '#a9c4e8' }}>{r[2]}</span>,
                <span className="tag gray">{r[3]}</span>,
              ])}
            />
          </div>
        </Panel>
        <Panel title="策略一致性核查" extra="每周核查项 · 数据取自策略库与权限矩阵">
          <Table
            head={['核查项', '当前值', '结论']}
            rows={[
              ['敏感词 / 脱敏 / 注入 / 输出过滤策略', `${policies.length} 条（启用 ${policies.filter((p) => p.enabled).length}）`, policies.every((p) => p.versions.length > 0) ? '均有版本记录' : '存在无版本记录策略'],
              ['待审批策略变更', `${changes.filter((c) => c.status === '待审批').length} 项`, changes.some((c) => c.status === '待审批') ? '待安全审批人处理' : '无积压'],
              ['权限矩阵角色数', `4 个角色 · ${matrix.admin.view.length} 个可见权限点`, '矩阵可编辑并即时生效'],
              ['策略弱化审计（下调等级 / 放宽范围）', `${changes.filter((c) => c.op === '回滚' && c.status === '已生效').length} 次已回滚`, '异常变更自动回滚至上一审批版本'],
              ['系统提示词版本管理', `${prompts.length} 条目 · 均不在接口与前端暴露`, '符合要求'],
            ].map((r) => [
              <span className="small">{r[0]}</span>,
              <span className="small num">{r[1]}</span>,
              <span className="tiny" style={{ color: '#8fb0d6' }}>{r[2]}</span>,
            ])}
            minWidth={420}
          />
          <Callout warn text="策略弱化审计：未经审批下调处置等级或放宽拦截范围的变更，系统自动回滚至上一审批版本并登记审计记录。" />
        </Panel>
      </div>
    </div>
  )
}
