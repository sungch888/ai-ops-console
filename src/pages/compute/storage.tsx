import React from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Progress, Callout } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE } from '../../components/Chart'
import { storageInfo, netPlanes } from '../../data/mock'

export default function ComputeStorage() {
  const days = Array.from({ length: 30 }, (_, i) => `10-${6 + i}`.replace('10-32', '11-01'))
  const trendOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    grid: { left: 8, right: 16, top: 34, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: false, data: days,
      axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } },
      axisLabel: { color: AXIS_COLOR, interval: 3, fontSize: 11 },
    },
    yAxis: { type: 'value', name: 'PB', min: 30, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '已用容量', type: 'line', smooth: true, symbol: 'none', data: storageInfo.trend30d, lineStyle: { width: 2.5, color: '#22d3ee' }, areaStyle: { opacity: 0.14, color: '#22d3ee' } },
    ],
  }

  const netOpt = {
    color: ['#22d3ee', '#3d8bfd', '#2fd6a3', '#a78bfa'],
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 20, top: 20, bottom: 6, containLabel: true },
    xAxis: { type: 'value', max: 100, axisLabel: { color: AXIS_COLOR, formatter: '{value}%' }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    yAxis: { type: 'category', data: netPlanes.map((p) => p.name), axisLabel: { color: AXIS_COLOR }, axisLine: { show: false }, axisTick: { show: false } },
    series: [
      { name: '带宽负载', type: 'bar', barWidth: 14, data: netPlanes.map((p) => p.traffic), itemStyle: { borderRadius: 6 }, label: { show: true, position: 'right', color: '#9ec5ff', fontSize: 11, formatter: '{c}%' } },
    ],
  }

  return (
    <div>
      <PageHead
        title="存储与网络"
        desc="AI 训推服务存储 · 四张网络平面 · 容量与性能监测"
        extra={<><Badge tone="good">存储健康</Badge><Badge tone="warn">推理缓存 70%</Badge></>}
      />

      <div className="grid g-5">
        <Kpi label="存储总容量" value={storageInfo.total} unit="PB" foot="高性能并行文件系统" />
        <Kpi label="已用容量" value={storageInfo.used} unit="PB" foot={<><span className="up">▲ 15%</span> 30 日增长</>} />
        <Kpi label="聚合带宽" value="1.8" unit="TB/s" foot="读 1.2 / 写 0.6" />
        <Kpi label="配额已发放" value={128} unit="个" foot="按租户 / 项目划分" />
        <Kpi label="今日故障" value={0} unit="次" foot="近 30 日累计 2 次" />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="存储容量趋势（近 30 日）" extra="单位 PB · 含快照与日志">
          <Chart option={trendOpt} height={280} />
        </Panel>
        <Panel title="分类容量">
          {storageInfo.items.map((it) => {
            const pct = Math.round((it.used / it.total) * 100)
            return (
              <div key={it.name} style={{ marginBottom: 12 }}>
                <div className="row between small">
                  <span>{it.name}</span>
                  <span className="muted">{it.used} / {it.total} PB</span>
                </div>
                <div style={{ marginTop: 5 }}><Progress value={pct} tone={it.tone as '' | 'warn' | 'bad' | 'green'} /></div>
              </div>
            )
          })}
          <Callout warn text="推理缓存 / KV 已达 70%，建议清理过期会话缓存或扩容 4 PB，避免训推任务写入受阻。" />
        </Panel>
      </div>

      <div className="grid g-32 mt14">
        <Panel title="算力网络平面负载" extra="业务 / 管理 / 样本 / 参数">
          <Chart option={netOpt} height={240} />
        </Panel>
        <Panel title="网络平面明细" noPad>
          <div className="panel-body">
            <Table
              head={['平面', '规格', '负载', '用途']}
              rows={netPlanes.map((p) => [
                <span className="strong">{p.name}</span>,
                <span className="tag gray">{p.spec}</span>,
                <div style={{ minWidth: 110 }}><Progress value={p.traffic} tone={p.traffic > 70 ? 'warn' : 'green'} /></div>,
                <span className="muted small">{p.desc}</span>,
              ])}
            />
            <Callout text="参数面采用 400G RoCEv2 无损网络，支撑多机多卡梯度同步；样本面保障训练数据高吞吐读取。" />
          </div>
        </Panel>
      </div>

      <div className="grid g-2 mt14">
        <Panel title="存储运营（自动化等级）" noPad>
          <div className="panel-body">
            <Table
              head={['功能', '等级', '说明']}
              rows={[
                ['性能 / 容量监控、自动负载均衡、故障定位', <Badge tone="good">自动化</Badge>, '实时采集 · 阈值告警'],
                ['文件系统创建、配额发放、策略模板调整', <Badge tone="info">半自动化</Badge>, '审批后执行'],
                ['资产盘点、报表分析分析', <Badge tone="muted">人工操作</Badge>, '月度盘点 · 季度评估'],
              ]}
            />
          </div>
        </Panel>
        <Panel title="数据迁移支持（服务期满）" noPad>
          <div className="panel-body">
            <ul className="tl">
              <li><div className="tl-time">步骤 1</div><div className="small" style={{ color: 'var(--table-text)' }}>准备迁移数据：清点数据集、模型权重、日志归档范围</div></li>
              <li><div className="tl-time">步骤 2</div><div className="small" style={{ color: 'var(--table-text)' }}>迁移方式选择：在线同步 / 离线介质 / 快照切换</div></li>
              <li><div className="tl-time">步骤 3</div><div className="small" style={{ color: 'var(--table-text)' }}>挂载存储至新算力实例并校验连通性</div></li>
              <li><div className="tl-time">步骤 4</div><div className="small" style={{ color: 'var(--table-text)' }}>完整性校验：哈希比对 + 抽样回读，输出校验报告</div></li>
            </ul>
          </div>
        </Panel>
      </div>
    </div>
  )
}
