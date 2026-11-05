/* =====================================================================
 * 模型中心 · MindIE 推理服务监控
 * 服务级指标：副本健康 / 首包时延 TTFT / 吞吐 tok·s / 队列深度 / KV 缓存命中
 * 取数：MindIE /metrics（未接采集层时由平台推理引擎与资源账本同源推导）
 * 本页只读监控 + 提交副本扩容工单；灰度放量与版本回退不在本页做（走部署工单 / 模型资产页）
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Callout, Kpi, PageHead, Panel, Progress, State, Table } from '../../components/ui'
import { AXIS_COLOR, CHART_COLORS, Chart, GRID, SPLIT_COLOR, TOOLTIP_STYLE } from '../../components/Chart'
import { inferenceServices, sourceHint, telemetryStatus, telemetryStore, type InferenceService } from '../../engine/telemetry'
import { engine, useEngine } from '../../engine/engine'
import { usePerm } from '../../engine/auth'

/* 需要动作的判定口径（与例外监控「资源异常」规则同源） */
const ERR_MAX = 2.4
const QUEUE_MAX = 40
const TTFT_MAX = 900

const SVC_TONE: Record<InferenceService['health'], 'good' | 'warn' | 'bad'> = { ok: 'good', warn: 'warn', bad: 'bad' }
const SVC_TEXT: Record<InferenceService['health'], string> = { ok: '正常', warn: '阈值附近', bad: '异常' }

export default function ModelMonitor() {
  const st = useEngine()
  /* 权限点：auth.ts 的 PermKey 没有 'model'，模型中心各页统一挂 'gateway'（与 App.tsx 路由权限映射一致） */
  const perm = usePerm('gateway')
  const [nonce, setNonce] = useState(0)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  /* 采集层落 services.json 后自动切「采集层」：订阅刷新，不改采集层代码 */
  useEffect(() => telemetryStore.subscribe(() => setNonce((n) => n + 1)), [])

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
        <Kpi label="推理服务" value={svcs.length} unit="个" foot={`占用 ${cardsUsed} 卡位 · 就绪 ${svcs.reduce((s, x) => s + x.ready, 0)}/${instances} 实例`} />
        <Kpi label="实例总数" value={instances} unit="个" foot="副本数按平台模型台账计" />
        <Kpi label="占用卡位合计" value={cardsUsed} unit="卡" foot="副本 × 每副本卡位 · 与池对照同源" />
        <Kpi label="平均首包时延" value={avg((s) => s.ttftMs)} unit="ms" foot={`阈值 ${TTFT_MAX}ms · P99 平均 ${avg((s) => s.p99Ms)}ms`} />
        <Kpi label="平均错误率" value={avg((s) => s.errPct, 1)} unit="%" foot={`动作线 ${ERR_MAX}% · 重启合计 ${svcs.reduce((s, x) => s + x.restarts, 0)} 次`} />
        <Kpi label="队列深度合计" value={queueTotal} unit="请求" foot={`动作线 ${QUEUE_MAX} · 超线的服务见下方「需要动作的服务」`} />
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
                <Progress value={s.hbmPct} tone={s.hbmPct > 95 ? 'bad' : s.hbmPct > 85 ? 'warn' : ''} />
                <span className="tiny faint num">{s.hbmPct}%</span>
              </div>,
              <span className={`num ${s.errPct >= ERR_MAX ? 'strong' : ''}`}>{s.errPct}%</span>,
              <span className={`num ${s.restarts > 0 ? 'strong' : 'faint'}`}>{s.restarts}</span>,
              <Badge tone={SVC_TONE[s.health]}>{SVC_TEXT[s.health]}</Badge>,
            ])}
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
            {needAction.map(({ s, reasons }) => (
              <div key={s.service} style={{ border: '1px solid rgba(64,130,220,.16)', borderRadius: 10, padding: '9px 11px' }}>
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  <span className="mono small strong">{s.service}</span>
                  <span className="tag gray">{s.model}</span>
                  <span className="tag gray">{s.version}</span>
                  <span className="small">{s.poolName}</span>
                  <Badge tone={SVC_TONE[s.health]}>{SVC_TEXT[s.health]}</Badge>
                  <span className="tiny faint">{s.instances} 副本 / {s.cards} 卡位</span>
                </div>
                <div className="small" style={{ marginTop: 5, color: '#b9cbe6' }}>原因：{reasons.join(' · ')}</div>
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
                          ? { tone: 'good', text: `${r.order.id} 已提交，准入预检通过：${r.precheck.suggest ?? ''}（工单进变更窗口队列，执行后回到本页验收 TTFT 与队列）` }
                          : { tone: 'bad', text: `${r.order.id} 被准入校验驳回：${r.precheck.reason ?? '未给出理由'}${r.precheck.suggest ? ` · 建议：${r.precheck.suggest}` : ''}` },
                      )
                    }}
                  >
                    提交副本扩容
                  </button>
                  <Link className="btn sm ghost" to="/compute/exceptions">去例外监控看来源归因</Link>
                  <span className="tiny faint">扩容工单只加副本；限流来源与回收空闲卡位在例外监控页做</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {msg ? <div style={{ marginTop: 10 }}><Callout text={msg.text} warn={msg.tone === 'bad'} /></div> : null}
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
              <Badge tone={hint.status.ok ? 'good' : 'bad'}>{hint.status.ok ? '可用' : '取数失败'}</Badge>,
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
    </div>
  )
}
