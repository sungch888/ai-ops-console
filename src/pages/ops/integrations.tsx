/* =====================================================================
 * 外部接入配置中心（配置即接入）
 * 外部系统与外部资源都用一条「接入配置」描述：协议 / 接入方式 / 地址 / 鉴权 /
 * 频率 / 超时重试 / 降级策略 / 配额与计费 / 前置条件。虚拟与真实只差 mode 与地址。
 * 其中两项配置会直接改变平台能力：外部算力扩租通道、外部模型渠道开关。
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout, Tabs } from '../../components/ui'
import { Link } from 'react-router-dom'
import {
  useConnectors, connectorStore, intStore, notifyStore, downloadCsv, readiness, MODE_LABEL,
  TRANSPORTS, AUTHS, FALLBACKS, KIND_GROUP, rentConfig, llmChannelConfig,
  type Connector, type IntStatus, type ConnKind,
} from '../../engine/ops'
import { usePerm } from '../../engine/auth'
import { useEngine, rentInfo } from '../../engine/engine'

const STATUSES: IntStatus[] = ['已定', '待商定', '待客户方提供']
const TABS = ['接入配置', '新增接入', '状态清单', '配置字段与导入导出']

interface Draft { transport: string; endpoint: string; auth: string; dataItems: string; intervalSec: number; timeoutMs: number; retries: number; fallback: string; status: IntStatus; cards: string; price: string; tokens: string; tb: string }
const toDraft = (c: Connector): Draft => ({
  transport: c.transport, endpoint: c.endpoint, auth: c.auth, dataItems: c.dataItems,
  intervalSec: c.intervalSec, timeoutMs: c.timeoutMs, retries: c.retries, fallback: c.fallback, status: c.status,
  cards: String(c.quota?.cards ?? ''), price: String(c.quota?.pricePerCardDay ?? ''), tokens: String(c.quota?.tokensWanPerDay ?? ''), tb: String(c.quota?.tb ?? ''),
})
function freqLabel(sec: number) { return sec === 0 ? '事件触发' : sec === 10 ? '10 秒' : sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.round(sec / 60)} 分钟` : `${Math.round(sec / 3600)} 小时` }
function quotaLabel(c: Connector) {
  const q = c.quota
  if (!q) return '—'
  if (q.cards) return `${q.cards} 卡 · ${q.pricePerCardDay} 元/卡/日`
  if (q.tokensWanPerDay) return `${q.tokensWanPerDay.toLocaleString('zh-CN')} 万 token/日 · ${q.pricePerTokenWan} 元/万 token`
  if (q.tb) return `${q.tb} TB`
  return '—'
}
function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function OpsIntegrations() {
  const ints = useConnectors()
  const st = useEngine()
  const engRent = rentInfo(st)
  const perm = usePerm('integration')
  const [tab, setTab] = useState(TABS[0])
  const [sel, setSel] = useState('r-gpu')
  const cur = connectorStore.find(sel) ?? ints[0]
  const [draft, setDraft] = useState<Draft>(() => toDraft(cur))
  const [importText, setImportText] = useState('')
  const [nKind, setNKind] = useState<ConnKind>('外部算力资源')
  const [nName, setNName] = useState('')
  const [nOwner, setNOwner] = useState('客户方侧')
  const [nTransport, setNTransport] = useState<string>('REST / JSON')
  const [nAuth, setNAuth] = useState<string>('AppKey + 签名')
  const [nItems, setNItems] = useState('')
  const [nFreq, setNFreq] = useState('300')
  const [nCards, setNCards] = useState('8')
  const [nPrice, setNPrice] = useState('260')
  const [nPrereq, setNPrereq] = useState('')
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const rent = rentConfig()
  const llm = llmChannelConfig()
  const missing = readiness(cur)
  const readyReal = ints.filter((c) => readiness(c).length === 0).length

  const pick = (c: Connector) => { setSel(c.id); setDraft(toDraft(c)); setMsg(null) }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  const save = () => {
    const quota: Connector['quota'] = cur.quota
      ? {
          cards: cur.quota.cards !== undefined ? Number(draft.cards) || 0 : undefined,
          pricePerCardDay: cur.quota.pricePerCardDay !== undefined ? Number(draft.price) || 0 : undefined,
          tokensWanPerDay: cur.quota.tokensWanPerDay !== undefined ? Number(draft.tokens) || 0 : undefined,
          pricePerTokenWan: cur.quota.pricePerTokenWan !== undefined ? Number(draft.price || cur.quota.pricePerTokenWan) || 0.9 : undefined,
          tb: cur.quota.tb !== undefined ? Number(draft.tb) || 0 : undefined,
        }
      : undefined
    const r = connectorStore.update(cur.id, {
      transport: draft.transport, endpoint: draft.endpoint, auth: draft.auth, dataItems: draft.dataItems,
      intervalSec: Number(draft.intervalSec), timeoutMs: Number(draft.timeoutMs), retries: Number(draft.retries),
      fallback: draft.fallback, status: draft.status, quota,
    })
    if (!r.ok) { setMsg({ tone: 'bad', text: `保存失败：${r.reason}` }); return }
    setMsg({ tone: 'good', text: `已保存为 v${r.version}${r.diffs.length ? `：${r.diffs.join('；')}` : '（无字段变化）'}。配置生效无需改代码，历史已留痕。` })
  }

  const toReal = () => {
    const r = connectorStore.switchMode(cur.id, 'real')
    if (!r.ok) { setMsg({ tone: 'bad', text: r.reason ?? '切换失败' }); return }
    notifyStore.push('一般', `接入方式切换：${cur.name}`, `已切换为真实接口（${cur.transport} · ${cur.endpoint}），配置版本 v${r.version}。下一步做真实探活。`, '外部接入配置')
    setMsg({ tone: 'good', text: `已切到真实接口（v${r.version}）。平台侧代码未变，变的只是这条配置。` })
  }
  const toVirtual = () => {
    const r = connectorStore.switchMode(cur.id, 'virtual')
    setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `已切回虚拟模拟通道（v${'version' in r ? r.version : ''}），联调前占位可用` : r.reason ?? '切换失败' })
  }
  const probe = () => {
    const r = connectorStore.probe(cur.id)
    const rec = connectorStore.find(cur.id)?.probe
    if (!r.ok) { setMsg({ tone: 'bad', text: `探活失败：${rec?.msg ?? r.reason ?? '未知原因'}` }); return }
    notifyStore.push('一般', `接入探活：${cur.name}`, `${MODE_LABEL[cur.mode]}通道探活成功 · ${rec?.ms} ms · 返回 ${rec?.rows} 条样本`, '外部接入配置')
    setMsg({ tone: 'good', text: `探活成功：${rec?.ms} ms · ${rec?.rows} 条样本 · ${rec?.msg}` })
  }
  const runImport = () => {
    const r = connectorStore.importText(importText)
    setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `导入完成：新增 ${r.created} 条 / 更新 ${r.updated} 条（逐条 version +1，可回看变更历史）` : `导入未完成：${r.errors.join('；')}` })
  }

  const list = tab === '状态清单' ? ints : ints
  const sysCount = ints.filter((c) => KIND_GROUP[c.kind] === '系统').length
  const resCount = ints.filter((c) => KIND_GROUP[c.kind] === '资源').length

  return (
    <div>
      <PageHead
        title="外部接入配置中心"
        desc="外部系统与外部资源统一用「接入配置」解决：先虚拟模拟，真实资源到位后只改这条配置"
        extra={
          <>
            <Badge tone="info">虚拟模拟 {ints.filter((c) => c.mode === 'virtual').length} / 真实接口 {ints.filter((c) => c.mode === 'real').length}</Badge>
            <Badge tone="warn">{ints.filter((c) => !c.enabled).length} 项通道未启用</Badge>
            <button className="btn sm ghost" onClick={() => { connectorStore.reset(); pick(connectorStore.find('r-gpu')!); setMsg({ tone: 'good', text: '接入配置已恢复默认演示值' }) }}>恢复默认配置</button>
          </>
        }
      />

      {msg ? (
        <div className={`callout ${msg.tone === 'bad' ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div>{msg.text}</div>
        </div>
      ) : null}

      <div className="grid g-6">
        <Kpi label="接入配置项" value={ints.length} unit="条" foot={`外部系统 ${sysCount} · 外部资源 ${resCount}`} />
        <Kpi label="可直接切真实接口" value={readyReal} unit="条" foot="就绪校验通过（地址 + 状态 + 前置条件）" />
        <Kpi label="扩租算力额度" value={rent.quota} unit="卡" foot={<>{rent.enabled ? <span className="up">✔ 通道已启用</span> : <span className="down">● 未启用</span>} · {rent.price} 元/卡/日 · 已开 {engRent.used} 卡 · 剩 {engRent.available} 卡</>} />
        <Kpi label="外部 Token 配额" value={llm.quotaTokensWan.toLocaleString('zh-CN')} unit="万/日" foot={`${llm.price} 元/万 token · ${llm.enabled ? '渠道已启用' : '渠道未启用（权重不可上调）'}`} />
        <Kpi label="平均采集频率" value={Math.round(ints.reduce((s, c) => s + (c.intervalSec || 60), 0) / Math.max(1, ints.length))} unit="秒" foot="事件触发按 60 秒折算" />
        <Kpi label="可切协议种类" value={TRANSPORTS.length} unit="种" foot="REST / SOAP / MCP / Kafka / Syslog / 视图 / SFTP / gRPC" />
      </div>

      <div className="row between wrap" style={{ margin: '14px 0 10px' }}>
        <Tabs items={TABS} active={tab} onChange={setTab} />
        <span className="small faint">当前选中：{cur.name}（v{cur.version} · 更新 {cur.updatedAt}）</span>
      </div>

      <div className="grid g-21">
        <Panel title="接入配置台账" extra={perm.manage ? '可编辑 · 可探活 · 可切虚拟 / 真实' : '当前角色只读'} noPad>
          <div className="panel-body">
            <Table
              minWidth={1180}
              head={['接入对象', '类别 / 方向', '接入方式', '协议 / 地址', '采集项', '频率 · 超时 · 重试', '降级策略', '配额 / 计费', '状态 · 版本', '通道', '操作']}
              rows={list.map((c) => [
                <button className="btn sm ghost" style={{ textAlign: 'left', maxWidth: 210 }} onClick={() => pick(c)}><span className="strong small">{c.name}</span></button>,
                <span className="small">{c.kind}<div className="tiny faint">{c.direction}</div></span>,
                <span className="small">{MODE_LABEL[c.mode]}<div className="tiny faint">{c.mode === 'virtual' ? '演示 / 联调占位' : '真实通道'}</div></span>,
                <span className="small">{c.transport}<div className="tiny faint mono" style={{ maxWidth: 200 }}>{c.endpoint}</div></span>,
                <span className="tiny" style={{ maxWidth: 230 }}>{c.dataItems}</span>,
                <span className="num small">{freqLabel(c.intervalSec)}<div className="tiny faint">{c.timeoutMs} ms · 重试 {c.retries}</div></span>,
                <span className="tag gray">{c.fallback}</span>,
                <span className="small">{quotaLabel(c)}</span>,
                <span className="small">{c.status}<div className="tiny faint mono">v{c.version} · {c.updatedAt}</div></span>,
                <State s={c.enabled ? (c.health === 'ok' ? 'good' : c.health === 'warn' ? 'warn' : 'fault') : 'off'} />,
                perm.manage ? (
                  <div className="row gap6">
                    <button className="btn sm" onClick={() => { pick(c); setTab('接入配置') }}>配置</button>
                    <button className="btn sm ghost" onClick={() => { pick(c); const r = connectorStore.probe(c.id); const rec = connectorStore.find(c.id)?.probe; setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${c.name} 探活成功：${rec?.ms} ms · ${rec?.rows} 条样本` : `${c.name} 探活失败：${rec?.msg}` }) }}>探活</button>
                  </div>
                ) : <span className="tiny faint">只读</span>,
              ])}
            />
          </div>
        </Panel>

        <div>
          <Panel title={`配置编辑：${cur.name}`} extra={`当前 v${cur.version} · 责任方 ${cur.owner}`} noPad>
            <div className="panel-body">
              <div className="col gap6">
                <div className="row gap6 wrap">
                  <div>
                    <div className="tiny faint">接入方式</div>
                    <div className="row gap6" style={{ marginTop: 4 }}>
                      <button className={`btn sm ${cur.mode === 'virtual' ? 'primary' : ''}`} disabled={!perm.manage} onClick={toVirtual}>虚拟模拟</button>
                      <button className={`btn sm ${cur.mode === 'real' ? 'primary' : ''}`} disabled={!perm.manage} onClick={toReal}>真实接口</button>
                    </div>
                  </div>
                  <div>
                    <div className="tiny faint">通道开关</div>
                    <button className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} onClick={() => { const r = connectorStore.setEnabled(cur.id, !cur.enabled); setMsg({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `通道已${cur.enabled ? '停用' : '启用'}` : `不能启用：${r.reason}` }) }}>{cur.enabled ? '停用它' : '启用它'}</button>
                  </div>
                  <div>
                    <div className="tiny faint">接口状态</div>
                    <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={draft.status} onChange={(e) => set({ status: e.target.value as IntStatus })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                <div className="row gap6 wrap">
                  <div>
                    <div className="tiny faint">传输协议</div>
                    <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={draft.transport} onChange={(e) => set({ transport: e.target.value })}>
                      {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="tiny faint">鉴权方式</div>
                    <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={draft.auth} onChange={(e) => set({ auth: e.target.value })}>
                      {AUTHS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="tiny faint">降级策略（采不到时怎么办）</div>
                    <select className="btn sm" style={{ marginTop: 4 }} disabled={!perm.manage} value={draft.fallback} onChange={(e) => set({ fallback: e.target.value })}>
                      {FALLBACKS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <div className="tiny faint">接入地址（真实接入时填这里，虚拟阶段留「（未填）」）</div>
                  <input className="btn sm" style={{ marginTop: 4, width: '100%' }} disabled={!perm.manage} value={draft.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="如 https://10.32.8.17:8443/api/v1/agent/usage" />
                </div>
                <div>
                  <div className="tiny faint">采集项（字段清单，协议逐步完善就是这一栏逐版补齐）</div>
                  <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 52 }} disabled={!perm.manage} value={draft.dataItems} onChange={(e) => set({ dataItems: e.target.value })} />
                </div>
                <div className="row gap6 wrap">
                  <div>
                    <div className="tiny faint">采集频率（秒，0=事件触发）</div>
                    <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" disabled={!perm.manage} value={draft.intervalSec} onChange={(e) => set({ intervalSec: Number(e.target.value) })} />
                  </div>
                  <div>
                    <div className="tiny faint">超时（ms）</div>
                    <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" disabled={!perm.manage} value={draft.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} />
                  </div>
                  <div>
                    <div className="tiny faint">重试次数</div>
                    <input className="btn sm" style={{ marginTop: 4, width: 90 }} type="number" disabled={!perm.manage} value={draft.retries} onChange={(e) => set({ retries: Number(e.target.value) })} />
                  </div>
                </div>

                {cur.quota ? (
                  <div className="row gap6 wrap">
                    {cur.quota.cards !== undefined ? (
                      <>
                        <div><div className="tiny faint">扩租额度（卡）</div><input className="btn sm" style={{ marginTop: 4, width: 100 }} type="number" disabled={!perm.manage} value={draft.cards} onChange={(e) => set({ cards: e.target.value })} /></div>
                        <div><div className="tiny faint">单价（元 / 卡 / 日）</div><input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" disabled={!perm.manage} value={draft.price} onChange={(e) => set({ price: e.target.value })} /></div>
                      </>
                    ) : null}
                    {cur.quota.tokensWanPerDay !== undefined ? (
                      <>
                        <div><div className="tiny faint">日 Token 配额（万）</div><input className="btn sm" style={{ marginTop: 4, width: 120 }} type="number" disabled={!perm.manage} value={draft.tokens} onChange={(e) => set({ tokens: e.target.value })} /></div>
                        <div><div className="tiny faint">单价（元 / 万 token）</div><input className="btn sm" style={{ marginTop: 4, width: 120 }} type="number" disabled={!perm.manage} value={draft.price} onChange={(e) => set({ price: e.target.value })} /></div>
                      </>
                    ) : null}
                    {cur.quota.tb !== undefined ? (<div><div className="tiny faint">容量（TB）</div><input className="btn sm" style={{ marginTop: 4, width: 100 }} type="number" disabled={!perm.manage} value={draft.tb} onChange={(e) => set({ tb: e.target.value })} /></div>) : null}
                  </div>
                ) : null}

                <div className="divider" />
                <div className="small strong">切换真实接口的前置条件（勾选才算就绪）</div>
                {cur.prereq.map((p) => (
                  <label key={p} className="row gap6 small" style={{ marginTop: 6 }}>
                    <input type="checkbox" disabled={!perm.manage} checked={cur.prereqDone.includes(p)} onChange={() => connectorStore.togglePrereq(cur.id, p)} />
                    {p}
                  </label>
                ))}
                {missing.length ? <div className="tiny" style={{ color: '#ffb3b3', marginTop: 8 }}>未就绪：{missing.join(' / ')}</div> : <div className="tiny up" style={{ marginTop: 8 }}>就绪校验通过，可切换到真实接口</div>}

                <div className="row gap6" style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={!perm.manage} onClick={save}>保存配置（版本 +1）</button>
                  <button className="btn" disabled={!perm.manage} onClick={probe}>探活 / 试采</button>
                  <button className="btn ghost" onClick={() => { setDraft(toDraft(cur)); setMsg({ tone: 'good', text: '已放弃未保存的修改' }) }}>放弃修改</button>
                </div>

                <div className="divider" />
                <div className="small strong">配置变更历史（协议与字段逐版完善的记录）</div>
                {cur.changes.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>暂无变更记录</div> : (
                  <ul className="tiny" style={{ margin: '6px 0 0 16px', lineHeight: 1.9, color: '#a9c4e8' }}>
                    {cur.changes.map((c, i) => <li key={i}>{c.time} · {c.text}</li>)}
                  </ul>
                )}
                {cur.probe ? <div className="tiny faint" style={{ marginTop: 8 }}>最近探活：{cur.probe.time} · {cur.probe.ok ? `成功 ${cur.probe.ms} ms / ${cur.probe.rows} 条` : `失败`} · {cur.probe.msg}</div> : null}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {tab === '新增接入' ? (
        <Panel title="新增接入配置（新外部系统 / 新外部资源）" extra="新增即虚拟模拟通道，接口到位后改这条配置切真实" noPad>
          <div className="panel-body">
            <div className="col gap6">
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">接入对象名称</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 260 }} value={nName} onChange={(e) => setNName(e.target.value)} placeholder="如：视频专网 NPU 集群调度接口 / 第三方 GPU 扩租池 B" />
                </div>
                <div>
                  <div className="tiny faint">类别</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={nKind} onChange={(e) => setNKind(e.target.value as ConnKind)}>
                    {(['已建子系统', '安全设备', '基础服务', '外部算力资源', '外部模型渠道', '外部存储与备份', '外部数据源', '监控与日志外送'] as ConnKind[]).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">责任方</div>
                  <input className="btn sm" style={{ marginTop: 4, minWidth: 150 }} value={nOwner} onChange={(e) => setNOwner(e.target.value)} />
                </div>
              </div>
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">传输协议</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={nTransport} onChange={(e) => setNTransport(e.target.value)}>
                    {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">鉴权方式</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={nAuth} onChange={(e) => setNAuth(e.target.value)}>
                    {AUTHS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">采集频率（秒，0=事件触发）</div>
                  <input className="btn sm" style={{ marginTop: 4, width: 120 }} type="number" value={nFreq} onChange={(e) => setNFreq(e.target.value)} />
                </div>
                {KIND_GROUP[nKind] === '资源' ? (
                  <>
                    <div>
                      <div className="tiny faint">资源额度（卡 / 万 token / TB）</div>
                      <input className="btn sm" style={{ marginTop: 4, width: 110 }} type="number" value={nCards} onChange={(e) => setNCards(e.target.value)} />
                    </div>
                    <div>
                      <div className="tiny faint">单价（元 / 卡 / 日 或 元 / 万 token）</div>
                      <input className="btn sm" style={{ marginTop: 4, width: 130 }} type="number" value={nPrice} onChange={(e) => setNPrice(e.target.value)} />
                    </div>
                  </>
                ) : null}
              </div>
              <div>
                <div className="tiny faint">采集项 / 提供能力</div>
                <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 52 }} value={nItems} onChange={(e) => setNItems(e.target.value)} placeholder="如：可用卡位、卡型、单价、开卡与回收结果；或：应用元数据、运行日志、调用统计" />
              </div>
              <div>
                <div className="tiny faint">前置条件（一行一条，留空用默认三条：接口文档 / 联调环境 / 执行回执）</div>
                <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 52 }} value={nPrereq} onChange={(e) => setNPrereq(e.target.value)} placeholder="卡型与单价书面确认&#10;跨网白名单与网络策略&#10;开卡审批归口与限额" />
              </div>
              <div className="row gap6">
                <button
                  className="btn primary"
                  disabled={!perm.manage || !nName.trim() || !nOwner.trim()}
                  onClick={() => {
                    const isRes = KIND_GROUP[nKind] === '资源'
                    const quota = !isRes ? undefined
                      : nKind === '外部算力资源' ? { cards: Number(nCards) || 0, pricePerCardDay: Number(nPrice) || 0 }
                      : nKind === '外部模型渠道' ? { tokensWanPerDay: Number(nCards) || 0, pricePerTokenWan: Number(nPrice) || 0.9 }
                      : { tb: Number(nCards) || 0 }
                    const r = connectorStore.add({
                      name: nName, kind: nKind, transport: nTransport, auth: nAuth, dataItems: nItems, intervalSec: Number(nFreq),
                      owner: nOwner, quota, prereq: nPrereq.split('\n').map((x) => x.trim()).filter(Boolean),
                    })
                    if (!r.ok) { setMsg({ tone: 'bad', text: `新增失败：${r.reason}` }); return }
                    notifyStore.push('一般', `新增接入配置：${r.name}`, `${r.id} · ${nKind} · ${nTransport} · 责任方 ${nOwner}。当前为虚拟模拟通道且未启用，接口到位后填地址并切真实接口。`, '外部接入配置')
                    const created = connectorStore.find(r.id)!
                    pick(created)
                    setNName(''); setNItems(''); setNPrereq('')
                    setMsg({ tone: 'good', text: `已新增接入配置 ${r.id}（v1 · 虚拟模拟 · 通道未启用）。下一步：探活 → 确认接口状态「已定」→ 勾选前置条件 → 切真实接口；若它是算力资源，启用后可直接用于扩容补卡位。` })
                  }}
                >新增这条接入配置
                </button>
                <span className="small faint">新增条目立即进入台账与「统一接管范围」的可选接入列表；重名会被拒。</span>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {tab === '状态清单' ? (
        <div className="grid g-21 mt14">
          <Panel title="商定状态与卡点（谈判用）" extra="演示现场可逐项确认为已定 / 待商定 / 待客户方提供" noPad>
            <div className="panel-body">
              <Table
                minWidth={900}
                head={['接入对象', '类型', '接口状态', '卡点（blocking）', '责任方', '通道状态', '操作']}
                rows={ints.map((c) => [
                  <span className="strong small">{c.name}</span>,
                  <span className="tag gray">{c.kind}</span>,
                  perm.manage ? (
                    <select className="btn sm" value={c.status} onChange={(e) => connectorStore.setStatus(c.id, e.target.value as IntStatus)}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : <Badge tone={c.status === '已定' ? 'good' : c.status === '待商定' ? 'warn' : 'bad'}>{c.status}</Badge>,
                  <span className="tiny" style={{ maxWidth: 320 }}>{c.blocking}</span>,
                  <span className="small faint">{c.owner}</span>,
                  <State s={c.enabled ? (c.health === 'ok' ? 'good' : c.health === 'warn' ? 'warn' : 'fault') : 'off'} />,
                  perm.manage ? (
                    <div className="row gap6">
                      {c.health === 'fault'
                        ? <button className="btn sm primary" onClick={() => intStore.setHealth(c.id, 'ok')}>恢复通道</button>
                        : <button className="btn sm danger" onClick={() => intStore.setHealth(c.id, 'fault')}>模拟中断</button>}
                    </div>
                  ) : <span className="tiny faint">只读</span>,
                ])}
              />
            </div>
          </Panel>
          <Panel title="中断后的真实影响（可现场演示）">
            {ints.filter((c) => c.health !== 'ok').length === 0 ? (
              <div className="small" style={{ color: '#a9c4e8', lineHeight: 1.9 }}>当前所有通道正常。点任一对象的「模拟中断」，对应纳管页面会立即出现数据缺口提示，并生成一条「重要」通知。</div>
            ) : (
              <div>
                {ints.filter((c) => c.health !== 'ok').map((c) => (
                  <div key={c.id} style={{ marginBottom: 10 }}>
                    <div className="row gap6"><span className="small strong">{c.name}</span><State s={c.health === 'warn' ? 'warn' : 'fault'} /></div>
                    <div className="tiny" style={{ color: '#ffb3b3', marginTop: 3 }}>缺口：{c.dataItems} · 降级策略：{c.fallback}</div>
                  </div>
                ))}
              </div>
            )}
            <Callout warn text="待定接口在这里变成可视化议题清单，确认为「已定」后，同一接入在配置页即可切换真实通道，不需要再改平台代码。" />
          </Panel>
        </div>
      ) : null}

      {tab === '配置字段与导入导出' ? (
        <div className="grid g-2 mt14">
          <Panel title="配置字段说明（真实接入时逐字段替换）" noPad>
            <div className="panel-body">
              <Table
                minWidth={880}
                head={['配置字段', '虚拟模拟阶段', '真实接入阶段', '是否影响平台计算']}
                rows={[
                  [<span className="mono small">mode</span>, <span className="small">virtual：平台内置模拟数据</span>, <span className="small">real：按地址与协议实际采集</span>, <span className="small">是（缺口提示与降级策略）</span>],
                  [<span className="mono small">transport</span>, <span className="small">先按建议协议占位</span>, <span className="small">按对方接口文档替换（REST / SOAP / Kafka / Syslog…）</span>, <span className="small">否（决定采集实现）</span>],
                  [<span className="mono small">endpoint</span>, <span className="small">（未填）</span>, <span className="small">真实地址 + 端口 + 路径</span>, <span className="small">切真实时必填</span>],
                  [<span className="mono small">auth</span>, <span className="small">按建议方式</span>, <span className="small">实际票据 / 白名单 / 双向 TLS</span>, <span className="small">否（安全域实现）</span>],
                  [<span className="mono small">intervalSec / timeoutMs / retries</span>, <span className="small">演示默认值</span>, <span className="small">按对方容量与 SLA 调</span>, <span className="small">是（缺口与告警频次）</span>],
                  [<span className="mono small">fallback</span>, <span className="small">保留最近一次 / 标记不可采集 / 转人工</span>, <span className="small">按归口确认真实兜底方式</span>, <span className="small">是（页面缺口与报表口径）</span>],
                  [<span className="mono small">quota + 计费口径</span>, <span className="small">8 卡 / 260 元；3000 万 token / 0.9 元</span>, <span className="small">按合同与结算口径填</span>, <span className="small">是（卡位、成本与分摊）</span>],
                  [<span className="mono small">prereq / prereqDone</span>, <span className="small">演示列出待确认项</span>, <span className="small">逐项完成后才允许切真实</span>, <span className="small">是（切换门禁）</span>],
                ]}
              />
              <Callout text={<>接入方式与地址在这里改，平台功能不变。<b>协议可以逐版完善</b>：每次保存 version +1 并留下变更文本，联调时按版本对字段，不用重新开发。</>} />
            </div>
          </Panel>

          <Panel title="配置导入导出（换环境 / 换对接方时用同一份配置）" noPad>
            <div className="panel-body">
              <div className="row gap6" style={{ marginBottom: 10 }}>
                <button className="btn sm" onClick={() => setImportText(connectorStore.exportJson())}>把当前 {ints.length} 条配置载入文本框</button>
                <button className="btn sm ghost" onClick={() => downloadText('外部接入配置.json', connectorStore.exportJson(), 'application/json')}>下载 JSON 配置</button>
                <button className="btn sm ghost" onClick={() => { const { head, rows } = connectorStore.exportCsv(); downloadCsv('外部接入配置台账', head, rows) }}>下载配置台账 CSV</button>
              </div>
              <textarea
                className="btn sm mono" style={{ width: '100%', minHeight: 210, fontSize: 11.5 }}
                value={importText} onChange={(e) => setImportText(e.target.value)}
                placeholder='[{"id":"i-mcp","name":"MCP 服务平台","transport":"MCP 协议","endpoint":"https://10.20.6.31:9443/mcp","mode":"real","intervalSec":30,"prereq":["目录同步方向与冲突处理规则","健康探针字段定义","隔离指令下发与回执"],"prereqDone":["目录同步方向与冲突处理规则","健康探针字段定义","隔离指令下发与回执"],"status":"已定"}]'
              />
              <div className="row gap6" style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={!perm.manage || !importText.trim()} onClick={runImport}>导入这份配置</button>
                <span className="small faint">同 id 覆盖并版本 +1；新 id 直接新增；字段不合法会逐条报错并拒绝写入。</span>
              </div>
            </div>
          </Panel>
        </div>
      ) : null}

      <Panel title="两项配置会直接改变平台能力（可现场验证）" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={900}
            head={['配置项', '当前值', '对平台的真实影响', '怎么现场验证']}
            rows={[
              [<span className="small strong">外部算力扩租通道</span>, <span className="small">{rent.enabled ? '已启用' : '未启用'} · 额度 {rent.quota} 卡 · {rent.price} 元/卡/日 · 已开 {engRent.used} 卡 / 剩 {engRent.available} 卡</span>, <span className="small">启用后，本地空闲不足时扩容工单可用「外部扩租」补足卡位，成本按这里的单价计入外部成本；未启用则扩容被准入拒绝并写明缺什么</span>, <Link to="/ops/workflow" className="small">去资源调配工作台提交一笔超出空闲的扩容</Link>],
              [<span className="small strong">外部模型渠道接入</span>, <span className="small">{llm.enabled ? '已启用' : '未启用'} · 配额 {llm.quotaTokensWan.toLocaleString('zh-CN')} 万 token/日 · {llm.price} 元/万 token</span>, <span className="small">未启用时，路由权重不允许上调到外部厂商渠道（准入直接拒），外部 Token 成本随之为 0</span>, <Link to="/model/gateway" className="small">去推理网关做一次权重调整</Link>],
              [<span className="small strong">通道健康与降级策略</span>, <span className="small">{ints.filter((c) => c.health !== 'ok').length} 项异常 · 降级方式逐条配置</span>, <span className="small">中断后对应纳管页面出现数据缺口提示、生成通知，报表按「保留最近一次」或「标记不可采集」口径出数</span>, <Link to="/app/agents" className="small">去智能体纳管页看缺口提示</Link>],
            ]}
          />
          <Callout text="这就是「以配置方式解决接入」：今天这些对象是虚拟模拟的数据源，真实资源到位后把 mode 改成真实接口、填地址、勾完前置条件即可，采集实现与费用口径都从配置读；协议与字段在版本迭代里逐版补齐，历史可追溯。" />
        </div>
      </Panel>
    </div>
  )
}


