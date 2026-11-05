/* =====================================================================
 * 算力中心 · 昇腾算力卡监控
 * 卡级指标口径：温度 / HBM / 功耗 / 掉卡 / ECC 取自 npu-smi 或 NPU Exporter；
 * 未接采集层时由平台资源账本（池 + 模型副本 + 训练任务）同源推导，
 * 与「资源池与调度」页同一口径，不额外造数。
 * 本页：卡级只读展示 + 触阈值卡送例外监控；处置手段是限流来源或回收空闲卡位。
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Badge, Callout, Kpi, PageHead, Panel, Progress, Table } from '../../components/ui'
import { npuCards, sourceHint, telemetryStatus, telemetryStore, type NpuCard } from '../../engine/telemetry'
import { TOTAL_CARDS, poolFree, poolUtil, useEngine } from '../../engine/engine'
import { monitorStore } from '../../engine/exceptions'
import { usePerm } from '../../engine/auth'

/* 触阈值口径（与例外监控「资源异常」规则一致） */
const UTIL_MAX = 92
const TEMP_MAX = 85
const HBM_MAX = 95
const ECC_MAX = 5

const CARD_TONE: Record<'ok' | 'warn' | 'fault', 'good' | 'warn' | 'bad'> = { ok: 'good', warn: 'warn', fault: 'bad' }
const CARD_TEXT: Record<'ok' | 'warn' | 'fault', string> = { ok: '正常', warn: '阈值附近', fault: '掉卡 / 隔离' }
const NODE_TONE: Record<'ok' | 'warn' | 'fault', 'good' | 'warn' | 'bad'> = { ok: 'good', warn: 'warn', fault: 'bad' }
const NODE_TEXT: Record<'ok' | 'warn' | 'fault', string> = { ok: '节点正常', warn: '节点阈值附近', fault: '节点隔离中' }

export default function ComputeCards() {
  const st = useEngine()
  const perm = usePerm('compute')
  const [nonce, setNonce] = useState(0)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  /* 采集层落数后自动切「采集层」：订阅一次刷新，不改采集层代码 */
  useEffect(() => telemetryStore.subscribe(() => setNonce((n) => n + 1)), [])

  const tel = telemetryStatus()
  const hint = sourceHint('npu')
  const cards = npuCards()

  const rows = cards.map((c) => {
    const hbmPct = c.hbmTotal > 0 ? Math.round((c.hbmUsed / c.hbmTotal) * 100) : 0
    const reasons: string[] = []
    if (c.health === 'fault') reasons.push('掉卡或隔离')
    if (c.util > UTIL_MAX) reasons.push(`利用率 ${c.util}% 超阈（>${UTIL_MAX}%）`)
    if (c.temp >= TEMP_MAX) reasons.push(`温度 ${c.temp}℃ 超阈（≥${TEMP_MAX}℃）`)
    if (hbmPct > HBM_MAX) reasons.push(`HBM 占用 ${hbmPct}% 超阈（>${HBM_MAX}%）`)
    if (c.eccErrors >= ECC_MAX) reasons.push(`ECC 可纠正错误 ${c.eccErrors} 条偏高`)
    return { c, hbmPct, reasons }
  })
  const alerts = rows.filter((r) => r.reasons.length > 0)

  const online = cards.filter((c) => c.health !== 'fault').length
  const avgUtil = cards.length ? Math.round(cards.reduce((s, c) => s + c.util, 0) / cards.length) : 0
  const avgHbm = rows.length ? Math.round(rows.reduce((s, r) => s + r.hbmPct, 0) / rows.length) : 0
  const totalPower = cards.reduce((s, c) => s + c.power, 0)
  const localTotal = cards.length

  /* 按节点分组：每节点 8 张卡一个小区块 */
  const nodes = Array.from(new Set(cards.map((c) => c.node))).map((name) => {
    const list = cards.filter((c) => c.node === name)
    const health = list.some((c) => c.health === 'fault') ? 'fault' : list.some((c) => c.health === 'warn') ? 'warn' : 'ok'
    return { name, list, model: list[0]?.model ?? '—', poolName: list[0]?.poolName ?? '—', health: health as 'ok' | 'warn' | 'fault' }
  })

  const hbmOf = (c: NpuCard) => (c.hbmTotal > 0 ? Math.round((c.hbmUsed / c.hbmTotal) * 100) : 0)
  const cellBg = (c: NpuCard) =>
    c.health === 'fault' ? '#7a2222' : c.util > 85 ? '#8a4a2a' : c.util >= 60 ? '#2b5f8f' : '#1b3a5c'

  return (
    <div>
      <PageHead
        title="昇腾算力卡监控"
        desc="卡级指标来自 npu-smi / NPU Exporter，未接采集层时由平台资源账本同源推导（池 + 模型副本 + 训练任务），口径与资源池页一致"
        extra={
          <>
            <Badge tone="good">在线卡 {online} / {localTotal}</Badge>
            <Badge tone={alerts.length ? 'warn' : 'muted'}>告警卡 {alerts.length}</Badge>
            <Badge tone={tel.mode === '采集层' ? 'purple' : 'info'}>取数来源：{tel.mode}</Badge>
            <button className="btn sm ghost" onClick={() => setNonce((n) => n + 1)}>重取一次</button>
          </>
        }
      />

      <Callout
        warn
        text={
          <>
            <span className="strong">物理卡与池化分配是两本账：</span>
            本地物理侧 {nodes.length} 个节点 × 8 卡 = {localTotal} 张卡，按节点归入高保 / 共享 / 训练三类资源池（高保 {st.pools.find((p) => p.id === 'hp')?.cards ?? 0} 卡 · 共享 {st.pools.find((p) => p.id === 'shared')?.cards ?? 0} 卡 · 训练 {st.pools.find((p) => p.id === 'train')?.cards ?? 0} 卡，合计 {st.pools.reduce((s, p) => s + p.cards, 0)} 卡）。
            平台登记总量 {TOTAL_CARDS} 卡中另含外部扩租额度与未纳管设备：未纳管的不在本页卡表里，走「例外监控与阻断」页核查，本页不替它编造卡位。
          </>
        }
      />

      <div className="grid g-6 mt14">
        <Kpi label="卡总数（本页卡表）" value={localTotal} unit="张" foot={`节点侧计数 · 平台登记 ${TOTAL_CARDS} 卡`} />
        <Kpi label="在线卡" value={online} unit="张" foot={`隔离 / 掉卡 ${localTotal - online} 张`} />
        <Kpi label="告警卡" value={alerts.length} unit="张" foot={`利用率 >${UTIL_MAX}% 或 温度 ≥${TEMP_MAX}℃ 或 HBM >${HBM_MAX}% 或 fault`} />
        <Kpi label="平均利用率" value={avgUtil} unit="%" foot={`高保 ${poolUtil(st, 'hp')}% · 共享 ${poolUtil(st, 'shared')}% · 训练 ${poolUtil(st, 'train')}%`} />
        <Kpi label="HBM 平均占用率" value={avgHbm} unit="%" foot="单卡显存容量按采集字段计（不可采集时留空）" />
        <Kpi label="集群总功耗" value={totalPower.toLocaleString('zh-CN')} unit="W" foot="按卡位 power 求和 · 未接采集层时为推导值" />
      </div>

      <Panel className="mt14" title="卡位热力网格（按节点 × 卡位）" extra={`利用率分段：<60% 蓝 · 60–85% 深蓝 · >85% 橙 · 隔离 红 · 悬停看全量指标`}>
        <div className="col gap6">
          {nodes.map((n) => (
            <div key={n.name} style={{ border: '1px solid rgba(64,130,220,.16)', borderRadius: 10, padding: '10px 12px' }}>
              <div className="row gap6" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                <span className="strong small">{n.name}</span>
                <span className="tag gray">{n.model}</span>
                <span className="tag gray">{n.poolName}</span>
                <Badge tone={NODE_TONE[n.health]}>{NODE_TEXT[n.health]}</Badge>
                <span className="tiny faint">{n.list.length} 卡</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
                {n.list.map((c, i) => {
                  const hbm = hbmOf(c)
                  return (
                    <div
                      key={c.id}
                      title={`${c.id} · ${c.node} · ${c.model} · ${c.poolName}\n利用率 ${c.util}% · HBM ${c.hbmUsed}/${c.hbmTotal}GB（${hbm}%）\n温度 ${c.temp}℃ · 功耗 ${c.power}W\n承载服务：${c.service} · ECC 可纠正错误 ${c.eccErrors} 条 · ${CARD_TEXT[c.health]}`}
                      style={{
                        minWidth: 40, background: cellBg(c), borderRadius: 7, padding: '6px 4px',
                        textAlign: 'center', fontSize: 11, lineHeight: 1.4, color: '#e8f2ff',
                        border: c.health === 'fault' ? '1px solid rgba(255,107,107,.55)' : '1px solid rgba(160,205,255,.14)',
                      }}
                    >
                      <div style={{ opacity: 0.8 }}>卡{i + 1}</div>
                      <div className="num strong">{c.health === 'fault' ? '隔离' : `${c.util}%`}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="tiny faint">格子上的数字是该卡位当前利用率（无数据时按 0 计）；掉卡或被隔离的卡位显示「隔离」，不参与承载服务统计。</div>
        </div>
      </Panel>

      <Panel className="mt14" title="卡明细（卡位级台账）" extra={`${localTotal} 行 · 与池对照表同源`} noPad>
        <div className="panel-body">
          <Table
            minWidth={1150}
            head={['卡位', '节点', '型号', '资源池', '利用率', 'HBM 占用', '温度', '功耗', 'ECC 可纠正错误', '承载服务 / 任务', '健康']}
            rows={rows.map(({ c, hbmPct }) => [
              <span className="mono small">{c.id}</span>,
              <span className="small">{c.node}</span>,
              <span className="tag gray">{c.model}</span>,
              <span className="small">{c.poolName}</span>,
              <div style={{ minWidth: 120 }}>
                <Progress value={c.util} tone={c.util > UTIL_MAX ? 'bad' : c.util > 85 ? 'warn' : ''} />
                <span className="tiny faint num">{c.util}%</span>
              </div>,
              <div className="small num">{c.hbmUsed}/{c.hbmTotal}GB<div className="tiny faint">{hbmPct}%</div></div>,
              <span className={`num ${c.temp >= TEMP_MAX ? 'strong' : ''}`}>{c.temp}℃</span>,
              <span className="num">{c.power} W</span>,
              <span className={`num ${c.eccErrors >= ECC_MAX ? 'strong' : 'faint'}`}>{c.eccErrors}</span>,
              <span className="small">{c.service}</span>,
              <Badge tone={CARD_TONE[c.health]}>{CARD_TEXT[c.health]}</Badge>,
            ])}
          />
        </div>
      </Panel>

      <Panel
        className="mt14"
        title="卡级告警（送例外监控）"
        extra={
          <>
            <span className="tiny faint">触阈值口径：利用率 / 温度 / HBM / 掉卡隔离 / ECC</span>
            <button
              className="btn sm"
              disabled={!perm.manage}
              onClick={() => {
                const n = monitorStore.scanAndRaise()
                setMsg({
                  tone: 'good',
                  text: `已触发例外监控扫描一轮：本轮新增报警 ${n} 项。卡级异常在例外监控页记为「资源异常」，可用处置是限流来源（凭证 / 应用 / 外部渠道）或回收空闲卡位，不会停整池、不下线节点。`,
                })
              }}
            >
              送例外监控扫描
            </button>
            {perm.manage ? null : <span className="tiny faint">只读</span>}
          </>
        }
      >
        {alerts.length === 0 ? (
          <div className="small">当前没有触阈值卡（口径：利用率 &gt;{UTIL_MAX}%、温度 ≥{TEMP_MAX}℃、HBM &gt;{HBM_MAX}%、fault、ECC ≥{ECC_MAX} 条）。</div>
        ) : (
          <div className="col gap6">
            {alerts.map(({ c, reasons }) => (
              <div key={c.id} style={{ border: '1px solid rgba(64,130,220,.16)', borderRadius: 10, padding: '8px 10px' }}>
                <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                  <span className="mono small strong">{c.id}</span>
                  <span className="tag gray">{c.node}</span>
                  <Badge tone={CARD_TONE[c.health]}>{CARD_TEXT[c.health]}</Badge>
                  <span className="small">{c.service}</span>
                </div>
                <div className="tiny faint" style={{ marginTop: 4 }}>触阈值原因：{reasons.join(' · ')}</div>
              </div>
            ))}
            <div className="tiny faint">卡级异常只记「资源异常」类例外：先限流超额调用来源，再按空闲卡位做资源侧缓解（回收 / 抢占走变更窗口）。</div>
          </div>
        )}
        {msg ? <div style={{ marginTop: 10 }}><Callout text={msg.text} warn={msg.tone === 'bad'} /></div> : null}
      </Panel>

      <Panel className="mt14" title="池对照（卡表 vs 池化分配）" extra="本页卡表按节点统计，池化分配按平台资源账本统计" noPad>
        <div className="panel-body">
          <Table
            minWidth={860}
            head={['资源池', '池卡数', '已占用', '空闲', '池利用率', '占用条', '本页卡表内该池卡数']}
            rows={st.pools.map((p) => {
              const free = poolFree(st, p.id)
              const util = poolUtil(st, p.id)
              const inCardTable = cards.filter((c) => c.pool === p.id).length
              return [
                <span className="strong small">{p.name}</span>,
                <span className="num">{p.cards}</span>,
                <span className="num">{p.cards - free}</span>,
                <span className="num">{free}</span>,
                <span className="num">{util}%</span>,
                <div style={{ minWidth: 140 }}><Progress value={util} tone={util > 92 ? 'bad' : util > 85 ? 'warn' : ''} /></div>,
                <span className="num">{inCardTable}</span>,
              ]
            })}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            训练池占用来自训练任务台账（FT-118 等运行中算例），不是模型副本；高保 / 共享池占用来自模型副本（副本数 × 每副本卡位）。
            节点侧卡数与池卡数不一致时，差额是外部扩租额度或未纳管设备，未纳管部分在「例外监控与阻断」页核查。
          </div>
        </div>
      </Panel>

      <Panel className="mt14" title="数据来源与接口清单（npu）" extra={`当前模式：${tel.mode} · ${tel.generatedAt} · 本页渲染轮次 ${nonce + 1}`} noPad>
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
              <span className="num">{tel.sources.find((s) => s.id === 'npu')?.items ?? hint.status.items}</span>,
              <Badge tone={hint.status.ok ? 'good' : 'bad'}>{hint.status.ok ? '可用' : '取数失败'}</Badge>,
            ]]}
          />
          <div className="row gap6" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <span className="small faint">采集字段：</span>
            {hint.fields.map((f) => <span key={f} className="tag gray mono">{f}</span>)}
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>字段说明：{hint.note}</div>
          <div className="divider" />
          <div className="row gap6" style={{ flexWrap: 'wrap' }}>
            <Badge tone={tel.mode === '采集层' ? 'purple' : 'info'}>取数来源：{tel.mode}</Badge>
            <span className="small">生成时间 / 更新口径：{tel.generatedAt}</span>
            <span className="small">来源状态：{tel.sources.map((s) => `${s.name} ${s.items} 条（${s.at}）`).join(' · ')}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            <Callout
              text={
                <>
                  真实环境接入方式：把采集脚本（npu-smi info 或 NPU Exporter → Prometheus query）按 30 秒周期写到 <span className="mono">dist/data/cards.json</span> 并刷新 <span className="mono">manifest.json</span>，本页自动切到「采集层」，不改平台代码、不改本页字段口径。
                  厂商侧不开放的字段（例如部分固件不回报功耗或 ECC 计数）在卡表里留空并标「不可采集」，不用推导值冒充采集值。
                </>
              }
            />
          </div>
        </div>
      </Panel>
    </div>
  )
}
