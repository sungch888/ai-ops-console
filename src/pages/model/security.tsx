import { useEffect, useState } from 'react'
import { Kpi, Panel, PageHead, Badge, AlertBadge, Table, Callout, fmtCN } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { secDetection, traces } from '../../data/mock'
import { usePolicies, policyStore, POLICY_KINDS, POLICY_ACTIONS, SCOPES, type PolicyKind, type PolicyAction } from '../../engine/policies'
import { usePerm, useSession } from '../../engine/auth'
import { useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

const PIPELINE = [
  { name: '① 请求侧检测', desc: '提示词注入识别 · 敏感词审查 · 越权意图识别，覆盖用户输入与知识片段' },
  { name: '② 网关路由', desc: '渠道调度 · 限流配额 · 业务分级队列，全链路鉴权与审计' },
  { name: '③ 响应侧检测', desc: '违规内容过滤 · 敏感信息泄露检测 · 不实言论识别' },
  { name: '④ 处置动作', desc: '放行 / 提示 / 脱敏 / 拦截 / 转人工复核，按风险等级差异化执行' },
]

export default function Security() {
  const { policies, changes, prompts } = usePolicies()
  const canApprove = usePerm('approve').manage
  const canEdit = usePerm('security').manage
  const session = useSession()
  const [sel, setSel] = useState('P-01')
  const [kind, setKind] = useState<PolicyKind>('敏感词')
  const [scope, setScope] = useState('全局')
  const [act, setAct] = useState<PolicyAction>('拦截')
  const [pname, setPname] = useState('')
  const [pattern, setPattern] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const cur = policies.find((p) => p.id === sel) ?? policies[0]
  const by = session?.name ?? '运营值班'

  /* 告警直达口径（本页主键：策略 id / 变更单 id）
     本页红 / 黄 → 落检测策略库那一行（改版 / 提交启停 / 回滚都在这一行）或变更单那一行（通过 / 驳回就在这一行）
     别处点进来：?pick=P-05 → 选中并高亮那条策略（下方提交面板同步切到它）；?pick=PC-001 → 高亮那张变更单 */
  const pick = useAlertPick()
  usePickFlash(pick)
  const policyJump = (id: string, label: string): AlertJump => ({ page: '/model/security', pick: id, label })
  const changeJump = (id: string, label: string): AlertJump => ({ page: '/model/security', pick: id, label })
  const pendingChanges = changes.filter((c) => c.status === '待审批')
  const injectPolicy = policies.find((p) => p.kind === '注入特征' && p.action === '拦截')
  const maskPolicy = policies.find((p) => p.kind === '脱敏规则')
  const reviewPolicy = policies.find((p) => p.action === '转人工')
  const logJump = (l: { target: string; action: string }): AlertJump => traces.some((t) => t.id === l.target)
    ? { page: '/model/trace', pick: l.target, label: `到这条调用（${l.target}）那一行：六节点链路与处置结果都在那一行，定责从这一步走` }
    : { page: '/model/security', pick: l.action.includes('身份证') || l.action.includes('掩码') ? 'P-03' : l.action.includes('越权') ? 'P-06' : 'P-05', label: '这条处置日志对不上具体调用号：到命中的那条策略那一行看命中模式与处置等级' }
  useEffect(() => { if (pick && policies.some((p) => p.id === pick)) setSel(pick) }, [pick, policies])

  const typeOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 20, top: 14, bottom: 6, containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: secDetection.byType.map((t) => t.name),
      axisLabel: { color: AXIS_COLOR, fontSize: 11.5 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '命中 / 拦截',
        type: 'bar',
        barWidth: 9,
        data: secDetection.byType.map((t) => t.v),
        itemStyle: { borderRadius: 5, color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#1899e0' }, { offset: 1, color: '#22d3ee' }] } },
        label: { show: true, position: 'right', color: 'var(--info-text)', fontSize: 11 },
      },
    ],
  }

  return (
    <div>
      <PageHead
        title="安全检测"
        desc="输入输出双向内容安全检测 · Prompt 注入防护 · 策略弱化审计 —— 检测覆盖率 100%（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">检测链路正常</Badge>
            <AlertBadge tone="warn" jump={{ page: '/model/safety-flow', pick: '/api/v1/check/pre', label: '超时到底放行还是拦截，这条口径在检测流程的接口契约那一行定；改超时 ms 在下方面板' }}>超时放行 ≤ 5% · 口径待定</AlertBadge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="今日输入检测" value={fmtCN(secDetection.todayInput)} unit="次" foot="请求侧全量检测 · 覆盖率 100%" />
        <Kpi label="提示词注入命中" value={secDetection.injectHit} unit="次" foot={<span className="down">● 4 类手法 · 误判 {secDetection.injectFalse} 次</span>}
          jump={policyJump(injectPolicy?.id ?? 'P-05', `到「${injectPolicy?.name ?? '角色改写型注入特征'}」这一行：命中模式与处置动作就在这一行，改版 / 启停要走变更单`)} />
        <Kpi label="敏感信息拦截" value={secDetection.inputBlocked + secDetection.outputBlocked} unit="次" foot={`输入 ${secDetection.inputBlocked} · 输出 ${secDetection.outputBlocked}`}
          jump={policyJump(maskPolicy?.id ?? 'P-03', `到「${maskPolicy?.name ?? '身份证 / 手机号脱敏'}」这一行：拦截 / 脱敏动作就在这一行，要放宽或收紧都在这上面提交变更单`)} />
        <Kpi label="转人工复核" value={secDetection.queue} unit="起" foot={secDetection.queue
          ? <span className="down">{`● ${secDetection.queue} 起中危待复核 · 复核队列未积压`}</span>
          : '中危事件 · 复核队列未积压'}
          jump={secDetection.queue ? policyJump(reviewPolicy?.id ?? 'P-06', `到「${reviewPolicy?.name ?? '越权意图识别'}」这一行：处置动作就是「转人工」，命中后怎么派复核都在这一行改`) : undefined} />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="风险类型分布" extra="今日 · 命中 / 拦截次数" noPad>
          <div className="panel-body">
            <Chart option={typeOpt} height={300} />
          </div>
        </Panel>
        <Panel title="策略处置日志" extra="每次检测与处置均记录日志 · 支撑审计与策略优化" noPad>
          <div className="panel-body">
            <Table
              head={['时间', '对象', '处置动作', '等级']}
              rowKeys={secDetection.policyLogs.map((l) => l.target)} pick={pick}
              rows={secDetection.policyLogs.map((l) => [
                <span className="mono small">{l.time}</span>,
                <span className="mono small">{l.target}</span>,
                l.action,
                l.level === 'bad'
                  ? <AlertBadge tone="bad" jump={logJump(l)}>高危</AlertBadge>
                  : l.level === 'warn'
                  ? <AlertBadge tone="warn" jump={logJump(l)}>中危 · 待复核</AlertBadge>
                  : <Badge tone="info">记录</Badge>,
              ])}
              minWidth={680}
            />
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Panel title="双向检测链路" extra="调用前检测 + 调用后过滤 · 处置全程留痕">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            {PIPELINE.map((p) => (
              <div key={p.name} style={{ border: '1px solid rgba(var(--line-rgb), .18)', background: 'rgba(23,48,90,.28)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="strong">{p.name}</div>
                <div className="muted small" style={{ marginTop: 4 }}>{p.desc}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="检测策略库（敏感词 / 脱敏 / 注入特征 / 输出过滤）" extra="任何新增、修改、启停、回滚均须提交变更单并经安全审批；每次生效写入版本快照" className="mt14" noPad>
        <div className="panel-body">
          <Table
            head={['策略', '类型 · 作用域', '命中模式', '处置动作', '今日命中', '状态', '操作']}
            rowKeys={policies.map((p) => p.id)} pick={pick}
            rows={policies.map((p) => [
              <button className="btn sm ghost" style={{ padding: '2px 8px', textAlign: 'left' }} onClick={() => setSel(p.id)}><span className="strong">{p.id}</span> {p.name}</button>,
              <span className="small">{p.kind}<div className="tiny faint">{p.scope}</div></span>,
              <span className="mono tiny" style={{ maxWidth: 260 }}>{p.pattern}</span>,
              <Badge tone={p.action === '拦截' ? 'bad' : p.action === '转人工' ? 'warn' : p.action === '脱敏' ? 'info' : 'muted'}>{p.action}</Badge>,
              <span className="num">{fmtCN(p.hits)}</span>,
              p.enabled ? <Badge tone="good">启用</Badge> : <Badge tone="muted">停用</Badge>,
              <div className="row gap6">
                <button className="btn sm" disabled={!canEdit} onClick={() => { setSel(p.id); setKind(p.kind); setScope(p.scope); setAct(p.action); setPattern(p.pattern); setPname(p.name) }}>改版</button>
                <button className="btn sm ghost" disabled={!canEdit} onClick={() => policyStore.submitChange({ op: p.enabled ? '停用' : '启用', policyId: p.id, submitBy: by })}>{p.enabled ? '提交停用' : '提交启用'}</button>
              </div>,
            ])}
            minWidth={1080}
          />
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title={cur ? `策略变更提交 · ${cur.id} ${cur.name}` : '策略变更提交'} extra="提交后进入待审批队列，审批通过才生效并写入新版本">
          <div className="row wrap gap12">
            <div>
              <div className="tiny faint">类型</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={kind} onChange={(e) => setKind(e.target.value as PolicyKind)}>
                {POLICY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">作用域</div>
              <select className="btn sm" style={{ marginTop: 4, maxWidth: 200 }} value={scope} onChange={(e) => setScope(e.target.value)}>
                {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">处置动作</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={act} onChange={(e) => setAct(e.target.value as PolicyAction)}>
                {POLICY_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <div className="tiny faint">策略名称</div>
              <input className="btn sm" style={{ marginTop: 4, width: 200 }} value={pname} onChange={(e) => setPname(e.target.value)} placeholder="新增时填写名称" />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="tiny faint">命中模式 / 词组</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="如：调查措施 · 重点关注 · 线索来源" />
            </div>
            <button className="btn primary" disabled={!canEdit} onClick={() => { if (!pattern.trim()) { setFlash('命中模式不能为空'); return } policyStore.submitChange({ op: '修改', policyId: cur.id, submitBy: by, payload: { pattern: pattern.trim(), scope, action: act, enabled: cur.enabled } }); setFlash(`修改已提交待审批 · ${cur.id} 当前版本 v${cur.versions[cur.versions.length - 1].v}`) }}>提交修改</button>
            <button className="btn" disabled={!canEdit} onClick={() => { if (!pname.trim() || !pattern.trim()) { setFlash('新增须填写名称与命中模式'); return } policyStore.submitChange({ op: '新增', policyId: 'NEW', submitBy: by, payload: { pattern: pattern.trim(), scope, action: act, enabled: true, kind, name: pname.trim() } }); setFlash(`新增已提交待审批：${pname.trim()}`) }}>提交新增策略</button>
          </div>
          {flash ? (
            <div className="callout" style={{ marginTop: 12 }}>
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
              <div>{flash}</div>
            </div>
          ) : null}
          <Callout text="系统提示词纳入版本管理：修改须审批并保留历史版本，提示词内容不得通过接口或前端完整暴露。处置策略可按租户、模型、业务线差异化配置，每次检测与处置结果均记录日志。" />
        </Panel>

        <Panel title="版本历史与回滚" extra={cur ? `${cur.id} · 共 ${cur.versions.length} 个版本` : ''} noPad>
          <div className="panel-body">
            {cur ? (
              <Table
                head={['版本', '时间 / 提交人', '快照', '操作']}
                rows={cur.versions.map((v) => [
                  <span className="num strong">v{v.v}</span>,
                  <span className="small">{v.at} · {v.by}<div className="tiny faint">{v.note}</div></span>,
                  <span className="tiny faint" style={{ maxWidth: 220 }}>{v.action} · {v.scope} · {v.enabled ? '启用' : '停用'}<div className="mono tiny">{v.pattern.slice(0, 40)}</div></span>,
                  v.v === cur.versions[cur.versions.length - 1].v ? <span className="tag gray">当前版本</span> : <button className="btn sm" disabled={!canEdit} onClick={() => policyStore.submitChange({ op: '回滚', policyId: cur.id, submitBy: by, rollbackTo: v.v })}>回滚至此版本</button>,
                ])}
                minWidth={460}
              />
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid g-2 mt14">
        <Panel title="策略变更审批队列" extra={canApprove ? '当前角色有安全审批权' : '只读（当前角色无审批权）'} noPad>
          <div className="panel-body">
            {changes.length === 0 ? <Callout text="暂无策略变更单。提交修改 / 新增 / 启停 / 回滚后会在此进入审批队列。" /> : (
              <Table
                head={['变更单', '操作 · 对象', '内容', '提交', '状态']}
                rowKeys={changes.map((c) => c.id)} pick={pick}
                rows={changes.map((c) => [
                  <span className="mono small">{c.id}</span>,
                  <span className="small">{c.op}<div className="tiny faint">{c.target}</div></span>,
                  <span className="tiny faint" style={{ maxWidth: 280 }}>{c.detail}</span>,
                  <span className="small">{c.submitBy}<div className="tiny faint">{c.submitAt}</div></span>,
                  <div className="row gap6">
                    {c.status === '待审批' ? (
                      canApprove ? (
                        <>
                          <button className="btn sm primary" onClick={() => policyStore.approveChange(c.id, by)}>通过</button>
                          <button className="btn sm danger" onClick={() => policyStore.rejectChange(c.id, by, '变更依据不足，要求补充命中样本与影响评估')}>驳回</button>
                        </>
                      ) : <AlertBadge tone="warn" jump={changeJump(c.id, `这张变更单 ${c.id} 未闭环（当前角色无审批权）：到这一行看内容与对象，找有审批权的人处理`)}>待审批</AlertBadge>
                    ) : c.status === '已生效' ? <Badge tone="good">已生效</Badge> : <AlertBadge tone="bad" jump={changeJump(c.id, `变更单 ${c.id} 已驳回${c.note ? `：${c.note}` : ''}：到这一行看理由，补齐命中样本与影响评估后重提`)}>已驳回</AlertBadge>}
                  </div>,
                ])}
                minWidth={760}
              />
            )}
          </div>
        </Panel>

        <Panel title="系统提示词版本管理" extra="提示词正文不在接口与前端暴露 · 改版须审批" noPad>
          <div className="panel-body">
            <Table
              head={['提示词条目', '当前版本', '历史版本', '审批人', '暴露状态']}
              rows={prompts.map((p) => [
                <span className="small strong">{p.name}</span>,
                <span className="num">{p.ver}</span>,
                <span className="mono small">{p.versions.join(' · ')}</span>,
                <span className="small">{p.approver}<div className="tiny faint">{p.updatedAt}</div></span>,
                <span className="tag gray">不对外暴露</span>,
              ])}
              minWidth={520}
            />
            <div className="row gap6" style={{ marginTop: 10 }}>
              <span className="small faint">提交改版（演示：直接指定新版本号）</span>
              <input className="btn sm" style={{ width: 120 }} placeholder="如 v8" value={pname.startsWith('prompt:') ? pname.slice(7) : ''} onChange={(e) => setPname(`prompt:${e.target.value}`)} />
              <button className="btn sm" disabled={!canApprove || !pname.startsWith('prompt:') || !pname.slice(7).trim()} onClick={() => { const v = pname.slice(7).trim(); const r = policyStore.promptChange(prompts[0].name, v, by, by); setFlash(r.ok ? `${prompts[0].name} 已改版至 ${v} · 历史版本已留存` : r.reason ?? '') }}>提交改版</button>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          warn={pendingChanges.length > 0}
          jump={pendingChanges.length ? changeJump(pendingChanges[0].id, `到这张待审批的变更单 ${pendingChanges[0].id} 那一行：通过 / 驳回都在那一行做`) : undefined}
          text={
            <>
              策略库状态：<b>{policies.length} 条策略</b>（启用 {policies.filter((p) => p.enabled).length} 条 · 累计命中 {fmtCN(policies.reduce((s, p) => s + p.hits, 0))} 次）· 注入防护覆盖<b>指令绕过 / 提示词泄露 / 越权调用 / 上下文污染</b> 4 类手法 · <b>策略弱化审计每周执行</b>，未经审批的弱化变更自动回滚至上一审批版本并登记审计记录（当前待审批变更 {pendingChanges.length} 项{pendingChanges.length ? '：点过去落到要处理的那张变更单那一行' : ''}）。
            </>
          }
        />
      </div>
    </div>
  )
}
