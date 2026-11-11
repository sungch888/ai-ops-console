/* =====================================================================
 * 模型中心 · MindIE 推理服务监控
 * 服务级指标：副本健康 / 首包时延 TTFT / 吞吐 tok·s / 队列深度 / KV 缓存命中
 * 取数：MindIE /metrics（未接采集层时由平台推理引擎与资源账本同源推导）
 * 本页只读监控 + 提交副本扩容工单；灰度放量与版本回退不在本页做（走部署工单 / 模型资产页）
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {AlertBadge, Badge, Callout, Kpi, PageHead, Panel, Progress, State, Table, Tip} from '../../components/ui'
import { AXIS_COLOR, CHART_COLORS, Chart, GRID, SPLIT_COLOR, TOOLTIP_STYLE } from '../../components/Chart'
import { inferenceServices, sourceHint, telemetryStatus, telemetryStore, type InferenceService } from '../../engine/telemetry'
import { engine, useEngine } from '../../engine/engine'
import { metricNum, monitorStore, sampleClock, sampleTime, useMonitor, type MetricSample } from '../../engine/monitor'
import { usePerm } from '../../engine/auth'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

/* 需要动作的判定口径（与例外监控「资源异常」规则同源） */
const ERR_MAX = 2.4
const QUEUE_MAX = 40
const TTFT_MAX = 900

const BUCKET_CHOICES = [10, 15, 30, 60]

/** 分段宽度按采样时间跨度自动挑：图上最多 48 段，太少就换成更粗的段 */
function pickBucketMinutes(samples: MetricSample[]): number {
  if (samples.length < 2) return BUCKET_CHOICES[0]
  const ts = samples.map((x) => new Date(x.at).getTime()).filter((t) => !Number.isNaN(t))
  const span = (Math.max(...ts) - Math.min(...ts)) / 60000
  for (const c of BUCKET_CHOICES) if (span / c <= 48) return c
  return 120
}
const TEMP_MAX = 85
const HBM_MAX = 95

/** 采样按 N 分钟聚合成一段：平均画面积、最差值画虚线。原始点全画就是几百条乱线。 */
function bucketize(samples: MetricSample[], minutes: number) {
  const step = minutes * 60 * 1000
  const groups = new Map<number, MetricSample[]>()
  for (const x of samples) {
    const slot = Math.floor(new Date(x.at).getTime() / step)
    const arr = groups.get(slot)
    if (arr) arr.push(x); else groups.set(slot, [x])
  }
  const stat = (vals: (number | null)[], worst: boolean): number | null => {
    const got = vals.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
    if (!got.length) return null
    return worst ? Math.max(...got) : Math.round(got.reduce((a, b) => a + b, 0) / got.length)
  }
  const out: {
    t: string; avgTtft: number | null; maxTtft: number | null; avgP99: number | null; maxP99: number | null;
    avgHbm: number | null; maxHbm: number | null; avgTemp: number | null; maxTemp: number | null;
    avgUtil: number | null; maxUtil: number | null;
  }[] = []
  for (const slot of Array.from(groups.keys()).sort((a, b) => a - b)) {
    const g = groups.get(slot) || []
    const d = new Date(slot * step)
    out.push({
      t: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      avgTtft: stat(g.map((x) => x.ttft_ms), false), maxTtft: stat(g.map((x) => x.ttft_ms), true),
      avgP99: stat(g.map((x) => x.p99_ms), false), maxP99: stat(g.map((x) => x.p99_ms), true),
      avgHbm: stat(g.map((x) => x.hbm_pct), false), maxHbm: stat(g.map((x) => x.hbm_pct), true),
      avgTemp: stat(g.map((x) => x.gpu_temp_c), false), maxTemp: stat(g.map((x) => x.gpu_temp_c), true),
      avgUtil: stat(g.map((x) => x.gpu_util), false), maxUtil: stat(g.map((x) => x.gpu_util), true),
    })
  }
  return out
}

const SIDE: Record<'util' | 'hbm' | 'temp', { label: string; short: string; unit: string; warn: number | null; max: number | null }> = {
  util: { label: '卡利用率', short: '利用率 %', unit: '%', warn: null, max: 100 },
  hbm: { label: '显存 / KV 占用', short: '显存 %', unit: '%', warn: HBM_MAX, max: 100 },
  temp: { label: '卡温', short: '卡温 ℃', unit: '℃', warn: TEMP_MAX, max: null },
}

const SVC_TONE: Record<InferenceService['health'], 'good' | 'warn' | 'bad'> = { ok: 'good', warn: 'warn', bad: 'bad' }
const SVC_TEXT: Record<InferenceService['health'], string> = { ok: '正常', warn: '阈值附近', bad: '异常' }

export default function ModelMonitor() {
  const st = useEngine()
  /* 权限点：auth.ts 的 PermKey 没有 'model'，模型中心各页统一挂 'gateway'（与 App.tsx 路由权限映射一致） */
  const perm = usePerm('gateway')
  const [nonce, setNonce] = useState(0)
  const mon = useMonitor()
  /* 告警直达：本页红 / 黄提示全部可点，pick 口径写死在一处
     服务级告警 → pick = 服务名（服务清单那一行 + 「需要动作的服务」那张卡）
     探针目标级告警 → pick = 监控目标 id（Jump.monitorTarget 同一口径）
     断连兜底工单 → pick = 兜底工单 id（本页「我接管 / 关闭」就在那一行） */
  const pick = useAlertPick()
  usePickFlash(pick)
  const [sideMetric, setSideMetric] = useState<'util' | 'hbm' | 'temp'>('util')
  const bucketMin = pickBucketMinutes(mon.samples)
  const buckets = bucketize(mon.samples, bucketMin)
  const canProbe = usePerm('compute').manage
  const [tgt, setTgt] = useState({ name: '', base: '', api_key_env: '', interval_seconds: 30, window_seconds: 300, metric_format: 'openai', active_probe: 1 })
  const [monMsg, setMonMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string; jump?: AlertJump } | null>(null)
  const [fbMsg, setFbMsg] = useState<{ ok: boolean; text: string } | null>(null)

  /* 采集层落 services.json 后自动切「采集层」：订阅刷新，不改采集层代码 */
  useEffect(() => telemetryStore.subscribe(() => setNonce((n) => n + 1)), [])
  useEffect(() => { void monitorStore.refresh() }, [])

  const tel = telemetryStatus()
  const hint = sourceHint('mindie')
  const svcs = inferenceServices()

  const avg = (pick: (s: InferenceService) => number, fix = 0) => {
    if (!svcs.length) return 0
    const v = svcs.reduce((sum, s) => sum + pick(s), 0) / svcs.length
    return fix ? Number(v.toFixed(fix)) : Math.round(v)
  }
  const instances = svcs.reduce((s, x) => s + x.instances, 0)
  const cardsUsed = svcs.reduce((s, x) => s + x.cards, 0)
  const queueTotal = svcs.reduce((s, x) => s + x.queueDepth, 0)

  const needAction = svcs.map((s) => {
    const reasons: string[] = []
    if (s.ready < s.instances) reasons.push(`副本就绪 ${s.ready}/${s.instances}（有副本未起或正在重启）`)
    if (s.errPct >= ERR_MAX) reasons.push(`错误率 ${s.errPct}% ≥ ${ERR_MAX}%`)
    if (s.queueDepth >= QUEUE_MAX) reasons.push(`队列深度 ${s.queueDepth} ≥ ${QUEUE_MAX}`)
    if (s.ttftMs >= TTFT_MAX) reasons.push(`首包 TTFT ${s.ttftMs}ms ≥ ${TTFT_MAX}ms`)
    if (s.restarts > 0) reasons.push(`容器重启 ${s.restarts} 次`)
    return { s, reasons }
  }).filter((x) => x.reasons.length > 0)

  /* 本页各条红 / 黄告警的落点（口径统一，同一个告警不会跳到两个地方） */
  const svcJump = (s: InferenceService, label: string): AlertJump => ({ page: '/model/monitor', pick: s.service, label })
  const worstSvc = (list: InferenceService[], score: (x: InferenceService) => number, label: string): AlertJump | undefined => {
    const hit = [...list].sort((a, b) => score(b) - score(a))[0]
    return hit ? svcJump(hit, label) : undefined
  }
  const fbJump = (id: string): AlertJump => ({ page: '/model/monitor', pick: id, label: '去这张兜底工单认领或关闭' })
  const alertTone = (h: InferenceService['health']): 'warn' | 'bad' => (h === 'bad' ? 'bad' : 'warn')
  const srcJump = Jump.connector('m-mindie', '去外部对接清单看 MindIE 指标源这条接入')
  const errBadSvcs = svcs.filter((s) => s.errPct >= ERR_MAX)
  const queueBadSvcs = svcs.filter((s) => s.queueDepth >= QUEUE_MAX)
  const ttftBadSvcs = svcs.filter((s) => s.ttftMs >= TTFT_MAX)
  const readyBadSvcs = svcs.filter((s) => s.ready < s.instances)
  const alertedTargets = mon.targets.filter((t) => t.alert_state === '已告警')
  const brokenTarget = alertedTargets[0]
    ?? mon.targets.find((t) => t.last_status && t.last_status !== '已采集')
    ?? mon.targets[0]

  const names = svcs.map((s) => s.service)
  const ttftOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['首包 TTFT', 'P99 时延'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 10.5, interval: 0, rotate: names.length > 4 ? 22 : 0 } },
    yAxis: { type: 'value', name: 'ms', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '首包 TTFT', type: 'bar', barWidth: 12, itemStyle: { borderRadius: 4, color: CHART_COLORS[0] }, data: svcs.map((s) => s.ttftMs) },
      { name: 'P99 时延', type: 'bar', barWidth: 12, itemStyle: { borderRadius: 4, color: CHART_COLORS[3] }, data: svcs.map((s) => s.p99Ms) },
    ],
  }
  const queueOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['队列深度', '错误率'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 10.5, interval: 0, rotate: names.length > 4 ? 22 : 0 } },
    yAxis: [
      { type: 'value', name: '队列', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
      { type: 'value', name: '错误率 %', max: 10, axisLabel: { color: AXIS_COLOR }, splitLine: { show: false } },
    ],
    series: [
      { name: '队列深度', type: 'bar', barWidth: 16, itemStyle: { borderRadius: 4, color: CHART_COLORS[2] }, data: svcs.map((s) => s.queueDepth) },
      { name: '错误率', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 6, lineStyle: { width: 2, color: CHART_COLORS[5] }, itemStyle: { color: CHART_COLORS[5] }, data: svcs.map((s) => s.errPct) },
    ],
  }

  return (
    <div>
      <PageHead
        title="MindIE 推理服务监控"
        desc="服务级指标：副本健康、首包时延 TTFT、吞吐 tok/s、队列深度与 KV 缓存命中 · 指标口径按 MindIE 原字段名对齐"
        extra={
          <>
            <Badge tone="info">服务 {svcs.length} 个</Badge>
            <Badge tone="good">实例 {instances} 个</Badge>
            <Badge tone={tel.mode === '采集层' ? 'purple' : 'muted'}>取数来源：{tel.mode}</Badge>
            <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>按当前负载重算一次</button>
          </>
        }
      />

      <div className="grid g-6 mt14">
        <Kpi label="推理服务" value={svcs.length} unit="个" foot={readyBadSvcs.length
          ? <span className="down">{`● 就绪不足：${readyBadSvcs.length} 个服务有副本未起 · 占用 ${cardsUsed} 卡位`}</span>
          : `占用 ${cardsUsed} 卡位 · 就绪 ${svcs.reduce((s, x) => s + x.ready, 0)}/${instances} 实例`}
          jump={worstSvc(readyBadSvcs, (x) => x.instances - x.ready, '去这个副本没起齐的服务提交扩容')} />
        <Kpi label="实例总数" value={instances} unit="个" foot="副本数按平台模型台账计" />
        <Kpi label="占用卡位合计" value={cardsUsed} unit="卡" foot="副本 × 每副本卡位 · 与池对照同源" />
        <Kpi label="平均首包时延" value={avg((s) => s.ttftMs)} unit="ms" foot={ttftBadSvcs.length
          ? <span className="down">{`● ${ttftBadSvcs.length} 个服务 TTFT 超 ${TTFT_MAX}ms`}</span>
          : `阈值 ${TTFT_MAX}ms · P99 平均 ${avg((s) => s.p99Ms)}ms`}
          jump={worstSvc(ttftBadSvcs, (x) => x.ttftMs, '去这个 TTFT 超动作线的服务做处置')} />
        <Kpi label="平均错误率" value={avg((s) => s.errPct, 1)} unit="%" foot={errBadSvcs.length
          ? <span className="down">{`● ${errBadSvcs.length} 个服务错误率超 ${ERR_MAX}%`}</span>
          : `动作线 ${ERR_MAX}% · 重启合计 ${svcs.reduce((s, x) => s + x.restarts, 0)} 次`}
          jump={worstSvc(errBadSvcs, (x) => x.errPct, '去这个错误率超动作线的服务做处置')} />
        <Kpi label="队列深度合计" value={queueTotal} unit="请求" foot={queueBadSvcs.length
          ? <span className="down">{`● ${queueBadSvcs.length} 个服务队列超 ${QUEUE_MAX}`}</span>
          : `动作线 ${QUEUE_MAX} · 超线的服务见下方「需要动作的服务」`}
          jump={worstSvc(queueBadSvcs, (x) => x.queueDepth, '去这个队列超动作线的服务补承载')} />
      </div>

      <Panel className="mt14" title="服务清单（服务级台账）" extra={`${svcs.length} 个服务 · 来源：${tel.mode}`} noPad>
        <div className="panel-body">
          <Table
            minWidth={1350}
            head={['服务名', '模型', '版本', '资源池', '副本(就绪)', '卡位', 'QPS', '吞吐 tok/s', '首包 TTFT', 'P99 时延', '队列深度', 'KV 命中', 'HBM 占用', '错误率', '重启次数', '健康']}
            rows={svcs.map((s) => [
              <span className="mono small strong">{s.service}</span>,
              <span className="small">{s.model}</span>,
              <span className="tag gray">{s.version}</span>,
              <span className="small">{s.poolName}</span>,
              <span className={`num ${s.ready < s.instances ? 'strong' : ''}`}>{s.instances}({s.ready})</span>,
              <span className="num">{s.cards}</span>,
              <span className="num">{s.qps}</span>,
              <span className="num">{s.tokensPerSec}</span>,
              <span className={`num ${s.ttftMs >= TTFT_MAX ? 'strong' : ''}`}>{s.ttftMs}ms</span>,
              <span className="num">{s.p99Ms}ms</span>,
              <span className={`num ${s.queueDepth >= QUEUE_MAX ? 'strong' : ''}`}>{s.queueDepth}</span>,
              <span className="num">{s.kvHit}%</span>,
              <div style={{ minWidth: 110 }}>
                <Progress value={s.hbmPct} tone={s.hbmPct > 95 ? 'bad' : s.hbmPct > 85 ? 'warn' : ''}
                  jump={s.hbmPct > 85 ? svcJump(s, '去这个显存超阈的服务看原因并补承载') : undefined} />
                <span className="tiny faint num">{s.hbmPct}%</span>
              </div>,
              <span className={`num ${s.errPct >= ERR_MAX ? 'strong' : ''}`}>{s.errPct}%</span>,
              <span className={`num ${s.restarts > 0 ? 'strong' : 'faint'}`}>{s.restarts}</span>,
              SVC_TONE[s.health] === 'good'
                ? <Badge tone="good">{SVC_TEXT[s.health]}</Badge>
                : <AlertBadge tone={alertTone(s.health)} jump={svcJump(s, '去下方「需要动作的服务」这一条：看原因 / 提交副本扩容')}>{SVC_TEXT[s.health]}</AlertBadge>,
            ])}
            rowKeys={svcs.map((s) => s.service)} pick={pick}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            KV 命中率按 MindIE 原字段 kv_hit_pct 对齐；该指标厂商未开放时在卡位显示 0 并在来源清单标「厂商未开放」，不按经验值猜测。首包时延与队列深度是选型验收要写清的指标。
          </div>
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="首包 TTFT 与 P99 时延（按服务）" extra="选型验收口径 · 未接采集层时为推导值">
          <Chart option={ttftOpt} height={220} />
        </Panel>
        <Panel title="队列深度与错误率（按服务）" extra="超动作线的服务进入下方处置清单">
          <Chart option={queueOpt} height={220} />
        </Panel>
      </div>

      <Panel
        className="mt14"
        title="需要动作的服务"
        extra={
          <>
            <span className="tiny faint">判定：错误率 ≥{ERR_MAX}% 或 队列 ≥{QUEUE_MAX} 或 TTFT ≥{TTFT_MAX}ms 或 就绪副本 &lt; 副本数</span>
            {perm.manage ? null : <span className="tiny faint">只读</span>}
          </>
        }
      >
        {needAction.length === 0 ? (
          <div className="small">当前没有需要动作的服务：各服务副本就绪、错误率与队列深度都在动作线内。</div>
        ) : (
          <div className="col gap6">
            {needAction.map(({ s, reasons }) => {
              const hit = pick === s.service
              return (
              <div key={s.service} className={hit ? 'row-pick' : undefined}
                style={{ border: hit ? '1px solid var(--line-strong)' : '1px solid rgba(var(--line-rgb), .16)', boxShadow: hit ? '0 0 0 2px rgba(245,184,61,.35)' : undefined, borderRadius: 10, padding: '9px 11px' }}>
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  <span className="mono small strong">{s.service}</span>
                  <span className="tag gray">{s.model}</span>
                  <span className="tag gray">{s.version}</span>
                  <span className="small">{s.poolName}</span>
                  <AlertBadge tone={alertTone(s.health)} jump={svcJump(s, '落在这条处置卡：提交副本扩容 / 看服务清单那一行')}>{SVC_TEXT[s.health]}</AlertBadge>
                  <span className="tiny faint">{s.instances} 副本 / {s.cards} 卡位</span>
                </div>
                <div className="small" style={{ marginTop: 5, color: 'var(--table-text)' }}>原因：{reasons.join(' · ')}</div>
                <div className="row gap6" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn sm"
                    disabled={!perm.manage}
                    onClick={() => {
                      const r = engine.submit({
                        type: 'replica_scale',
                        applicant: '推理服务监控',
                        dept: '信息化管理部',
                        level: '高保',
                        reason: `服务 ${s.service}（${s.model} ${s.version} · ${s.poolName}）：${reasons.join('；')}；首包 ${s.ttftMs}ms / 队列 ${s.queueDepth} / 错误率 ${s.errPct}%，申请 +1 副本补承载`,
                        spec: { model: s.model, delta: 1 },
                      })
                      setMsg(
                        r.precheck.ok
                          ? { tone: 'good', text: `${r.order.id} 已提交，准入预检通过：${r.precheck.suggest ?? ''}（工单进变更窗口队列，执行后回到本页验收 TTFT 与队列）`, jump: Jump.order(r.order.id, '去看这张扩容工单') }
                          : { tone: 'bad', text: `${r.order.id} 被准入校验驳回：${r.precheck.reason ?? '未给出理由'}${r.precheck.suggest ? ` · 建议：${r.precheck.suggest}` : ''}`, jump: Jump.order(r.order.id, '去看这张被驳回的扩容工单，按理由调整后重提') },
                      )
                    }}
                  >
                    提交副本扩容
                  </button>
                  <Link className="btn sm ghost" to="/compute/exceptions">去例外监控看来源归因</Link>
                  <span className="tiny faint">扩容工单只加副本；限流来源与回收空闲卡位在例外监控页做</span>
                </div>
              </div>
              )
            })}
          </div>
        )}
        {msg ? <div style={{ marginTop: 10 }}><Callout text={msg.text} warn={msg.tone === 'bad'} jump={msg.jump} /></div> : null}
      </Panel>

      <Panel className="mt14" title="版本与灰度" extra="当前生效版本与版本清单（灰度放量走部署工单）" noPad>
        <div className="panel-body">
          <Table
            minWidth={980}
            head={['模型简称', '当前版本', '版本清单', '副本', '每副本卡位', '资源池', '状态']}
            rows={st.models.map((m) => [
              <span className="strong small">{m.short}</span>,
              <span className="tag gray">{m.ver}</span>,
              <span className="mono small">{m.versions.join(' / ')}</span>,
              <span className="num">{m.replicas}</span>,
              <span className="num">{m.perReplica}</span>,
              <span className="small">{st.pools.find((p) => p.id === m.pool)?.name ?? m.pool}</span>,
              <State s={m.state} />,
            ])}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            版本回退在「模型资产管理」页做（回退要注明依据并通知受影响应用）；灰度放量在这里的部署工单做（<span className="mono">model_deploy</span> 工单写清副本数、每副本卡位、目标节点、镜像与灰度比例，容器平台回执到位才算生效）。
          </div>
        </div>
      </Panel>

      <Panel className="mt14" title="数据来源与接口清单（MindIE）" extra={`当前模式：${tel.mode} · ${tel.generatedAt} · 本页渲染轮次 ${nonce + 1}`} noPad>
        <div className="panel-body">
          <Table
            minWidth={900}
            head={['取数点', '接口 / 取数方式', '认证方式', '频率', '落盘文件', '本轮条目数', '状态']}
            rows={[[
              <span className="strong small">{hint.name}</span>,
              <span className="small">{hint.via}</span>,
              <span className="small">{hint.auth}</span>,
              <span className="num">{hint.every}</span>,
              <span className="mono small">{hint.file}</span>,
              <span className="num">{tel.sources.find((x) => x.id === 'mindie')?.items ?? hint.status.items}</span>,
              hint.status.ok ? <Badge tone="good">可用</Badge> : <AlertBadge tone="bad" jump={srcJump}>取数失败</AlertBadge>,
            ]]}
          />
          <div className="row gap6" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <span className="small faint">采集字段：</span>
            {hint.fields.map((f) => <span key={f} className={`tag ${f === 'kv_hit_pct' ? '' : 'gray'} mono`}>{f}</span>)}
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>字段说明：{hint.note}</div>
          <div className="row gap6" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <Badge tone="warn">kv_hit_pct：厂商未开放时留空并标「厂商未开放」</Badge>
            <span className="small">来源状态：{tel.sources.map((x) => `${x.name} ${x.items} 条（${x.at}）`).join(' · ')}</span>
          </div>
          <div className="divider" />
          <div style={{ marginTop: 10 }}>
            <Callout
              text={
                <>
                  真实环境接入方式：采集侧按 15 秒周期读 MindIE <span className="mono">/metrics</span>（或 vLLM <span className="mono">/metrics</span>），落到 <span className="mono">dist/data/services.json</span> 并刷新 <span className="mono">manifest.json</span>，本页自动切到「采集层」，不改平台代码、不改本页指标口径。
                  MindIE 侧不开放的指标（例如 KV 命中率在某些版本不暴露）在页面标「厂商未开放」并留空，不用平台推导值冒充采集值；本页给出的动作建议只生成工单，服务侧的实际变更由容器平台执行并回执。
                </>
              }
            />
          </div>

        </div>
      </Panel>
      <Panel title="平台内置监控探针（采样入库 · 只读拉取外部服务）" className="mt14" noPad
        extra={<span className="tiny faint">探针 {mon.state?.thread ? '在跑' : '未起'} · {mon.tick} 秒一轮 · 成功 {mon.state?.probes ?? 0} / 失败 {mon.state?.failures ?? 0}
          <Tip label="采样口径" text={'库里 ' + mon.total + ' 条采样，保留 ' + mon.retention + ' 小时；探针只读 GET /metrics 与 /health，不会改对方服务'} />
        </span>}>
        <div className="panel-body">
          {mon.error ? <Callout warn text={'监控读不到：' + mon.error}
            jump={brokenTarget ? Jump.monitorTarget(brokenTarget.id, '去这个采不到的监控目标立即采一轮') : srcJump} /> : null}
          {alertedTargets.length ? (
            <Callout warn text={
              <>
                已经告出来的断连（点目标名就落到那一行，那里有「立即采一轮」与启停）：
                {alertedTargets.map((x) => (
                  <AlertBadge key={x.id} tone="bad" jump={Jump.monitorTarget(x.id, '去这个采不到的监控目标：立即采一轮 / 看最近错误')}>
                    {x.name} · 连续 {x.fail_streak} 轮采不到
                  </AlertBadge>
                ))}
                <span className="tiny faint">通知已发 · 兜底工单派给 {alertedTargets.map((x) => ((mon.state?.alerts || {})[x.id]?.owner || '值班岗位')).join(' / ')}</span>
              </>
            } />
          ) : null}
                    {mon.fallback.length ? (
            <>
              <div className="divider" />
              <div className="tiny strong" style={{ marginTop: 10 }}>断连兜底工单（谁在处理、有没有闭环）</div>
              <Table minWidth={1000} head={['工单 / 来源', '状态', '现在归谁', '开单时间', '闭环操作']} rows={mon.fallback.map((f) => [
                <span className="tiny strong">{f.title.slice(0, 46)}<div className="tiny mono faint">{f.id} · {f.ref}</div></span>,
                <span>{f.status === '待接管' ? <AlertBadge tone="warn" jump={fbJump(f.id)}>待接管</AlertBadge>
                  : f.status === '已升级' ? <AlertBadge tone="bad" jump={fbJump(f.id)}>已升级（没人接管）</AlertBadge>
                  : f.status === '已接管' ? <Badge tone="info">已接管</Badge> : <Badge tone="good">已关闭</Badge>}</span>,
                <span className="tiny">{f.owner}</span>,
                <span className="tiny faint">{(f.created_at || '').replace('T', ' ').replace('Z', '')}</span>,
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  {(f.status === '待接管' || f.status === '已升级') ? (
                    <button className="btn sm ghost" disabled={!canProbe}
                      onClick={() => void monitorStore.decideFallback(f.id, 'take').then((r) => setFbMsg({
                        ok: !!r.ok, text: r.ok ? f.id + ' 已认领：' + (r.owner || '') : '被拒：' + (r.error || '') }))}>我接管</button>
                  ) : null}
                  {f.status !== '已关闭' ? (
                    <button className="btn sm ghost" disabled={!canProbe}
                      onClick={() => {
                        const note = window.prompt('关闭原因（必填）：已联系对方重启 / 已切流量 / 换成备用地址 / 误报')
                        if (!note) { setFbMsg({ ok: false, text: '没写原因，工单不关闭' }); return }
                        void monitorStore.decideFallback(f.id, 'close', note).then((r) => setFbMsg({
                          ok: !!r.ok, text: r.ok ? f.id + ' 已关闭：' + (r.note || '') : '被拒：' + (r.error || '') }))
                      }}>处置完毕 · 关闭</button>
                  ) : null}
                </div>,
              ])} rowKeys={mon.fallback.map((f) => f.id)} pick={pick} />
              {fbMsg ? <div className="tiny" style={{ marginTop: 6, color: fbMsg.ok ? 'var(--ok-text)' : 'var(--bad-text)' }}>{fbMsg.text}</div> : null}
              <div className="tiny faint" style={{ marginTop: 6 }}>
                「我接管」把这张工单认领到人头上（记录谁、几点）；「处置完毕 · 关闭」必须写原因，而且当目标仍然采不到时会提醒你
                「关闭只是处置登记，不代表它已经通」。目标重新采到时工单会自动关闭，不需要人管。
              </div>
            </>
          ) : null}
          <Table minWidth={1080} head={['监控目标', '地址', '取数口径 / 密钥', '间隔 / 窗口', '最近一轮', '操作']} rows={mon.targets.map((t) => [
            <span className="small strong">{t.name}<div className="tiny mono faint">{t.id} · {t.enabled ? '启用' : '已停用'}</div></span>,
            <span className="tiny mono">{t.base}</span>,
            <span className="tiny mono">{t.metric_format === 'openai' ? 'OpenAI 兼容' : t.metric_format === 'prometheus' ? 'Prometheus 文本' : 'JSON 指标'}{t.active_probe ? ' · 主动探测开' : ''}
              <div className="tiny faint">{t.api_key_env || '不需要密钥'}{mon.keyEnvPresent[t.id] === false && t.api_key_env ? <AlertBadge tone="warn" jump={Jump.monitorTarget(t.id, '去这一行：补密钥环境变量 / 立即采一轮')}>环境变量没给</AlertBadge> : null}</div>
            </span>,
            <span className="tiny">{t.interval_seconds} 秒 / 窗口 {t.window_seconds} 秒</span>,
            <span className="tiny">{t.last_status === '已采集' ? <Badge tone="good">已采集</Badge> : t.last_status ? <AlertBadge tone="bad" jump={Jump.monitorTarget(t.id, '去这一行：立即采一轮 / 看最近错误')}>{t.last_status}</AlertBadge> : <Badge tone="muted">还没采过</Badge>}{t.alert_state === '已告警' ? <AlertBadge tone="bad" jump={Jump.monitorTarget(t.id, '去这一行：立即采一轮 / 看最近错误')}>已告警 · 连续 {t.fail_streak} 轮采不到</AlertBadge> : null}{t.last_error ? <div className="tiny" style={{ color: 'var(--bad-text)', maxWidth: 260 }}>{t.last_error}</div> : null}</span>,
            <div className="row gap6" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" disabled={!canProbe} onClick={() => void monitorStore.probe(t.id).then((r) => setMonMsg({ ok: !!r.ok, text: r.ok ? t.name + ' 已采一轮（样本写进 metric_samples）' : '采集被拒：' + (r.error || '') }))}>立即采一轮</button>
              <button className="btn sm ghost" disabled={!canProbe} onClick={() => void monitorStore.saveTarget({ ...t, enabled: t.enabled ? 0 : 1 }).then((r) => setMonMsg({ ok: !!r.ok, text: r.ok ? (t.enabled ? t.name + ' 已停用' : t.name + ' 已启用') : '被拒：' + (r.error || '') }))}>{t.enabled ? '停用' : '启用'}</button>
            </div>,
          ])} rowKeys={mon.targets.map((t) => t.id)} pick={pick} />
          {mon.targets.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>还没有监控目标：在下面填一台推理服务。
            <Tip label="怎么填" text="它暴露 /metrics（JSON 或 Prometheus 文本）就选对应口径；只有 OpenAI 兼容接口（/v1/models）就选「只有 OpenAI 兼容接口」，卡指标会标「对方未开放」。填完不用重启，下一轮探针就采。" /></div> : null}

          <div className="row gap6 wrap" style={{ marginTop: 12 }}>
            <input className="btn sm" style={{ width: 210 }} value={tgt.name} placeholder="目标显示名" onChange={(e) => setTgt({ ...tgt, name: e.target.value })} />
            <input className="btn sm" style={{ width: 280 }} value={tgt.base} placeholder="http://内网地址:8081" onChange={(e) => setTgt({ ...tgt, base: e.target.value })} />
            <input className="btn sm" style={{ width: 220 }} value={tgt.api_key_env} placeholder="取密钥的环境变量名（可空）" onChange={(e) => setTgt({ ...tgt, api_key_env: e.target.value })} />
            <input className="btn sm" style={{ width: 110 }} value={tgt.interval_seconds} placeholder="间隔秒" onChange={(e) => setTgt({ ...tgt, interval_seconds: Number(e.target.value) || 30 })} />
            <select className="btn sm" style={{ width: 150 }} value={tgt.metric_format} onChange={(e) => setTgt({ ...tgt, metric_format: e.target.value })}>
              <option value="json">JSON 指标（自带 /metrics）</option>
              <option value="prometheus">Prometheus 文本 /metrics</option>
              <option value="openai">只有 OpenAI 兼容接口</option>
            </select>
            <label className="row gap6 tiny" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={tgt.active_probe === 1} onChange={(e) => setTgt({ ...tgt, active_probe: e.target.checked ? 1 : 0 })} />
              主动探测（每轮发一个 16 词元的小请求）
            </label>
            <button className="btn sm primary" disabled={!canProbe || !tgt.name || !tgt.base}
              onClick={() => void monitorStore.saveTarget({ ...tgt, probe: true }).then((r) => setMonMsg({ ok: !!r.ok, text: r.ok ? ((r.probe && r.probe.ok) ? tgt.name + ' 已挂上并采到第一轮' : tgt.name + ' 已挂上，但第一轮：' + ((r.probe && r.probe.error) || '未采')) : '被拒：' + (r.error || '') }))}>挂上目标并采一轮</button>
            {!canProbe ? <span className="tiny faint">要「算力中心」操作权才能加目标或手动采</span> : null}
          </div>
          {monMsg ? <div className="tiny" style={{ marginTop: 8, color: monMsg.ok ? 'var(--ok-text)' : 'var(--bad-text)' }}>{monMsg.text}</div> : null}

          {buckets.length > 1 ? (
            <div className="grid g-21" style={{ marginTop: 12 }}>
              <Panel title={'时延趋势（' + bucketMin + ' 分钟平均 · 阈值 ' + TTFT_MAX + ' 毫秒）'} bodyClass="tight"
                extra={<Tip label="图上为什么不是每一个点" text={'原始采样 ' + mon.tick + ' 秒一轮，库里最多留 ' + mon.retention + ' 小时，共 ' + mon.total + ' 条。全画在一张图上就是几百条乱线，这里按 ' + bucketMin + ' 分钟聚合成一段：实心面积是平均，虚线是该段最差值。P99 默认不画，点图例可以打开。'} />}>
                <Chart height={196} option={{
                  color: CHART_COLORS, tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' }, grid: { ...GRID, top: 34 },
                  legend: { data: ['首包 TTFT（平均）', 'TTFT 最差值', 'P99 时延'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 12 }, selected: { 'P99 时延': false } },
                  xAxis: { type: 'category', boundaryGap: false, data: buckets.map((b) => b.t), axisLine: { lineStyle: { color: SPLIT_COLOR } }, axisLabel: { color: AXIS_COLOR, fontSize: 10.5, interval: 'auto', hideOverlap: true } },
                  yAxis: { type: 'value', name: '毫秒', nameTextStyle: { color: AXIS_COLOR }, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } }, splitNumber: 3 },
                  series: [
                    { name: '首包 TTFT（平均）', type: 'line', smooth: false, symbol: 'none', connectNulls: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.16 }, data: buckets.map((b) => b.avgTtft),
                      markLine: { silent: true, symbol: 'none', data: [{ yAxis: TTFT_MAX }], lineStyle: { type: 'dashed', color: '#ff6b6b', width: 1.4 }, label: { formatter: '阈值 ' + TTFT_MAX + ' 毫秒', position: 'insideEndTop', fontSize: 11 } } },
                    { name: 'TTFT 最差值', type: 'line', smooth: false, symbol: 'none', connectNulls: false, lineStyle: { width: 1.2, type: 'dashed' }, data: buckets.map((b) => b.maxTtft) },
                    { name: 'P99 时延', type: 'line', smooth: false, symbol: 'none', connectNulls: false, lineStyle: { width: 1.4 }, data: buckets.map((b) => b.avgP99) },
                  ],
                }} />
              </Panel>
              <Panel title={'算力侧趋势（' + SIDE[sideMetric].label + ' · ' + bucketMin + ' 分钟平均）'} bodyClass="tight"
                extra={<div className="row gap6"><div className="tabs">{(['util', 'hbm', 'temp'] as const).map((k) => (
                  <span key={k} className={'tab' + (sideMetric === k ? ' active' : '')} onClick={() => setSideMetric(k)}>{SIDE[k].short}</span>
                ))}</div><Tip label="三个指标为什么分开画" text="显存 % 与卡温 ℃ 不是一个量纲，挤在同一个纵轴上必然互相压成乱线；这里一次只画一个指标：面积是平均，虚线是该段最差值，虚线红标是告警阈值。要看另一个指标点上面的切换。" /></div>}>
                <Chart height={196} option={{
                  color: CHART_COLORS, tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' }, grid: { ...GRID, top: 30 },
                  legend: { data: [SIDE[sideMetric].label + '（平均）', SIDE[sideMetric].label + ' 最差值'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 12 } },
                  xAxis: { type: 'category', boundaryGap: false, data: buckets.map((b) => b.t), axisLine: { lineStyle: { color: SPLIT_COLOR } }, axisLabel: { color: AXIS_COLOR, fontSize: 10.5, interval: 'auto', hideOverlap: true } },
                  yAxis: { type: 'value', name: SIDE[sideMetric].unit, max: SIDE[sideMetric].max, nameTextStyle: { color: AXIS_COLOR }, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } }, splitNumber: 3 },
                  series: [
                    { name: SIDE[sideMetric].label + '（平均）', type: 'line', smooth: false, symbol: 'none', connectNulls: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.16 }, data: buckets.map((b) => (sideMetric === 'util' ? b.avgUtil : sideMetric === 'hbm' ? b.avgHbm : b.avgTemp)),
                      ...(SIDE[sideMetric].warn ? { markLine: { silent: true, symbol: 'none', data: [{ yAxis: SIDE[sideMetric].warn }], lineStyle: { type: 'dashed', color: '#ff6b6b', width: 1.4 }, label: { formatter: '阈值 ' + SIDE[sideMetric].warn + SIDE[sideMetric].unit, position: 'insideEndTop', fontSize: 11 } } } : {}) },
                    { name: SIDE[sideMetric].label + ' 最差值', type: 'line', smooth: false, symbol: 'none', connectNulls: false, lineStyle: { width: 1.2, type: 'dashed' }, data: buckets.map((b) => (sideMetric === 'util' ? b.maxUtil : sideMetric === 'hbm' ? b.maxHbm : b.maxTemp)) },
                  ],
                }} />
              </Panel>
            </div>
          ) : null}

          <Table minWidth={1180} head={['采样时间', '目标 / 状态', 'QPS', '吞吐 tok/s', '首包 TTFT', 'P99', '队列', 'KV 复用命中', '显存 %', '卡温 / 功耗', '窗口内请求']} rows={mon.samples.slice(0, 14).map((x) => [
            <span className="tiny mono">{sampleTime(x.at)}</span>,
            <span className="tiny">{x.service}{x.status === '取数失败' ? <AlertBadge tone="bad" jump={Jump.monitorTarget(x.target, '去这个采不到的监控目标：立即采一轮 / 看最近错误')}>取数失败</AlertBadge> : null}{x.model ? <div className="tiny faint mono">{x.model}</div> : null}</span>,
            <span className="num small">{metricNum(x.qps)}</span>,
            <span className="num small">{metricNum(x.tokens_per_sec)}</span>,
            <span className="num small">{x.ttft_ms === null ? '对方未开放' : `${x.ttft_ms} ms`}</span>,
            <span className="num small">{x.p99_ms === null ? '对方未开放' : `${x.p99_ms} ms`}</span>,
            <span className="num small">{metricNum(x.queue_depth)}</span>,
            <span className="num small">{x.kv_hit_pct === null ? '对方未开放' : `${x.kv_hit_pct}%`}</span>,
            <span className="num small">{x.hbm_pct === null ? '对方未开放' : `${x.hbm_pct}%`}</span>,
            <span className="tiny">{x.gpu_temp_c === null ? '卡指标对方未开放' : `${x.gpu_temp_c} ℃ / ${x.gpu_power_w} W`}<div className="tiny faint">{x.gpu_name || '对方未开放卡型'}</div></span>,
            <span className="num small">{metricNum(x.req_window)}{x.status === '取数失败' ? <div className="tiny" style={{ color: 'var(--bad-text)', maxWidth: 240 }}>{(x.note || '').slice(0, 70)}</div> : null}</span>,
          ])} rowKeys={mon.samples.slice(0, 14).map((x) => x.target)} pick={pick} />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            探针取数：数据服务自己按目标各自的间隔去拉，口径按目标选（JSON 指标 / Prometheus 文本 / 只有 OpenAI 兼容接口）；
            不向被监控的服务写任何东西；库里 <span className="mono">metric_samples</span> 是权威副本，界面只是读它。
            取数失败也写一条样本（状态「取数失败」），断连在台账里看得见，不会悄悄变成空页。
            密钥只在启动环境的环境变量里，库和前端都只存变量名。
          </div>
        </div>
      </Panel>
    </div>
  )
}
