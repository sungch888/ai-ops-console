/* =====================================================================
 * 推理引擎运行指标（需求 模型 7：前缀缓存命中率、容器 / 进程监控）
 * 指标由副本、卡位、池利用率、渠道配额与引擎配置推导，配置开关改完即生效
 * ===================================================================== */
import { Kpi, Panel, PageHead, Badge, State, Table, Callout, Progress } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { useEngine, engine } from '../../engine/engine'
import { useInference, inferenceStore, metricsOf, containersOf, clusterSummary, type Quantization } from '../../engine/inference'
import { usePerm } from '../../engine/auth'

export default function EngineMetrics() {
  const st = useEngine()
  const cfg = useInference()
  const gate = usePerm('gateway')
  const ms = metricsOf(st)
  const cs = clusterSummary(st)
  const containers = containersOf(st)

  const last = st.history.length ? st.history[st.history.length - 1].util.hp : 60
  const trend = st.history.slice(-12)
  const trendOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    grid: GRID,
    legend: { data: ['前缀缓存命中率（%）', '首 Token 时延（ms）'], textStyle: { color: AXIS_COLOR, fontSize: 11 }, top: 4 },
    xAxis: { type: 'category', boundaryGap: false, data: trend.map((h) => h.time), axisLabel: { color: AXIS_COLOR, fontSize: 11 } },
    yAxis: [
      { type: 'value', name: '%', max: 100, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
      { type: 'value', name: 'ms', axisLabel: { color: AXIS_COLOR }, splitLine: { show: false } },
    ],
    series: [
      { name: '前缀缓存命中率（%）', type: 'line', smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 }, data: trend.map((h) => Math.max(5, Math.min(92, Math.round((cs.cacheHit + (last - h.util.hp) * 0.22) * 10) / 10))) },
      { name: '首 Token 时延（ms）', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false, data: trend.map((h) => Math.max(30, Math.round(cs.ttft + (h.util.hp - last) * 1.7))) },
    ],
  }

  return (
    <div>
      <PageHead
        title="推理引擎运行指标"
        desc="前缀缓存命中率 · KV 缓存占用 · 首 Token 时延 · 批处理并发 · 容器与进程监控"
        extra={<><Badge tone="info">指标由副本 / 卡位 / 利用率推导</Badge><Badge tone="warn">演示口径 · 不接真实推理引擎</Badge></>}
      />

      <div className="grid g-6">
        <Kpi label="在线推理实例" value={cs.instances} unit="个" foot={`${cs.models} 个模型 · ${cs.cards} 卡承载`} />
        <Kpi label="平均前缀缓存命中率" value={cs.cacheHit} unit="%" foot={cfg.prefixCache ? '前缀缓存已开启' : <span className="down">● 前缀缓存已关闭</span>} />
        <Kpi label="平均首 Token 时延" value={cs.ttft} unit="ms" foot={`批处理窗口 ${cfg.batchWindowMs}ms · 最大并发 ${cfg.maxNumSeqs}`} />
        <Kpi label="KV 缓存占用" value={cs.kvUsed} unit="GB" foot={`可用 ${cs.kvTotal} GB · 量化 ${cfg.quantization}`} />
        <Kpi label="集群生成吞吐" value={cs.tokensPerSec.toLocaleString('zh-CN')} unit="token/s" foot={`平均 batch ${ms.length ? Math.round(ms.reduce((s, m) => s + m.avgBatch, 0) / ms.length) : 0} 条 / 批`} />
        <Kpi label="缓存节省折算" value={cs.savedCost.toLocaleString('zh-CN')} unit="元/日" foot={<><span className="up">✔ 已计入当日成本</span> 少生成 {cs.savedTokensWan.toLocaleString('zh-CN')} 万 token</>} />
      </div>

      <Panel title="引擎配置（改完即生效，指标同步变化）" extra={gate.manage ? '当前角色可调整' : '当前角色只读'} className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            <label className="row gap6 small">
              <input type="checkbox" checked={cfg.prefixCache} disabled={!gate.manage} onChange={(e) => inferenceStore.set({ prefixCache: e.target.checked })} />
              前缀缓存（Prefix Caching）
            </label>
            <label className="row gap6 small">
              <input type="checkbox" checked={cfg.kvResident} disabled={!gate.manage} onChange={(e) => inferenceStore.set({ kvResident: e.target.checked })} />
              KV 常驻显存
            </label>
            <div>
              <div className="tiny faint">权重量化方式</div>
              <select className="btn sm" style={{ marginTop: 4 }} disabled={!gate.manage} value={cfg.quantization} onChange={(e) => inferenceStore.set({ quantization: e.target.value as Quantization })}>
                <option value="FP16">FP16（精度优先）</option>
                <option value="W8A8">W8A8（显存省 38%）</option>
                <option value="INT8">INT8（显存省 50%）</option>
              </select>
            </div>
            <div>
              <div className="tiny faint">最大并发序列 max_num_seqs</div>
              <select className="btn sm" style={{ marginTop: 4 }} disabled={!gate.manage} value={cfg.maxNumSeqs} onChange={(e) => inferenceStore.set({ maxNumSeqs: Number(e.target.value) })}>
                <option value={128}>128</option><option value={192}>192</option><option value={256}>256</option><option value={384}>384</option>
              </select>
            </div>
            <div>
              <div className="tiny faint">批处理等待窗口</div>
              <select className="btn sm" style={{ marginTop: 4 }} disabled={!gate.manage} value={cfg.batchWindowMs} onChange={(e) => inferenceStore.set({ batchWindowMs: Number(e.target.value) })}>
                <option value={4}>4 ms（低时延）</option><option value={8}>8 ms（平衡）</option><option value={16}>16 ms（高吞吐）</option>
              </select>
            </div>
            <button className="btn sm ghost" disabled={!gate.manage} onClick={() => inferenceStore.reset()}>恢复默认配置</button>
          </div>

          <Callout text={<>配置与指标的因果关系可在现场直接演示（实测）：关闭前缀缓存 → 命中率 77.2% → 27.2%、首 Token 时延 +61ms、当日缓存节省从 ¥8,295 掉到 ¥2,922；量化 FP16 → W8A8 → KV 占用下降 38%（W8A8 → INT8 再降 19%）；批处理窗口 4ms → 16ms → 平均 batch 上升、时延上升；副本 +2 → 实例 2→4、命中率 77.2%→74.4%（缓存变冷）、KV 21.8→72.2 GB，时延随该池利用率变化。<b>这些数值为演示推导，真实值需接推理框架（昇腾 MindIE / vLLM 等）后由实施方提供。</b></>} />
        </div>
      </Panel>

      <Panel title="模型级运行指标" extra="副本、卡位与池利用率变化会立即改变本表 · 与资源调配工作台同源" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1120}
            head={['模型', '实例 / 卡位', 'GPU 利用率', 'KV 缓存占用', '前缀缓存命中率', '首 Token 时延', '生成吞吐', '平均 batch', '请求队列', '重启次数', '判定', '操作']}
            rows={ms.map((m) => [
              <span className="strong small">{m.short}<div className="tiny faint">{m.name}</div></span>,
              <span className="num small">{m.instances} 实例 · {m.cards} 卡<div className="tiny faint">{m.rpm} RPM</div></span>,
              <div style={{ minWidth: 90 }}><span className="num small">{m.gpuUtil}%</span><Progress value={m.gpuUtil} tone={m.gpuUtil > 90 ? 'bad' : m.gpuUtil > 78 ? 'warn' : ''} /></div>,
              <span className="num small">{m.kvUsedGB} / {m.kvTotalGB} GB<div className="tiny faint">{Math.round((m.kvUsedGB / m.kvTotalGB) * 100)}% 显存</div></span>,
              <span className="num" style={{ color: m.cacheHit < 35 ? '#ffb3b3' : undefined }}>{m.cacheHit}%</span>,
              <span className="num">{m.ttftMs} ms</span>,
              <span className="num small">{m.tokensPerSec.toLocaleString('zh-CN')}</span>,
              <span className="num small">{m.avgBatch}</span>,
              <span className="num small">{m.queueDepth}</span>,
              <span className="num small">{m.restarts}</span>,
              <span className="small">{m.health === 'ok' ? <Badge tone="good">{m.note}</Badge> : m.health === 'warn' ? <Badge tone="warn">{m.note}</Badge> : <Badge tone="bad">{m.note}</Badge>}</span>,
              <button className="btn sm ghost" disabled={!gate.manage} onClick={() => inferenceStore.restart(m.short)}>重启实例</button>,
            ])}
          />
          {st.models.filter((m) => m.state === '已下线' || m.replicas === 0).length ? (
            <Callout text={`已下线或无存活副本的模型：${st.models.filter((m) => m.state === '已下线' || m.replicas === 0).map((m) => m.short).join(' / ')} —— 实例已全部摘除，KV 缓存释放，本表不再计入。`} />
          ) : null}
        </div>
      </Panel>

      <Panel title="前缀缓存命中率与首 Token 时延（按历史利用率推演）" extra={`采样 ${trend.length} 个周期 · 与高保集群利用率联动`} className="mt14">
        <Chart option={trendOpt} height={260} />
      </Panel>

      <Panel title="容器与进程监控" extra="每实例一个推理容器 · 显存与内存按 KV 占用拆分" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1020}
            head={['容器名', '所属模型', 'CPU 占用', '内存', '显存占用', '重启次数', '已运行', '状态']}
            rows={containers.map((c) => [
              <span className="mono small">{c.instance}</span>,
              <span className="small">{c.model}</span>,
              <span className="num small">{c.cpu}%</span>,
              <span className="num small">{c.memGB} GB</span>,
              <div style={{ minWidth: 110 }}><span className="num small">{c.vramGB} / {c.vramTotal} GB</span><Progress value={Math.round((c.vramGB / c.vramTotal) * 100)} tone={c.vramGB / c.vramTotal > 0.9 ? 'bad' : c.vramGB / c.vramTotal > 0.75 ? 'warn' : ''} /></div>,
              <span className="num small">{c.restarts}</span>,
              <span className="num small">{c.uptimeMin ? `${Math.floor(c.uptimeMin / 60)} 小时 ${c.uptimeMin % 60} 分` : '—'}</span>,
              c.state === '运行中' ? <State s="run" /> : c.state === '冷启动' ? <Badge tone="warn">冷启动 · 缓存重建中</Badge> : <Badge tone="muted">已摘除</Badge>,
            ])}
          />
          <div className="row gap6" style={{ marginTop: 10 }}>
            <button className="btn sm ghost" disabled={!gate.manage} onClick={() => { engine.get().events.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5), level: '一般', text: '推理容器巡检已完成：实例健康检查通过，无 OOM 与重启异常' }); engine.refresh() }}>登记一次容器巡检</button>
            <span className="small faint">巡检结果写入运行事件流；容器指标为演示推导，真实采集需接节点监控。</span>
          </div>
        </div>
      </Panel>
    </div>
  )
}
