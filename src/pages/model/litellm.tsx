/* =====================================================================
 * LiteLLM 网关仪表（第一期：只读观测 + 用量归因）
 * 取数：采集层 gateway.json / routes.json（LiteLLM Admin API 落盘）；
 *       未接采集层时由平台凭证台账 + 渠道配置同源推导，来源标「平台推导」。
 * 处置口径：本页不写网关。限流 / 吊销一律生成平台工单，走准入校验与运营审批；
 *           网关侧真正生效需要厂商开放写接口与执行回执（待厂商开放）。
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout, Progress, fmt } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { gatewayKeys, gatewayRoutes, sourceHint, useTelemetry } from '../../engine/telemetry'
import { engine, useEngine } from '../../engine/engine'
import { monitorStore, monitorSummary } from '../../engine/exceptions'
import { usePerm } from '../../engine/auth'

/** 平台口径的凭证配额上限（与引擎准入、例外监控同一套口径） */
const CAP: Record<string, number> = { 个人密钥: 120, 平台代理: 400 }
const capOf = (kind: string) => CAP[kind] ?? 400
const STATUS_TONE: Record<string, 'good' | 'warn' | 'muted'> = { ok: 'good', warn: 'warn', off: 'muted' }
const STATUS_LABEL: Record<string, string> = { ok: '正常', warn: '异常', off: '已停用' }

type Msg = { tone: 'good' | 'bad' | 'info'; text: string }

export default function LiteLlmGateway() {
  const st = useEngine()
  const tele = useTelemetry()
  const perm = usePerm('gateway')
  const keys = gatewayKeys()
  const routes = gatewayRoutes()
  const hint = sourceHint('litellm')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const activeKeys = keys.filter((k) => k.status !== 'off')
  const offKeys = keys.filter((k) => k.status === 'off')
  const hotKeys = keys.filter((k) => k.rpmLimit > 0 && k.usedRpm / k.rpmLimit > 0.85)
  const reqToday = keys.reduce((s, k) => s + k.requests, 0)
  const errToday = keys.reduce((s, k) => s + k.errors, 0)
  const fallToday = keys.reduce((s, k) => s + k.fallbacks, 0)
  const costToday = Math.round(keys.reduce((s, k) => s + k.spendDay, 0))
  const tokensWan = Math.round(routes.reduce((s, r) => s + r.tokensWan, 0) * 10) / 10
  const errPct = reqToday ? Math.round((errToday / reqToday) * 1000) / 10 : 0
  const overQuota = keys.filter((k) => k.usedRpm > k.rpmLimit && k.rpmLimit > 0)

  /* -------- 网关 key ↔ 平台凭证台账 一致性 -------- */
  const keyIds = keys.map((k) => k.keyId)
  const credIds = st.creds.map((c) => c.id)
  const gatewayOnly = keys.filter((k) => !credIds.includes(k.keyId))
  const platformOnly = st.creds.filter((c) => !keyIds.includes(c.id))
  const matched = keys.filter((k) => credIds.includes(k.keyId))

  /* -------- 动作：一律发工单，不在网关侧直接改写 -------- */
  const doThrottle = (keyId: string) => {
    const k = keys.find((x) => x.keyId === keyId)
    const cred = st.creds.find((c) => c.id === keyId)
    if (!cred) {
      setMsg({ tone: 'bad', text: `限流工单未提交：网关侧 key ${keyId} 在平台凭证台账里没有对应记录（属「网关有 · 平台无」差异）。准入会回「未找到凭证 ${keyId}」——先在「模型中心 · 凭证与配额」补登记，或把它送例外监控做目录对齐。` })
      return
    }
    const cap = capOf(cred.kind)
    const r = engine.submit({
      type: 'quota_adjust',
      applicant: '网关观测 · 运营值守',
      dept: '运营',
      level: cred.kind === '平台代理' ? '高保' : '共享',
      reason: `【LiteLLM 网关观测】${keyId}（${cred.holder} · ${cred.kind}）当前 ${k?.usedRpm ?? 0}/${k?.rpmLimit ?? cred.rpm} RPM${k && k.rpmLimit > 0 && k.usedRpm / k.rpmLimit > 0.85 ? '，配额占用已超过 85%' : ''}：把该 key 的 RPM 配额压回平台口径上限 ${cap} RPM（个人密钥 120 / 平台代理 400）。平台只发单，审批通过后才生效，不在网关侧直接写值。`,
      spec: { credId: cred.id, rpm: cap },
    })
    if (!r.precheck.ok) { setMsg({ tone: 'bad', text: `「限流回上限」被准入拒绝（理由原样回执）：${r.precheck.reason ?? '未给出理由'}` }); return }
    setMsg({ tone: 'good', text: `限流工单 ${r.order.id} 已提交（待运营审批 · 双人复核后生效）：${r.precheck.suggest ?? ''}。本页不写 LiteLLM：网关侧改配额要厂商开放写接口并回执行结果（待厂商开放）。` })
  }

  const doRevoke = (keyId: string) => {
    const k = keys.find((x) => x.keyId === keyId)
    if (confirmId !== keyId) {
      setConfirmId(keyId)
      setMsg({ tone: 'info', text: `请再点一次「确认吊销」才会提交吊销工单：吊销 ${keyId}${k ? `（${k.holder}）` : ''} 会切断这条调用入口并清理关联授权与路由，模型与卡位不受影响，须通知持有人与归口。要取消就点别的行或刷新页面。` })
      return
    }
    setConfirmId(null)
    const cred = st.creds.find((c) => c.id === keyId)
    const r = engine.submit({
      type: 'credential_revoke',
      applicant: '网关观测 · 运营值守',
      dept: '运营',
      level: cred?.kind === '个人密钥' ? '共享' : '高保',
      reason: `【LiteLLM 网关观测】吊销 ${keyId}${k ? `（${k.holder} · ${k.app} · ${k.model}）` : ''}：网关侧观测到 ${k?.usedRpm ?? 0}/${k?.rpmLimit ?? 0} RPM${k && k.status === 'warn' ? ' · 该 key 当前处于异常状态' : ''}，切断调用入口并清理关联授权；须通知持有人，业务侧改走新凭证。`,
      spec: { credId: keyId },
    })
    if (!r.precheck.ok) { setMsg({ tone: 'bad', text: `「吊销」被准入拒绝（理由原样回执）：${r.precheck.reason ?? '未给出理由'}` }); return }
    setMsg({ tone: 'good', text: `吊销工单 ${r.order.id} 已提交（待审批）：${r.precheck.suggest ?? ''}。平台侧记为已吊销；LiteLLM 侧撤 key 需网关写接口与执行回执（待厂商开放），回执到位前页面上仍会看到该 key 在跑。` })
  }

  const doScan = () => {
    const fresh = monitorStore.scanAndRaise()
    const s = monitorSummary()
    const dir = s.byKind.find((x) => x.kind === '目录不一致')?.n ?? 0
    const quota = s.byKind.find((x) => x.kind === '配额越界')?.n ?? 0
    setMsg({
      tone: 'good',
      text: `已扫描一轮例外监控（第 ${s.round} 轮 · ${s.lastScanAt}）：本轮新增待分析 ${fresh} 条 · 台账共 ${s.total} 条（待分析 ${s.open} · 已阻断 ${s.blocked}）。本页两类差异进例外台账：目录不一致类做双侧同步摘除（不回收卡位、不下线模型），凭证超额走【配额越界】类的限流 / 吊销；接管缺口类 ${s.gap} 条只停调用入口。`,
    })
  }

  const barOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, right: 6, textStyle: { color: AXIS_COLOR, fontSize: 11 }, itemWidth: 10, itemHeight: 8 },
    grid: GRID,
    xAxis: {
      type: 'category',
      data: routes.map((r) => r.model),
      axisLabel: { color: AXIS_COLOR, fontSize: 10, interval: 0, rotate: routes.length > 4 ? 16 : 0 },
    },
    yAxis: [
      { type: 'value', name: 'Token(万)', axisLabel: { color: AXIS_COLOR }, nameTextStyle: { color: AXIS_COLOR, fontSize: 11 }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
      { type: 'value', name: 'RPM', axisLabel: { color: AXIS_COLOR }, nameTextStyle: { color: AXIS_COLOR, fontSize: 11 }, splitLine: { show: false } },
    ],
    series: [
      { name: 'Token(万)', type: 'bar', barWidth: 18, data: routes.map((r) => r.tokensWan) },
      { name: 'RPM', type: 'bar', yAxisIndex: 1, barWidth: 18, data: routes.map((r) => r.rpm) },
    ],
  }

  return (
    <div>
      <PageHead
        title="LiteLLM 网关仪表"
        desc="按 key / 模型 / 渠道看用量、成本、限流与异常回退 · 处置动作一律走平台工单"
        extra={
          <>
            <Badge tone="good">活跃 key {activeKeys.length} / {keys.length}</Badge>
            <Badge tone={hotKeys.length ? 'warn' : 'muted'}>触限 key {hotKeys.length}</Badge>
            <Badge tone="info">超额 {overQuota.length}</Badge>
            <Badge tone={tele.mode === '采集层' ? 'good' : 'muted'}>取数来源：{tele.mode}</Badge>
          </>
        }
      />

      {msg ? <div style={{ marginTop: 6 }}><Callout warn={msg.tone === 'bad'} text={msg.text} /></div> : null}

      <div className="grid g-6" style={{ marginTop: 14 }}>
        <Kpi label="key 总数" value={keys.length} unit="个" foot={`活跃 ${activeKeys.length} · 停用 ${offKeys.length} · 异常 ${keys.filter((k) => k.status === 'warn').length}`} />
        <Kpi label="今日请求合计" value={fmt(reqToday)} unit="次" foot={`错误 ${fmt(errToday)} 次 · 错误率 ${errPct}%`} />
        <Kpi label="今日 Token" value={tokensWan} unit="万" foot="与渠道路由同源 · 含外部渠道" />
        <Kpi label="今日网关侧成本" value={costToday.toLocaleString('zh-CN')} unit="元" foot="spendDay 求和 · 计费口径待厂商对账" />
        <Kpi label="错误与回退" value={`${errToday + fallToday}`} unit="次" foot={`错误 ${errToday} · 回退 ${fallToday}（异常渠道降级）`} />
        <Kpi label="触限 key" value={hotKeys.length} unit="个" foot={`配额占用 > 85% · 超额 ${overQuota.length} 个`} />
      </div>

      <Panel
        title="Key 明细（用量 / 配额 / 成本 / 处置入口）"
        extra={perm.manage ? '处置动作 = 生成工单（准入校验 + 运营审批）· 本页不写网关' : <span className="tiny faint">只读</span>}
        className="mt14"
        noPad
      >
        <div className="panel-body">
          <Table
            minWidth={1350}
            head={['Key', '持有人', '应用', '模型', '渠道', '配额 RPM', '当前 RPM', '配额占用', '日请求', '错误', '回退', '日成本', '状态', '动作']}
            rows={keys.map((k) => {
              const pct = k.rpmLimit > 0 ? Math.round((k.usedRpm / k.rpmLimit) * 100) : 0
              const cap = capOf(k.kind)
              const onPlatform = credIds.includes(k.keyId)
              return [
                <span className="mono small strong">{k.keyId}</span>,
                <span className="small">{k.holder}</span>,
                <span className="small">{k.app}</span>,
                <span className="small">{k.model}</span>,
                <span className="small">{k.channel}<div className="tiny faint">{k.kind}</div></span>,
                <span className="num">{k.rpmLimit}{k.rpmLimit > cap ? <span className="tiny" style={{ color: 'var(--bad-text)' }}> 超上限 {cap}</span> : null}</span>,
                <span className="num">{k.usedRpm}</span>,
                <div style={{ minWidth: 110 }}>
                  <Progress value={pct} tone={pct >= 100 ? 'bad' : pct > 85 ? 'warn' : ''} />
                  <span className="tiny faint">{pct}%{pct > 85 ? ' 触限' : ''}</span>
                </div>,
                <span className="num">{fmt(k.requests)}</span>,
                <span className="num" style={{ color: k.errors ? 'var(--bad-text)' : undefined }}>{k.errors}</span>,
                <span className="num" style={{ color: k.fallbacks ? 'var(--warn-text)' : undefined }}>{k.fallbacks}</span>,
                <span className="num">¥{k.spendDay.toLocaleString('zh-CN')}</span>,
                <Badge tone={STATUS_TONE[k.status] ?? 'muted'}>{STATUS_LABEL[k.status] ?? k.status}</Badge>,
                onPlatform ? (
                  <span className="row gap6">
                    <button className="btn sm" disabled={!perm.manage} onClick={() => doThrottle(k.keyId)}>限流回上限</button>
                    {confirmId === k.keyId ? (
                      <button className="btn sm danger" disabled={!perm.manage} onClick={() => doRevoke(k.keyId)}>再点一次确认吊销</button>
                    ) : (
                      <button className="btn sm danger" disabled={!perm.manage} onClick={() => doRevoke(k.keyId)}>吊销</button>
                    )}
                    {!perm.manage ? <span className="tiny faint">只读</span> : null}
                  </span>
                ) : (
                  <span className="tiny faint">平台台账无此 key：先做目录对齐再发单</span>
                ),
              ]
            })}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            口径：触限 = 当前 RPM / 配额 RPM &gt; 85%；限流回上限 = 把该 key 的 RPM 压回平台口径上限（个人密钥 {CAP['个人密钥']} / 平台代理 {CAP['平台代理']}）；吊销须二次确认。两类动作都只提交工单（{`quota_adjust`} / {`credential_revoke`}），准入不通过就把理由原样显示在页面上方。
          </div>
        </div>
      </Panel>

      <Panel title="渠道与路由分布" extra="Token 与 RPM 两组对照 · 观测与用量归因" className="mt14">
        <Chart option={barOpt} height={220} />
        <div style={{ marginTop: 6 }}>
          <Table
            minWidth={900}
            head={['渠道/模型', '类别', '权重', 'RPM', 'Token(万)', '错误率', '健康']}
            rows={routes.map((r) => [
              <span className="small strong">{r.model}</span>,
              <Badge tone={r.channel === '本地' ? 'muted' : 'info'}>{r.channel}</Badge>,
              <span className="num">{r.weight}</span>,
              <span className="num">{r.rpm.toLocaleString('zh-CN')}</span>,
              <span className="num">{r.tokensWan}</span>,
              <span className="num" style={{ color: r.errPct >= 4 ? 'var(--bad-text)' : undefined }}>{r.errPct}%</span>,
              <Badge tone={r.health === 'ok' ? 'good' : r.health === 'warn' ? 'warn' : 'bad'}>{r.health === 'ok' ? '健康' : r.health === 'warn' ? '异常' : '故障'}</Badge>,
            ])}
          />
        </div>
        <Callout text="权重调整、故障切换、副本扩缩在「模型中心 · 推理网关」做（走变更窗口与准入）；本页只做观测与用量归因 —— 谁在烧 Token、哪条渠道在回退、成本落在哪个 key 上。" />
      </Panel>

      <Panel
        title="网关侧 key ↔ 平台凭证台账一致性"
        extra={`网关侧 ${keys.length} 条 · 平台台账 ${st.creds.length} 条 · 对得上 ${matched.length} 条`}
        className="mt14"
      >
        <div className="grid g-2">
          <div className="col gap6">
            <div className="row gap6">
              <span className="small strong">① 网关有、平台无</span>
              <Badge tone={gatewayOnly.length ? 'warn' : 'good'}>{gatewayOnly.length} 条</Badge>
            </div>
            <div className="row wrap gap6">
              {gatewayOnly.length ? gatewayOnly.map((k) => <span key={k.keyId} className="tag gray">{k.keyId}（{k.holder}）</span>) : <span className="tiny faint">无差异：网关侧每条 key 都能在平台凭证台账里找到</span>}
            </div>
            <div className="tiny faint">这类 key 属「目录之外」：限流 / 吊销工单会被准入拒绝（未找到凭证），要先补登记或送例外监控。</div>
          </div>
          <div className="col gap6">
            <div className="row gap6">
              <span className="small strong">② 平台有、网关无</span>
              <Badge tone={platformOnly.length ? 'warn' : 'good'}>{platformOnly.length} 条</Badge>
            </div>
            <div className="row wrap gap6">
              {platformOnly.length ? platformOnly.map((c) => <span key={c.id} className="tag gray">{c.id}（{c.holder}）</span>) : <span className="tiny faint">无差异：平台台账每条凭证都能在网关侧看到用量</span>}
            </div>
            <div className="tiny faint">这类凭证要么未真正发放到网关、要么已被网关侧删除：须与归口核对后走凭证回收或重新发放。</div>
          </div>
        </div>
        <div className="divider" />
        <div className="row gap6 wrap">
          <button className="btn sm" disabled={!perm.manage} onClick={doScan}>扫描一轮例外监控</button>
          {!perm.manage ? <span className="tiny faint">只读</span> : null}
          <span className="tiny faint">比对按 keyId / 凭证 id 逐条做；不一致会进例外台账（【目录不一致】类双侧同步摘除、【配额越界】类限流或吊销、【接管缺口】类先停调用入口）</span>
        </div>
      </Panel>

      <Panel title="限流与配额口径" extra="演示口径写清，真实环境按接口读回对齐" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={980}
            head={['口径项', '平台演示口径（硬校验）', '真实环境怎么对齐']}
            rows={[
              [<span className="small strong">个人密钥 RPM 上限</span>, <span className="small">{CAP['个人密钥']} RPM：发放与配额调整准入都会当场拒绝超限提交</span>, <span className="small">从 LiteLLM <span className="mono">/key/info</span> 读回该 key 的 RPM / TPM 上限，与台账值比对；不一致标出并生成例外</span>],
              [<span className="small strong">平台代理 RPM 上限</span>, <span className="small">{CAP['平台代理']} RPM：同上；渠道总容量在推理网关侧另有配额校验</span>, <span className="small">同上；渠道容量、权重与副本在推理网关核对</span>],
              [<span className="small strong">超限提交会怎样</span>, <span className="small">准入直接返回不通过 + 理由（本页把理由原样显示），工单进「已驳回」留痕</span>, <span className="small">同口径：理由要能直接给业务方，便于解释「为什么不给提额」</span>],
              [<span className="small strong">渠道配额占用</span>, <span className="small">按渠道已分配 RPM / 容量 RPM 计算，提额后超 100% 直接拒绝</span>, <span className="small">网关侧按 key 汇总回算；渠道容量与并发上限待厂商书面确认（待厂商开放）</span>],
              [<span className="small strong">Token 与成本</span>, <span className="small">日成本 = 各 key spendDay 求和；外部渠道按配置的 Token 单价折算</span>, <span className="small">从 <span className="mono">/spend/logs</span> 逐条回算并与厂商账单对账；计费口径待厂商确认（待厂商开放）</span>],
              [<span className="small strong">下发限流</span>, <span className="small">平台只发配额调整工单，审批通过只改平台台账值</span>, <span className="small">网关侧真正改 key 配额需厂商开放写接口 + 执行回执（待厂商开放，已挂在外部接入配置中心）</span>],
            ]}
          />
        </div>
      </Panel>

      <Panel title="数据来源与接口清单（LiteLLM）" extra={`${hint.name} · 落盘文件 ${hint.file}`} className="mt14">
        <div className="grid g-21">
          <div className="col gap6">
            <div className="small"><b>取数方式 via：</b><span className="mono">{hint.via}</span></div>
            <div className="small"><b>鉴权 auth：</b>{hint.auth}（只读作用域，不给平台写权限）</div>
            <div className="small"><b>频率 every：</b>{hint.every} · <b>落盘：</b><span className="mono">{hint.file}</span>（路由分布在 <span className="mono">routes.json</span>，清单在 <span className="mono">manifest.json</span>）</div>
            <div className="tiny faint">字段 fields（采集层按这些名字落盘，平台内部做一层映射）</div>
            <div className="row wrap gap6">
              {hint.fields.map((f) => <span key={f} className="tag gray mono">{f}</span>)}
            </div>
            <div className="row gap6">
              <Badge tone={hint.status.ok ? 'good' : 'bad'}>{hint.status.ok ? '本轮可取数' : '本轮取数失败'}</Badge>
              <span className="tiny faint">{hint.status.at} · {hint.status.items} 条 · 当前模式 {tele.mode}（{tele.generatedAt}）</span>
            </div>
            <div className="tiny faint">{hint.status.note}</div>
          </div>
          <div className="col gap6">
            <div className="small">{hint.note}</div>
            <div className="tiny faint">
              取不到的字段照实写「不可采集 / 待厂商开放」：网关侧 key 的创建人、预算周期、轮换记录、写操作回执，本演示环境均无来源，页面上不做承诺。
            </div>
            <Callout
              warn
              text={
                <>
                  <b>采集层只读，平台不写网关。</b>本平台对 LiteLLM 只做三件事：读 key 与配额、读用量与成本、读渠道健康。
                  要真正把限流值下发到网关、把吊销动作落到 key 上，需要厂商开放<b>写接口</b>并给出<b>执行回执</b>（改前值 / 改后值 / 生效时间 / 失败原因），
                  这条待开放项已挂在「运营分析 · 外部对接清单」的接入配置里跟催；回执到位前，页面上的处置动作一律显示为「已提交工单 · 待执行」。
                </>
              }
            />
          </div>
        </div>
      </Panel>
    </div>
  )
}
