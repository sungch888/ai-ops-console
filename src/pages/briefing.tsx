/* =====================================================================
 * 投屏汇报首页（16:9 · 5 页翻页 · 暗色大屏 / 蓝白汇报双配色）
 * 数字全部来自引擎与实时账本：副本、权重、卡位、处置动作、策略变更都会改变本页
 * ===================================================================== */
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEngine, poolUtil, freeCards, totalAllocated, totalReplicas, activeCreds, TOTAL_CARDS, engine } from '../engine/engine'
import { ledgerOf } from '../engine/ledger'
import { useAlertRules } from '../engine/alerts'
import { usePolicies } from '../engine/policies'
import { useNotifs } from '../engine/ops'
import { monitorSummary } from '../engine/exceptions'
import { governSummary } from '../engine/govern'
import { useSession } from '../engine/auth'

type Palette = { bg: string; panel: string; border: string; text: string; sub: string; accent: string; good: string; warn: string; bad: string; bar: string }

const DARK: Palette = {
  bg: '#060f1e', panel: 'rgba(23,48,90,.42)', border: 'rgba(64,130,220,.22)', text: '#eaf3ff',
  sub: '#a9c4e8', accent: '#22d3ee', good: '#2fd6a3', warn: '#f5b83d', bad: '#ff6b6b', bar: 'rgba(64,130,220,.16)',
}
const LIGHT: Palette = {
  bg: '#eef3f9', panel: '#ffffff', border: '#d5e2f1', text: '#12233a',
  sub: '#4d6party', accent: '#0f7ac0', good: '#0f8a63', warn: '#a4650a', bad: '#b3261e', bar: '#e3ecf7',
}
LIGHT.sub = '#55708f'

const CAP: Record<string, string> = { hp: '高保业务集群', shared: '共享推理集群', train: '训练微调集群' }

export default function Briefing() {
  const nav = useNavigate()
  const st = useEngine()
  const rules = useAlertRules()
  const { policies, changes } = usePolicies()
  const notifs = useNotifs()
  const acc = useSession()
  const [page, setPage] = useState(0)
  const [light, setLight] = useState(false)
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const t1 = setInterval(() => engine.tickSimulate(), 4000)
    const t2 = setInterval(() => setClock(new Date()), 1000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setPage((p) => Math.min(4, p + 1))
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => { clearInterval(t1); clearInterval(t2); window.removeEventListener('keydown', onKey) }
  }, [])

  const p = light ? LIGHT : DARK
  const L = ledgerOf(st)
  const running = st.orders.filter((o) => o.status === 'running')
  const queued = st.orders.filter((o) => o.status === 'queued')
  const pending = st.orders.filter((o) => o.status === 'submitted')
  const slot = engine.activeSlot()
  const contained = st.managed.filter((m) => m.status !== '正常')
  const firedRules = rules.filter((r) => r.fired > 0)

  const card = { background: p.panel, border: `1px solid ${p.border}`, borderRadius: 12, padding: '14px 16px' }
  const kpi = (label: string, value: string | number, unit: string, foot?: string, tone?: string) => (
    <div style={card}>
      <div style={{ fontSize: 13, color: p.sub }}>{label}</div>
      <div style={{ fontSize: 34, fontWeight: 700, marginTop: 6, color: tone ?? p.text, fontVariantNumeric: 'tabular-nums' }}>
        {value}<span style={{ fontSize: 15, marginLeft: 6, color: p.sub }}>{unit}</span>
      </div>
      {foot ? <div style={{ fontSize: 12, color: p.sub, marginTop: 6 }}>{foot}</div> : null}
    </div>
  )
  const barRow = (name: string, pct: number, right: string, tone: string) => (
    <div key={name} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: p.text }}>
        <span>{name}</span><span style={{ color: p.sub, fontVariantNumeric: 'tabular-nums' }}>{right}</span>
      </div>
      <div style={{ height: 10, background: p.bar, borderRadius: 6, marginTop: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(2, Math.min(100, pct))}%`, background: tone, borderRadius: 6 }} />
      </div>
    </div>
  )
  const panelTitle = (t: string, extra?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: p.text }}>{t}</div>
      {extra ? <div style={{ fontSize: 12.5, color: p.sub }}>{extra}</div> : null}
    </div>
  )

  const slides: { title: string; sub: string; body: ReactNode }[] = [
    {
      title: '三中心一体化运营态势',
      sub: '算力 · 模型 · 应用 同源数据，同一套账本',
      body: (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14 }}>
          {kpi('算力卡位', `${totalAllocated(st)} / ${TOTAL_CARDS}`, '张', `空闲 ${freeCards(st)} 张 · 池化率 ${Math.round((totalAllocated(st) / TOTAL_CARDS) * 100)}%`)}
          {kpi('推理副本', totalReplicas(st), '个', `${st.models.filter((m) => m.state === '运行中').length} 个模型在运行 · ${st.models.filter((m) => m.state === '已下线').length} 个已下线`)}
          {kpi('今日调用量', (L.callsToday / 10000).toFixed(1), '万次', `${L.liveCards} 卡承载 · ${L.rpm} RPM`)}
          {kpi('今日 Token', (L.tokensToday / 10000).toFixed(2), '亿', `外部渠道占 ${(L.externalShare * 100).toFixed(0)}%`)}
          {kpi('今日折算成本', (L.costToday / 10000).toFixed(2), '万元', `本地卡位 ${(L.localCost / 10000).toFixed(2)} 万 + 外部 Token ${(L.externalCost / 10000).toFixed(2)} 万`)}
          {kpi('活跃凭证', activeCreds(st), '个', `已吊销 ${st.creds.filter((c) => c.status === 'off').length} 个 · 配额可调整`)}
          {kpi('在途工单', pending.length + running.length + queued.length, '项', `待审批 ${pending.length} · 执行中 ${running.length} · 排队 ${queued.length}`)}
          {kpi('告警与策略', `${rules.length} 规则 / ${policies.length} 策略`, '条', `已触发 ${rules.reduce((s, r) => s + r.fired, 0)} 次 · 待审批变更 ${changes.filter((c) => c.status === '待审批').length} 项`)}
        </div>
      ),
    },
    {
      title: '资源池与变更调度',
      sub: '准入计算 · 变更窗口串行 · 队列接续 · 高保优先抢占',
      body: (
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr .85fr', gap: 16 }}>
          <div style={card}>
            {panelTitle('资源池利用率', '引擎实时值 · 每次采样刷新')}
            {st.pools.map((pl) => {
              const u = poolUtil(st, pl.id)
              return barRow(`${CAP[pl.id]}（${pl.cards} 卡）`, u, `${u}%`, u > 90 ? p.bad : u > 75 ? p.warn : p.good)
            })}
            <div style={{ fontSize: 13, color: p.sub, marginTop: 4 }}>
              卡位账本：{st.pools.map((pl) => `${CAP[pl.id]} ${pl.cards}`).join(' · ')}
            </div>
          </div>
          <div style={card}>
            {panelTitle('变更窗口与执行队列', slot ? `${slot.id} 使用中 ${slot.from}-${slot.to}` : '当前未开放')}
            {barRow('执行中变更', running.length ? 100 : 4, `${running.length} 项`, running.length ? p.accent : p.good)}
            {barRow('排队工单', queued.length ? Math.min(100, queued.length * 25) : 4, `${queued.length} 项`, queued.length ? p.warn : p.good)}
            {barRow('待审批工单', pending.length ? Math.min(100, pending.length * 20) : 4, `${pending.length} 项`, pending.length ? p.warn : p.good)}
            <div style={{ fontSize: 13.5, color: p.text, lineHeight: 1.9, marginTop: 6 }}>
              同一时刻仅一项变更占用窗口，其余按提交顺序排队；无开放窗口时新变更自动排入下一预约窗口。
              {contained.length ? <div style={{ color: p.warn, marginTop: 6 }}>处置中对象 {contained.length} 项：{contained.map((m) => `${m.name}(${m.status})`).join('、')}</div> : null}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '模型副本与渠道路由',
      sub: '副本数、版本与渠道权重共同决定承载与成本',
      body: (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={card}>
            {panelTitle('模型承载', '副本 × 每副本卡位')}
            {st.models.map((m) => barRow(`${m.short} · ${m.ver}${m.state === '已下线' ? ' · 已下线' : ''}`, m.replicas ? Math.min(100, m.replicas * m.perReplica * 12) : 2, `${m.replicas} × ${m.perReplica} 卡`, m.replicas ? p.accent : p.bad))}
          </div>
          <div style={card}>
            {panelTitle('渠道权重与健康度', st.failover ? `故障切换生效中：${st.failover.channelName} → ${st.failover.toChannel}` : '无切换生效 · 空闲')}
            {st.channels.map((c) => barRow(`${c.name.split('（')[0]}（${c.kind} · p95 ${c.latency}ms · 错误率 ${c.err}%）`, c.weight, `${c.weight}%`, c.health === 'ok' ? p.good : c.health === 'warn' ? p.warn : p.bad))}
            <div style={{ fontSize: 13, color: p.sub, marginTop: 6 }}>
              今日 Token 分布：本地 {((1 - L.externalShare) * 100).toFixed(0)}% · 外部 {(L.externalShare * 100).toFixed(0)}%；异常渠道权重上限 20%（准入硬校验）
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '算力资源例外监控与阻断',
      sub: '所有算力资源按 L4 彻底接管 · 后台轮扫旁路接入与资源异常 · 例外可一键阻断并可回滚',
      body: (() => {
        const m = monitorSummary()
        const g = governSummary()
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={card}>
              {panelTitle('例外检出分布（未闭环 / 总数）', `第 ${m.round} 轮轮扫 · ${m.lastScanAt}`)}
              {m.byKind.map((k) => barRow(`${k.kind}`, k.n ? Math.round((k.open / k.n) * 100) : 0, `${k.open} / ${k.n}`, k.open ? (k.kind === '旁路接入' || k.kind === '旁路调用' ? p.bad : p.warn) : p.good))}
              <div style={{ fontSize: 13, color: p.sub, marginTop: 6 }}>
                紧急 {m.urgent} 项 · 高 {m.high} 项 · 已阻断 {m.blocked} 项 · 人工放行 {m.passed} 项；同一例外只报一次，报警进通知中心与事件流。
              </div>
            </div>
            <div style={card}>
              {panelTitle('接管深度覆盖率', `登记 ${g.total} 项 · 可处置 ${g.manageable} · 可调度 ${g.schedulable}`)}
              {g.byDomain.map((d) => barRow(`${d.domain}`, d.rate, `${d.l3} / ${d.total}`, d.rate >= 80 ? p.good : d.rate >= 50 ? p.warn : p.bad))}
              <div style={{ fontSize: 13, color: p.sub, marginTop: 6 }}>
                可调度算力总量：本地 88 卡 + 已纳管外部 {g.externalCards} 卡；未彻底接管的对象在例外台账里逐条列出缺什么，可先暂停对外调用。
              </div>
            </div>
          </div>
        )
      })(),
    },
    {
      title: '已实现的可操作闭环',
      sub: '以下每一项在演示版里都可现场操作、可回滚、有留痕',
      body: (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            ['算力池扩缩与回收', '空闲卡位实时校验，不足直接拒绝；回收后模型承载同步下降'],
            ['高保优先抢占', '利用率 >90% 才触发；被抢占方副本降级并发通知'],
            ['模型副本与路由权重', '副本变更接卡位账本；权重调整受异常渠道上限约束'],
            ['凭证发放 / 提额 / 吊销', '渠道配额占用实时计算，个人密钥默认上限 120 RPM'],
            ['变更窗口串行与排期', '预约窗口 → 开启 → 队列按序接续 → 结束顺延'],
            ['告警规则可配置', '固定阈值 + 基线偏离，四维度含应用侧指标，触发生成工单'],
            ['渠道故障自动切换', '劣化即切换并降权，通知受影响业务，可回切闭环'],
            ['应用侧处置动作', '暂停入库 / 限流 / 暂停应用 / 工具隔离 / 插件禁用'],
            ['检测策略库与版本回滚', '变更须审批，版本历史可回滚，驳回同样留痕'],
            ['模型版本回退与下线', '链路可用性验证；下线释放卡位并通知受影响应用'],
            ['调用审计检索与链路还原', '人员—入口—智能体—知识库—工具—渠道六节点，可导出'],
            ['报表与台账 CSV 导出', '取当前引擎快照，UTF-8 BOM，Excel 直接可打开'],
          ].map(([t, d]) => (
            <div key={t} style={{ ...card, padding: '11px 14px' }}>
              <div style={{ fontSize: 15.5, color: p.text, fontWeight: 600 }}>
                <span style={{ color: p.good }}>✔ </span>{t}
              </div>
              <div style={{ fontSize: 13, color: p.sub, marginTop: 4 }}>{d}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: '需要客户方明确的口径',
      sub: '演示版按虚拟数据实现，以下五项需选型阶段确认',
      body: (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={card}>
            {panelTitle('待确认清单')}
            {[
              ['平台部署在哪张网', '一套平台跨网 vs 三套网各自部署，影响菜单与数据可见范围'],
              ['7 个已建子系统的接口规格', '由谁提供接口文档与联调环境，决定对接清单能否落地'],
              ['6 类安全设备的联动执行主体', '「一键止损」由平台下发还是设备侧执行并回执'],
              ['等保定级与商用密码评估', '定级结论与密评计划决定国密改造与审计范围'],
              ['非功能指标量化', '可用性、并发、时延、RTO/RPO 的验收数值与测量方式'],
            ].map(([t, d]) => (
              <div key={t} style={{ borderBottom: `1px solid ${p.border}`, padding: '9px 0' }}>
                <div style={{ fontSize: 15.5, color: p.text, fontWeight: 600 }}>{t}</div>
                <div style={{ fontSize: 13, color: p.sub, marginTop: 3 }}>{d}</div>
              </div>
            ))}
          </div>
          <div style={card}>
            {panelTitle('演示数据与口径说明')}
            <div style={{ fontSize: 14, color: p.text, lineHeight: 1.95 }}>
              本页全部数字由演示引擎实时推导：<b>调用量 = 存活副本承载（每卡 22 RPM）× 应用承接系数</b>；
              <b>Token = 调用量 × 820 token/次</b>；<b>成本 = 已分配推理卡位 {L.allocCards} 卡 × 210 元/卡/日 + 外部 Token × 0.9 元/万 token</b>（承载 {L.liveCards} 卡 / 已分配 {L.allocCards} 卡）。
              <div style={{ marginTop: 10, color: p.sub }}>
                外部系统（统一身份认证、6 类安全设备、7 个已建子系统、短信与邮件通道）按对接清单虚拟接入，可演示中断与降级影响；
                凭证内容、人员与事项数据均为虚构，不涉及真实敏感数据。
              </div>
              <div style={{ marginTop: 10, fontSize: 13, color: p.sub }}>
                当前会话：{acc ? `${acc.name}（${acc.role === 'admin' ? '平台管理员' : acc.role === 'ops' ? '运营值班' : acc.role === 'dev' ? '业务开发者' : '业务用户'}）` : '未登录'} · 未闭环通知 {notifs.filter((n) => !n.handled).length} 条 · 告警已触发 {rules.reduce((s, r) => s + r.fired, 0)} 次
              </div>
            </div>
          </div>
        </div>
      ),
    },
  ]

  const cur = slides[page]
  return (
    <div style={{ minHeight: '100vh', background: p.bg, color: p.text, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', borderBottom: `1px solid ${p.border}` }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>AI 运营管理平台 · 选型交流汇报</div>
          <div style={{ fontSize: 12.5, color: p.sub, marginTop: 2 }}>算力中心 · 模型中心 · 应用中心 一体化运营（演示版数据为虚拟模拟）</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => setLight((x) => !x)}>{light ? '切换暗色投屏' : '切换蓝白汇报'}</button>
          <button className="btn sm" onClick={() => { const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> }; el.requestFullscreen?.() }}>全屏投屏</button>
          <button className="btn sm ghost" onClick={() => nav('/')}>返回平台</button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px 22px' }}>
        <div style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9', maxHeight: 'calc(100vh - 150px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>{cur.title}</div>
            <div style={{ fontSize: 14, color: p.sub, marginTop: 3 }}>{cur.sub}</div>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>{cur.body}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 22px', borderTop: `1px solid ${p.border}`, fontSize: 13, color: p.sub }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn sm" disabled={page === 0} onClick={() => setPage((x) => Math.max(0, x - 1))}>上一页</button>
          <button className="btn sm primary" disabled={page === slides.length - 1} onClick={() => setPage((x) => Math.min(slides.length - 1, x + 1))}>下一页</button>
          <span style={{ marginLeft: 8 }}>第 {page + 1} / {slides.length} 页 · 也可用 ← → 方向键翻页</span>
        </div>
        <div style={{ display: 'flex', gap: 14, fontVariantNumeric: 'tabular-nums' }}>
          <span>{clock.toLocaleDateString('zh-CN')}</span>
          <span>{clock.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <span>引擎采样第 {st.tick} 周期</span>
          <span style={{ color: p.good }}>● 数据实时刷新（每 4 秒采样）</span>
        </div>
      </div>
    </div>
  )
}
