/* =====================================================================
 * 配置中心（v3.1 / v3.3 / v3.4 / v3.6 的「先内建、后迁移」开关）
 *   身份来源 / 审批来源 / 通知渠道 / 排班来源 / 处置指令确认超时 —— 全部是配置项，不改业务代码
 *   口径：试运行阶段本系统自己独立跑（内建模式）；外部来源做成适配器 + 映射表，
 *         材料到位后按「影子同步 → 双写核对 → 切主源」迁移；没配好的来源会明确拒绝，不静默降级
 * 权限：改配置需要「权限矩阵」操作权；排班与派单需要「资源调配」操作权
 * ===================================================================== */
import { useEffect, useState } from 'react'
import {Badge, Callout, Kpi, Panel, PageHead, Table, Tip} from '../../components/ui'
import { NAV } from '../../navCatalog'
import { DEMO_NAV, setView, useView } from '../../engine/view'
import { listLinks, loadConfig, saveConfig, syncLinks, useFlags, usePerm } from '../../engine/auth'
import { COLLECT_KINDS, buildSourceConfig, collectStore, useCollect } from '../../engine/collect'
import { apiSend } from '../../engine/db'
import { consoleStore, useConsole } from '../../engine/console'

const SOURCE_KEYS = ['auth-provider', 'approval-source', 'notify-channels', 'duty-source'] as const
const CHOICES: Record<string, { v: string; label: string }[]> = {
  'auth-provider': [
    { v: 'local', label: '平台内建账号（试运行默认 · 独立运行）' },
    { v: 'cas', label: 'CAS 单点登录（待客户方给协议版本）' },
    { v: 'oauth2', label: 'OAuth2 / OIDC（待客户方给签发方）' },
    { v: 'ldap', label: 'LDAP 目录（待客户方给基 DN）' },
  ],
  'approval-source': [
    { v: 'local', label: '平台内审批（默认 · 本系统审批台）' },
    { v: 'external', label: '外部审批系统（本系统只回写与跟踪）' },
  ],
  'notify-channels': [
    { v: 'site', label: '仅站内看板（最保守）' },
    { v: 'site,email', label: '站内 + 邮件（一期口径）' },
    { v: 'site,email,sms,im', label: '站内 + 邮件 + 短信 + 即时通讯（短信/IM 需客户方通道）' },
  ],
  'duty-source': [
    { v: 'local', label: '本系统排班表（试运行由建设团队安排）' },
    { v: 'external', label: '客户方值班系统（本系统只派单与跟踪）' },
  ],
}

export default function OpsSettings() {
  const flags = useFlags()
  const cons = useConsole()
  const col = useCollect()
  const [src, setSrc] = useState({ kind: 'services', name: '', base: '', api_key_env: '', format: '', interval_seconds: 60, extra: '' })
  const [colMsg, setColMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const view = useView()
  const matrixPerm = usePerm('matrix')
  const dutyPerm = usePerm('workflow')
  const [links, setLinks] = useState<any[]>([])
  const [syncText, setSyncText] = useState('ext-7701|示例岗位甲|ops\next-7702|示例岗位乙|user')
  const [syncMsg, setSyncMsg] = useState('')
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [shiftDraft, setShiftDraft] = useState<Record<string, Partial<any>>>({})
  const [routeDraft, setRouteDraft] = useState<Record<string, Partial<any>>>({})

  useEffect(() => {
    void loadConfig()
    void consoleStore.refresh()
    void listLinks().then((r) => setLinks(r.rows))
  }, [])
  useEffect(() => { setDraft({ ...flags.config }) }, [flags.config])
  useEffect(() => { void collectStore.refresh() }, [])

  const put = async (key: string, value: string) => {
    setErr('')
    const r = await saveConfig(key, value)
    if (!r.ok) setErr(key + ' 保存被拒：' + (r.error || ''))
  }

  const doSync = async () => {
    setSyncMsg('')
    const accounts = syncText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [external_id, name, role] = l.split(/[|,;\t]+/).map((x) => (x || '').trim())
      return { external_id, name, role }
    })
    if (!accounts.length) { setSyncMsg('先粘贴至少一行外部账号（每行：外部账号 | 姓名 | 角色）'); return }
    const r = await syncLinks(flags.config['auth-provider'] || 'local', accounts)
    if (!r.ok) { setSyncMsg('影子同步被拒：' + (r.error || '')); return }
    setSyncMsg('影子同步完成：共 ' + r.total + ' 条，可对应本地账号 ' + r.matched + ' 条，待绑定 ' + r.unmatched + ' 条（只读导入，不改本地账号）')
    const lr = await listLinks()
    setLinks(lr.rows)
  }

  const cfg = flags.config
  const prov = flags.providers[cfg['auth-provider'] || 'local']

  return (
    <>
      <PageHead title="配置中心 · 来源与派单开关" desc="同一套业务代码，来源可配：先内建独立运行，材料到位后切外部，不改接口契约" />

      <div className="grid g-4">
        <Kpi label="身份来源" value={cfg['auth-provider'] || 'local'} foot={prov?.label || ''} />
        <Kpi label="审批来源" value={cfg['approval-source'] || 'local'} foot={cfg['approval-source'] === 'external' ? '外部回写 + 超时兜底' : '本系统审批台'} />
        <Kpi label="通知渠道" value={cfg['notify-channels'] || 'site'} foot="一期：站内 + 邮件；短信/IM 等客户方通道" />
        <Kpi label="指令确认超时" value={(cfg['command-ack-timeout-min'] || '30') + ' 分钟'} foot="超时未确认自动转人工兜底" />
      </div>

      {!matrixPerm.manage ? <div className="mt14"><Callout text="你现在没有「权限矩阵」操作权，配置只能看不能改。改动本身在服务端判定，改前端没用。" /></div> : null}

      <Panel title="演示视图（哪些页面摆在台面上 · 存数据服务）" className="mt14" focus
        extra={<span className="tiny faint">当前 {view.mode === 'demo' ? '演示档 · 留 ' + view.nav.length + ' 个入口' : '完整模式 · 40 个入口全开'} · 次要面板{view.fold ? '收成一行' : '全部展开'}</span>}>
        <div className="row gap6 wrap">
          <button className={'btn sm' + (view.mode === 'demo' ? ' primary' : '')} disabled={!matrixPerm.manage}
            onClick={() => setView({ mode: 'demo' })}>演示档</button>
          <button className={'btn sm' + (view.mode === 'full' ? ' primary' : '')} disabled={!matrixPerm.manage}
            onClick={() => setView({ mode: 'full' })}>完整模式</button>
          <button className="btn sm ghost" disabled={!matrixPerm.manage}
            onClick={() => setView({ fold: !view.fold })}>{view.fold ? '次要面板改成全部展开' : '次要面板改回收成一行'}</button>
          <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => setView({ nav: DEMO_NAV })}>入口恢复默认清单</button>
          <Tip label="这一项改的是什么" text="只改界面把哪些页面摆在侧栏上、次要面板要不要折叠；功能、接口、权限、数据一个都没动。配置写进数据服务的状态键 dsh-demo-view-v1，换台电脑登录还是这套。正式实施时把模式切到「完整模式」即可全部启用。" />
        </div>
        <div className="divider" />
        <div className="tiny faint">演示档侧栏留哪些入口（勾掉 = 收进「正式实施再启用」那页，功能照常在）：</div>
        <div className="grid g-4 mt8">
          {NAV.map((g) => (
            <div key={g.group} className="panel" style={{ padding: '10px 12px' }}>
              <div className="tiny strong">{g.group}</div>
              {g.items.map((it) => (
                <label key={it.to} className="row gap6 tiny" style={{ alignItems: 'center', marginTop: 5 }}>
                  <input type="checkbox" disabled={!matrixPerm.manage} checked={view.nav.includes(it.to)}
                    onChange={() => setView({ nav: view.nav.includes(it.to) ? view.nav.filter((x) => x !== it.to) : [...view.nav, it.to] })} />
                  {it.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="来源配置（配置项，不是代码分支）" className="mt14">
        <Table minWidth={860} head={['配置项', '取值', '口径与影响', '保存']} rows={SOURCE_KEYS.map((k) => [
          <span className="small strong">{flags.labels[k] || k}<span className="faint tiny mono"> {k}</span></span>,
          <select className="btn sm" style={{ minWidth: 260 }} disabled={!matrixPerm.manage} value={draft[k] ?? cfg[k] ?? ''}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
            {(CHOICES[k] || []).map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>,
          <span className="tiny faint">{k === 'auth-provider' ? (prov?.note || '') + '；切换后本地账号只留运维兜底'
            : k === 'approval-source' ? '外部来源时本系统只登记「待回写」并跟踪超时，超时自动出兜底工单'
            : k === 'notify-channels' ? '发送器插件式；渠道发不出去自动回落站内并留记录'
            : '试运行由建设团队排班（下面值班表可改）；切外部后本系统只做派单与升级跟踪'}</span>,
          <button className="btn sm primary" disabled={!matrixPerm.manage || (draft[k] ?? cfg[k]) === cfg[k]}
            onClick={() => void put(k, draft[k] ?? cfg[k] ?? '')}>保存</button>,
        ])} />
        <div className="row gap6 wrap" style={{ marginTop: 10 }}>
          <span className="tiny faint">处置指令确认超时（分钟）</span>
          <input className="btn sm" style={{ width: 90 }} value={draft['command-ack-timeout-min'] ?? cfg['command-ack-timeout-min'] ?? '30'}
            disabled={!matrixPerm.manage} onChange={(e) => setDraft({ ...draft, 'command-ack-timeout-min': e.target.value })} />
          <button className="btn sm primary" disabled={!matrixPerm.manage || (draft['command-ack-timeout-min'] ?? cfg['command-ack-timeout-min']) === cfg['command-ack-timeout-min']}
            onClick={() => void put('command-ack-timeout-min', draft['command-ack-timeout-min'] ?? '30')}>保存</button>
          {err ? <span className="tiny" style={{ color: 'var(--bad-text)' }}>{err}</span> : null}
        </div>
        <div className="tiny faint" style={{ marginTop: 8 }}>
          迁移三步（写进实施方案，不在演示里假装完成）：<b>① 影子同步</b> —— 外部账号只读导进来比对差异；
          <b>② 双写核对</b> —— 内外两边账号连续对齐 ≥10 个工作日、差异清零；<b>③ 切主源</b> —— 改这一个配置项就切过去，登录与权限判定改走外部来源，本地账号留运维兜底。
        </div>
      </Panel>

      <Panel title="身份来源：账号映射表与影子同步" className="mt14" noPad>
        <div className="panel-body">
          <div className="tiny faint">每行一条外部账号：<span className="mono">外部账号 | 姓名 | 角色</span>。影子同步只读导入，不会覆盖或新建本地账号；对不上的标「待绑定」，要人工绑定后才算对齐。</div>
          <textarea className="btn sm" style={{ width: '100%', minHeight: 74, marginTop: 8, fontFamily: 'monospace' }}
            value={syncText} disabled={!matrixPerm.manage} onChange={(e) => setSyncText(e.target.value)} />
          <div className="row gap6 mt14" style={{ marginTop: 12 }}>
            <button className="btn primary sm" disabled={!matrixPerm.manage} onClick={() => void doSync()}>执行影子同步</button>
            <span className="tiny faint">当前身份来源：{cfg['auth-provider'] || 'local'}</span>
            {syncMsg ? <span className="tiny" style={{ color: 'var(--ok-text)' }}>{syncMsg}</span> : null}
          </div>
          <Table minWidth={820} head={['外部账号', '外部姓名', '外部角色', '对应本地账号', '比对结果', '最近同步']} rows={links.map((r) => [
            <span className="small mono">{r.external_id}</span>,
            <span className="small">{r.name || '—'}</span>,
            <span className="tiny">{r.role || '—'}</span>,
            <span className="tiny mono">{r.user_id || '—'}</span>,
            <span>{r.matched ? <Badge tone="good">可对应</Badge> : <Badge tone="warn">待绑定</Badge>}</span>,
            <span className="tiny mono">{(r.last_seen || '').replace('T', ' ').replace('Z', '')}</span>,
          ])} />
          {links.length === 0 ? <div className="tiny faint" style={{ marginTop: 8 }}>映射表现在是空的：正式切换前这张表必须先跑满一轮影子同步，把差异条数降到 0。</div> : null}
        </div>
      </Panel>

      <Panel title="排班与派单（试运行由建设团队安排，全部可配）" className="mt14" noPad>
        <div className="panel-body">
          {cons.error ? <Callout warn text={cons.error} /> : null}
          <div className="tiny faint">派单映射：例外类型 → 当班岗位 → 超时升级岗位。改完立即影响「算力中心 · 例外监控与阻断」的自动派单与升级。</div>
          <Table minWidth={900} head={['例外类型', '派给岗位', '超时升级到', '保存']} rows={cons.routes.map((r) => {
            const d = routeDraft[r.kind] || {}
            return [
              <span className="small strong">{r.kind}</span>,
              <input className="btn sm" style={{ width: 170 }} value={d.duty_role ?? r.duty_role} disabled={!matrixPerm.manage}
                onChange={(e) => setRouteDraft({ ...routeDraft, [r.kind]: { ...d, duty_role: e.target.value } })} />,
              <input className="btn sm" style={{ width: 170 }} value={d.escalate_role ?? r.escalate_role} disabled={!matrixPerm.manage}
                onChange={(e) => setRouteDraft({ ...routeDraft, [r.kind]: { ...d, escalate_role: e.target.value } })} />,
              <button className="btn sm primary" disabled={!matrixPerm.manage}
                onClick={() => void consoleStore.saveRoute({ kind: r.kind, duty_role: d.duty_role ?? r.duty_role, escalate_role: d.escalate_role ?? r.escalate_role })}>保存</button>,
            ]
          })} />
          <Table minWidth={1000} head={['岗位编号', '值班岗位', '当班人', '内线 / 电话', '上级', '负责范围', '启用']} rows={cons.shifts.map((s) => {
            const d = shiftDraft[s.id] || {}
            return [
              <span className="tiny mono">{s.id}</span>,
              <input className="btn sm" style={{ width: 150 }} value={d.role ?? s.role} disabled={!matrixPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, role: e.target.value } })} />,
              <input className="btn sm" style={{ width: 190 }} value={d.name ?? s.name} disabled={!matrixPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, name: e.target.value } })} />,
              <input className="btn sm" style={{ width: 120 }} value={d.phone ?? s.phone} disabled={!matrixPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, phone: e.target.value } })} />,
              <input className="btn sm" style={{ width: 170 }} value={d.lead ?? s.lead} disabled={!matrixPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, lead: e.target.value } })} />,
              <input className="btn sm" style={{ width: 200 }} value={d.scope ?? s.scope} disabled={!matrixPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, scope: e.target.value } })} />,
              <span>{s.enabled ? <Badge tone="good">启用</Badge> : <Badge tone="muted">停用</Badge>}</span>,
            ]
          })} />
          <div className="row gap6 mt14" style={{ marginTop: 12 }}>
            <button className="btn sm primary" disabled={!matrixPerm.manage}
              onClick={() => void consoleStore.saveShift({ id: 'D-90', role: '新增岗位', name: '当班 · 待排', phone: '内线 80xx', lead: '值班长', scope: '临时岗位' })}>加一个岗位</button>
            <span className="tiny faint">数据来源：{cons.fromServer ? '数据服务 duty_shifts / duty_routes 表' : '读不到服务，暂时沿用代码默认口径'}</span>
          </div>
        </div>
      </Panel>

      <Panel title="这些开关现在的真实状态（不装成已完成）" className="mt14">
        <Table minWidth={760} head={['适配器', '现在的状态', '等材料 / 等什么']} rows={Object.entries(flags.providers).map(([k, p]) => [
          <span className="small strong">{k}<span className="faint tiny mono"> {p.label}</span></span>,
          <span>{p.ready ? <Badge tone="good">可用（内建）</Badge> : <Badge tone="warn">占位 · 未配置</Badge>}</span>,
          <span className="tiny faint">{p.note}</span>,
        ])} />
        <div className="tiny faint" style={{ marginTop: 8 }}>
          未配置好的来源被选中时，登录与审批会明确报错、不会静默退回内建模式；这样试运行时出问题看得见。
        </div>
      </Panel>
      <Panel title="资源接入与采集（加资源不用改代码）" className="mt14" noPad
        extra={<span className="tiny faint">采集线程 {col.state?.thread ? '在跑' : '未起'} · 成功 {col.state?.runs ?? 0} / 失败 {col.state?.failures ?? 0}
          <Tip label="接入与告警口径" text={'接入要先审批：' + (col.approvalMode === 'off' ? '关（登记即生效 + 审计）' : '开（先生成资源接入工单）')
            + ' · 断连告警：' + ((flags.config['monitor-alert-enabled'] || 'on') === 'on'
              ? '开（连续 ' + (flags.config['monitor-alert-fail-count'] || '2') + ' 轮采不到就告警、开兜底工单）' : '关（只留痕，不发通知）')
            + ' · 改这些只动配置，不用改代码'} />
        </span>}>
        <div className="panel-body">
          {col.error ? <Callout warn text={'资源接入读不到：' + col.error} /> : null}
          <Table minWidth={1120} head={['资源 / 类型', '关键配置（密钥只写环境变量名）', '间隔', '最近一轮', '接入状态', '操作']} rows={col.sources.map((d) => [
            <span className="small strong">{d.name}<div className="tiny faint">{d.kind} · {d.id} · {d.enabled ? '启用' : '已停用'}{d.alert_state === '已告警' ? ' · 已告警（连续 ' + d.fail_streak + ' 轮）' : ''}</div></span>,
            <span className="tiny mono" style={{ maxWidth: 340 }}>{(JSON.stringify(JSON.parse(d.config_json || '{}')) || '').slice(0, 190)}</span>,
            <span className="tiny">{d.interval_seconds} 秒</span>,
            <span className="tiny">{d.last_status === '已采集' ? <Badge tone="good">已采集</Badge> : d.last_status ? <Badge tone="bad">{d.last_status}</Badge> : <Badge tone="muted">还没采过</Badge>}
              {d.last_error ? <div className="tiny" style={{ color: 'var(--bad-text)', maxWidth: 260 }}>{d.last_error}</div> : null}
              <div className="tiny faint">{(d.last_run_at || '').replace('T', ' ').replace('Z', '')}</div></span>,
            <span>{d.approval_state === '已生效' ? <Badge tone="good">已生效</Badge> : d.approval_state === '待审批' ? <Badge tone="warn">待审批 {d.order_id}</Badge> : <Badge tone="bad">已驳回</Badge>}</span>,
            <div className="row gap6" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void collectStore.run(d.kind).then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? d.name + ' 已采一轮' : d.name + ' 采集失败：' + JSON.stringify(r.result?.errors || r.error || '') }))}>立即采</button>
              <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void collectStore.saveSource({ id: d.id, kind: d.kind, name: d.name, config: JSON.parse(d.config_json || '{}'), interval_seconds: d.interval_seconds, enabled: !d.enabled }).then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? (d.enabled ? d.name + ' 已停用' : d.name + ' 已启用') : '被拒：' + (r.error || '') }))}>{d.enabled ? '停用' : '启用'}</button>
              <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void collectStore.deleteSource(d.id).then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? d.name + ' 已删除（配置留审计）' : '删除被拒：' + (r.error || '') }))}>删除</button>
            </div>,
          ])} />
          {col.sources.length === 0 ? <div className="tiny faint" style={{ marginTop: 6 }}>还没有采集源：在下面填一个（也可以点「从采集脚本配置文件导入」把现有文件配置搬进来，之后就只在系统里改）。</div> : null}

          <div className="divider" />
          <div className="row gap6 wrap" style={{ marginTop: 10 }}>
            <select className="btn sm" style={{ width: 210 }} value={src.kind} onChange={(e) => setSrc({ ...src, kind: e.target.value })}>
              {COLLECT_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
            </select>
            <input className="btn sm" style={{ width: 200 }} value={src.name} placeholder="资源显示名" onChange={(e) => setSrc({ ...src, name: e.target.value })} />
            <input className="btn sm" style={{ width: 290 }} value={src.base} placeholder="地址 http://内网地址:端口（或指标端点全 URL）" onChange={(e) => setSrc({ ...src, base: e.target.value })} />
            <input className="btn sm" style={{ width: 210 }} value={src.api_key_env} placeholder="取密钥的环境变量名（可空）" onChange={(e) => setSrc({ ...src, api_key_env: e.target.value })} />
            <select className="btn sm" style={{ width: 170 }} value={src.format} onChange={(e) => setSrc({ ...src, format: e.target.value })}>
              <option value="">默认口径</option>
              <option value="json">JSON 指标</option>
              <option value="prometheus">Prometheus 文本</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
            <input className="btn sm" style={{ width: 110 }} value={src.interval_seconds} placeholder="间隔秒" onChange={(e) => setSrc({ ...src, interval_seconds: Number(e.target.value) || 60 })} />
          </div>
          <textarea className="btn sm" style={{ width: '100%', height: 54, marginTop: 8, resize: 'vertical' }} value={src.extra}
            onChange={(e) => setSrc({ ...src, extra: e.target.value })}
            placeholder='附加配置（JSON 对象，可选）：例如 {"query":"DCGM_FI_DEV_GPU_UTIL","cards":8,"pool":"hp"}' />
          <div className="row gap6 wrap" style={{ marginTop: 8 }}>
            <button className="btn sm primary" disabled={!matrixPerm.manage || !src.name || !src.base}
              onClick={() => {
                let cfg: Record<string, unknown>
                try { cfg = buildSourceConfig(src) } catch (e) { setColMsg({ ok: false, text: '附加配置不是合法 JSON：' + (e instanceof Error ? e.message : '') }); return }
                void collectStore.saveSource({ kind: src.kind, name: src.name, config: cfg, interval_seconds: src.interval_seconds, collect: true })
                  .then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? (r.approval_state === '待审批' ? src.name + ' 已登记，等工单 ' + r.order_id + ' 审批通过才生效' : src.name + ' 已接入并采了一轮') : '被拒：' + (r.error || '') }))
              }}>接入这个资源并采一轮</button>
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void collectStore.run().then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? '全部启用资源已采一轮' : '采集有失败：' + JSON.stringify(r.result?.errors || r.error || '') }))}>立即采全部</button>
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void collectStore.importFile().then((r) => setColMsg({ ok: !!r.ok, text: r.ok ? '已从采集脚本配置文件导入 ' + (r.imported || []).length + ' 类资源；之后只在系统里改，文件不再被读' : '导入失败：' + (r.error || '') }))}>从采集脚本配置文件导入</button>
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void saveConfig('data-source-approval', col.approvalMode === 'off' ? 'on' : 'off').then(() => collectStore.refresh())}>接入要先审批：{col.approvalMode === 'off' ? '开' : '关'}</button>
            <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void saveConfig('monitor-alert-enabled', (flags.config['monitor-alert-enabled'] || 'on') === 'on' ? 'off' : 'on')}>断连要告警：{(flags.config['monitor-alert-enabled'] || 'on') === 'on' ? '关' : '开'}</button>
            <select className="btn sm" style={{ width: 200 }} disabled={!matrixPerm.manage} value={flags.config['monitor-alert-fail-count'] || '2'}
              onChange={(e) => void saveConfig('monitor-alert-fail-count', e.target.value)}>
              {['1', '2', '3', '5'].map((v) => <option key={v} value={v}>连续 {v} 轮采不到就告警</option>)}
            </select>
            <select className="btn sm" style={{ width: 230 }} disabled={!matrixPerm.manage} value={flags.config['fallback-escalate-min'] || '15'}
              onChange={(e) => void saveConfig('fallback-escalate-min', e.target.value)}>
              {['0', '10', '15', '30', '60'].map((v) => <option key={v} value={v}>{v === '0' ? '兜底工单不自动升级' : '兜底挂 ' + v + ' 分钟没人接管就升级'}</option>)}
            </select>
            <button className="btn sm ghost" disabled={!matrixPerm.manage}
              onClick={() => void apiSend('POST', '/monitor/sweep', {}).then((r) => setColMsg({
                ok: !!r.ok,
                text: r.ok ? '巡检兜底工单：升级 ' + (r.escalated ?? 0) + ' 张（挂太久没人接管的派给带班角色）；待接管清单 '
                  + ((r.pending || []).filter((x: any) => x.status === '待接管').length) + ' 张'
                  : '巡检失败：' + (r.error || '') })).catch((e) => setColMsg({ ok: false, text: '巡检没成：' + String((e && e.message) || e) }))}>巡检兜底工单</button>
            {!matrixPerm.manage ? <span className="tiny faint">要「权限矩阵」操作权才能接入 / 改 / 删采集源（与改配置同级）</span> : null}
          </div>
          {colMsg ? <div className="tiny" style={{ marginTop: 8, color: colMsg.ok ? 'var(--ok-text)' : 'var(--bad-text)' }}>{colMsg.text}</div> : null}

          <div className="divider" />
          <Table minWidth={900} head={['采集类型', '本轮条数', '最近采集时间', '状态 / 错误']} rows={COLLECT_KINDS.map((k) => {
            const one = col.status[k.v] || col.status[k.v + '.json']
            return [
              <span className="tiny strong">{k.label}</span>,
              <span className="num small">{one ? one.items : 0}</span>,
              <span className="tiny faint">{one ? (one.at || '').replace('T', ' ').replace('Z', '') : '未采'}</span>,
              <span className="tiny">{one ? (one.error ? <span style={{ color: 'var(--bad-text)' }}>{one.error}</span> : <Badge tone="good">正常</Badge>) : <Badge tone="muted">未配置</Badge>}{one && one.sources > 1 ? <span className="tiny faint"> 由 {one.sources} 个源合并</span> : null}</span>,
            ]
          })} />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            口径：加一台资源 = 在这里配一条采集源（类型 + 地址 + 口径 + 间隔），不改代码、不改文件；数据服务自己按间隔只读拉取，
            结果写进 <span className="mono">collect_payloads</span>，各页面主表格读它。密钥只写 <span className="mono">env:环境变量名</span> 引用，
            值由启动数据服务的环境提供，库里不存密钥。卡指标走 Prometheus / NPU Exporter；
            <span className="mono">npu-smi</span> 直采要在数据服务所在机器上执行命令，仍只保留在采集脚本里，不由界面触发。
            打开「接入要先审批」后，新增或变更会先生成一张 <span className="mono">resource_onboard</span> 工单，
            在审批台通过后才生效（驳回则不生效）；两种模式都会写审计（<span className="mono">data_source_put</span>）。
            连不通也会告：连续采不到到达阈值（默认 2 轮，可改）→ 事件台账 + 通知中心 + 兜底工单（按派单映射派给值班岗位，默认「算力资源值班」），
            只告一次不刷屏；重新采到 → 恢复通知 + 兜底工单自动关闭；关掉「断连要告警」时仍然留痕（状态与连续轮数），只是不发通知。
            兜底工单挂了没人接管也会追：默认挂 15 分钟无人接管 → 状态变「已升级」、改派给派单映射里的带班角色（默认「值班长」）并发一条「紧急」通知；
            设成「不自动升级」就只靠人工巡检，界面上的「巡检兜底工单」按钮可以随时手动巡检一次。
          </div>
        </div>
      </Panel>
    </>
  )
}
