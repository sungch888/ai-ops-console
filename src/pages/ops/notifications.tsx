import React from 'react'
import {Kpi, Panel, PageHead, Badge, AlertBadge, Table, Callout, Tip} from '../../components/ui'
import { useNotifs, notifyStore, AUTO_MERGE_BY } from '../../engine/ops'
import { liveAlertStore, useLiveAlerts, isAutoMerged } from '../../engine/liveAlerts'
import { Jump, useAlertPick, usePickFlash } from '../../engine/alertJump'
import { flagsStore, usePerm } from '../../engine/auth'
import { apiGet, apiSend } from '../../engine/db'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'

const CHANNELS = ['站内看板', '短信', '即时通讯', '值班电话', '邮件']

export default function OpsNotifications() {
  const notifs = useNotifs()
  const perm = usePerm('analytics')
  const srv = useLiveAlerts()
  const [srvMsg, setSrvMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const pick = useAlertPick()
  usePickFlash(pick)
  const mergedN = srv.filter((n: any) => isAutoMerged(n as any)).length
  const loadSrv = () => void liveAlertStore.refresh()
  React.useEffect(() => { loadSrv() }, [])
  const routes = notifyStore.routes()
  const unread = notifs.filter((n) => !n.read).length
  const urgent = notifs.filter((n) => n.level === '紧急').length
  const handled = notifs.filter((n) => n.handled).length
  const realUnhandled = srv.filter((n: any) => !n.handled).length
  const realUrgent = srv.filter((n: any) => !n.handled && n.level === '紧急').length
  const realHandled = srv.filter((n: any) => !!n.handled).length
  /* 告警直达口径：本页主键 = 通知编号（Jump.notification 同一口径）。
     点任一红 / 黄等级徽章 = 高亮它自己那一行并把它滚到中间 —— 「我处置了」/「处置闭环」按钮就在那一行 */
  const notifJump = (id: string, label: string) => Jump.notification(id, label)
  const firstUnread = notifs.find((n) => !n.read)
  const firstOpenSrv = srv.find((n: any) => !n.handled)
  const firstOpenUrgent = srv.find((n: any) => !n.handled && n.level === '紧急')

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
            {unread > 0 ? <AlertBadge tone="warn" jump={notifJump(firstUnread?.id ?? '', `还有 ${unread} 条没读：点过去落到第一条未读那一行，处置按钮就在那一行`)}>未读 {unread}</AlertBadge> : <Badge tone="good">未读 0</Badge>}
            <button className="btn sm ghost" onClick={() => notifyStore.markAllRead()}>全部标记已读</button>
            <button className="btn sm ghost" onClick={() => notifyStore.reset()}>清空通知</button>
          </>
        }
      />

      <div className="grid g-4">
        <Kpi label="真实告警待处置" value={realUnhandled} unit="条"
          foot={<span className={realUnhandled ? 'down' : 'up'}>{realUnhandled ? `${liveAlertStore.unhandledCauses()} 个原因要有人认领（同因重复只算一个）` : '全部已处置'}</span>}
          jump={firstOpenSrv ? notifJump(String(firstOpenSrv.id), `第一条没人处置的真实告警是「${firstOpenSrv.title}」：点过去落到这一行，「我处置了」按钮就在这一行（会滚到中间）`) : undefined} />
        <Kpi label="紧急待处置" value={realUrgent} unit="条" foot="监控断连与兜底升级会升紧急"
          jump={firstOpenUrgent ? notifJump(String(firstOpenUrgent.id), `第一条待处置的紧急告警是「${firstOpenUrgent.title}」：点过去落到这一行处置它`) : undefined} />
        <Kpi label="已处置" value={realHandled} unit="条"
          foot={`含系统自动闭环的取数恢复通知 · 同因重复自动并入 ${mergedN + notifs.filter((n) => n.handled_by === AUTO_MERGE_BY).length} 条`} />
      </div>

      <div className="grid g-21 mt14">
        <Panel title="真实告警通知（数据服务写进库里的）" noPad
          extra={<span className="tiny faint">监控断连 / 兜底升级 / 恢复通知都落在这里 · 未处置 {srv.filter((n) => !n.handled).length} 条<button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => void loadSrv()}>重新拉取</button></span>}>
          <div className="panel-body">
            {srv.length === 0 ? <div className="empty">库里还没有服务端告警通知 · 采不到数或兜底升级时会写进来</div> : (
              <Table minWidth={980} head={['编号', '时间（本地）', '等级', '来源', '内容', '处置状态']}
            rowKeys={srv.map((n: any) => String(n.id))} pick={pick}
            rows={srv.map((n: any) => [
                <span className="tiny mono">{n.id}</span>,
                <span className="tiny faint">{n.time}</span>,
                <span>{n.level === '紧急' ? <AlertBadge tone="bad" jump={notifJump(String(n.id), `这条紧急告警「${n.title}」：点过去高亮这一行并滚到中间，「我处置了」按钮就在这一行`)}>紧急</AlertBadge> : n.level === '重要' ? <AlertBadge tone="warn" jump={notifJump(String(n.id), `这条重要告警「${n.title}」：点过去高亮这一行并滚到中间，「我处置了」按钮就在这一行`)}>重要</AlertBadge> : <Badge tone="info">一般</Badge>}</span>,
                <span className="tiny">{n.source}</span>,
                <span className="tiny">{n.title}
                  {n.cause ? <span className="tag gray" style={{ marginLeft: 6 }}>同一原因 {n.cause}</span> : null}
                  <div className="tiny faint" style={{ maxWidth: 420 }}>{(n.body || '').slice(0, 150)}</div></span>,
                <span className="tiny">{n.handled ? <Badge tone="good">已处置 · {n.handled_by || '记录在案'}</Badge>
                  : <><AlertBadge tone="warn" jump={notifJump(String(n.id), `这条告警没人处置（${n.title}）：点过去高亮这一行并滚到中间，「我处置了」按钮就在这一行`)}>未处置</AlertBadge>{perm.manage ? <button className="btn sm ghost" style={{ marginLeft: 6 }}
                    onClick={() => {
                      const note = window.prompt('处置说明（可空）：已联系对方 / 已切流量 / 已知悉等值班处理') || ''
                      void liveAlertStore.ack(n.id, note).then((r) => {
                        setSrvMsg({
                          ok: !!r.ok,
                          text: r.ok ? String(r.note || '已处置并记录到人')
                            : '处置没成：' + String(r.error || '') + '（若是「未登录或会话已过期」，先重新登录再点一次）',
                        })
                      })
                    }}>我处置了</button> : <span className="tiny faint" style={{ marginLeft: 6 }}>要「运营分析」操作权才能处置</span>}</>}</span>,
              ])} />
            )}
            {srvMsg ? <div className="tiny" style={{ marginTop: 6, color: srvMsg.ok ? 'var(--ok-text)' : 'var(--bad-text)' }}>{srvMsg.text}</div> : null}
            <div className="tiny faint" style={{ marginTop: 6 }}>
              同一原因重复报警<span className="strong">只留最新一条要处置</span>：新的同因告警写进来时，之前没处置的自动完成处置（处置人记「{AUTO_MERGE_BY}」，审计 monitor_notify_ack / monitor_alert 里看得见并了几条）；取数恢复、兜底升级同理。处置最新一条时，同因旧告警一并闭环。关掉这个口径：配置项 <span className="mono">alert-merge-same-cause = off</span>。
            </div>
            <div className="tiny faint" style={{ marginTop: 6 }}>
              平台自己发现、自己写进库的告警，<span className="strong">没人处置就一直挂着</span>
              <Tip label="怎么追办、留什么痕" text="兜底工单挂满配置的分钟数（默认 15 分钟）没人接管，会自动升级给带班角色并再发一条紧急通知；处置会记录是谁、几点、说明，写审计 monitor_notify_ack。" />
            </div>
          </div>
        </Panel>
        <Panel title="通知列表（演示推导 · 不是真实采集）" extra="引擎事件自动生成 · 点击处置写入闭环" noPad>
          <div className="panel-body">
            {notifs.length === 0 ? <div className="empty">暂无通知 · 在工作台执行一次变更或点「演示冲击场景」即可产生</div> : (
              <Table
                minWidth={900}
                head={['编号', '时间', '等级', '来源', '内容', '送达渠道', '状态', '操作']}
                rowKeys={notifs.slice(0, 20).map((n) => n.id)} pick={pick}
                rows={notifs.slice(0, 20).map((n) => [
                  <span className="mono small">{n.id}</span>,
                  <span className="mono small">{n.time}</span>,
                  n.level === '紧急' ? <AlertBadge tone="bad" jump={notifJump(n.id, `这条紧急通知「${n.title}」：点过去高亮这一行并滚到中间，「处置闭环」按钮就在这一行`)}>紧急</AlertBadge> : n.level === '重要' ? <AlertBadge tone="warn" jump={notifJump(n.id, `这条重要通知「${n.title}」：点过去高亮这一行并滚到中间，「处置闭环」按钮就在这一行`)}>重要</AlertBadge> : <Badge tone="muted">一般</Badge>,
                  <span className="small">{n.source}</span>,
                  <span className="small" style={{ maxWidth: 320 }}><b>{n.title}</b>
                    {n.merged ? <AlertBadge tone="warn" jump={notifJump(n.id, `这条通知已自动并入 ${n.merged} 条同因旧告警：处置这一条（按钮就在这一行），旧的同因告警一并闭环`)}>已自动并入 {n.merged} 条同因旧告警</AlertBadge> : null}
                    <div className="tiny faint">{n.text}</div></span>,
                  <span className="tiny faint">{n.channels.join(' · ')}</span>,
                  n.handled ? <Badge tone="good">{n.handled_by === AUTO_MERGE_BY ? '同因已并入' : '已处置'}</Badge>
                    : n.read ? <Badge tone="info">已读</Badge> : <AlertBadge tone="warn" jump={notifJump(n.id, `这条通知还没读也没处置（${n.title}）：点过去高亮这一行并滚到中间，「已读」/「处置闭环」按钮就在这一行`)}>未读</AlertBadge>,
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
              <Callout text={'配置项 notify-channels 当前是「' + (flagsStore.get().config['notify-channels'] || 'site') + '」：一期只保证站内看板 + 邮件（邮件走发送器插件，通道发不出去自动回落站内并留记录）；短信 / 即时通讯 / 值班电话等客户方要给通道与凭证后才打开，打开前这些开关点了也不会有真实送达。'} />
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
