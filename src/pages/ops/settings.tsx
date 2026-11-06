/* =====================================================================
 * 配置中心（v3.1 / v3.3 / v3.4 / v3.6 的「先内建、后迁移」开关）
 *   身份来源 / 审批来源 / 通知渠道 / 排班来源 / 处置指令确认超时 —— 全部是配置项，不改业务代码
 *   口径：试运行阶段本系统自己独立跑（内建模式）；外部来源做成适配器 + 映射表，
 *         材料到位后按「影子同步 → 双写核对 → 切主源」迁移；没配好的来源会明确拒绝，不静默降级
 * 权限：改配置需要「权限矩阵」操作权；排班与派单需要「资源调配」操作权
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { Badge, Callout, Kpi, Panel, PageHead, Table } from '../../components/ui'
import { listLinks, loadConfig, saveConfig, syncLinks, useFlags, usePerm } from '../../engine/auth'
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
          {err ? <span className="tiny" style={{ color: '#ff9a9a' }}>{err}</span> : null}
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
            {syncMsg ? <span className="tiny" style={{ color: '#7ee2b8' }}>{syncMsg}</span> : null}
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
              <input className="btn sm" style={{ width: 170 }} value={d.duty_role ?? r.duty_role} disabled={!dutyPerm.manage}
                onChange={(e) => setRouteDraft({ ...routeDraft, [r.kind]: { ...d, duty_role: e.target.value } })} />,
              <input className="btn sm" style={{ width: 170 }} value={d.escalate_role ?? r.escalate_role} disabled={!dutyPerm.manage}
                onChange={(e) => setRouteDraft({ ...routeDraft, [r.kind]: { ...d, escalate_role: e.target.value } })} />,
              <button className="btn sm primary" disabled={!dutyPerm.manage}
                onClick={() => void consoleStore.saveRoute({ kind: r.kind, duty_role: d.duty_role ?? r.duty_role, escalate_role: d.escalate_role ?? r.escalate_role })}>保存</button>,
            ]
          })} />
          <Table minWidth={1000} head={['岗位编号', '值班岗位', '当班人', '内线 / 电话', '上级', '负责范围', '启用']} rows={cons.shifts.map((s) => {
            const d = shiftDraft[s.id] || {}
            return [
              <span className="tiny mono">{s.id}</span>,
              <input className="btn sm" style={{ width: 150 }} value={d.role ?? s.role} disabled={!dutyPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, role: e.target.value } })} />,
              <input className="btn sm" style={{ width: 190 }} value={d.name ?? s.name} disabled={!dutyPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, name: e.target.value } })} />,
              <input className="btn sm" style={{ width: 120 }} value={d.phone ?? s.phone} disabled={!dutyPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, phone: e.target.value } })} />,
              <input className="btn sm" style={{ width: 170 }} value={d.lead ?? s.lead} disabled={!dutyPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, lead: e.target.value } })} />,
              <input className="btn sm" style={{ width: 200 }} value={d.scope ?? s.scope} disabled={!dutyPerm.manage}
                onChange={(e) => setShiftDraft({ ...shiftDraft, [s.id]: { ...d, scope: e.target.value } })} />,
              <span>{s.enabled ? <Badge tone="good">启用</Badge> : <Badge tone="muted">停用</Badge>}</span>,
            ]
          })} />
          <div className="row gap6 mt14" style={{ marginTop: 12 }}>
            <button className="btn sm primary" disabled={!dutyPerm.manage}
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
    </>
  )
}
