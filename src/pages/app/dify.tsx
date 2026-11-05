/* =====================================================================
 * Dify / RAGFlow 纳管（第一期）
 * 第一期范围：只读接「应用清单 + 发布状态 + 归口 + 绑定模型 + 用量/文档数」。
 * 第二期（调用日志、配额下发、知识库条目、用户与权限映射）只留位置，接口待厂商开放。
 * 一致性口径：Dify/RAGFlow 侧的发布状态 与 平台侧目录（纳管表 + 统一接管登记册）双向核对。
 * ===================================================================== */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Kpi, Panel, PageHead, Badge, Table, Callout } from '../../components/ui'
import { managedApps, sourceHint, useTelemetry, type ManagedApp } from '../../engine/telemetry'
import { connectorStore, readiness, MODE_LABEL, type Connector } from '../../engine/connectors'
import { governStore, useGovernViews, DEPTH_LABEL, type GovernedView } from '../../engine/govern'
import { monitorStore, monitorSummary } from '../../engine/exceptions'
import { usePerm } from '../../engine/auth'

const STATUS_TONE: Record<string, 'good' | 'warn' | 'muted' | 'purple'> = { 已发布: 'good', 草稿: 'purple', 已下线: 'muted' }

type Msg = { tone: 'good' | 'bad' | 'info'; text: string }

/** 一条接入配置的完整展示（配置项 / 前置条件对照 / 就绪缺口 / 版本与变更历史） */
function connBlock(c: Connector | undefined) {
  if (!c) return <Callout warn text="未找到这条接入配置：可在「运营分析 · 外部对接清单」恢复默认配置，或新增同名通道后再看本页。" />
  const miss = readiness(c)
  return (
    <div className="col gap6">
      <div className="row gap6 wrap">
        <span className="small strong">{c.name}</span>
        <span className="tag gray mono">{c.id}</span>
        <Badge tone="info">{c.kind}</Badge>
        <Badge tone={c.mode === 'real' ? 'good' : 'purple'}>{MODE_LABEL[c.mode]}</Badge>
        <Badge tone={c.enabled ? 'good' : 'muted'}>{c.enabled ? '通道启用' : '通道停用'}</Badge>
        <Badge tone={c.status === '已定' ? 'good' : c.status === '待商定' ? 'warn' : 'bad'}>{c.status}</Badge>
        <Badge tone={c.health === 'ok' ? 'good' : c.health === 'warn' ? 'warn' : 'bad'}>{c.health === 'ok' ? '链路正常' : c.health === 'warn' ? '链路异常' : '链路中断'}</Badge>
      </div>
      <div className="small">方向：{c.direction} · 归口：{c.owner}</div>
      <div className="small">地址：<span className="mono">{c.endpoint}</span> · 传输：{c.transport} · 鉴权：{c.auth}</div>
      <div className="small">频率：{c.intervalSec === 0 ? '事件触发' : `每 ${c.intervalSec} 秒`} · 超时 {c.timeoutMs} ms · 重试 {c.retries} 次 · 降级：{c.fallback}</div>
      <div className="small">采集项（第一期只读）：{c.dataItems}</div>
      <div className="small" style={{ color: '#ffd98a' }}>未开放范围 / 卡点：{c.blocking}</div>
      <div className="divider" />
      <div className="tiny faint">前置条件对照（全部完成才具备切真实接口的条件）</div>
      <div className="col gap6">
        {c.prereq.map((p) => (
          <div key={p} className="row gap6">
            <Badge tone={c.prereqDone.includes(p) ? 'good' : 'warn'}>{c.prereqDone.includes(p) ? '已完' : '未完'}</Badge>
            <span className="small">{p}</span>
          </div>
        ))}
      </div>
      <div className="tiny faint">切换真实接入前还缺：{miss.length ? miss.join(' / ') : '无（已就绪）'}</div>
      <div className="divider" />
      <div className="tiny faint">配置版本 v{c.version} · 更新于 {c.updatedAt}</div>
      <div className="col gap6">
        {c.changes.length ? c.changes.map((ch) => (
          <div key={`${ch.time}-${ch.text}`} className="small"><span className="mono tiny faint">{ch.time}</span> {ch.text}</div>
        )) : <span className="tiny faint">暂无变更记录</span>}
      </div>
      <div className="row gap6 wrap">
        <Link to="/ops/integrations" className="btn sm ghost">去外部接入配置中心改这条配置</Link>
        <span className="tiny faint">只改配置不改代码：{MODE_LABEL[c.mode]} → {MODE_LABEL.real} 就是在这条配置上填地址、定鉴权、勾前置条件</span>
      </div>
    </div>
  )
}

export default function DifyRagflow() {
  const tele = useTelemetry()
  const perm = usePerm('app')
  const gv = useGovernViews()
  const apps = managedApps()
  const hintDify = sourceHint('dify')
  const hintRag = sourceHint('ragflow')
  const [msg, setMsg] = useState<Msg | null>(null)

  /** 该应用是否已在统一接管登记册（按名字匹配，含本平台侧影子对象） */
  const govHit = (name: string): GovernedView | undefined =>
    gv.find((g) => {
      const base = g.name.split('（')[0].trim()
      return g.name === name || base === name || g.name.includes(name) || name.includes(base)
    })
  const inCatalog = (a: ManagedApp) => a.onPlatform || Boolean(govHit(a.name))

  const published = apps.filter((a) => a.status === '已发布')
  const draft = apps.filter((a) => a.status === '草稿')
  const offline = apps.filter((a) => a.status === '已下线')
  const onPlat = apps.filter((a) => a.onPlatform)
  const gapPublish = apps.filter((a) => a.status === '已发布' && !inCatalog(a))
  const gapDraft = apps.filter((a) => a.status !== '已发布' && a.onPlatform)
  const bothNone = apps.filter((a) => a.status !== '已发布' && !inCatalog(a))
  const diff = gapPublish.length + gapDraft.length

  const doRegister = (a: ManagedApp) => {
    const hit = govHit(a.name)
    if (hit) {
      setMsg({ tone: 'info', text: `「${a.name}」已在统一接管登记册（${hit.id} · ${hit.domain} · ${DEPTH_LABEL[hit.depth]} · ${hit.statusLabel}）：${hit.why}。要改归口或换绑接入配置，去「总览 · 统一接管范围」。` })
      return
    }
    const connectorId = a.platform === 'Dify' ? 'a-dify' : 'a-ragflow'
    const r = governStore.add({
      id: `g-app-${a.platform === 'Dify' ? 'dify' : 'ragflow'}-${gv.length + 1}`,
      domain: '智能体',
      name: `${a.name}（${a.platform}）`,
      source: '已建子系统',
      vendor: a.platform === 'Dify' ? 'Dify（公司内网已部署）' : 'RAGFlow（公司内网已部署）',
      scale: `${a.type} · ${a.metric}`,
      cards: 0,
      connectorId,
      owner: a.owner,
      cls: '内部',
      note: `第一期由 ${connectorId} 只读接入带入：发布状态 ${a.status} · 归口 ${a.owner} · 绑定模型 ${a.models || '未标注'} · 最近更新 ${a.updatedAt || '未标注'}`,
      wantDepth: 2,
    })
    if (!r.ok) { setMsg({ tone: 'bad', text: `没有登记进去：${r.reason}（接管册里同名对象已存在时，去「总览 · 统一接管范围」编辑既有条目）` }); return }
    const view = governStore.views().find((x) => x.id === r.id)
    const depth = view?.depth ?? 1
    setMsg({
      tone: 'good',
      text: `已登记进统一接管登记册：${r.id} · 绑定接入配置 ${connectorId} · 归口 ${a.owner} → 接管深度 ${DEPTH_LABEL[depth]}（${view?.why ?? ''}）。第一期只到「可见 / 可度量」：要升到 L3 可处置，需要调用日志与配额写接口开放并给执行回执（待厂商开放）。`,
    })
  }

  const doScan = () => {
    const fresh = monitorStore.scanAndRaise()
    const s = monitorSummary()
    const dir = s.byKind.find((x) => x.kind === '目录不一致')?.n ?? 0
    const gap = s.byKind.find((x) => x.kind === '接管缺口')?.n ?? 0
    setMsg({
      tone: 'good',
      text: `已送例外监控扫描（第 ${s.round} 轮 · ${s.lastScanAt}）：本轮新增待分析 ${fresh} 条 · 台账共 ${s.total} 条（待分析 ${s.open}）。其中【目录不一致】类 ${dir} 条：处置口径是双侧同步摘除目录入口（技术目录与使用目录一起摘、断开调用路由），背后的服务、算力与卡位不动，也不回收卡位；恢复纳入须归口确认。本页两类差异共 ${diff} 条，另有【接管缺口】类 ${gap} 条按接管深度低于 L4 检出。`,
    })
  }

  return (
    <div>
      <PageHead
        title="Dify / RAGFlow 纳管（第一期）"
        desc="第一期只接应用清单与发布状态（只读）；调用日志、配额下发属第二期"
        extra={
          <>
            <Badge tone="info">纳管应用 {apps.length}</Badge>
            <Badge tone="good">已发布 {published.length}</Badge>
            <Badge tone={diff ? 'warn' : 'good'}>一致性差异 {diff}</Badge>
            <Badge tone={tele.mode === '采集层' ? 'good' : 'muted'}>取数来源：{tele.mode}</Badge>
          </>
        }
      />

      {msg ? <div style={{ marginTop: 6 }}><Callout warn={msg.tone === 'bad'} text={msg.text} /></div> : null}

      <div className="grid g-6" style={{ marginTop: 14 }}>
        <Kpi label="纳管应用总数" value={apps.length} unit="个" foot={`Dify ${apps.filter((a) => a.platform === 'Dify').length} · RAGFlow ${apps.filter((a) => a.platform === 'RAGFlow').length}`} />
        <Kpi label="已发布" value={published.length} unit="个" foot="对平台侧目录可见、可被调用" />
        <Kpi label="草稿 / 未发布" value={draft.length} unit="个" foot="不该出现在业务使用目录" />
        <Kpi label="已下线" value={offline.length} unit="个" foot="须确认目录入口已双侧摘除" />
        <Kpi label="平台目录已登记" value={onPlat.length} unit="个" foot={`接管册在册 ${apps.filter((a) => inCatalog(a)).length} · 未登记 ${apps.length - onPlat.length}`} />
        <Kpi label="目录不一致" value={diff} unit="条" foot={`已发布无登记 ${gapPublish.length} · 有登记未发布 ${gapDraft.length}`} />
      </div>

      <Panel
        title="应用清单（第一期只读）"
        extra={perm.manage ? '未登记的应用可直接登记进统一接管登记册（写平台侧目录，不写 Dify / RAGFlow）' : <span className="tiny faint">只读</span>}
        className="mt14"
        noPad
      >
        <div className="panel-body">
          <Table
            minWidth={1250}
            head={['平台', '应用', '类型', '发布状态', '归口', '最近更新', '绑定模型', '调用量 / 文档数', '平台侧登记', '动作']}
            rows={apps.map((a) => {
              const hit = govHit(a.name)
              return [
                <Badge tone={a.platform === 'Dify' ? 'purple' : 'info'}>{a.platform}</Badge>,
                <span className="small strong">{a.name}</span>,
                <span className="small">{a.type}</span>,
                <Badge tone={STATUS_TONE[a.status] ?? 'muted'}>{a.status}</Badge>,
                <span className="small">{a.owner}</span>,
                <span className="mono tiny">{a.updatedAt || '未标注'}</span>,
                <span className="small">{a.models || '未标注'}</span>,
                <span className="small">{a.metric || '待厂商开放'}</span>,
                a.onPlatform
                  ? <Badge tone="good">已登记</Badge>
                  : hit
                    ? <Badge tone="purple">接管册在册</Badge>
                    : <Badge tone="warn">未登记</Badge>,
                <span className="row gap6">
                  {hit ? (
                    <span className="tiny faint">{hit.id} · {DEPTH_LABEL[hit.depth]}</span>
                  ) : (
                    <button className="btn sm" disabled={!perm.manage} onClick={() => doRegister(a)}>去接管册登记</button>
                  )}
                  <Link to="/govern" className="btn sm ghost">接管册</Link>
                  {!perm.manage ? <span className="tiny faint">只读</span> : null}
                </span>,
              ]
            })}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            「平台侧登记」看两套目录：平台纳管表（应用中心）与统一接管登记册（总览）。两边都算已登记；只有接入侧有、平台侧没有的，才是本页要处理的一致性差异。调用量 / 文档数来自第一期只读清单，逐次调用日志属第二期（待厂商开放）。
          </div>
        </div>
      </Panel>

      <Panel
        title="一致性核查（两套目录谁说了算）"
        extra={`差异 ${diff} 条 · 忽略 ${bothNone.length} 条 · 判定以「谁在被调用」为准`}
        className="mt14"
      >
        <div className="col gap6">
          <div className="row gap6 wrap">
            <span className="small strong">① 接入侧已发布，平台侧无登记</span>
            <Badge tone={gapPublish.length ? 'warn' : 'good'}>{gapPublish.length} 条</Badge>
          </div>
          {gapPublish.length ? (
            <div className="col gap6">
              {gapPublish.map((a) => (
                <div key={`${a.platform}-${a.name}`} className="row gap6 wrap">
                  <Badge tone={a.platform === 'Dify' ? 'purple' : 'info'}>{a.platform}</Badge>
                  <span className="small">{a.name}</span>
                  <span className="tag gray">归口 {a.owner}</span>
                  <span className="tiny" style={{ color: '#ffd98a' }}>建议动作：登记 —— 在统一接管登记册登记并绑定 {a.platform === 'Dify' ? 'a-dify' : 'a-ragflow'}，指定归口；确认它是平台外自建应用的，记「平台外运行，不纳管」并留依据</span>
                </div>
              ))}
            </div>
          ) : <span className="tiny faint">无：所有已发布应用都能对上平台侧目录</span>}

          <div className="divider" />

          <div className="row gap6 wrap">
            <span className="small strong">② 平台侧有登记，接入侧是草稿 / 已下线</span>
            <Badge tone={gapDraft.length ? 'warn' : 'good'}>{gapDraft.length} 条</Badge>
          </div>
          {gapDraft.length ? (
            <div className="col gap6">
              {gapDraft.map((a) => (
                <div key={`${a.platform}-${a.name}`} className="row gap6 wrap">
                  <Badge tone={a.platform === 'Dify' ? 'purple' : 'info'}>{a.platform}</Badge>
                  <span className="small">{a.name}</span>
                  <Badge tone={STATUS_TONE[a.status] ?? 'muted'}>{a.status}</Badge>
                  <span className="tiny" style={{ color: '#ffd98a' }}>建议动作：摘除或复核归口 —— 确认是「还在开发、先从业务目录摘除」还是「已下线但目录没摘」：前者挂为草稿跟踪，后者双侧同步摘除并留处置记录</span>
                </div>
              ))}
            </div>
          ) : <span className="tiny faint">无：平台侧登记的应用在接入侧都是已发布状态</span>}

          <div className="divider" />

          <div className="row gap6 wrap">
            <span className="small strong">③ 双方都无（忽略）</span>
            <Badge tone="muted">{bothNone.length} 条</Badge>
            <span className="tiny faint">既未发布也未登记：不产生一致性动作，只在清单里留一行，避免下次被当成漏纳管</span>
          </div>
          {bothNone.length ? (
            <div className="row wrap gap6">
              {bothNone.map((a) => <span key={`n-${a.platform}-${a.name}`} className="tag gray">{a.platform} · {a.name}</span>)}
            </div>
          ) : null}
        </div>

        <div className="divider" />
        <div className="row gap6 wrap">
          <button className="btn sm" disabled={!perm.manage} onClick={doScan}>按目录不一致送例外监控</button>
          {!perm.manage ? <span className="tiny faint">只读</span> : null}
          <span className="tiny faint">例外台账里的【目录不一致】类：处置是双侧同步摘除目录入口（技术目录 + 使用目录一起摘、断开调用路由），背后的服务与算力不停，且不回收卡位、不下线模型；重新纳入须归口确认</span>
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="接入配置 ①：Dify" extra="第一期接口范围与就绪程度" noPad>
          <div className="panel-body">{connBlock(connectorStore.find('a-dify'))}</div>
        </Panel>
        <Panel title="接入配置 ②：RAGFlow" extra="第一期接口范围与就绪程度" noPad>
          <div className="panel-body">{connBlock(connectorStore.find('a-ragflow'))}</div>
        </Panel>
      </div>

      <Panel title="第二期接口范围（已留位置，待厂商确认）" extra="位置已留 / 字段已定义 / 接口与回执待厂商开放" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1050}
            head={['第二期要接的内容', '平台侧已留的位置', '要谁提供 · 现在缺什么']}
            rows={[
              [
                <span className="small strong">调用日志与用量（逐次调用、Token、错误码、耗时）</span>,
                <span className="small">本页「调用量 / 文档数」列升级为逐日曲线；明细进「模型中心 · 调用审计检索」与「调用溯源」，与网关 key 用量对账</span>,
                <span className="small">Dify 侧 Service API 日志接口、RAGFlow 侧消息 / 调用记录接口：字段字典与留存期 <b>待厂商开放</b>，平台侧字段位已按 <span className="mono">calls_day / tokens / err_code</span> 留好</span>,
              ],
              [
                <span className="small strong">配额与限流下发（应用侧并发 / Token 上限）</span>,
                <span className="small">「模型中心 · 凭证与配额」配额调整工单 + 本页「LiteLLM 网关仪表」的工单入口；平台侧配额值已可管</span>,
                <span className="small">需要 Dify / RAGFlow 开放<b>写接口</b>并给<b>执行回执</b>（改前值 / 改后值 / 生效时间 / 失败原因）：<b>待厂商开放</b>；没有回执前平台只发单不声称已生效</span>,
              ],
              [
                <span className="small strong">知识库条目与向量化状态（条目数、入库 / 解析 / 向量化进度）</span>,
                <span className="small">「应用中心 · 知识库纳管」的库清单与入库状态板块，可与本页文档数做对账</span>,
                <span className="small">RAGFlow 数据集详情（<span className="mono">/api/v1/datasets</span> 下的条目与解析状态）：字段口径与密级标签 <b>待厂商确认</b></span>,
              ],
              [
                <span className="small strong">用户与权限映射（应用账号 ↔ 平台账号 ↔ 角色 / 密级）</span>,
                <span className="small">「应用中心 · 跨平台运营」权限矩阵与账号归口列；本页「归口」列已按组织口径显示</span>,
                <span className="small">统一身份认证 SSO 口径（票据方式、角色映射表、会话时效）：<b>待客户方与厂商共同确认</b>；未确认前本页不做用户级统计</span>,
              ],
            ]}
          />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            写清边界：第一期只读不改任何外部系统；第二期的「下发」类动作一律走平台工单，外部侧执行方与回执方式先由厂商书面确认，确认前页面上不出现「已生效」。
          </div>
        </div>
      </Panel>

      <Panel title="数据来源与接口清单（Dify / RAGFlow）" extra="两个取数点分别列 · 同一份落盘文件 apps.json" className="mt14">
        <div className="grid g-2">
          {[hintDify, hintRag].map((h) => (
            <div key={h.id} className="col gap6">
              <div className="row gap6 wrap">
                <span className="small strong">{h.name}</span>
                <span className="tag gray mono">{h.id}</span>
                <span className="tag gray">落盘 {h.file}</span>
              </div>
              <div className="small"><b>取数方式 via：</b><span className="mono">{h.via}</span></div>
              <div className="small"><b>鉴权 auth：</b>{h.auth}</div>
              <div className="small"><b>频率 every：</b>{h.every}</div>
              <div className="tiny faint">字段 fields（按这些名字落盘，平台内部做映射）</div>
              <div className="row wrap gap6">{h.fields.map((f) => <span key={f} className="tag gray mono">{f}</span>)}</div>
              <div className="row gap6">
                <Badge tone={h.status.ok ? 'good' : 'bad'}>{h.status.ok ? '本轮可取数' : '本轮取数失败'}</Badge>
                <span className="tiny faint">{h.status.at} · {h.status.items} 条</span>
              </div>
              <div className="tiny faint">{h.status.note}</div>
              <div className="small">{h.note}</div>
            </div>
          ))}
        </div>
        <div className="divider" />
        <Callout
          text={
            <>
              当前取数模式：<b>{tele.mode}</b>（{tele.generatedAt}）。真实环境只要让采集脚本把两份清单写成 <span className="mono">apps.json</span>（并更新 <span className="mono">manifest.json</span>，生成时间在 15 分钟内），
              站点根目录的 <span className="mono">dist/data/apps.json</span> 到位即自动切换到真实清单，<b>不改平台代码</b>；页面上的取数来源徽章会从「平台推导」变成「采集层」。
              取不到的字段照实在页面显示「未标注 / 待厂商开放」，不做推算承诺。接真实环境请用<b>只读账号</b>：本页对 Dify / RAGFlow 只读，任何「下发」都走平台工单与外部侧执行回执。
            </>
          }
        />
      </Panel>
    </div>
  )
}
