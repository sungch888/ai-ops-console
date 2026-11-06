import React, { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { useEngine } from '../../engine/engine'
import { ledgerOf, getAllocMode, setAllocMode, type AllocMode } from '../../engine/ledger'
import { useReports, reportStore, downloadCsv } from '../../engine/ops'
import { usePerm } from '../../engine/auth'

export default function OpsAnalytics() {
  const st = useEngine()
  const reports = useReports()
  const perm = usePerm('export')
  const L = ledgerOf(st)
  const [mode, setMode] = useState<AllocMode>(getAllocMode())
  const [citySel, setCitySel] = useState(L.perCity[0]?.name ?? '示范市01')
  const days = L.trend30.map((d) => d.day)
  const tokenOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    grid: GRID,
    xAxis: { type: 'category', boundaryGap: false, data: days, axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, interval: 3, fontSize: 11 } },
    yAxis: { type: 'value', name: '万 Token / 日', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [{ name: 'Token 消耗', type: 'line', smooth: true, symbol: 'none', data: L.trend30.map((d) => d.tokens), lineStyle: { width: 2.6, color: '#22d3ee' }, areaStyle: { opacity: 0.16, color: '#22d3ee' } }],
  }

  const costOpt = {
    color: ['#22d3ee', '#3d8bfd', '#2fd6a3', '#f5b83d', '#a78bfa', '#ff6b6b'],
    tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: '{b}: {c}%' },
    legend: { bottom: 0, textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, itemWidth: 10, itemHeight: 10 },
    series: [
      {
        type: 'pie',
        radius: ['46%', '70%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: '#0a1424', borderWidth: 2 },
        label: { color: '#9ec5ff', fontSize: 11.5, formatter: '{b}\n{c}%' },
        data: L.perLine.map((c) => ({ name: c.name, value: Math.round((c.cost / Math.max(1, L.costToday)) * 100) })),
      },
    ],
  }

  const cityOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 22, top: 14, bottom: 6, containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR, formatter: '{value}万' }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    yAxis: { type: 'category', inverse: true, data: L.perCity.map((c) => c.name), axisLabel: { color: AXIS_COLOR, fontSize: 11.5 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ name: '日调用量', type: 'bar', barWidth: 10, data: L.perCity.map((c) => Math.round(c.calls / 1000) / 10), itemStyle: { borderRadius: 5, color: '#2fd6a3' }, label: { show: true, position: 'right', color: '#8fe6c8', fontSize: 11 } }],
  }

  const appOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 22, top: 14, bottom: 6, containLabel: true },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR, formatter: (v: number) => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    yAxis: { type: 'category', inverse: true, data: L.perApp.slice(0, 8).map((a) => a.name), axisLabel: { color: AXIS_COLOR, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ name: '今日调用', type: 'bar', barWidth: 10, data: L.perApp.slice(0, 8).map((a) => a.calls), itemStyle: { borderRadius: 5, color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#1899e0' }, { offset: 1, color: '#22d3ee' }] } }, label: { show: true, position: 'right', color: '#9ec5ff', fontSize: 10.5, formatter: (p: { value: number }) => (p.value / 10000).toFixed(1) + '万' } }],
  }

  return (
    <div>
      <PageHead
        title="运营分析报表"
        desc="统一看板 · 告警闭环 · 成本分摊 · 周报月报与容量评估"
        extra={<><Badge tone="info">报表 5 份在制</Badge><Badge tone="good">SLA 99.93%</Badge></>}
      />

      <div className="grid g-5">
        <Kpi label="本月调用量" value={((L.callsToday * 30) / 10000).toFixed(0)} unit="万次" foot={<span className="small faint">由 {L.liveCards} 卡承载 · 副本变更实时影响</span>} />
        <Kpi label="本月 Token" value={((L.tokensToday * 30) / 10000).toFixed(1)} unit="亿" foot={<span className="small faint">外部渠道占 {(L.externalShare * 100).toFixed(0)}%</span>} />
        <Kpi label="本月折算成本" value={((L.costToday * 30) / 10000).toFixed(1)} unit="万元" foot={`本地卡位 ${(L.localCost * 30 / 10000).toFixed(1)} 万 + 外部 Token ${(L.externalCost * 30 / 10000).toFixed(1)} 万`} />
        <Kpi label="活跃应用" value={12 - L.stopped.length} unit="个" foot={L.stopped.length ? <span className="down">● {L.stopped.length} 个已停止承接</span> : '另有 2 个灰度试点'} />
        <Kpi label="告警闭环率" value="96" unit="%" foot="未闭环 4 项在跟进" />
      </div>

      <Callout text={<>账本口径（与调配工作台、总览、网关同源）：<b>调用量 = 存活副本承载（每卡 22 RPM）× 应用承接系数</b>（限流 0.4、暂停 / 隔离 / 下线 0）；<b>Token = 调用量 × 平均 820 token/次</b>；<b>成本 = 已分配推理卡位 {L.allocCards} 卡 × 210 元/卡/日 + 外部渠道 Token × 0.9 元/万 token</b>。当前承载 {L.liveCards} 卡 / 已分配 {L.allocCards} 卡：扩容只增加可分配卡位（计入成本），副本增加才提升调用量。副本扩缩、渠道权重调整、应用限流与暂停、模型下线都会即时改变本页数字，因此总览、网关、报表三处看到的是同一套数字。</>} />

      <Panel title="Token 消耗趋势（近 30 日）" extra="全平台 · 按日汇总" className="mt14">
        <Chart option={tokenOpt} height={260} />
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="条线算力成本占比" extra="按租户 / 业务线归集">
          <Chart option={costOpt} height={280} />
        </Panel>
        <Panel title="各地市调用量 Top 9" extra="组织层级标签贯通">
          <Chart option={cityOpt} height={280} />
        </Panel>
      </div>

      <div className="grid g-21 mt14">
        <Panel title="应用调用量排行" extra="今日 · 万次">
          <Chart option={appOpt} height={280} />
        </Panel>
        <Panel title="报表台账" extra={perm.manage ? '可生成 · 可导出 CSV' : '当前角色不可生成与导出'} noPad>
          <div className="panel-body">
            <div className="row wrap gap6">
              {[['日值班日志', '日报'], ['模型服务运行周报', '周报'], ['运营月报（含成本分摊）', '月报'], ['容量评估报告', '季度']].map(([n, t]) => (
                <button key={n} className="btn sm primary" disabled={!perm.manage} onClick={() => reportStore.generate(`${n}（${new Date().toLocaleDateString('zh-CN')}）`, t, st)}>生成{n}</button>
              ))}
            </div>
            <div className="divider" />
            <Table
              minWidth={760}
              head={['报表', '类型', '编制时间', '行数', '状态', '操作']}
              rows={reports.map((r) => [
                <span className="strong small">{r.name}<div className="tiny faint">{r.note}</div></span>,
                <span className="tag gray">{r.type}</span>,
                <span className="mono small">{r.time}</span>,
                <span className="num small">{r.rows}</span>,
                r.state === '已报送' ? <Badge tone="good">已报送</Badge> : r.state === '已生成' ? <Badge tone="info">已生成</Badge> : <Badge tone="warn">编制中</Badge>,
                <div className="row gap6">
                  <button
                    className="btn sm"
                    disabled={!perm.manage || r.state === '编制中'}
                    onClick={() => downloadCsv(`${r.name}`, ['指标', '数值', '口径'], [
                      ['模型调用总量（近 30 日）', L.trend30.reduce((s, x) => s + x.tokens, 0), '实时账本 · 万 Token'],
                      ['今日调用量', L.callsToday, '实时账本 · 次'],
                      ['今日折算成本（元）', L.costToday, `本地 ${L.localCost} + 外部 ${L.externalCost}`],
                      ['活跃凭证数', st.creds.filter((c) => c.status !== 'off').length, '凭证台账'],
                      ['在途调配工单数', st.orders.filter((o) => o.status === 'submitted' || o.status === 'running').length, '工单台账'],
                      ['资源池卡位分配', st.pools.map((p) => `${p.name}=${p.cards}`).join(' | '), '资源账本'],
                      ['模型副本总数', st.models.reduce((s, m) => s + m.replicas, 0), '模型资产'],
                      ['渠道权重', st.channels.map((c) => `${c.name}=${c.weight}%`).join(' | '), '推理网关'],
                      ['处置中应用 / 已停止应用', `${L.throttled.length} / ${L.stopped.length}`, '处置动作台账'],
                      ['Token 峰值（万）', Math.max(...L.trend30.map((x) => x.tokens)), '实时账本'],
                    ])}
                  >导出 CSV</button>
                  {r.state === '已生成' && perm.manage ? <button className="btn sm ghost" onClick={() => reportStore.markSent(r.id)}>报送</button> : null}
                </div>,
              ])}
            />
            <div className="divider" />
            <div className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>
              例行交付：日值班日志与事件台账 · 周运行周报 · 月运营报表（含成本分摊）· 季度容量评估报告。生成的报表取<b>当前引擎实时快照</b>，导出为 UTF-8 BOM 编码 CSV，Excel 可直接打开。
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="用量与成本账本明细（实时推导）" extra={perm.manage ? '可导出 CSV · 与总览 / 网关同源' : '只读（无导出权限）'} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={880}
            head={['模型', '承载卡位', '今日调用', '今日 Token（万）', '折算成本', '备注']}
            rows={L.perModel.map((m) => [
              <span className="strong mono small">{m.name}</span>,
              <span className="num small">{m.cards ? `${m.cards} 卡` : '—'}</span>,
              <span className="num">{(m.calls / 10000).toFixed(1)} 万</span>,
              <span className="num">{m.tokens.toLocaleString('zh-CN')}</span>,
              <span className="num small">¥{m.cost.toLocaleString('zh-CN')}</span>,
              <span className="tiny faint">{m.note}</span>,
            ])}
          />
          <div className="divider" />
          <Table
            minWidth={880}
            head={['业务应用', '条线', '今日调用', '今日 Token（万）', '折算成本', '运行态']}
            rows={L.perApp.map((a) => [
              <span className="strong small">{a.name}</span>,
              <span className="tag gray">{a.dept}</span>,
              <span className="num">{(a.calls / 10000).toFixed(1)} 万</span>,
              <span className="num small">{a.tokens.toLocaleString('zh-CN')}</span>,
              <span className="num small">¥{a.cost.toLocaleString('zh-CN')}</span>,
              a.note ? <Badge tone={a.note.includes('限流') ? 'warn' : 'bad'}>{a.note}</Badge> : <span className="tiny faint">正常承接</span>,
            ])}
          />
          <div className="row gap6" style={{ marginTop: 12 }}>
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv('用量与成本账本', ['对象', '类型', '今日调用', '今日Token(万)', '折算成本(元)', '运行态'], [
                ...L.perModel.map((m) => [m.name, '模型', m.calls, m.tokens, m.cost, m.note ?? '']),
                ...L.perApp.map((a) => [a.name, '应用', a.calls, a.tokens, a.cost, a.note ?? '正常承接']),
                ...L.perCity.map((c) => [c.name, '地市', c.calls, c.tokens, c.cost, '']),
                ['合计', '平台', L.callsToday, L.tokensToday, L.costToday, `本地卡位 ${L.localCost} · 外部 Token ${L.externalCost}`],
              ])}
            >导出用量与成本账本（模型 + 应用 + 地市）</button>
            <span className="small faint">当前账本：{L.liveCards} 卡在承载 · 副本系数 {L.capacityFactor} · 限流 {L.throttled.length} 项 · 停止 {L.stopped.length} 项</span>
          </div>
        </div>
      </Panel>

      <Panel title="项目组维度成本与用量" extra={`分摊口径：${L.allocMode === 'budget' ? '按预算科目权重' : '按用量占比'} · 两种口径都可算，规则需客户方确认`} className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap6" style={{ marginBottom: 12 }}>
            <span className="small faint">分摊口径</span>
            <button className={`btn sm ${L.allocMode === 'usage' ? 'primary' : ''}`} onClick={() => { setAllocMode('usage'); setMode('usage') }}>按用量占比</button>
            <button className={`btn sm ${L.allocMode === 'budget' ? 'primary' : ''}`} onClick={() => { setAllocMode('budget'); setMode('budget') }}>按预算科目权重</button>
            <span className="small faint" style={{ marginLeft: 'auto' }}>切换后本页与导出 CSV 同步变化（当前：{mode === 'budget' ? '预算科目' : '用量占比'}）</span>
          </div>
          <Table
            minWidth={980}
            head={['项目组', '归口条线', '纳入应用', '分摊卡位', '今日调用', '今日 Token（万）', '今日折算成本', '本月预估', '分摊依据']}
            rows={L.perProject.map((pr) => [
              <span className="strong small">{pr.name}</span>,
              <span className="tag gray">{pr.line}</span>,
              <span className="num small">{pr.apps} 个</span>,
              <span className="num small">{pr.cards} 卡</span>,
              <span className="num">{(pr.calls / 10000).toFixed(1)} 万</span>,
              <span className="num">{pr.tokens.toLocaleString('zh-CN')}</span>,
              <span className="num small">¥{pr.cost.toLocaleString('zh-CN')}</span>,
              <span className="num small">¥{(pr.cost * 30).toLocaleString('zh-CN')}</span>,
              <span className="tiny faint" style={{ maxWidth: 230 }}>{pr.note}</span>,
            ])}
          />
          <div className="divider" />
          <Table
            minWidth={900}
            head={['使用方（凭证归口）', '凭证数', '配额合计', '用量占比', '今日调用', '今日 Token（万）', '今日折算成本', '积分 / 风险提示']}
            rows={L.perPerson.map((pe) => [
              <span className="strong small">{pe.name}</span>,
              <span className="num small">{pe.creds} 个</span>,
              <span className="num small">{pe.rpm} RPM</span>,
              <span className="num small">{pe.share}%</span>,
              <span className="num">{pe.calls.toLocaleString('zh-CN')}</span>,
              <span className="num">{pe.tokens.toLocaleString('zh-CN')}</span>,
              <span className="num small">¥{pe.cost.toLocaleString('zh-CN')}</span>,
              <span className="tiny faint">{pe.points.toLocaleString('zh-CN')} 分{pe.expSoon ? ` · 临期 ${pe.expSoon}` : ''}{pe.revoked ? ` · 已吊销 ${pe.revoked}` : ''}</span>,
            ])}
          />
          <div className="row gap6" style={{ marginTop: 12 }}>
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv(`项目组与使用方分摊表（${L.allocMode === 'budget' ? '按预算科目' : '按用量占比'}）`, ['对象', '类型', '归口', '纳入应用/凭证', '配额或卡位', '今日调用', '今日Token(万)', '今日成本(元)', '本月预估(元)', '分摊依据'], [
                ...L.perProject.map((pr) => [pr.name, '项目组', pr.line, pr.apps, pr.cards, pr.calls, pr.tokens, pr.cost, pr.cost * 30, pr.note ?? '']),
                ...L.perPerson.map((pe) => [pe.name, '使用方', pe.rpm >= 100 ? '平台代理' : '个人密钥', pe.creds, pe.rpm, pe.calls, pe.tokens, pe.cost, pe.cost * 30]),
              ])}
            >导出项目组与使用方分摊表（当前口径）</button>
            <span className="small faint">分摊口径可现场切换：按用量占比（谁用得多谁多担）或按预算科目权重（按年度预算预置权重）。页面与导出 CSV 同步生效，真实规则需客户方确认（详见盘点文档待商定项）。</span>
          </div>
        </div>
      </Panel>

      <Panel title="地市 / 区县逐级下钻" extra="同一账本逐级归集 · 市局 → 下级单位 / 分区 · 可逐级导出" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap6" style={{ marginBottom: 12 }}>
            <span className="small faint">选择地市</span>
            {L.perCity.map((c) => (
              <button key={c.name} className={`btn sm ${c.name === citySel ? 'primary' : ''}`} onClick={() => setCitySel(c.name)}>{c.name}</button>
            ))}
          </div>
          {(() => {
            const city = L.perCity.find((c) => c.name === citySel) ?? L.perCity[0]
            const rows = L.perDistrict.filter((d) => d.city === city.name)
            return (
              <>
                <div className="row wrap gap12" style={{ marginBottom: 10 }}>
                  <span className="small strong">{city.name} 合计</span>
                  <span className="small faint">调用 <b className="num">{city.calls.toLocaleString('zh-CN')}</b> 次 · Token <b className="num">{city.tokens.toLocaleString('zh-CN')}</b> 万 · 折算成本 <b className="num">¥{city.cost.toLocaleString('zh-CN')}</b> · 占全平台 {Math.round((city.calls / Math.max(1, L.callsToday)) * 100)}%</span>
                </div>
                <Table
                  minWidth={820}
                  head={['下级单位 / 分区', '今日调用', '今日 Token（万）', '今日折算成本', '占本市比例', '本月预估调用']}
                  rows={rows.map((d) => [
                    <span className="strong small">{d.name}</span>,
                    <span className="num">{d.calls.toLocaleString('zh-CN')}</span>,
                    <span className="num">{d.tokens.toLocaleString('zh-CN')}</span>,
                    <span className="num small">¥{d.cost.toLocaleString('zh-CN')}</span>,
                    <span className="num small">{Math.round((d.calls / Math.max(1, city.calls)) * 100)}%</span>,
                    <span className="num small">{((d.calls * 30) / 10000).toFixed(1)} 万</span>,
                  ])}
                />
                <div className="row gap6" style={{ marginTop: 12 }}>
                  <button
                    className="btn sm" disabled={!perm.manage}
                    onClick={() => downloadCsv(`逐级用量报表_${city.name}`, ['层级', '地市', '下级单位/分区', '今日调用', '今日Token(万)', '今日成本(元)'], [
                      ['全市', city.name, '合计', city.calls, city.tokens, city.cost],
                      ...rows.map((d) => ['区县', city.name, d.name, d.calls, d.tokens, d.cost]),
                    ])}
                  >导出本市逐级报表（市 + 区县）</button>
                  <button
                    className="btn sm ghost" disabled={!perm.manage}
                    onClick={() => downloadCsv('逐级用量报表_全部地市', ['层级', '地市', '下级单位/分区', '今日调用', '今日Token(万)', '今日成本(元)'], L.perCity.flatMap((c) => [['全市', c.name, '合计', c.calls, c.tokens, c.cost] as (string | number)[], ...L.perDistrict.filter((d) => d.city === c.name).map((d) => ['区县', c.name, d.name, d.calls, d.tokens, d.cost] as (string | number)[])]))}
                  >导出全部地市逐级报表</button>
                  <span className="small faint">区县权重为演示预设比例；真实层级与归集规则（按属地还是按业务单位）需客户方确认。</span>
                </div>
              </>
            )
          })()}
        </div>
      </Panel>

      <Panel title="数据导出（台账 CSV）" extra={perm.manage ? '✔ 真实下载文件' : '只读（无导出权限）'} className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap6">
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv('调配工单台账', ['工单号', '类型', '对象', '数量', '申请人', '状态', '触发条件', '结论'], st.orders.map((o) => [o.id, o.type, o.target, o.amount, o.applicant, o.status, o.reason, o.rejectReason ?? o.decidedBy ?? '']))}
            >导出工单台账（{st.orders.length} 条）</button>
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv('凭证台账', ['凭证ID', '类型', '持有方', '授权应用', '授权模型', 'RPM', 'TPM', 'IP白名单', '剩余有效期', '状态'], st.creds.map((c) => [c.id, c.kind, c.holder, c.app, c.model, c.rpm, c.tpm, c.ip, c.expDays, c.status]))}
            >导出凭证台账（{st.creds.length} 条）</button>
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv('资源账本', ['对象', '卡位/副本', '利用率或权重', '备注'], [
                ...st.pools.map((p) => [p.name, p.cards, '', p.policy]),
                ...st.models.map((m) => [`模型 ${m.name}`, `${m.replicas} 副本 × ${m.perReplica} 卡`, '', m.pool]),
                ...st.channels.map((c) => [`渠道 ${c.name}`, `${c.allocatedRpm}/${c.capacityRpm} RPM`, `${c.weight}%`, `健康度 ${c.health} · p95 ${c.latency}ms`]),
              ])}
            >导出资源账本</button>
            <button
              className="btn sm" disabled={!perm.manage}
              onClick={() => downloadCsv('运行事件流', ['时间', '等级', '事件'], st.events.map((e) => [e.time, e.level, e.text]))}
            >导出运行事件流（{st.events.length} 条）</button>
          </div>
          <Callout text="导出为演示版真实生成的 CSV 文件（含 BOM，Excel 直接可开）。生产环境将按客户方报表模板输出，报表模板库与报送方式待商定。" />
        </div>
      </Panel>

      <Callout text="成本分摊数据按租户 / 业务线 / 项目组统计 Token 消耗与资源占用，支持 CSV、Excel 导出，作为租赁费用结算与扩缩容谈判依据。" />
    </div>
  )
}
