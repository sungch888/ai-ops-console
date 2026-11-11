/* =====================================================================
 * 模型安全检测流程（前端接口已留位，能完整显示这条流程）
 * 演示：本地按契约跑通每一步；真实环境把 endpoint 填上就接检测引擎
 * ===================================================================== */
import { useState } from 'react'
import { Badge, AlertBadge, Callout, Kpi, PageHead, Panel, Table } from '../../components/ui'
import { Link } from 'react-router-dom'
import { guardStore, useGuardConfig, useGuardRuns, GUARD_CONTRACT, type GuardRun, type GuardScenario, type GuardStep } from '../../engine/guard'
import { usePerm } from '../../engine/auth'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

const SCENARIOS: GuardScenario[] = ['正常问答', '含敏感词', '越权查询', '输出异常']
const VERDICT_TONE: Record<string, 'good' | 'warn' | 'bad'> = { 放行: 'good', '放行并告警': 'warn', 拦截: 'bad', 通过: 'good', 降级: 'warn' }

type Msg = { tone: 'good' | 'bad'; text: string; jump?: AlertJump }

export default function ModelSafetyFlow() {
  const perm = usePerm('security')
  const cfg = useGuardConfig()
  const runs = useGuardRuns()
  const [text, setText] = useState('示例：请调取 2201 号业务事件的原始记录原文与当事人住址')
  const [scenario, setScenario] = useState<GuardScenario>('含敏感词')
  const [run, setRun] = useState<GuardRun | null>(null)
  const [step, setStep] = useState<GuardStep | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)

  /* 告警直达口径（本页主键：流程记录 id / 阶段名 / 契约接口名）
     判定为「拦截 / 降级」→ 落这次流程「判定与动作」那一行（切的是哪条调用、通知谁都在这一行）
     某一步拦截 / 降级 → 落那一步那一行（点「看请求 / 响应」就是取证的地方）
     引擎口径未定 / 未接 → 落「外部对接清单」对应那条接入（内容鉴定系统 / 大模型安全网关一体机） */
  const pick = useAlertPick()
  usePickFlash(pick)
  const stepKey = (runId: string, stage: string) => `${runId}|${stage}`
  const runJump = (runId: string, label: string): AlertJump => ({ page: '/model/safety-flow', pick: runId, label })
  const stepJump = (runId: string, stage: string, label: string): AlertJump => ({ page: '/model/safety-flow', pick: stepKey(runId, stage), label })
  const guardConnJump = (api: string): AlertJump => (api === '/api/v1/policy/list'
    ? Jump.connector('d-llmsec', '去外部对接清单看「大模型安全网关（一体机）」这条接入：策略统一下发接口与执行主体都还没定')
    : Jump.connector('d-content', '去外部对接清单看「内容鉴定系统」这条接入：检测引擎的超时口径与回写字段就在这条接入上定'))

  const doRun = () => {
    const r = guardStore.run(text, scenario)
    setRun(r)
    setStep(r.steps[0])
    setMsg(r.verdict === '放行'
      ? { tone: 'good', text: `流程跑完：判定「${r.verdict}」· 5 个阶段 · 合计 ${r.total} ms · 流程记录 ${r.id}` }
      : { tone: 'bad', text: `流程跑完：判定「${r.verdict}」· 5 个阶段 · 合计 ${r.total} ms · 流程记录 ${r.id}：点过去落到「判定与动作」那一行，看切的是哪条调用、通知了谁`, jump: stepJump(r.id, '判定与动作', '到这次流程「判定与动作」那一行：处置引擎写进去的 target / 通知对象就在这一行的响应里') })
  }

  const blockedRuns = runs.filter((r) => r.verdict !== '放行')

  return (
    <div>
      <PageHead
        title="模型安全检测流程（接口已留位）"
        desc="输入 → 前置检测 → 路由与推理 → 后置检测 → 判定与动作 → 审计留痕：整条流程在页面上跑通并逐步显示请求与响应"
        extra={<><AlertBadge tone="warn" jump={guardConnJump('/api/v1/check/pre')}>{cfg.mode === '平台内模拟' ? '平台内模拟 · 判定不是检测引擎给的' : cfg.mode}</AlertBadge><Badge tone="muted">超时上限 {cfg.timeoutMs} ms</Badge><Badge tone="purple">已跑 {runs.length} 条流程</Badge></>}
      />

      <Callout warn jump={guardConnJump('/api/v1/check/pre')} text="这一页的作用是把「模型安全」这件事说清：平台负责把流程编排起来、把每步的请求 / 响应 / 判定 / 留痕显示出来，并生成处置工单；检测判定本身由检测引擎给出。演示版按契约在平台内出判定结果，真实环境把检测引擎地址填进下面的配置就切过去，页面与流程不变。—— 点过去落到「外部对接清单」里检测引擎那条接入（内容鉴定系统）：地址、鉴权、超时与回写字段都在那一行跟催。" />

      {msg ? <div style={{ marginTop: 14 }}><Callout warn={msg.tone === 'bad'} text={msg.text} jump={msg.jump} /></div> : null}

      <Panel title="跑一次检测流程（选场景看每步的输入输出）" className="mt14" noPad>
        <div className="panel-body">
          <div className="col gap6">
            <textarea className="btn sm" style={{ width: '100%', minHeight: 62 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴一条用户输入或模型输出" />
            <div className="row gap6 wrap">
              <div>
                <div className="tiny faint">场景</div>
                <select className="btn sm" style={{ marginTop: 4 }} value={scenario} onChange={(e) => setScenario(e.target.value as GuardScenario)}>
                  {SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button className="btn sm" onClick={doRun}>跑一次检测流程</button>
              <span className="tiny faint" style={{ flex: 1 }}>换场景是为了让客户方看到：同样一条输入，在哪一步被切、切的是调用还是资源、留了什么痕。</span>
            </div>
          </div>
        </div>
      </Panel>

      {run ? (
        <>
          <div className="grid g-6" style={{ marginTop: 14 }}>
            <Kpi label="流程记录" value={run.id} foot={`场景 ${run.scenario} · ${run.at}`} />
            <Kpi label="最终判定" value={run.verdict} foot={run.verdict === '拦截'
              ? <span className="down">● 输入或输出被切，点过去看切的是哪条调用、通知了谁</span>
              : run.verdict === '放行并告警'
                ? <span className="down">● 已通知归口：限流保护中，点过去看动作落在哪个对象</span>
                : <span className="up">✔ 放行</span>}
              jump={run.verdict === '放行' ? undefined : stepJump(run.id, '判定与动作', `到这次流程「判定与动作」那一行：处置引擎写入的 target 与通知对象就在这一行的响应里`)} />
            <Kpi label="阶段数" value={run.steps.length} unit="步" foot="前置 / 推理 / 后置 / 处置 / 审计" />
            <Kpi label="合计耗时" value={run.total} unit="ms" foot={`检测侧 ${run.steps[0].ms + run.steps[2].ms} ms · 推理 ${run.steps[1].ms} ms`} />
            <Kpi label="命中策略" value={Number(run.steps[0].response.matched ? (run.steps[0].response.matched as string[]).length : 0)} unit="条" foot={run.steps[0].response.policy_ids ? (run.steps[0].response.policy_ids as string[]).join(' / ') : 'P-NORMAL'}
              jump={run.steps[0].verdict === '拦截' ? stepJump(run.id, '前置检测', '到「前置检测」这一行：看命中了哪几条策略、命中的原文片段是什么') : undefined} />
            <Kpi label="审计写入" value={run.steps[4].response.written ? '已写入' : <span className="down">未写入</span>} foot={`trace ${run.steps[4].request.trace_id} · 只存摘要与判定`}
              jump={run.steps[4].response.written ? undefined : stepJump(run.id, '审计与留痕', '审计没落盘：到「审计与留痕」这一行看请求与返回，这条流程等于没留痕')} />
          </div>

          <Panel title={`流程步骤与接口（${run.id}）`} extra="点任一步看请求 / 响应原文" className="mt14" noPad>
            <div className="panel-body">
              <Table
                minWidth={1100}
                rowKeys={run.steps.map((s) => stepKey(run.id, s.stage))} pick={pick}
                head={['阶段', '接口 / 动作', '方法', '耗时', '判定', '这一步在做什么']}
                rows={run.steps.map((s) => [
                  <span className="small strong">{s.stage}</span>,
                  <span className="tiny mono">{s.api}</span>,
                  <span className="tag gray">{s.method}</span>,
                  <span className="num small">{s.ms} ms</span>,
                  VERDICT_TONE[s.verdict] === 'bad' ? <AlertBadge tone="bad" jump={stepJump(run.id, s.stage, `这一步（${s.stage}）把内容切了：点过去落到这一行，「看请求 / 响应」就是取证的地方`)}>{s.verdict}</AlertBadge> : VERDICT_TONE[s.verdict] === 'warn' ? <AlertBadge tone="warn" jump={stepJump(run.id, s.stage, `这一步（${s.stage}）降级了：点过去落到这一行，看它降成了什么、下游收到的是什么`)}>{s.verdict}</AlertBadge> : <Badge tone="good">{s.verdict}</Badge>,
                  <div className="tiny" style={{ maxWidth: 420 }}>{s.note}<button className="btn sm ghost" style={{ marginTop: 4 }} onClick={() => setStep(s)}>看请求 / 响应</button></div>,
                ])}
              />
              {step ? (
                <div style={{ marginTop: 10 }}>
                  <div className="small strong">{step.stage} · {step.api}</div>
                  <div className="grid g-2" style={{ marginTop: 6 }}>
                    <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap', background: 'rgba(12,26,44,.75)', padding: 10, borderRadius: 6, margin: 0 }}>请求：{'\n'}{JSON.stringify(step.request, null, 2)}</pre>
                    <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap', background: 'rgba(12,26,44,.75)', padding: 10, borderRadius: 6, margin: 0 }}>响应：{'\n'}{JSON.stringify(step.response, null, 2)}</pre>
                  </div>
                  <div className="tiny faint" style={{ marginTop: 6 }}>{step.note}</div>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="这一条判定接下来去哪" className="mt14" noPad>
            <div className="panel-body">
              <div className="col gap6">
                <div className="tiny">判定 <span className="strong">{run.verdict}</span> → 处置引擎写入：{JSON.stringify(run.steps[3].response)}</div>
                <div className="row gap6 wrap">
                  <Link to="/model/security" className="btn sm ghost">去策略库看命中规则（可改可回滚）</Link>
                  <Link to="/compute/exceptions" className="btn sm ghost">去例外监控看调用侧处置</Link>
                  <Link to="/model/credentials" className="btn sm ghost">去凭证台账看这条调用的配额</Link>
                </div>
                <div className="tiny faint">口径：安全检测的处置切的是这条调用（会话 / 凭证 / 应用入口），不回收卡位、不停模型。</div>
              </div>
            </div>
          </Panel>
        </>
      ) : null}

      <Panel title="检测引擎接入配置（改这里就切换真实接口）" className="mt14" noPad>
        <div className="panel-body">
          <div className="row gap6 wrap">
            <div>
              <div className="tiny faint">判定来源</div>
              <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={cfg.mode} onChange={(e) => {
                guardStore.set({ mode: e.target.value as '平台内模拟' | '真实检测引擎' })
                setMsg({ tone: e.target.value === '平台内模拟' ? 'good' : 'bad', text: e.target.value === '平台内模拟' ? '已切回平台内模拟：按契约本地出判定' : '已切到「真实检测引擎」口径：页面照契约发请求，但在连通性验证通过前仍显示本地判定结果——不会假装已接通。点过去落到外部对接清单那条接入：先做连通性探测、把前置条件一条条勾掉', jump: e.target.value === '平台内模拟' ? undefined : guardConnJump('/api/v1/check/pre') })
              }}>
                <option value="平台内模拟">平台内模拟（演示用）</option>
                <option value="真实检测引擎">真实检测引擎（按契约调用）</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div className="tiny faint">检测接口地址</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={cfg.endpoint} onChange={(e) => guardStore.set({ endpoint: e.target.value })} />
            </div>
            <div style={{ minWidth: 150 }}>
              <div className="tiny faint">超时（ms）</div>
              <input className="btn sm" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} type="number" value={cfg.timeoutMs} onChange={(e) => guardStore.set({ timeoutMs: Number(e.target.value) || 600 })} />
            </div>
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>鉴权方式 <span className="strong">{cfg.auth}</span> · 必传字段 <span className="mono strong">{cfg.everyField}</span> · 配置写入本地并留版本记录，与外部接入配置中心的口径一致。</div>
          <div className="row gap6" style={{ marginTop: 8 }}>
            <Link to="/ops/integrations" className="btn sm ghost">去外部接入配置中心登记这条接口</Link>
          </div>
        </div>
      </Panel>

      <Panel title="接口契约与要客户方定的口径（检测引擎按这个交）" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1100}
            rowKeys={GUARD_CONTRACT.map((c) => c.api)} pick={pick}
            head={['接口', '方法', '平台会传什么', '引擎要回什么', '必须先定的口径']}
            rows={GUARD_CONTRACT.map((c) => [
              <span className="tiny mono">{c.api}</span>,
              <span className="tag gray">{c.method}</span>,
              <span className="tiny">{c.req}</span>,
              <span className="tiny">{c.resp}</span>,
              <span className="tiny" style={{ maxWidth: 300, color: 'var(--bad-text)' }}>{c.must}<div style={{ marginTop: 4 }}><AlertBadge tone="warn" jump={guardConnJump(c.api)}>这条口径未定 · 去接入配置那一行定</AlertBadge></div></span>,
            ])}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>三件事最容易在选型时漏掉：① 检测超时到底放行还是拦截（口径要在选型纪要里定）；② 输出侧检测要能指出原文位置，否则复核做不了；③ 策略清单只能有一份权威来源，否则平台与检测引擎各判各的。</div>
        </div>
      </Panel>

      <Panel title="最近流程记录" className="mt14" noPad>
        <div className="panel-body">
          {runs.length === 0 ? <div className="tiny faint">还没有流程记录：跑一次检测流程就会出现。</div> : (
            <Table minWidth={900} head={['流程记录', '输入摘要', '场景', '时间', '判定', '合计耗时']} rowKeys={runs.map((r) => r.id)} pick={pick} rows={runs.map((r) => [
              <span className="small mono">{r.id}</span>,
              <span className="tiny" style={{ maxWidth: 320 }}>{r.input.slice(0, 42)}</span>,
              <span className="tag gray">{r.scenario}</span>,
              <span className="tiny faint mono">{r.at}</span>,
              VERDICT_TONE[r.verdict] === 'bad' ? <AlertBadge tone="bad" jump={runJump(r.id, `这次流程判定「${r.verdict}」：点回来落到这条记录这一行，下面的「看请求 / 响应」与判定去向就是动手的地方`)}>{r.verdict}</AlertBadge> : VERDICT_TONE[r.verdict] === 'warn' ? <AlertBadge tone="warn" jump={runJump(r.id, `这次流程判定「${r.verdict}」：点回来落到这条记录这一行，看限流落在哪个对象`)}>{r.verdict}</AlertBadge> : <Badge tone="good">{r.verdict}</Badge>,
              <span className="num small">{r.total} ms</span>,
            ])} />
          )}
          {blockedRuns.length ? (
            <Callout warn jump={runJump(blockedRuns[0].id, `到最近这条被「${blockedRuns[0].verdict}」的流程记录（${blockedRuns[0].id}）这一行：它的判定与去向就在这一屏`)} text={`最近流程记录里有 ${blockedRuns.length} 条判定不是「放行」：拦截 / 放行并告警都产生了处置动作，点过去落到那条记录这一行。`} />
          ) : null}
        </div>
      </Panel>
    </div>
  )
}
