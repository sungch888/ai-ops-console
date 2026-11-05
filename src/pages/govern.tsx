/* =====================================================================
 * 统一接管范围（算力平台 / 算力资源 / 智能体 / Skill / MCP）
 * 接管深度不是声明出来的：由「接入配置就绪程度」实时推导，改配置立刻变绿或变黄
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout, Tabs, Progress } from '../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../components/Chart'
import { Link } from 'react-router-dom'
import { useGovernViews, useGovern, governStore, governSummary, governViews, DOMAINS, DEPTH_LABEL, DEPTH_WHY, type Domain } from '../engine/govern'
import { useConnectors, connectorStore } from '../engine/ops'
import { TOTAL_CARDS, useEngine } from '../engine/engine'
import { usePerm } from '../engine/auth'

const TABS: (Domain | '全部')[] = ['全部', ...DOMAINS]

export default function GovernScope() {
  const views = useGovernViews()
  const rows = useGovern()
  const connectors = useConnectors()
  const [gName, setGName] = useState('')
  const [gDomain, setGDomain] = useState<Domain>('算力资源')
  const [gSource, setGSource] = useState<'自建' | '已建子系统' | '外部厂商' | '边缘 / 终端' | '第三方资源'>('第三方资源')
  const [gVendor, setGVendor] = useState('')
  const [gScale, setGScale] = useState('')
  const [gCards, setGCards] = useState('8')
  const [gConn, setGConn] = useState('')
  const [gCls, setGCls] = useState<'公开' | '内部' | '敏感'>('内部')
  const [gOwner, setGOwner] = useState('客户方侧')
  const [gNote, setGNote] = useState('')
  const [bindId, setBindId] = useState('')
  const [bindConn, setBindConn] = useState('')
  const [gmsg, setGMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const depthLabelFor = (id: string) => governViews().find((x) => x.id === id)?.depth ?? 1
  const whyFor = (id: string) => governViews().find((x) => x.id === id)?.why ?? ''
  const st = useEngine()
  const sum = governSummary()
  const perm = usePerm('overview')
  const [tab, setTab] = useState<(typeof TABS)[number]>('全部')
  const list = tab === '全部' ? views : views.filter((v) => v.domain === tab)

  const schedulableTotal = TOTAL_CARDS + sum.externalCards
  const localAlloc = st.pools.reduce((s, p) => s + p.cards, 0)

  const covOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
    grid: GRID,
    legend: { data: ['可处置（L3+）', '可调度（L4）', '仅登记（L1）'], textStyle: { color: AXIS_COLOR, fontSize: 11.5 }, top: 4 },
    xAxis: { type: 'category', data: sum.byDomain.map((d) => d.domain), axisLabel: { color: AXIS_COLOR, fontSize: 11.5 } },
    yAxis: { type: 'value', name: '对象数', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '可处置（L3+）', type: 'bar', stack: 'a', barWidth: 34, data: sum.byDomain.map((d) => d.l3) },
      { name: '可调度（L4）', type: 'bar', stack: 'a', data: sum.byDomain.map((d) => d.l4) },
      { name: '仅登记（L1）', type: 'bar', stack: 'a', data: sum.byDomain.map((d) => d.total - d.l3) },
    ],
  }

  return (
    <div>
      <PageHead
        title="统一接管范围"
        desc="算力平台 · 算力资源 · 智能体 · Skill · MCP —— 接管深度与覆盖率由接入配置实时推导"
        extra={
          <>
            <Badge tone="good">可处置 {sum.manageable} / {sum.total}</Badge>
            <Badge tone="info">可调度 {sum.schedulable} / {sum.total}</Badge>
            <Badge tone="warn">{sum.registeredOnly} 项目前只能登记</Badge>
            <button className="btn sm ghost" onClick={() => governStore.reset()}>恢复默认登记册</button>
          </>
        }
      />

      {gmsg ? (
        <div className={`callout ${gmsg.tone === 'bad' ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div>{gmsg.text}</div>
        </div>
      ) : null}

      <div className="grid g-6">
        <Kpi label="登记在册对象" value={sum.total} unit="项" foot={`算力平台 6 · 算力资源 4 · 智能体 6 · Skill 4 · MCP 5`} />
        <Kpi label="可处置对象" value={sum.manageable} unit="项" foot={<><span className="up">✔ 可下发暂停 / 限流 / 隔离 / 禁用</span> · 覆盖率 {sum.manageRate}%</>} />
        <Kpi label="可调度对象" value={sum.schedulable} unit="项" foot={`纳入卡位 / 副本 / 权重 / 变更窗口 · ${sum.scheduleRate}%`} />
        <Kpi label="演示内可操作" value={sum.demoActionableCount} unit="项" foot={`真实接管可处置 ${sum.manageable} 项 · 差额就是接口未定造成的落差`} />
        <Kpi label="可调度总量" value={schedulableTotal} unit="卡" foot={`本地 ${TOTAL_CARDS} 卡（已分配 ${localAlloc}）+ 已纳管外部 ${sum.externalCards} 卡`} />
        <Kpi label="可见算力规模" value={sum.visibleCards} unit="卡" foot="含外部与边缘，可出报表但未必可调度" />
      </div>

      <Panel title="接管深度阶梯（每一级要达到什么条件）" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={980}
            head={['深度', '平台能做什么', '达到条件', '当前对象数']}
            rows={[
              [<Badge tone="muted">L1 可见</Badge>, <span className="small">{DEPTH_WHY[1]}</span>, <span className="small">登记在册即可（无需接口）</span>, <span className="num">{views.filter((v) => v.depth === 1).length}</span>],
              [<Badge tone="warn">L2 可度量</Badge>, <span className="small">{DEPTH_WHY[2]}</span>, <span className="small">接入通道启用且健康（协议 / 字段可待定）</span>, <span className="num">{views.filter((v) => v.depth === 2).length}</span>],
              [<Badge tone="info">L3 可处置</Badge>, <span className="small">{DEPTH_WHY[3]}</span>, <span className="small">接口状态已定为「已定」，可下发处置动作</span>, <span className="num">{views.filter((v) => v.depth === 3).length}</span>],
              [<Badge tone="good">L4 可调度</Badge>, <span className="small">{DEPTH_WHY[4]}</span>, <span className="small">接口已定 + 执行回执类前置条件完成</span>, <span className="num">{views.filter((v) => v.depth === 4).length}</span>],
            ]}
          />
          <Callout text={<>「接管所有」在这套平台里是<b>四件事</b>：登记在册、能采到指标、能下处置、能进调度。目前 {sum.schedulable} 项已进调度，{sum.manageable} 项可处置，剩下 {sum.registeredOnly} 项卡在接入配置上——<Link to="/ops/integrations">在外部接入配置中心启用通道 / 确认为已定 / 勾选执行回执</Link>，本页的接管深度和覆盖率会立刻跟着变，不需要改平台代码。</>} />
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="接管登记册" extra={`当前视图 ${list.length} 项 · 深度实时推导`} noPad>
          <div className="panel-body">
            <div className="row between wrap" style={{ gap: 10, marginBottom: 12 }}>
              <Tabs items={TABS as string[]} active={tab} onChange={(t) => setTab(t as (typeof TABS)[number])} />
              <span className="small faint">来源：自建 / 已建子系统 / 外部厂商 / 边缘终端 / 第三方资源</span>
            </div>
            <Table
              minWidth={1180}
              head={['接管对象', '类别', '来源 / 厂商', '规模与运行态', '接入配置', '真实接管深度', '目标深度', '演示内可操作', '卡点 / 说明']}
              rows={list.map((v) => [
                <span className="strong small">{v.name}<div className="tiny faint" style={{ maxWidth: 240 }}>{v.note}</div></span>,
                <span className={`tag ${v.domain === '智能体' ? 'purple' : v.domain === 'MCP' ? '' : 'gray'}`}>{v.domain}</span>,
                <span className="small">{v.source}<div className="tiny faint">{v.vendor}</div></span>,
                <span className="small">{v.scale}{v.cards ? <div className="tiny faint">{v.cards} 卡</div> : null}</span>,
                <span className="small">{v.connectorName}<div className="tiny faint">{v.mode}</div></span>,
                <Badge tone={v.depth === 4 ? 'good' : v.depth === 3 ? 'info' : v.depth === 2 ? 'warn' : 'muted'}>{DEPTH_LABEL[v.depth]}</Badge>,
                perm.manage ? (
                  <select className="btn sm" value={v.wantDepth} onChange={(e) => governStore.setWantDepth(v.id, Number(e.target.value) as 1 | 2 | 3 | 4)}>
                    {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{DEPTH_LABEL[d]}</option>)}
                  </select>
                ) : <Badge tone="muted">{DEPTH_LABEL[v.wantDepth]}</Badge>,
                v.demo ? <Badge tone="good">可演示处置</Badge> : <Badge tone="muted">仅登记 / 展示</Badge>,
                <span className="tiny" style={{ maxWidth: 300 }}>{v.why}<div className="tiny faint" style={{ marginTop: 3 }}>{v.demoWhy}</div></span>,
              ])}
            />
            {list.some((v) => v.wantDepth > v.depth) ? (
              <div className="row gap6" style={{ marginTop: 12 }}>
                <Link to="/ops/integrations" className="btn sm primary">去外部接入配置中心补齐前置条件</Link>
                <span className="small faint">共 {list.filter((v) => v.wantDepth > v.depth).length} 项的目标深度尚未达到，缺的都是接入侧条件（接口状态 / 地址 / 执行回执），不是平台功能。</span>
              </div>
            ) : null}
          </div>
        </Panel>

        <div>
          <Panel title="各类别接管覆盖率">
            <Chart option={covOpt} height={250} />
          </Panel>
          <Panel title="覆盖率明细" className="mt14" noPad>
            <div className="panel-body">
              <Table
                minWidth={620}
                head={['类别', '登记数', '可处置', '可调度', '可处置覆盖率']}
                rows={sum.byDomain.map((d) => [
                  <span className="small strong">{d.domain}</span>,
                  <span className="num">{d.total}</span>,
                  <span className="num">{d.l3}</span>,
                  <span className="num">{d.l4}</span>,
                  <div style={{ minWidth: 130 }}><span className="num small">{d.rate}%</span><Progress value={d.rate} tone={d.rate >= 80 ? 'green' : d.rate >= 50 ? 'warn' : 'bad'} /></div>,
                ])}
              />
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid g-2 mt14">
        <Panel title="新增接管对象登记（新增资源入册）" extra="登记即 L1；绑定接入配置后深度自动重算" noPad>
          <div className="panel-body">
            <div className="col gap6">
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">对象名称</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 250 }} value={gName} onChange={(e) => setGName(e.target.value)} placeholder="如：第三方 GPU 扩租池 B / 下级单位边缘推理盒子" />
                </div>
                <div>
                  <div className="tiny faint">类别</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={gDomain} onChange={(e) => setGDomain(e.target.value as Domain)}>
                    {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">来源</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={gSource} onChange={(e) => setGSource(e.target.value as typeof gSource)}>
                    {(['自建', '已建子系统', '外部厂商', '边缘 / 终端', '第三方资源'] as const).map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">密级</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={gCls} onChange={(e) => setGCls(e.target.value as '公开' | '内部' | '敏感')}>
                    <option value="公开">公开</option><option value="内部">内部</option><option value="敏感">敏感</option>
                  </select>
                </div>
              </div>
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">厂商 / 提供方</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 160 }} value={gVendor} onChange={(e) => setGVendor(e.target.value)} placeholder="如 资源方 / 属地机关事业单位" />
                </div>
                <div>
                  <div className="tiny faint">规模描述</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 220 }} value={gScale} onChange={(e) => setGScale(e.target.value)} placeholder="如 额度 8 卡 · 260 元/卡/日" />
                </div>
                <div>
                  <div className="tiny faint">卡位数（无卡填 0）</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" value={gCards} onChange={(e) => setGCards(e.target.value)} />
                </div>
                <div>
                  <div className="tiny faint">归口 / 责任方</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 140 }} value={gOwner} onChange={(e) => setGOwner(e.target.value)} />
                </div>
              </div>
              <div>
                <div className="tiny faint">绑定的接入配置（可先不绑，之后再接）</div>
                <select className="btn sm" style={{ marginTop: 4, width: '100%' }} value={gConn} onChange={(e) => setGConn(e.target.value)}>
                  <option value="">（不绑定：先登记在册）</option>
                  {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.kind} · {c.status} · {c.enabled ? '已启用' : '未启用'}）</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">说明</div>
                <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 46 }} value={gNote} onChange={(e) => setGNote(e.target.value)} placeholder="写清用途、边界与待确认事项" />
              </div>
              <div className="row gap6">
                <button
                  className="btn primary"
                  disabled={!perm.manage || !gName.trim() || !gOwner.trim()}
                  onClick={() => {
                    const id = `g-${Date.now().toString().slice(-6)}`
                    const r = governStore.add({ id, domain: gDomain, name: gName, source: gSource, vendor: gVendor || '待确认', scale: gScale || '（待补充）', cards: Number(gCards) || 0, connectorId: gConn, wantDepth: 4, owner: gOwner, cls: gCls, note: gNote || '（待补充）' })
                    if (!r.ok) { setGMsg({ tone: 'bad', text: `登记失败：${r.reason}` }); return }
                    setGMsg({ tone: 'good', text: `已登记 ${gName} → 当前深度 ${DEPTH_LABEL[depthLabelFor(id)]}（${whyFor(id)}）` })
                    setGName(''); setGNote(''); setBindId(id)
                  }}
                >登记这个对象
                </button>
                <span className="small faint">重名会被拒；绑定已就绪的接入配置可直接升到 L3 / L4。</span>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="把已登记对象接到接入配置上（深度升级演示）" extra="换绑后深度与覆盖率立即重算" noPad>
          <div className="panel-body">
            <div className="col gap6">
              <div>
                <div className="tiny faint">选择已登记对象</div>
                <select className="btn sm" style={{ marginTop: 4, width: '100%' }} value={bindId} onChange={(e) => setBindId(e.target.value)}>
                  <option value="">（选一个）</option>
                  {rows.map((g) => <option key={g.id} value={g.id}>{g.name}（{g.domain} · 现接 {g.connectorId || '无'}）</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">接到哪条接入配置</div>
                <select className="btn sm" style={{ marginTop: 4, width: '100%' }} value={bindConn} onChange={(e) => setBindConn(e.target.value)}>
                  <option value="">（解除绑定，退回 L1）</option>
                  {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.transport} · {c.status} · {c.mode === 'real' ? '真实接口' : '虚拟模拟'} · {c.enabled ? '已启用' : '未启用'}）</option>)}
                </select>
              </div>
              <div className="row gap6">
                <button
                  className="btn primary"
                  disabled={!perm.manage || !bindId || !bindConn}
                  onClick={() => {
                    const r = governStore.bind(bindId, bindConn)
                    if (!r.ok) { setGMsg({ tone: 'bad', text: `换绑失败：${r.reason}` }); return }
                    setGMsg({ tone: 'good', text: `已换绑，当前深度 ${DEPTH_LABEL[depthLabelFor(r.id)]}（${whyFor(r.id)}）。若接的是算力资源类配置且通道已启用，扩容工单在本地空闲不足时即可使用它的额度。` })
                  }}
                >换绑并重算深度
                </button>
                <span className="small faint">深度规则：未启用 / 中断 → L1；通道正常 → L2；接口已定 → L3；再加执行回执类前置完成 → L4。</span>
              </div>
              <Callout text={`当前登记 ${rows.length} 项，其中可处置 ${governSummary().manageable} 项、可调度 ${governSummary().schedulable} 项。新增资源本身不增加覆盖率，把它接上并确认接口状态才会升。`} />
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="接管范围对照客户方文档" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1020}
            head={['接管对象类型', '平台侧接管动作', '已具备能力（演示可操作）', '还需客户方 / 厂商给什么']}
            rows={[
              [<span className="small strong">算力平台</span>, <span className="small">统一登记异构算力平台（昇腾 / 寒武纪 / 训练平台 / 专网 NPU / 第三方扩租 / 边缘盒子），统一卡位台账与调度等级</span>, <span className="small">本地三池的扩容 / 回收 / 抢占 / 副本 / 权重全可操作；扩租平台可通过配置启用后补卡位</span>, <span className="small">各平台卡位与利用率接口、边缘站点清单与运维配合方式</span>],
              [<span className="small strong">算力资源</span>, <span className="small">卡位、存储配额、备份、跨网链路的资源台账与变更单</span>, <span className="small">卡位分配与成本分摊、存储配额台账、链路展示与告警</span>, <span className="small">外部备份保留期与恢复演练口径、链路切换的执行主体</span>],
              [<span className="small strong">智能体</span>, <span className="small">各子系统与外部智能体统一登记、运行监测、限流 / 暂停 / 恢复、下线与回滚</span>, <span className="small">处置动作面板可执行并通知归口；运行态列与引擎同源</span>, <span className="small">子系统运行日志与调用统计接口、外部智能体的处置执行与回执</span>],
              [<span className="small strong">Skill</span>, <span className="small">Skill 仓库与平台侧业务使用目录联动：版本、上架审核、启用 / 禁用、目录双侧摘除</span>, <span className="small">Skill 对象已进入双目录，可禁用 / 启用 / 隔离并核查一致性</span>, <span className="small">Skill 仓库的目录与版本接口、上架审批回写字段</span>],
              [<span className="small strong">MCP</span>, <span className="small">MCP 服务双侧目录（技术注册 ↔ 业务使用）、健康探针、调用统计、隔离出目录</span>, <span className="small">隔离 / 重新纳入即双侧同步并断开调用路由，一致性核查计数实时</span>, <span className="small">MCP 平台的探针字段、目录同步方向与冲突处理规则</span>],
            ]}
          />
          <Callout warn text={<>两个口径要分清：<b>真实接管深度</b>看接入配置就绪程度（下表「当前深度」），<b>演示内可操作</b>看平台纳管表里有没有这个对象（演示页面上的处置动作作用在平台侧影子状态）。接管范围覆盖这五类没有缺口，<b>缺口在接管深度</b>：外部与第三方对象要下到 L3 / L4，必须由接口方提供接口并确认「执行回执」类前置条件；否则平台只能做到「看得见、算得清」，做不到「下得去、调得动」。这是选型阶段需要客户方推动外部方确认的事。</>} />
        </div>
      </Panel>
    </div>
  )
}
