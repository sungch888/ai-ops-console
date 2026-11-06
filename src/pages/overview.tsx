import React from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout } from '../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../components/Chart'
import {
  overview, models, secEvents, computeCards,
} from '../data/mock'
import { useEngine, poolUtil, freeCards, totalAllocated, totalReplicas, activeCreds, TOTAL_CARDS } from '../engine/engine'
import { ledgerOf } from '../engine/ledger'
import { useNotifs } from '../engine/ops'

function useLive() {
  // 演示效果：数字轻微波动
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 3000)
    return () => clearInterval(t)
  }, [])
  return tick
}

export default function Overview() {
  const st = useEngine()
  const notifs = useNotifs()
  const tick = useLive()
  const L = ledgerOf(st)
  const wave = 1 + Math.sin(tick / 2.2) * 0.004
  const callsToday = ((L.callsToday / 10000) * wave).toFixed(1)
  const qpsNow = Math.max(1, Math.round((L.callsToday / 86400) * wave))
  const allocPct = Math.round((totalAllocated(st) / TOTAL_CARDS) * 100)

  const trendOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    grid: GRID,
    xAxis: { type: 'category', boundaryGap: false, data: L.series.map((s) => s.hour), axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, interval: 2 } },
    yAxis: { type: 'value', name: '万次', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      {
        name: '模型调用量',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: L.series.map((s) => Math.round(s.calls / 100) / 100),
        areaStyle: { opacity: 0.16 },
        lineStyle: { width: 2.5 },
      },
    ],
  }

  const cityOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 20, top: 14, bottom: 6, containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR, formatter: '{value}万' }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    yAxis: { type: 'category', inverse: true, data: L.perCity.map((c) => c.name), axisLabel: { color: AXIS_COLOR, fontSize: 11.5 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [
      {
        name: '调用量',
        type: 'bar',
        barWidth: 9,
        data: L.perCity.map((c) => Math.round(c.calls / 1000) / 10),
        itemStyle: { borderRadius: 5, color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#1899e0' }, { offset: 1, color: '#22d3ee' }] } },
        label: { show: true, position: 'right', color: 'var(--info-text)', fontSize: 11 },
      },
    ],
  }

  const modelDonutOpt = {
    color: ['#22d3ee', '#3d8bfd', '#2fd6a3', '#f5b83d', '#a78bfa', '#ff6b6b'],
    tooltip: { ...TOOLTIP_STYLE, trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    series: [
      {
        name: '模型负载',
        type: 'pie',
        radius: ['52%', '74%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#0a1424', borderWidth: 2 },
        label: { show: false },
        data: st.models.filter((m) => m.replicas > 0).map((m) => ({ name: m.short, value: m.replicas * m.perReplica })),
      },
    ],
  }

  return (
    <div>
      <PageHead
        title="运营总览"
        desc="算力 · 模型 · 应用 三中心一体化运营态势（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">平台可用性 {overview.sla}%</Badge>
            <Badge tone="info">安全拦截准确率 {overview.secRate}%</Badge>
          </>
        }
      />

      <div className="grid g-8">
        <Kpi label="NPU 算力卡" value={TOTAL_CARDS} unit="张" foot={`已分配 ${totalAllocated(st)} · 空闲 ${freeCards(st)}`} />
        <Kpi label="池化率" value={allocPct} unit="%" foot="与调配工作台同源" />
        <Kpi label="在线模型" value={st.models.length} unit="个" foot={`副本 ${totalReplicas(st)} 个 · ${st.channels.length} 条渠道`} />
        <Kpi label="在线应用" value={12 - L.stopped.length} unit="个" foot={L.stopped.length ? <span className="down">● {L.stopped.length} 项已停止承接调用</span> : '12 个智能体应用 · 全部在承接'} />
        <Kpi label="今日调用量" value={callsToday} unit="万次" foot={<span className="small faint">账本同源：{L.liveCards} 卡在承载 · RPM {L.rpm}</span>} />
        <Kpi label="今日 Token" value={(L.tokensToday / 10000).toFixed(2)} unit="亿" foot={`本地 ${((L.tokensToday * (1 - L.externalShare)) / 10000).toFixed(2)} 亿 · 外部 ${(L.externalShare * 100).toFixed(0)}% 渠道`} />
        <Kpi label="今日折算成本" value={(L.costToday / 10000).toFixed(2)} unit="万元" foot={`本地卡位 ${(L.localCost / 10000).toFixed(2)} 万 · 外部 Token ${(L.externalCost / 10000).toFixed(2)} 万`} />
        <Kpi label="活跃凭证" value={activeCreds(st)} unit="个" foot={`待审批 ${st.orders.filter((o) => o.status === 'submitted').length} · 排队 ${st.orders.filter((o) => o.status === 'queued').length}`} />
        <Kpi label="未闭环通知" value={notifs.filter((n) => !n.handled).length} unit="条" foot={<span className="down">● 含自动建议与对接异常</span>} />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="近 24 小时模型调用量趋势" extra="推理网关 · 全渠道汇总">
          <Chart option={trendOpt} height={300} />
        </Panel>
        <Panel title="在线模型负载分布" extra="按占用卡位 · 调度引擎实时值">
          <Chart option={modelDonutOpt} height={250} />
          <div className="divider" />
          {st.pools.map((p) => {
            const u = poolUtil(st, p.id)
            return (
              <div key={p.id} style={{ marginBottom: 9 }}>
                <div className="row between small">
                  <span>{p.name} <span className="faint">({p.cards} 卡)</span></span>
                  <span className={u > 90 ? 'strong' : 'muted'}>{u}%</span>
                </div>
                <div style={{ marginTop: 4 }}><Progress value={u} tone={u > 90 ? 'bad' : u > 80 ? 'warn' : 'green'} /></div>
              </div>
            )
          })}
          <div className="tiny faint" style={{ marginTop: 6 }}>资源类指标与「资源调配工作台」同源，随工单执行实时变化；调用量与地市排行来自网关统计（演示数据源）。</div>
        </Panel>
      </div>

      <div className="grid g-32 mt14">
        <Panel title="各地市调用量排行（今日）" extra="万次 / 日 · 组织维度归集" noPad>
          <div className="panel-body">
            <Chart option={cityOpt} height={330} />
          </div>
        </Panel>
        <Panel title="今日安全事件动态" extra={`${overview.eventsToday} 起 · 2 起紧急`} noPad>
          <div className="panel-body">
            <Table
              head={['时间', '等级', '类型', '处置状态']}
              rows={secEvents.slice(0, 5).map((e) => [
                <span className="mono small">{e.time}</span>,
                e.level === '紧急' ? <Badge tone="bad">紧急</Badge> : e.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>,
                e.type,
                e.status === '处置中' ? <Badge tone="warn">处置中</Badge> : <Badge tone="good">已闭环</Badge>,
              ])}
            />
            <div className="mt14">
              <Callout text="提示词注入攻击（示范市02）已拦截并溯源，涉事个人密钥已限流；详情见「模型中心 · 安全检测」。" warn icon={undefined} />
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid g-21 mt14">
        <Panel title="核心应用调用 TOP" extra="今日调用量（万次）" noPad>
          <div className="panel-body">
            <Table
              head={['应用', '条线', '今日调用（账本）', 'Token', '折算成本', '运行态']}
              rows={L.perApp.slice(0, 7).map((a) => [
                <span className="strong">{a.name}</span>,
                <span className="tag gray">{a.dept}</span>,
                <span className="num">{(a.calls / 10000).toFixed(1)} 万</span>,
                <span className="num small">{a.tokens.toLocaleString('zh-CN')} 万</span>,
                <span className="num small">¥{a.cost.toLocaleString('zh-CN')}</span>,
                a.note ? <Badge tone={a.note.includes('限流') ? 'warn' : 'bad'}>{a.note}</Badge> : <Badge tone="good">正常承接</Badge>,
              ])}
              minWidth={760}
            />
          </div>
        </Panel>
        <Panel title="国产化算力卡概况" extra="88 张 NPU · 3 厂商">
          {computeCards.map((c) => (
            <div key={c.type} className="mt8" style={{ marginTop: 14 }}>
              <div className="row between">
                <span>{c.type}</span>
                <span className="muted small">{c.count} 张 · {c.util}% 利用率</span>
              </div>
              <div className="mt8" style={{ marginTop: 7 }}>
                <Progress value={c.util} tone={c.util > 85 ? 'warn' : ''} />
              </div>
            </div>
          ))}
          <div className="divider" />
          <div className="row between small">
            <span className="muted">今日算力事件 1 起（NPU 掉卡已自愈）</span>
            <Badge tone="good">资源健康</Badge>
          </div>
        </Panel>
      </div>

      <div className="callout mt20">
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.5" />
        </svg>
        <div>
          本页面为选型交流演示环境：全部指标、事件、人员均为<b>虚拟数据</b>，外部系统（身份认证、安全设备、业务子系统）已按接口约定虚拟接入，用于展示平台能力边界与运营闭环。
        </div>
      </div>
    </div>
  )
}
