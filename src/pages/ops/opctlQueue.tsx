/* =====================================================================
 * 操作控制 · 执行队列与变更窗口
 *   口径：审批通过不等于生效。落窗口才执行、串行执行（同一时刻只跑一项）、外部动作等回执、
 *         回执后走分段成功判定，全段通过才算生效；任一段失败即「部分成功」，不得显示整体成功（原文 2.5-2）。
 *   双人复核：凭证 / 额度 / 权限项 / 下线类动作，执行与复核必须是两个不同账号（原文 2.6-3）。
 *         本页只有一个「复核放行」按钮——用执行人自己的账号点会被服务端 g5 拒；
 *         要走通请换复核岗账号（ops2 / ops123）登录后再点。
 *   自动执行三态：获批策略范围内 → 先建变更工单再执行；超范围 / 未获批 / 建单失败 → 一律不执行（1.1-9、2.8-4）。
 *   判定全部在服务端（server/opctl.py），本页只发请求、展示结果与原因。
 * ===================================================================== */
import { useEffect, useState, type ReactNode } from 'react'
import { AlertBadge, Badge, Callout, Kpi, PageHead, Panel, Table, Tip } from '../../components/ui'
import { STATUS_ALERT, STATUS_LABEL, STATUS_TONE, opDef, opctlStore, useOpctl, type OpRun } from '../../engine/opctl'
import { usePerm } from '../../engine/auth'
import { useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

const aJump = (id: string, label: string): AlertJump => ({ page: '/ops/opctl-audit', pick: id, label })
const OK_NOTE = '已核对审批范围、授权值与依赖，同意执行（审批意见留痕）'
const FAIL_REASON = '网关侧返回渠道名冲突，未生效'

type Res = { ok: boolean; reason?: string }

export default function OpctlQueue() {
  const st = useOpctl()
  const pick = useAlertPick()
  usePickFlash(pick)
  const perm = usePerm('opctl')
  const execPerm = usePerm('opctl_exec')
  const reviewPerm = usePerm('opctl_review')
  const [msg, setMsg] = useState<{ ok: boolean; text: string; opId?: string } | null>(null)
  const [policy, setPolicy] = useState('')
  const say = (ok: boolean, text: string, opId?: string) => setMsg({ ok, text, opId })

  useEffect(() => { if (!st.fromServer && !st.loading) void opctlStore.refresh() }, [st.fromServer, st.loading])
  useEffect(() => { if (!policy && st.policies.length) setPolicy(st.policies[0].id) }, [policy, st.policies])

  /** 统一动作包装：把服务端返回的 ok / reason 铺成一条提示（判定不在前端） */
  const act = (p: Promise<Res>, okText: (r: Res) => string, opId?: string) => {
    void p.then((r) => say(r.ok, r.ok ? okText(r) : (r.reason ?? '被服务端拦下'), opId))
  }

  const inFlight = st.ops.filter((o) => !['已闭环', '已驳回', '已回滚'].includes(o.status))
  const queued = st.ops.filter((o) => o.status === '待窗口')
  const waitingReceipt = st.ops.filter((o) => o.status === '待回执')
  const fb = st.fallbacks.filter((f) => f.status !== '已关闭')
  const winOpen = st.windows.some((w) => w.status === '使用中')
  const p = st.policies.find((x) => x.id === policy)

  const buttons = (o: OpRun) => {
    const dis = !execPerm.manage
    const b: ReactNode[] = []
    if (o.status === '待审批') {
      b.push(<button key="ap" className="btn sm primary" disabled={!perm.manage}
        onClick={() => act(opctlStore.approve(o.id, OK_NOTE), () => `${o.id} 审批通过，进入排队待窗口`, o.id)}>审批通过</button>)
      b.push(<button key="rj" className="btn sm ghost" disabled={!perm.manage}
        onClick={() => act(opctlStore.reject(o.id, '范围与授权值不一致，退回补充依据'), () => `${o.id} 已驳回，不启动执行，原单保留依据`, o.id)}>驳回</button>)
    }
    if (o.status === '待复核') {
      b.push(<button key="rv" className="btn sm primary" disabled={!reviewPerm.manage}
        onClick={() => act(opctlStore.review(o.id), () => `${o.id} 复核放行（与执行人非同一账号），进入执行推进`, o.id)}>复核放行</button>)
      b.push(<Tip key="tip" label="同人会怎样" text="用执行人自己的账号点会被服务端 g5 拒：执行与复核必须是两个不同账号。演示通过请用复核岗 ops2 / ops123 登录。" />)
    }
    if (o.status === '待窗口') {
      b.push(<button key="ex" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.execute(o.id), () => `${o.id} 已下发执行${opDef(o.code)!.execMode === '外部执行需回执' ? '：等外部回执，回执前台账不动' : opDef(o.code)!.needsDual ? '：等另一账号复核' : '：开始分段判定'}`, o.id)}>执行下发</button>)
      if (opDef(o.code)!.urgentAllowed) {
        b.push(<button key="em" className="btn sm danger" disabled={dis}
          onClick={() => act(opctlStore.emergency(o.id), () => `${o.id} 已标为紧急：自动建关联变更单，须 24h 内补审`, o.id)}>标紧急（免窗口）</button>)
      }
    }
    if (o.status === '执行中') {
      b.push(<button key="st" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.stage(o.id, true), () => `${o.id} 当前分段通过，推进下一段`, o.id)}>推进当前分段</button>)
      b.push(<button key="sf" className="btn sm danger" disabled={dis}
        onClick={() => act(opctlStore.stage(o.id, false, FAIL_REASON), () => `${o.id} 该段失败，已标「部分成功」，界面不会显示整体上线成功`, o.id)}>该段失败</button>)
    }
    if (o.status === '待回执') {
      b.push(<button key="rc" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.receipt(o.id, true, '外部系统回执：配置已落地并自检通过'), () => `${o.id} 回执成功，进入分段判定`, o.id)}>回执成功</button>)
      b.push(<button key="rf" className="btn sm danger" disabled={dis}
        onClick={() => act(opctlStore.receipt(o.id, false, '外部系统回执：目标节点资源不足，执行失败'), () => `${o.id} 回执失败，台账不动，已生成人工兜底工单`, o.id)}>回执失败</button>)
    }
    if (o.status === '部分成功') {
      b.push(<button key="rt" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.stage(o.id, true), () => `${o.id} 失败段重试通过，继续推进`, o.id)}>重试失败段</button>)
      b.push(<button key="rb" className="btn sm ghost" disabled={dis}
        onClick={() => act(opctlStore.rollback(o.id), () => '已生成反向操作并按变更前快照复验', o.id)}>回退</button>)
    }
    if (o.status === '已生效') {
      b.push(<button key="vf" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.verify(o.id, 'P99 1.62s（前 2.31s）· 失败率 0.2%（前 1.1%）· 用量 +18%'), () => `${o.id} 效果验证通过，可闭环`, o.id)}>效果验证</button>)
      b.push(<button key="rb2" className="btn sm ghost" disabled={dis}
        onClick={() => act(opctlStore.rollback(o.id), () => '已生成反向操作并按变更前快照复验', o.id)}>回退</button>)
    }
    if (o.status === '已验证') {
      b.push(<button key="cl" className="btn sm primary" disabled={dis}
        onClick={() => act(opctlStore.close(o.id), () => `${o.id} 已闭环：台账与实际一致，通知已送达`, o.id)}>闭环并释放窗口</button>)
    }
    if (o.status === '待人工兜底') {
      b.push(<button key="tk" className="btn sm primary" disabled={!perm.manage}
        onClick={() => act(opctlStore.takeover(o.id), () => `${o.id} 兜底工单已被接管，责任转当前账号`, o.id)}>人工接管</button>)
    }
    if (o.status === '失败') {
      b.push(<button key="rb3" className="btn sm ghost" disabled={dis}
        onClick={() => act(opctlStore.rollback(o.id), () => '已生成反向操作', o.id)}>回退</button>)
    }
    if (o.emergency?.state === '待补审' && o.status !== '已闭环') {
      b.push(<button key="cp" className="btn sm ghost" disabled={!perm.manage}
        onClick={() => act(opctlStore.complement(o.id), () => `${o.id} 紧急处置已补审并归档`, o.id)}>补审</button>)
    }
    if (!b.length) b.push(<span key="n" className="tiny faint">终态 · 看审计</span>)
    return b
  }

  const row = (o: OpRun) => {
    const def = opDef(o.code)!
    const stageCell = <span className="tiny">{o.stages.map((s) => (
      <Badge key={s.name} tone={s.state === '通过' ? 'good' : s.state === '失败' ? 'bad' : s.state === '执行中' ? 'info' : 'muted'}>{s.name}</Badge>
    ))}</span>
    return [
      <span className="mono tiny" key="id">{o.id}{o.rollbackOf ? <span className="faint tiny"> ← {o.rollbackOf}</span> : null}</span>,
      <span className="small" key="ac">{def.action}<span className="tiny faint"> · {def.resource}</span></span>,
      <span className="tiny" key="tg">{o.target}{o.urgent ? <Badge tone="bad">紧急</Badge> : null}{o.emergency?.state === '待补审' ? <AlertBadge tone="warn" jump={aJump(o.id, '这条紧急处置还没补审：点过去看补审与关联变更单')}>待补审</AlertBadge> : null}</span>,
      STATUS_ALERT[o.status]
        ? <AlertBadge key="st" tone={STATUS_ALERT[o.status]!} jump={aJump(o.id, `这条停在「${STATUS_LABEL[o.status]}」：点过去看它被哪条门禁拦下、依据哪条原文`)}>{STATUS_LABEL[o.status]}</AlertBadge>
        : <Badge key="st" tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>,
      <span className="mono tiny" key="tk">{o.ticketId}<span className="faint tiny"> {def.ticketKind}</span></span>,
      <span className="tiny" key="sg">{stageCell}</span>,
      <span className="tiny" key="rv">{def.needsDual
        ? (o.reviewedBy ? <Badge tone="good">已复核 {o.reviewedBy.split('（')[0]}</Badge>
          : <AlertBadge tone="warn" jump={aJump(o.id, '复核还没做：执行与复核必须是两个不同账号')}>待复核</AlertBadge>)
        : <Badge tone="muted">不需要</Badge>}</span>,
      <span className="tiny" key="ex">{o.executedBy ?? '—'}{o.externalRef ? <span className="faint tiny mono"> {o.externalRef}</span> : null}</span>,
      <span className="row gap6 wrap" key="bt">{buttons(o)}</span>,
    ]
  }

  return (
    <>
      <PageHead title="操作控制 · 执行队列与变更窗口"
        desc="审批通过不等于生效：落窗口才执行、同一时刻只跑一项、外部动作等回执、回执后按分段判定，全段通过才算生效" />

      {st.error ? (
        <div className="mt14"><Callout warn text={`操作数据读不到：${st.error}（判定在服务端，本地不会假装成功；请确认数据服务已启动并已登录）`} /></div>
      ) : null}

      <div className="grid g-4" style={{ marginTop: 14 }}>
        <Kpi label="在途操作" value={String(inFlight.length)} unit="项" foot="含执行中与待回执" />
        <Kpi label="排队待窗口" value={String(queued.length)} unit="项" foot={winOpen ? '当前有使用中窗口，按提交顺序接续' : '无开放窗口：已保留位次'} />
        <Kpi label="等外部回执" value={String(waitingReceipt.length)} unit="项" foot="回执到位前不改台账占用"
          jump={waitingReceipt[0] ? { page: '/ops/opctl-queue', pick: waitingReceipt[0].id, label: '点过去落到这条：回执成功 / 失败都在那一行' } : undefined} />
        <Kpi label="兜底在途" value={String(fb.length)} unit="项" foot={fb.length ? '执行失败或超时未回执自动生成' : '当前没有兜底工单'} />
      </div>

      {msg ? <div className="mt14"><Callout warn={!msg.ok} text={msg.text} jump={msg.opId ? { page: '/ops/opctl-audit', pick: msg.opId, label: '点过去看这条操作的完整轨迹与拦截依据' } : undefined} /></div> : null}

      <Panel focus title="变更窗口（预约 → 开启 → 结束；非紧急动作无窗口只排队）" className="mt14" noPad>
        <Table minWidth={900} rowKeys={st.windows.map((w) => w.id)} pick={pick}
          head={['窗口号', '范围', '时间', '事由', '状态', '预约人', '操作']}
          rows={st.windows.map((w) => [
            <span className="mono tiny" key="id">{w.id}</span>, <span className="small" key="sc">{w.scope}</span>,
            `${w.from}–${w.to}`, w.reason,
            <Badge key="st" tone={w.status === '使用中' ? 'good' : w.status === '已预约' ? 'warn' : 'muted'}>{w.status}</Badge>,
            <span className="tiny" key="by">{w.by}</span>,
            <span className="row gap6 wrap" key="op">
              {w.status === '已预约' && perm.manage
                ? <button className="btn sm primary" onClick={() => act(opctlStore.openWindow(w.id), () => `窗口 ${w.id} 已开启，排队操作按序开始执行`)}>开启窗口</button> : null}
              {w.status === '使用中' && perm.manage
                ? <button className="btn sm" onClick={() => act(opctlStore.closeWindow(w.id), () => `窗口 ${w.id} 已结束，剩余排队操作顺延至下一预约`)}>结束窗口</button> : null}
              {w.status === '使用中' ? <Tip label="串行执行" text="同一时刻只允许一项变更实际执行；后审批通过的操作进入队列，窗口释放后按提交顺序自动开始，无需再次审批。" /> : null}
            </span>,
          ])} />
        <div className="tiny faint" style={{ padding: '8px 12px 12px' }}>
          {winOpen ? '当前有开放窗口：排队中的操作可执行下发。' : '当前无开放窗口：执行下发会被服务端 g6 拦下并保留排队位次（紧急通道需单独权限，且放宽类动作紧急也禁止）。'}
        </div>
      </Panel>

      <Panel focus title="执行队列与操作台账（审批 / 复核 / 执行 / 回执 / 分段判定 / 回退都在这一张表）" className="mt14" noPad>
        <Table minWidth={1420} rowKeys={st.ops.map((o) => o.id)} pick={pick}
          head={['操作号', '动作', '目标', '状态', '关联工单', '分段成功判定', '双人复核', '执行人 / 外部单号', '可做的动作']}
          rows={st.ops.map(row)} />
        <div className="tiny faint" style={{ padding: '10px 12px 12px' }}>
          状态机：待审批 → 待窗口 → 执行中（凭证类执行后转「待复核」，另一账号复核放行才继续）→（外部动作）待回执 →
          分段判定 → 已生效 → 已验证 → 已闭环；任一分段失败即「部分成功」，可重试该段 / 回退 / 转人工兜底（原文 2.5-2/3、SP-08）。
        </div>
      </Panel>

      <Panel focus title="自动执行三态判定（范围内自动 / 超范围转人工 / 未获批或建单失败即阻断）" className="mt14">
        <div className="row gap6 wrap" style={{ alignItems: 'flex-end' }}>
          <label className="col" style={{ minWidth: 260 }}>
            <span className="tiny faint">策略</span>
            <select className="btn sm" value={policy} onChange={(e) => setPolicy(e.target.value)}>
              {st.policies.map((x) => <option key={x.id} value={x.id}>{x.name}（{x.ver} · {x.approved ? '已获批' : '未获批'}）</option>)}
            </select>
          </label>
          <button className="btn sm primary" disabled={!perm.manage || !p}
            onClick={() => act(opctlStore.autoscale(policy, false), () => '已按获批策略先建变更工单并自动执行')}>按策略评估并执行</button>
          <button className="btn sm danger" disabled={!perm.manage || !p}
            onClick={() => act(opctlStore.autoscale(policy, true), () => '已执行')}>模拟「执行前建单失败」</button>
          <Tip label="策略怎么改" text="策略的指标、阈值、最小/最大规模、冷却期与获批状态属于管理配置，改动须走变更工单并版本化（原文 1.1-9）。本页只做三态判定演示，不改策略。" />
        </div>
        {p ? (
          <div className="row gap6 wrap" style={{ marginTop: 10 }}>
            <Badge tone="info">指标口径：{p.metric}</Badge>
            <Badge tone="info">触发：{p.threshold} · {p.sustain}</Badge>
            <Badge tone="info">规模边界：副本 {p.min}–{p.max}</Badge>
            <Badge tone="info">冷却期：{p.cooldown}</Badge>
            <Badge tone={p.approved ? 'good' : 'bad'}>策略 {p.ver} · {p.approved ? '已获批' : '未获批：不执行，转人工审批'}</Badge>
          </div>
        ) : null}
        <div className="tiny faint" style={{ marginTop: 10 }}>
          本期不接真实调度器：范围内动作只走到「执行中 + 已建工单」，用于演示授权边界与留痕，不代表已真实扩容。
        </div>
      </Panel>

      <Panel title="人工兜底待办（执行失败 / 超时未回执 / 建单失败自动生成）" className="mt14" noPad>
        {fb.length === 0 ? <div className="tiny faint" style={{ padding: 12 }}>当前没有兜底工单：一次外部执行失败、一次超时未回执、一次自动建单失败就会自动生成。</div> : (
          <Table minWidth={900} rowKeys={fb.map((f) => f.id)} pick={pick}
            head={['待办号', '来源操作', '标题', '详情', '责任', '状态', '操作']}
            rows={fb.map((f) => [
              <span className="mono tiny" key="id">{f.id}</span>,
              <span className="mono tiny" key="op">{f.opId}</span>,
              <span className="small" key="ti">{f.title}</span>, <span className="tiny" key="de">{f.detail}</span>,
              <span className="tiny" key="ow">{f.owner}</span>,
              <Badge key="st" tone={f.status === '在途' ? 'bad' : 'info'}>{f.status}</Badge>,
              f.status === '在途'
                ? <button key="bt" className="btn sm" disabled={!perm.manage}
                  onClick={() => act(opctlStore.takeover(f.opId), () => `${f.id} 已转由当前账号接管`)}>接管</button>
                : <span key="bt" className="tiny faint">已接管</span>,
            ])} />
        )}
        <div className="tiny faint" style={{ padding: '8px 12px 12px' }}>
          超时未回写的操作可用上面的「回执失败」演示；兜底口径沿用处置指令台既有实现（超时自动转人工兜底并生成工单）。
        </div>
      </Panel>
    </>
  )
}
