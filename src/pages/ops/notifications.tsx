import React from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout } from '../../components/ui'
import { useNotifs, notifyStore } from '../../engine/ops'
import { usePerm } from '../../engine/auth'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'

const CHANNELS = ['站内看板', '短信', '即时通讯', '值班电话', '邮件']

export default function OpsNotifications() {
  const notifs = useNotifs()
  const perm = usePerm('analytics')
  const routes = notifyStore.routes()
  const unread = notifs.filter((n) => !n.read).length
  const urgent = notifs.filter((n) => n.level === '紧急').length
  const handled = notifs.filter((n) => n.handled).length

  const bySource = ['模型中心 / 算力中心', '外部对接', '运营分析']
  const srcOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['一般', '重要', '紧急'], top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    grid: GRID,
    xAxis: { type: 'category', data: bySource, axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 11 } },
    yAxis: { type: 'value', name: '条', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: (['一般', '重要', '紧急'] as const).map((lv, i) => ({
      name: lv, type: 'bar' as const, stack: 'n', barWidth: 26,
      itemStyle: { color: CHART_COLORS[i], borderRadius: i === 2 ? [5, 5, 0, 0] : 0 },
      data: bySource.map((s) => notifs.filter((n) => n.source === s && n.level === lv).length),
    })),
  }

  return (
    <div>
      <PageHead
        title="通知中心"
        desc="告警与事件按等级路由到渠道，支持已读确认与处置闭环"
        extra={
          <>
            <Badge tone={unread > 0 ? 'warn' : 'good'}>未读 {unread}</Badge>
            <button className="btn sm ghost" onClick={() => notifyStore.markAllRead()}>全部标记已读</button>
            <button className="btn sm ghost" onClick={() => notifyStore.reset()}>清空通知</button>
          </>
        }
      />

      <div className="grid g-4">
        <Kpi label="未读通知" value={unread} unit="条" foot="顶栏铃铛同步计数" />
        <Kpi label="通知总数" value={notifs.length} unit="条" foot="保留最近 60 条" />
        <Kpi label="紧急通知" value={urgent} unit="条" foot="路由含短信与值班电话" />
        <Kpi label="已处置" value={handled} unit="条" foot={<span className="up">闭环确认</span>} />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="通知列表" extra="引擎事件自动生成 · 点击处置写入闭环" noPad>
          <div className="panel-body">
            {notifs.length === 0 ? <div className="empty">暂无通知 · 在工作台执行一次变更或点「演示冲击场景」即可产生</div> : (
              <Table
                minWidth={900}
                head={['编号', '时间', '等级', '来源', '内容', '送达渠道', '状态', '操作']}
                rows={notifs.slice(0, 20).map((n) => [
                  <span className="mono small">{n.id}</span>,
                  <span className="mono small">{n.time}</span>,
                  n.level === '紧急' ? <Badge tone="bad">紧急</Badge> : n.level === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>,
                  <span className="small">{n.source}</span>,
                  <span className="small" style={{ maxWidth: 320 }}><b>{n.title}</b><div className="tiny faint">{n.text}</div></span>,
                  <span className="tiny faint">{n.channels.join(' · ')}</span>,
                  n.handled ? <Badge tone="good">已处置</Badge> : n.read ? <Badge tone="info">已读</Badge> : <Badge tone="warn">未读</Badge>,
                  <div className="row gap6">
                    {!n.read ? <button className="btn sm ghost" onClick={() => notifyStore.markRead(n.id)}>已读</button> : null}
                    {!n.handled && perm.manage ? <button className="btn sm primary" onClick={() => notifyStore.markHandled(n.id)}>处置闭环</button> : null}
                  </div>,
                ])}
              />
            )}
          </div>
        </Panel>

        <div>
          <Panel title="通知来源分布">
            <Chart option={srcOpt} height={210} />
          </Panel>
          <Panel title="渠道路由规则" extra={perm.manage ? '可调整 · 立即对新通知生效' : '只读（当前角色不可修改）'} className="mt14" noPad>
            <div className="panel-body">
              <Table
                head={['等级', '送达渠道（点击切换）']}
                rows={(['紧急', '重要', '一般'] as const).map((lv) => [
                  lv === '紧急' ? <Badge tone="bad">紧急</Badge> : lv === '重要' ? <Badge tone="warn">重要</Badge> : <Badge tone="muted">一般</Badge>,
                  <div className="row wrap gap6">
                    {CHANNELS.map((ch) => {
                      const on = routes[lv].includes(ch)
                      return (
                        <span
                          key={ch}
                          className={`tag ${on ? 'green' : 'gray'}`}
                          style={{ cursor: perm.manage ? 'pointer' : 'default', opacity: on ? 1 : 0.5 }}
                          onClick={() => perm.manage && notifyStore.toggleChannel(lv, ch)}
                        >
                          {ch}
                        </span>
                      )
                    })}
                  </div>,
                ])}
              />
              <Callout text="演示版渠道为站内模拟（真实短信 / 即时通讯 / 电话待接入客户方侧通知平台）。紧急事件默认同时路由至看板、短信、即时通讯与值班电话，且要求 15 分钟内响应。" />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
