/* =====================================================================
 * 操作控制 · 操作目录与发起（唯一的写入口）
 *   口径：任何实际变更都先在这里发起 → dry-run 预计算影响面（不产生外部调用）→ 提交即建/关联工单 →
 *         之后到「执行队列与变更窗口」审批 / 复核 / 执行 / 验证。面板与监控页一律不做执行入口（原文 GW-12、5.1-6）。
 *   真实拦截在服务端口径的内核 src/engine/opctl.ts 里：无工单不执行、未预检不下发、申请人不得自批（除部署）、
 *         凭证与额度类必须双人复核（原文 1.1-8 / 2.5-2 / 2.6-3）。前端按钮禁用只是体验，不是安全边界（原文 1.3）。
 *   本期不接真实网关 / 容器平台：外部动作走「已下发·待回执」，回执到位才改台账（沿用 engine.ts:779/793）。
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertBadge, Badge, Callout, Kpi, PageHead, Panel, Table, Tabs, Tip } from '../../components/ui'
import { OP_CATALOG, OP_GROUPS, OP_JUDGE, OUT_OF_SCOPE_MSG, STATUS_ALERT, STATUS_LABEL, STATUS_TONE, opDef, opctlStore, ownerOf, useOpctl } from '../../engine/opctl'
import { currentAccount, usePerm } from '../../engine/auth'
import { useAlertPick, type AlertJump } from '../../engine/alertJump'

const qJump = (id: string, label: string): AlertJump => ({ page: '/ops/opctl-queue', pick: id, label })

export default function OpctlCatalog() {
  const st = useOpctl()
  const nav = useNavigate()
  const pick = useAlertPick()
  const viewPerm = usePerm('opctl')
  const execPerm = usePerm('opctl_exec')
  const [group, setGroup] = useState(OP_GROUPS[0])
  const [code, setCode] = useState('OC-D-03')
  const [target, setTarget] = useState('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [pre, setPre] = useState<{ id: string; impact: string[]; reasons: string[] } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; opId?: string } | null>(null)
  const def = opDef(code)!
  const me = currentAccount()
  useEffect(() => { if (!st.fromServer && !st.loading) void opctlStore.refresh() }, [st.fromServer, st.loading])
  const pending = st.ops.filter((o) => ['待审批', '待复核', '待窗口', '待回执'].includes(o.status))
  const waitingReview = st.ops.filter((o) => o.status === '待复核')

  const runPrecheck = async () => {
    setMsg(null)
    const r = await opctlStore.precheck(code, target, params)
    if (!r.id) { setPre(null); setMsg({ ok: false, text: '预检未通过：' + (r.reasons ?? []).join('；') }); return }
    setPre({ id: r.id, impact: r.impact ?? [], reasons: r.reasons ?? [] })
    setMsg(r.ok
      ? { ok: true, text: `预检通过（演练模式，未产生任何外部调用）：影响 ${r.impact?.length ?? 0} 项，预检号 ${r.id}。下一步提交会生成 ${def.ticketKind} 并关联本次变更` }
      : { ok: false, text: '预检不通过，不能提交：' + (r.reasons ?? []).join('；') })
  }
  const submit = async () => {
    if (!pre) { setMsg({ ok: false, text: '没做预检不能提交：服务端要求先有 dry-run 预检记录（沿用处置指令台既有口径）' }); return }
    const r = await opctlStore.submit(code, target, params, pre.id)
    if (!r.ok) { setMsg({ ok: false, text: r.reason ?? '提交被拒' }); return }
    setMsg({ ok: true, text: `${r.id} 已提交并关联工单，进入「${def.needsDual ? '待复核 → ' : ''}排队待窗口」。`, opId: r.id })
    setPre(null); setTarget(''); setParams({})
  }

  const rows = OP_CATALOG.filter((d) => d.group === group).map((d) => [
    <span className="mono tiny">{d.code}</span>,
    <span className="small strong">{d.action}</span>,
    ownerOf(d) === '本单元' ? <Badge tone="muted">本单元</Badge> : <AlertBadge tone="warn" jump={{ page: '/app/market', label: '应用发布归应用中心：点过去看应用中心的上架与发布入口' }}>归应用中心</AlertBadge>,
    <span className="tiny">{d.resource}</span>,
    <Badge tone="info">{d.ticketKind}</Badge>,
    <Badge tone={d.execMode === '平台自动' ? 'purple' : d.execMode === '外部执行需回执' ? 'warn' : 'muted'}>{d.execMode}</Badge>,
    d.needsDual ? <AlertBadge tone="warn" jump={qJump(st.ops.find((o) => o.status === '待复核')?.id ?? '', '点过去落到待复核那条：换另一账号复核，同人会被拒')}>需双人复核</AlertBadge> : <Badge tone="muted">单人</Badge>,
    d.selfApprove ? <Badge tone="purple">可自审</Badge> : <Badge tone="muted">不可自审</Badge>,
    d.autoAllowed ? <Badge tone="good">可自动</Badge> : <Badge tone="muted">仅人工</Badge>,
    <Badge tone={d.priority === 'P0' ? 'bad' : d.priority === 'P1' ? 'warn' : 'muted'}>{d.priority}</Badge>,
    <span className="tiny">{d.external}</span>,
    <span className="tiny faint">{d.sourceRef}</span>,
  ])

  return (
    <>
      <PageHead title="操作控制 · 操作目录与发起"
        desc="把已批准的决策变成对资源的真实变更：所有写操作只有这一个入口，先预检后提交，提交即建/关联工单（原文 1.1-8 不得绕过工单直接修改）" />

      <div className="grid g-4" style={{ marginTop: 14 }}>
        <Kpi label="可发起动作" value={String(OP_CATALOG.length)} foot="59 条操作目录里的 17 条代表性动作，已接内核（含池借还 3 条）" />
        <Kpi label="在途操作" value={String(pending.length)} unit="项" foot="待审批 / 待复核 / 排队 / 待回执"
          jump={pending[0] ? qJump(pending[0].id, '点过去落到队列里这一行：审批 / 复核 / 执行 / 回执都在那一行') : undefined} />
        <Kpi label="待双人复核" value={String(waitingReview.length)} unit="项"
          foot={waitingReview.length ? '凭证与额度类：另一账号复核前不得标记成功' : '当前没有待复核项'}
          jump={waitingReview[0] ? qJump(waitingReview[0].id, '点过去落到待复核这一行：先试同人复核（会被拒），再换另一账号') : undefined} />
        <Kpi label="被门禁拦下" value={String(st.denied)} unit="次" foot="每次拦截都落审计：平台拦了什么、依据哪条原文" />
      </div>

      {st.error ? (
        <div className="mt14">
          <Callout warn text={`操作数据读不到：${st.error}（判定在服务端，本地不会假装成功；请确认数据服务已启动并已登录）`} />
        </div>
      ) : null}

      {msg ? (
        <div className="mt14">
          <Callout warn={!msg.ok} text={msg.text}
            jump={msg.opId ? qJump(msg.opId, '点过去落到这条操作那一行：审批 / 复核 / 执行 / 回退都在那里') : undefined} />
        </div>
      ) : null}

      <Panel focus title="发起操作（① 先做 dry-run 预检 → ② 确认提交）" className="mt14">
        {!viewPerm.view ? <Callout warn text="没有「操作控制」权限：只能查看目录，不能发起。权限判定在服务端，改前端无效（原文 1.3）。" /> : null}
        {ownerOf(def) !== '本单元' ? <Callout warn text={OUT_OF_SCOPE_MSG + '。这条留在目录里只用来表明边界与状态交接，不能在这里发起。'} /> : null}
        <div className="row gap6 wrap" style={{ alignItems: 'flex-end' }}>
          <label className="col" style={{ minWidth: 220 }}>
            <span className="tiny faint">操作（OC 编号）</span>
            <select className="btn sm" value={code} disabled={!viewPerm.view}
              onChange={(e) => { setCode(e.target.value); setPre(null); setParams({}) }}>
              {OP_CATALOG.map((d) => <option key={d.code} value={d.code}>{d.code} · {d.action}</option>)}
            </select>
          </label>
          <label className="col" style={{ minWidth: 220 }}>
            <span className="tiny faint">目标对象（资源 + 版本）</span>
            <input className="btn sm" style={{ width: '100%' }} value={target} disabled={!viewPerm.view}
              placeholder={def.code === 'OC-D-03' ? '如：SK-示例业务一部-07（Service Account Key）' : '写清被操作对象与版本'}
              onChange={(e) => { setTarget(e.target.value); setPre(null) }} />
          </label>
          {def.fields.map((f) => (
            <label className="col" key={f.key} style={{ minWidth: 150 }}>
              <span className="tiny faint">{f.label}</span>
              <select className="btn sm" value={params[f.key] ?? f.options?.[0] ?? ''} disabled={!viewPerm.view}
                onChange={(e) => { setParams({ ...params, [f.key]: e.target.value }); setPre(null) }}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          ))}
          <button className="btn sm primary" disabled={!viewPerm.view || ownerOf(def) !== '本单元'} onClick={() => void runPrecheck()}>① 先做 dry-run 预检</button>
          <button className="btn primary sm" disabled={!viewPerm.view || ownerOf(def) !== '本单元' || !pre || pre.reasons.length > 0} onClick={() => void submit()}>② 看过影响面，确认提交</button>
          <Tip label="为什么必须先预检" text="没有预检记录，提交点不动：服务端要求先算影响面（会牵连哪些凭证 / 渠道 / 卡位 / 应用），dry-run 只算不发，不产生任何外部调用。" />
        </div>

        <div className="mt14">
          <span className="small faint">本条动作的门禁与依据：</span>
          <div className="row gap6 wrap" style={{ marginTop: 6 }}>
            <Badge tone="info">工单类型：{def.ticketKind}</Badge>
            <Badge tone="info">执行归属：{def.execMode}</Badge>
            {def.needsDual ? <Badge tone="purple">双人执行复核（原文 {def.sourceRef.replace(/原文 /, '')}）</Badge> : null}
            {def.selfApprove ? <Badge tone="purple">允许申请人自审（仅部署工单）</Badge> : <Badge tone="muted">申请人不得自批</Badge>}
            {def.urgentAllowed ? <Badge tone="warn">可走紧急通道（须 24h 补审）</Badge> : <Badge tone="muted">不允许紧急</Badge>}
            <Tip label="门禁链" text={OP_JUDGE} />
          </div>
        </div>

        {pre ? (
          <div className="mt14">
            <div className="small strong">预检 {pre.id} · 影响面清单（由台账推导，未产生外部调用）</div>
            <div className="row gap6 wrap" style={{ marginTop: 6 }}>
              {pre.impact.map((i) => <Badge key={i} tone="info">{i}</Badge>)}
              {pre.reasons.map((r) => <AlertBadge key={r} tone="bad" jump={qJump('', '预检不通过项：改参数重新预检，不能绕过')}>{r}</AlertBadge>)}
            </div>
            <div className="tiny faint" style={{ marginTop: 8 }}>
              变更前快照：变更前台账值已留存，回退与复核都要取它对比（原文 2.10-1 无法建立可用快照时先修复，不承诺可恢复）
            </div>
          </div>
        ) : (
          <div className="tiny faint" style={{ marginTop: 12 }}>还没做预检。预检不通过（对象不可定位、参数高于获批上限、模型未准入）都会被直接拦下。</div>
        )}
        <div className="tiny faint" style={{ marginTop: 8 }}>
          当前登录：{me ? `${me.name}（${me.role === 'admin' ? '系统管理员' : me.role === 'ops' ? '运营人员' : '普通用户'}）` : '未登录'} ·
          执行权 {execPerm.manage ? '有' : '无'} · 复核权 {usePerm('opctl_review').manage ? '有' : '无'} · 细到每条动作的权限在「操作权限（逐账号）」页开关
          <Tip label="口径" text="执行与复核是两个不同权限点，且不允许同一个账号既执行又复核（原文 2.6-3 同一人不得兼任）。" />
        </div>
      </Panel>

      <Panel focus title="操作目录（8 组 / 56 条，此处接内核 14 条代表性动作）" className="mt14" noPad
        extra="完整 56 条见 docs-src/operation-catalog.csv，字段含执行归属 / 双人复核 / 自动化 / 原文依据">
        <div style={{ padding: '10px 12px 0' }}><Tabs items={OP_GROUPS} active={group} onChange={setGroup} /></div>
        <div className={pick ? 'row-pick' : undefined}>
          <Table minWidth={1240} rowKeys={OP_CATALOG.filter((d) => d.group === group).map((d) => d.code)} pick={pick}
            head={['编号', '动作', '归属单元', '资源对象', '工单类型', '执行归属', '双人复核', '自审', '自动化', '优先级', '对接外部系统', '原文依据']}
            rows={rows} />
        </div>
        <div className="tiny faint" style={{ padding: '8px 12px 12px' }}>
          执行归属三值（原文 6-3）：<span className="mono">人工</span> / <span className="mono">平台自动</span> / <span className="mono">外部执行需回执</span>；
          「归应用中心」的动作用 g0 归属边界拦在本单元门外：本单元只接收发布后的状态交接与回执（原文 4.2 引言）；
          标「待确认」的 14 条不接自动执行，界面会明确要求人工回填回执，不允许把「已下发」显示成「已生效」。
        </div>
      </Panel>

      <Panel title="在途操作速览" className="mt14" noPad>
        <Table minWidth={860} rowKeys={pending.map((o) => o.id)} pick={pick}
          head={['操作号', '动作', '目标', '状态', '关联工单', '谁提的', '为什么停在这儿']}
          rows={pending.map((o) => {
            const why = o.status === '待审批' ? '等审批；申请人不得自批（仅部署工单可自审）'
              : o.status === '待复核' ? '等另一名运营账号复核，未复核不得标记成功'
              : o.status === '待窗口' ? '等开放变更窗口，排队位次已保留' : '等外部系统执行回执，回执到位前不改台账'
            return [<span className="mono tiny">{o.id}</span>, <span className="small">{opDef(o.code)?.action}</span>, o.target,
            STATUS_ALERT[o.status] ? <AlertBadge tone={STATUS_ALERT[o.status]!} jump={qJump(o.id, '点过去落到这一行处理')}>{STATUS_LABEL[o.status]}</AlertBadge> : <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>,
            <span className="mono tiny">{o.ticketId}</span>, <span className="tiny">{o.requestedBy}</span>, <span className="tiny faint">{why}</span>]
          })} />
      </Panel>
      <div className="tiny faint" style={{ marginTop: 10 }}>
        全量目录、门禁链、双人复核范围与灰度方案：docs-src/operation-control-unit.md · operation-catalog.csv · operation-control-decisions.md · operation-control-p0.md
      </div>
    </>
  )
}
