import React from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { computeCards, computeNodes, computeEvents } from '../../data/mock'
import { useEngine, poolUtil, freeCards, totalAllocated, totalReplicas, TOTAL_CARDS, rentInfo } from '../../engine/engine'
import { useGovernViews, governSummary, DEPTH_LABEL } from '../../engine/govern'
import { Link } from 'react-router-dom'

export default function ComputeOverview() {
  const st = useEngine()
  const gov = useGovernViews().filter((g) => g.domain === '算力平台' || g.domain === '算力资源')
  const gs = governSummary()
  const rent = rentInfo(st)
  const utilOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['利用率', '显存占用', '温度'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: {
      type: 'category',
      data: computeNodes.map((n) => n.name.replace('AI-', '')),
      axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } },
      axisLabel: { color: AXIS_COLOR, fontSize: 11 },
    },
    yAxis: [
      { type: 'value', name: '%', max: 100, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
      { type: 'value', name: '℃', max: 100, axisLabel: { color: AXIS_COLOR }, splitLine: { show: false } },
    ],
    series: [
      { name: '利用率', type: 'bar', barWidth: 12, itemStyle: { borderRadius: 4, color: '#22d3ee' }, data: computeNodes.map((n) => n.util) },
      { name: '显存占用', type: 'bar', barWidth: 12, itemStyle: { borderRadius: 4, color: '#3d8bfd' }, data: computeNodes.map((n) => n.mem) },
      { name: '温度', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 6, lineStyle: { width: 2, color: '#f5b83d' }, itemStyle: { color: '#f5b83d' }, data: computeNodes.map((n) => n.temp) },
    ],
  }

  const vendorOpt = {
    color: ['#22d3ee', '#3d8bfd', '#a78bfa'],
    tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: '{b}: {c} 张 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: '#0a1424', borderWidth: 2 },
        label: { show: false },
        data: computeCards.map((c) => ({ name: c.type.split(' ')[0] + ' ' + c.type.split(' ')[1], value: c.count })),
      },
    ],
  }

  return (
    <div>
      <PageHead
        title="算力资源总览"
        desc="88 张国产化 NPU · 8 个训推节点 · 统一纳管与池化调度"
        extra={<><Badge tone="good">集群健康</Badge><Badge tone="warn">1 节点故障已自愈</Badge></>}
      />

      <div className="grid g-6">
        <Kpi label="算力卡总数" value={TOTAL_CARDS} unit="张" foot="昇腾 / 寒武纪 / 海光" />
        <Kpi label="卡位分配率" value={Math.round((totalAllocated(st) / TOTAL_CARDS) * 100)} unit="%" foot={`已分配 ${totalAllocated(st)} · 空闲 ${freeCards(st)}`} />
        <Kpi label="高保集群利用率" value={poolUtil(st, 'hp')} unit="%" foot={`共享 ${poolUtil(st, 'shared')}% · 训练 ${poolUtil(st, 'train')}%`} />
        <Kpi label="训推节点" value={8} unit="个" foot={<span className="down">● 1 个隔离中</span>} />
        <Kpi label="推理副本" value={totalReplicas(st)} unit="个" foot={`${st.models.length} 个在线模型 · 实时`} />
        <Kpi label="平均温度" value={65} unit="℃" foot="阈值 85℃" />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="节点资源监控" extra="利用率 / 显存 / 温度 · 实时采集">
          <Chart option={utilOpt} height={280} />
        </Panel>
        <Panel title="算力卡厂商分布" extra="国产化适配">
          <Chart option={vendorOpt} height={280} />
        </Panel>
      </div>

      <div className="grid g-32 mt14">
        <Panel title="节点明细" extra="含资源池归属与网络平面" noPad>
          <div className="panel-body">
            <Table
              minWidth={820}
              head={['节点', '算力卡', '卡数', '利用率', '显存', '温度', '资源池', '网络平面', '状态']}
              rows={computeNodes.map((n) => [
                <span className="strong">{n.name}</span>,
                <span className="tag gray">{n.card}</span>,
                <span className="num">{n.cards}</span>,
                <div style={{ minWidth: 120 }}>
                  <Progress value={n.util} tone={n.util > 85 ? 'warn' : n.util === 0 ? 'bad' : ''} />
                  <span className="tiny faint">{n.util}%</span>
                </div>,
                <span className="num">{n.mem}%</span>,
                <span className="num">{n.temp}℃</span>,
                <span className="muted small">{n.pool}</span>,
                <span className="dim small">{n.net}</span>,
                <State s={n.status} />,
              ])}
            />
          </div>
        </Panel>
        <Panel title="算力事件与自愈" extra="近 48 小时">
          <ul className="tl">
            {computeEvents.map((e) => (
              <li key={e.time}>
                <div className="tl-time mono">{e.time}</div>
                <div className="row gap6" style={{ marginBottom: 4 }}>
                  {e.level === '紧急' ? <Badge tone="bad">紧急</Badge> : e.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>}
                  <Badge tone="good">{e.status}</Badge>
                </div>
                <div className="small" style={{ color: 'var(--table-text)', lineHeight: 1.6 }}>{e.text}</div>
              </li>
            ))}
          </ul>
          <Callout text="AI-Infer-06 掉卡后，健康探针 30 秒内触发隔离，实例自动迁移至高保集群备用副本，业务侧无感知。" />
        </Panel>
      </div>

      <div className="grid g-3 mt14">
        {computeCards.map((c) => (
          <Panel key={c.type} title={c.type} extra={`${c.count} 张 · ${c.power}`}>
            <div className="row between small muted"><span>利用率</span><span>{c.util}%</span></div>
            <div style={{ marginTop: 6 }}><Progress value={c.util} /></div>
            <div className="row between small muted" style={{ marginTop: 12 }}><span>显存</span><span>{c.mem}%</span></div>
            <div style={{ marginTop: 6 }}><Progress value={c.mem} tone={c.mem > 80 ? 'warn' : ''} /></div>
            <div className="row between small muted" style={{ marginTop: 12 }}><span>平均温度</span><span>{c.temp}℃</span></div>
            <div style={{ marginTop: 6 }}><Progress value={c.temp} tone="green" /></div>
          </Panel>
        ))}
      </div>

      <Panel title="异构算力平台与资源接管范围" extra={`本地 ${TOTAL_CARDS} 卡 + 已纳管可调度外部 ${gs.externalCards} 卡 · 可调度总量 ${TOTAL_CARDS + gs.externalCards} 卡`} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1000}
            head={['接管对象', '来源 / 厂商', '规模', '真实接管深度', '可调度性', '卡点 / 说明']}
            rows={gov.map((g) => [
              <span className="strong small">{g.name}</span>,
              <span className="small">{g.source}<div className="tiny faint">{g.vendor}</div></span>,
              <span className="small">{g.scale}</span>,
              <span className={`tag ${g.depth === 4 ? 'green' : g.depth === 3 ? '' : g.depth === 2 ? 'orange' : 'gray'}`}>{DEPTH_LABEL[g.depth]}</span>,
              g.depth >= 4 ? <State s="ok" /> : g.depth === 3 ? <Badge tone="info">可处置不可调度</Badge> : <Badge tone="warn">不进调度</Badge>,
              <span className="tiny" style={{ maxWidth: 320 }}>{g.why}</span>,
            ])}
          />
          <div className="row gap6" style={{ marginTop: 10 }}>
            <Link to="/govern" className="btn sm ghost">查看完整接管登记册（智能体 / Skill / MCP）</Link>
            <Link to="/ops/integrations" className="btn sm ghost">去接入配置中心启用扩租通道</Link>
            <span className="small faint">扩租通道当前{rent.enabled ? `已启用（额度 ${rent.quota} 卡 · 已开 ${rent.used} 卡 · ${rent.price} 元/卡/日）` : `未启用（额度 ${rent.quota} 卡）`}；{rent.enabled ? '本地空闲不足时扩容工单会自动走扩租' : '启用后本地不足时扩容可走扩租补卡位'}。</span>
          </div>
        </div>
      </Panel>

      <div className="callout mt20">
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
        <div>
          监控指标通过各厂商 SDK（昇腾 CANN、寒武纪 CNMON 等）采集后统一映射到平台监控模型；可采集项取决于厂商提供的原始数据接口能力。
        </div>
      </div>
    </div>
  )
}
