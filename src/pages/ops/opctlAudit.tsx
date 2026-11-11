/* =====================================================================
 * 操作控制 · 操作审计与回退
 *   口径：每次实际变更的审计分三段——意图段（谁提的、关联哪张工单、变更前后要什么）、
 *         执行段（谁批、谁执行、谁复核、外部回执、每段判定结果）、
 *         结果段（是否生效、效果验证证据、通知是否真的送达、未闭环事项与责任人）。
 *   「拦下」也是审计对象：平台拦了什么、命中哪条门禁、依据原文哪一条，都要能查（原文 1.1-8 失败与回退也须留痕）。
 *   管理变更审计 ≠ 查询/导出审计：两者采集与关联分别评估、不能互相代替（原文 GW-14）；
 *   不逐次建单的正常操作（查询、面板、逐请求推理、按批准策略分流）仍留运行/操作审计日志（原文 1.1-10）。
 * ===================================================================== */
import { useState } from 'react'
import { AlertBadge, Badge, Callout, Kpi, PageHead, Panel, Table, Tip } from '../../components/ui'
import { STATUS_LABEL, STATUS_TONE, OP_JUDGE, opDef, useOpctl } from '../../engine/opctl'
import { usePerm } from '../../engine/auth'
import { useAlertPick, usePickFlash } from '../../engine/alertJump'

export default function OpctlAudit() {
  const st = useOpctl()
  const pick = useAlertPick()
  usePickFlash(pick)
  const perm = usePerm('opctl')
  const [sel, setSel] = useState('')
  const cur = st.ops.find((o) => o.id === (sel || pick)) ?? st.ops[0]
  const def = cur ? opDef(cur.code)! : null
  const denied = st.ops.flatMap((o) => o.trace.filter((t) => t.result === '拦下').map((t) => ({ ...t, opId: o.id, action: opDef(o.code)?.action ?? '' })))
  const rollbacks = st.ops.filter((o) => o.rollbackOf)
  const notComplemented = st.ops.filter((o) => o.emergency?.state === '待补审')
  const notifyRows = st.ops.flatMap((o) => o.notify.map((n) => ({ ...n, opId: o.id })))

  return (
    <>
      <PageHead title="操作控制 · 操作审计与回退"
        desc="每次变更的意图段 / 执行段 / 结果段都可查，拦下、失败与回退同样留痕；管理变更审计与查询导出审计分开记录" />

      <div className="grid g-4" style={{ marginTop: 14 }}>
        <Kpi label="被门禁拦下" value={String(st.denied)} unit="次" foot="每条拦截都记命中门禁与原文依据" />
        <Kpi label="操作记录" value={String(st.ops.length)} unit="条" foot="含反向操作与自动动作" />
        <Kpi label="紧急未补审" value={String(notComplemented.length)} unit="条" foot="紧急处置须在 24h 内补审并关联变更单"
          jump={notComplemented[0] ? { page: '/ops/opctl-audit', pick: notComplemented[0].id, label: '点过去看这条紧急处置的补审与关联单' } : undefined} />
        <Kpi label="通知未送达" value={String(notifyRows.filter((n) => n.state === '未送达').length)} unit="条" foot="发送成功 ≠ 送达 ≠ 已确认（原文 SP-07）" />
      </div>

      {!perm.view ? <div className="mt14"><Callout warn text="没有「操作控制」权限：审计页只对有权限账号开放；谁能查审计记录本身也是权限项（原文 1.3）。" /></div> : null}

      <Panel focus title="操作台账（点开一条看三段式审计）" className="mt14" noPad>
        <Table minWidth={1320} rowKeys={st.ops.map((o) => o.id)} pick={sel || pick}
          head={['操作号', '动作 / 对象', '意图段：申请人 · 工单', '执行段：审批 / 执行 / 复核', '结果段：状态 · 效果验证 · 通知', '轨迹']}
          rows={st.ops.map((o) => [
            <button className="btn sm ghost mono tiny" onClick={() => setSel(o.id)}>{o.id}</button>,
            <span className="small">{opDef(o.code)?.action}<span className="tiny faint"> · {o.target}</span></span>,
            <span className="tiny">{o.requestedBy}<br /><span className="mono faint">{o.ticketId} · {o.ticketKind}</span></span>,
            <span className="tiny">{o.approvedBy ?? '—'}<br />{o.executedBy ?? '—'}<br />{opDef(o.code)!.needsDual ? (o.reviewedBy ? <Badge tone="good">{o.reviewedBy}</Badge> : <AlertBadge tone="bad" jump={{ page: '/ops/opctl-queue', pick: o.id, label: '复核没做：点过去到队列处理' }}>缺复核</AlertBadge>) : <span className="faint">不要求</span>}</span>,
            <span className="tiny"><Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
              {o.failStage ? <span className="bad tiny"> 失败段：{o.failStage}</span> : null}
              <br />{o.notify.length ? o.notify.map((n, i) => <Badge key={i} tone={n.state === '已送达' ? 'good' : n.state === '未送达' ? 'bad' : 'warn'}>{n.state}</Badge>) : <span className="faint">无通知</span>}</span>,
            <span className="tiny faint">{o.trace.length} 条</span>,
          ])} />
      </Panel>

      {cur && def ? (
        <>
          <Panel focus title="分段成功判定与审计轨迹" extra={`${cur.id} · ${def.action} · ${def.sourceRef}`} className="mt14" noPad>
            <div style={{ padding: '10px 12px 0' }}>
              <div className="row gap6 wrap">
                <Badge tone="info">工单 {cur.ticketId} · {cur.ticketKind}</Badge>
                <Badge tone="info">执行归属 {cur.execMode}</Badge>
                <Badge tone={def.needsDual ? 'purple' : 'muted'}>{def.needsDual ? '双人执行复核' : '单人执行'}</Badge>
                {cur.externalRef ? <Badge tone="warn">外部单号 {cur.externalRef}</Badge> : null}
                {cur.emergency ? <Badge tone="bad">紧急 · {cur.emergency.state}（{cur.emergency.dueAt} 前）</Badge> : null}
                <span className="tiny faint">变更前：{cur.beforeSnap}</span>
                <span className="tiny faint">变更后：{cur.afterSnap ?? '未产生'}</span>
                <Tip label="十道门禁" text={OP_JUDGE} />
              </div>
            </div>
            <Table minWidth={1100}
              head={['分段', '状态', '时间', '证据 / 失败原因']}
              rows={cur.stages.map((s) => [
                <span className="small">{s.name}</span>,
                <Badge tone={s.state === '通过' ? 'good' : s.state === '失败' ? 'bad' : s.state === '执行中' ? 'info' : 'muted'}>{s.state}</Badge>,
                <span className="tiny mono">{s.at ?? '—'}</span>,
                <span className="tiny">{s.reason ?? (s.state === '通过' ? '结果已回查确认（不以登记完成代替验证）' : '—')}</span>,
              ])} />
            <Table minWidth={1200} rowKeys={cur.trace.map((t, i) => `${cur.id}-${i}`)} pick={pick}
              head={['时间', '账号', '门禁', '动作', '结果', '理由 / 详情']}
              rows={cur.trace.map((t) => [
                <span className="tiny mono">{t.at}</span>, <span className="tiny">{t.actor}</span>,
                <span className="tiny mono">{t.gate}</span>, <span className="tiny">{t.action}</span>,
                t.result === '拦下' ? <AlertBadge tone="bad" jump={{ page: '/ops/opctl-queue', pick: cur.id, label: '这条被拦下：点过去到队列看能不能做、该谁做' }}>拦下</AlertBadge> : <Badge tone={t.result === '失败' ? 'bad' : t.result === '通过' ? 'good' : 'info'}>{t.result}</Badge>,
                <span className="tiny">{t.reason ?? t.detail ?? '—'}{t.reason && t.gate.includes('原文') ? '' : ''}</span>,
              ])} />
            <div className="tiny faint" style={{ padding: '8px 12px 12px' }}>
              依据原文口径：失败与回退同样审计留痕（1.1-8）；分段未齐备不得显示整体上线成功（2.5-2）；
              凭证未完成双人复核不得标记发放成功（2.6-3）；自动变更须有策略版本、前后资源与效果验证（SP-08）。
            </div>
          </Panel>

          <Panel title="通知与反馈（发送 / 送达 / 确认分列，通知不替代审批与执行）" noPad className="mt14">
            {notifyRows.length === 0 ? <div className="tiny faint" style={{ padding: 12 }}>当前没有通知记录。</div> : (
              <Table minWidth={760} head={['操作号', '责任账号', '渠道', '时间', '状态', '口径']}
                rows={notifyRows.map((n, i) => [
                  <span className="mono tiny">{n.opId}</span>, <span className="tiny">{n.to}</span>, n.channel,
                  <span className="tiny mono">{n.at}</span>,
                  <Badge tone={n.state === '已送达' ? 'good' : n.state === '未送达' ? 'bad' : 'warn'}>{n.state}</Badge>,
                  <span className="tiny faint">{n.state === '已送达' ? '送达已确认' : '发送成功不等于送达，未送达保留待办并升级（原文 SP-07）'}</span>,
                ])} />
            )}
          </Panel>
        </>
      ) : null}

      <Panel title="回退记录（反向操作 + 按变更前快照复验）" className="mt14" noPad>
        {rollbacks.length === 0 ? <div className="tiny faint" style={{ padding: 12 }}>当前没有回退记录：执行失败、部分成功或效果不达预期时可发起；凭证吊销类不可自动回滚，只能重新发放并重新双人复核。</div> : (
          <Table minWidth={1000} rowKeys={rollbacks.map((o) => o.id)} pick={pick}
            head={['反向操作号', '原操作', '动作', '目标', '状态', '快照对比']}
            rows={rollbacks.map((o) => [
              <span className="mono tiny">{o.id}</span>, <span className="mono tiny">{o.rollbackOf}</span>,
              opDef(o.code)?.action, o.target,
              <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>,
              <span className="tiny">回退到：{o.afterSnap}</span>,
            ])} />
        )}
      </Panel>

      <Panel title="平台拦下了什么（门禁命中清单，可按操作号跳回队列处理）" className="mt14" noPad>
        {denied.length === 0 ? <div className="tiny faint" style={{ padding: 12 }}>当前没有拦截记录。发起一个不合规的操作（比如不预检就提交、用同一账号既执行又复核）就会出现在这里。</div> : (
          <Table minWidth={1100} rowKeys={denied.map((d, i) => `${d.opId}-${i}`)} pick={pick}
            head={['时间', '操作号', '动作', '命中门禁', '理由（含原文依据）']}
            rows={denied.map((d) => [
              <span className="tiny mono">{d.at}</span>,
              <button className="btn sm ghost mono tiny" onClick={() => setSel(d.opId)}>{d.opId}</button>,
              <span className="tiny">{d.action}</span>,
              <span className="tiny mono">{d.gate}</span>,
              <span className="tiny">{d.reason}</span>,
            ])} />
        )}
      </Panel>

      <Panel title="审计口径（哪些必须分开记、哪些不逐次建单也要留痕）" className="mt14">
        <ul className="tiny" style={{ lineHeight: 1.9, margin: 0, paddingLeft: 18 }}>
          <li><span className="strong">管理变更审计 ≠ 查询 / 导出审计</span>：一个记「谁改了什么配置」，一个记「谁查了 / 导了什么」，采集与关联分别评估，不能互相代替（原文 GW-14）。</li>
          <li><span className="strong">原文与摘要导出权限分开</span>；导出含未脱敏敏感数据时停止交付并记录原因，修复复核后再提供（原文 4.4.2-2）。</li>
          <li>不逐次建单的正常操作（查询、面板查看、逐请求推理、按批准策略分流、授权范围内的训练操作、到期自动回收）<span className="strong">仍保留运行 / 操作审计日志</span>（原文 1.1-10/11）。</li>
          <li>权限项变更须记：账号、权限项、变更前后值、审批人、执行人、时间、结果，并关联原工单（原文 1.3）。</li>
          <li>Key 一律以哈希脱敏形式出现，不记录可用明文凭证（原文 GW-02）；权重到期清理不删除追溯与审计记录（原文 1.1-11）。</li>
          <li>敏感原文按逐账号细粒度授权，运营或管理员角色不自动全开；无权限 / 未启用 / 缺失不得解释为「不存在调用」（原文 4.4.3）。</li>
        </ul>
      </Panel>
    </>
  )
}
