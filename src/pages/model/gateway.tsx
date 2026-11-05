import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout } from '../../components/ui'
import { gatewayEndpoints, tools as gatewayTools } from '../../data/mock'
import { useEngine, engine, DIRECTORY_KINDS } from '../../engine/engine'
import { ledgerOf } from '../../engine/ledger'
import { usePerm } from '../../engine/auth'

const STRATEGIES = [
  { name: '固定优先级', desc: '高保服务集群优先放行，核心业务（报告撰写、咨询问答）独立队列保障' },
  { name: '权重分流', desc: '当前权重 50 / 30 / 20，每周复核渠道利用率与负载偏离度（>30% 触发优化）' },
  { name: '延迟优先', desc: '同等健康度下路由至 p95 延迟最低的渠道，持续劣化渠道自动降权' },
  { name: '业务分级路由', desc: '高保队列与共享队列隔离，资源紧张时低优流量先行限流' },
  { name: '限流与配额', desc: '按租户配置 RPM / TPM / 并发上限，触顶预警并支持超额阻断' },
  { name: '主备降级切换', desc: '主渠道故障或错误率持续超阈，自动切换备用渠道 / 降级链路并通知业务方' },
]

const card = {
  border: '1px solid rgba(64,130,220,.18)',
  background: 'rgba(23,48,90,.28)',
  borderRadius: 10,
  padding: '10px 12px',
}

export default function Gateway() {
  const st = useEngine()
  const L = ledgerOf(st)
  const canGate = usePerm('gateway').manage
  const gatewayChannels = st.channels
  const [target, setTarget] = useState(gatewayChannels[0]?.id ?? 'ascend')
  const [flash, setFlash] = useState<string | null>(null)
  const fo = st.failover ?? null
  const drills = st.orders.filter((o) => o.applicant === '运行监测 · 自动处置')
  const gate = usePerm('gateway')
  const [dflash, setDFlash] = useState<string | null>(null)
  return (
    <div>
      <PageHead
        title="推理网关"
        desc="统一推理入口 · 多厂商协议统一映射 OpenAI 兼容格式 · 全链路鉴权 / 限流 / 审计（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">端点可用率 99.97%</Badge>
            <Badge tone="info">国密 TLS 已启用</Badge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="在线渠道" value={st.channels.length} unit="个" foot={`本地 ${st.channels.filter((c) => c.kind === '本地').length} · 外部 ${st.channels.filter((c) => c.kind === '外部').length} · 异常 ${st.channels.filter((c) => c.health !== 'ok').length}`} />
        <Kpi label="能力 API 端点" value={gatewayEndpoints.length} unit="个" foot="Chat / Embed / Rerank / ASR / Batch" />
        <Kpi label="当前 QPS" value={Math.max(1, Math.round(L.callsToday / 86400))} foot={`今日 ${(L.callsToday / 10000).toFixed(1)} 万次 · 与总览同源`} />
        <Kpi label="故障切换" value={fo ? '生效中' : '空闲'} foot={`自动切换演练 ${drills.length} 次 · 均可回切`} />
      </div>

      <Panel title="渠道故障切换（自动处置演练）" extra="健康探测失败 → 自动切换备用渠道并降权 → 通知受影响业务方 → 登记事件台账 → 恢复后回切" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            <div className="row gap6">
              <span className="small faint">当前状态</span>
              {fo ? <State s="run" /> : <State s="good" />}
              <span className="small">
                {fo ? `${fo.channelName} → ${fo.toChannel}（${fo.at}）· 异常渠道权重已降至 5%` : '无生效中的切换 · 各渠道权重正常'}
              </span>
            </div>
            <div>
              <div className="tiny faint">演练目标渠道</div>
              <select className="btn sm" style={{ marginTop: 4 }} value={target} onChange={(e) => setTarget(e.target.value)}>
                {gatewayChannels.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.health === 'ok' ? '健康' : '异常'}）</option>)}
              </select>
            </div>
            <div className="row gap6">
              <button className="btn sm" disabled={!canGate} onClick={() => { const r = engine.degradeChannel(target); setFlash(r.ok ? `已模拟 ${gatewayChannels.find((c) => c.id === target)?.name} 探测失败（错误率抬升、p95 超 200ms）` : r.reason ?? '') }}>模拟渠道劣化</button>
              <button className="btn sm primary" disabled={!canGate} onClick={() => { const r = engine.failover(); setFlash(r.ok ? `已自动切换：${r.from} → ${r.to} · 切换工单 ${r.orderId} · 受影响应用 ${r.affected?.length ?? 0} 项已通知` : r.reason ?? '') }}>触发自动切换</button>
              <button className="btn sm ghost" disabled={!canGate || !fo} onClick={() => { const r = engine.restoreFailover(); setFlash(r.ok ? `已回切至变更前权重方案 ${r.weights}` : r.reason ?? '') }}>执行回切</button>
            </div>
          </div>

          {flash ? (
            <div className="callout" style={{ marginTop: 12 }}>
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
              <div>{flash}</div>
            </div>
          ) : null}

          {fo && fo.affectedApps.length ? (
            <div className="row wrap gap6" style={{ marginTop: 12 }}>
              <span className="small faint">受影响业务方（已推送变更通知）</span>
              {fo.affectedApps.map((a) => <span key={a} className="tag amber">{a}</span>)}
            </div>
          ) : null}

          {drills.length ? (
            <div style={{ marginTop: 12 }}>
              <Table
                head={['切换工单', '触发原因', '权重变化', '状态', '留痕节点']}
                rows={drills.map((o) => [
                  <span className="mono small">{o.id}</span>,
                  <span className="tiny faint" style={{ maxWidth: 320 }}>{o.reason}</span>,
                  <span className="mono small">{o.target} {o.amount}</span>,
                  <State s={o.status === 'submitted' ? 'pending' : o.status === 'queued' ? 'queued' : o.status === 'running' ? 'run' : o.status === 'rejected' ? 'block' : o.status === 'rolled_back' ? 'rollback' : 'closed'} />,
                  <span className="tiny faint">{o.trace.map((t) => t.action).join(' → ')}</span>,
                ])}
                minWidth={900}
              />
            </div>
          ) : null}

          <Callout text="切换由自动处置工单承载，因此同样受变更窗口与准入校验约束：若窗口被占用，切换工单进入队列并在 trace 中记录；无健康备用渠道时不切换，改为执行入口限流保护并升级为「紧急」事件。" />
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="渠道状态" extra="实时健康探测 · 连续 3 次不可用即切换" noPad>
          <div className="panel-body">
            <Table
              head={['渠道', '类型', '副本', 'p95 延迟', '错误率', '配额占用', '权重', '状态']}
              rows={gatewayChannels.map((c) => [
                <span className="strong">{c.name}</span>,
                <Badge tone={c.kind === '本地' ? 'muted' : 'info'}>{c.kind}</Badge>,
                <span className="num">{c.replicas || '—'}</span>,
                <span className="num">{c.latency}ms</span>,
                c.err > 1 ? <Badge tone="warn">{c.err}%</Badge> : <span className="num">{c.err}%</span>,
                <span className="num small">{c.allocatedRpm} / {c.capacityRpm} RPM</span>,
                <span className="num strong">{c.weight}%</span>,
                <State s={c.health} />,
              ])}
              minWidth={820}
            />
          </div>
        </Panel>
        <Panel title="能力 API 端点" extra="统一协议栈 · 禁止无认证接口对外" noPad>
          <div className="panel-body">
            <Table
              head={['API', '能力', '今日调用', '状态']}
              rows={gatewayEndpoints.map((e) => [
                <span className="mono strong">{e.api}</span>,
                e.desc,
                <span className="num">{e.today}</span>,
                <State s={e.status} />,
              ])}
              minWidth={420}
            />
          </div>
        </Panel>
      </div>

      <Panel title="MCP 工具 / 插件 / Skill 目录联动（技术注册目录 ↔ 业务使用目录）" extra="模型侧注册与业务侧上架双向同步 · 隔离即两侧同时摘除并断开调用路由" className="mt14" noPad>
        <div className="panel-body">
          {dflash ? (
            <div className="callout" style={{ marginBottom: 12 }}>
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
              <div>{dflash}</div>
            </div>
          ) : null}
          <Table
            minWidth={960}
            head={['工具 / 插件', '类型与版本', '归口', '技术注册目录（模型侧）', '业务使用目录（应用侧）', '运行质量（实时）', '目录一致性', '模型侧操作']}
            rows={st.managed.filter((m) => DIRECTORY_KINDS.includes(m.kind)).map((m) => {
              const meta = gatewayTools.find((t) => t.name === m.name)
              const act = m.tech || m.biz ? '隔离出目录' : '重新纳入'
              return [
                <span className="strong small">{m.name}<div className="tiny faint">{m.id} · {m.level}队列</div></span>,
                <span className="tag gray">{m.kind}</span>,
                <span className="small">{meta?.version ?? '—'}<div className="tiny faint">{m.owner}</div></span>,
                m.tech ? <Badge tone="good">已注册 · 可调用</Badge> : <Badge tone="bad">已摘除 · 路由已断开</Badge>,
                m.biz ? <Badge tone="good">已上架 · 业务可见</Badge> : <Badge tone="warn">未上架 / 待同步</Badge>,
                <span className="num small">成功率 {m.success.toFixed(1)}%<div className="tiny faint">失败率 {m.failRate.toFixed(1)}% · 队列 {m.queue}</div></span>,
                m.tech === m.biz && m.status === '正常' ? <Badge tone="good">一致</Badge> : <Badge tone="warn">不一致 · 需双方确认</Badge>,
                <div className="row gap6">
                  <span className="tiny faint">{m.status === '正常' ? '' : m.status}</span>
                  {gate.manage ? (
                    <button
                      className={`btn sm ${act === '重新纳入' ? 'primary' : 'danger'}`}
                      onClick={() => {
                        const r = engine.submit({ type: 'containment', applicant: '模型中心 · 网关值守', dept: '模型中心', level: m.level, reason: `模型侧发起「${act}」：${m.name} 的注册状态与业务上架状态需同步（当前技术侧${m.tech ? '在册' : '摘除'} / 业务侧${m.biz ? '在册' : '摘除'}）`, spec: { kind: m.kind, name: m.name, action: act, basis: '人工分析' } })
                        setDFlash(r.precheck.ok ? `已提交 ${r.order.id}：${r.precheck.suggest ?? ''}` : `模型侧操作被拒：${r.precheck.reason}`)
                      }}
                    >{act}</button>
                  ) : <span className="tiny faint">无处置权限（只读）</span>}
                </div>,
              ]
            })}
          />
          <Callout text={<>目录联动口径：模型侧「技术注册目录」登记工具的服务契约（版本、归口、健康探测），应用侧「业务使用目录」决定业务人员能否看到与调用。<b>任一侧执行隔离 / 禁用，两侧状态同时置为摘除并断开调用路由</b>；恢复须「重新纳入 / 启用」并由归口确认。当前不一致项 {st.managed.filter((m) => (DIRECTORY_KINDS.includes(m.kind)) && (m.tech !== m.biz || m.status !== '正常')).length} 项，需模型中心与业务归口双方确认后同步。</>} />
        </div>
      </Panel>

      <Panel title="权重调整（可执行）" extra="提交 → 校验权重合计与异常渠道上限 → 生效" className="mt14" noPad>
        <div className="panel-body">
          <div className="row wrap gap12">
            {[[60, 30, 10], [50, 30, 20], [70, 20, 10], [40, 40, 20]].map((w) => (
              <button
                key={w.join('/')}
                className={`btn sm ${st.channels.map((c) => c.weight).join('/') === w.join('/') ? 'primary' : ''}`}
                disabled={!canGate}
                onClick={() => {
                  const r = engine.submit({ type: 'weight_adjust', applicant: '网关运行保障岗', dept: '运营', level: '高保', reason: `渠道调度优化：权重调整为 ${w.join('/')}`, spec: { weights: w.join(',') } })
                  if (r.precheck.ok) engine.approve(r.order.id)
                }}
              >
                {w.join(' / ')}
              </button>
            ))}
            <span className="small faint">校验：权重合计须 100；错误率超阈的异常渠道权重不得超过 20%，否则直接驳回</span>
          </div>
          {st.orders.filter((o) => o.type === 'weight_adjust').length > 0 ? (
            <div className="mt14" style={{ marginTop: 14 }}>
              <Table
                head={['工单', '权重方案', '状态', '结论 / 驳回原因']}
                rows={st.orders.filter((o) => o.type === 'weight_adjust').slice(0, 5).map((o) => [
                  <span className="mono small">{o.id}</span>,
                  <span className="mono small">{String(o.spec.weights).replace(/,/g, ' / ')}</span>,
                  <State s={o.status === 'submitted' ? 'pending' : o.status === 'rejected' ? 'block' : o.status === 'running' ? 'run' : 'done'} />,
                  <span className="small" style={{ color: o.rejectReason ? '#ffb3b3' : '#a9c4e8' }}>{o.rejectReason ?? (o.trace[o.trace.length - 1]?.detail ?? '')}</span>,
                ])}
              />
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="mt14">
        <Panel title="路由与调度策略" extra="策略变更须审批留痕 · 支持灰度与回退">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            {STRATEGIES.map((s) => (
              <div key={s.name} style={card}>
                <div className="strong">{s.name}</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {s.name === '权重分流' ? `当前权重 ${st.channels.map((c) => c.weight).join(' / ')}（合计 100），每周复核渠道利用率与负载偏离度（>30% 触发优化）` : s.desc}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          warn
          text={
            <>
              安全红线：<b>上层应用必须经推理网关统一入口获取模型能力</b>，禁止绕过网关直咨询问底层厂商或渠道接口；无凭证、无鉴权请求一律拒绝，每次调用生成唯一 traceId，全链路日志留存可审计。
            </>
          }
        />
      </div>
    </div>
  )
}
