/* =====================================================================
 * 操作控制 · 操作权限（逐账号）
 *   口径（原文 1.2 / 1.3）：角色只有三种，但「不把同角色账号的全部权限绑定为相同集合」；
 *         这里按「动作 × 职责」给每个账号单独开关——同一个运营团队里，一个能执行发 Key，另一个只能复核。
 *   判定在服务端：op_perms 表 + 服务端会话账号；改权限要「权限矩阵」权限（运营账号点不动）。
 *   每次开关都由服务端自动生成关联工单并记变更前后值（原文 1.3）。
 * ===================================================================== */
import { useEffect, useState } from 'react'
import { AlertBadge, Badge, Callout, Kpi, PageHead, Panel, Table, Tabs, Tip } from '../../components/ui'
import { opctlStore, useOpctl } from '../../engine/opctl'
import { currentAccount, usePerm } from '../../engine/auth'

const SCOPES: { v: string; l: string }[] = [
  { v: 'self', l: '本人' }, { v: 'org', l: '本组织' }, { v: 'line', l: '本业务线' }, { v: 'global', l: '全局' },
]
const KIND_LABEL: Record<string, string> = {
  view: '查看', request: '发起', approve: '审批', execute: '执行', review: '复核', config: '配置', auto: '自动执行', emergency: '紧急',
}

export default function OpctlPerm() {
  const st = useOpctl()
  const perms = st.perms
  const matrixPerm = usePerm('matrix')
  const [domain, setDomain] = useState('')
  const [msg, setMsg] = useState('')
  const me = currentAccount()

  useEffect(() => { if (!st.fromServer && !st.loading) void opctlStore.refresh() }, [st.fromServer, st.loading])

  const domains = Array.from(new Set(perms.items.map((p) => p.domain)))
  const dom = domain || domains[0] || ''
  const items = perms.items.filter((p) => p.domain === dom)
  const grantOf = (acctId: string, perm: string) => perms.grants.find((g) => g.accountId === acctId && g.perm === perm)
  const conflicts = perms.grants
    .filter((g) => /\.(execute|allocate)$/.test(g.perm))
    .filter((g) => perms.grants.some((x) => x.accountId === g.accountId && x.perm === g.perm.replace(/\.(execute|allocate)$/, '.review')))
    .map((g) => g.accountId)

  const toggle = async (acctId: string, perm: string) => {
    const r = await opctlStore.permToggle(acctId, perm)
    setMsg(r.ok ? `已变更 ${perm}（服务端已生成关联工单并留痕）` : (r.reason ?? '变更被拒'))
  }
  const setScope = async (acctId: string, perm: string, scope: string) => {
    const r = await opctlStore.permScope(acctId, perm, scope)
    setMsg(r.ok ? `数据范围已改为 ${SCOPES.find((s) => s.v === scope)?.l ?? scope}` : (r.reason ?? '变更被拒'))
  }

  const cell = (acctId: string, perm: string) => {
    const g = grantOf(acctId, perm)
    if (!g) {
      return matrixPerm.manage
        ? <button className="btn sm ghost" onClick={() => void toggle(acctId, perm)}>未开启</button>
        : <span className="tiny faint">未开启</span>
    }
    const conflict = conflicts.includes(acctId) && /\.review$/.test(perm)
    return (
      <span className="row gap6 wrap">
        <button className="btn sm ghost" disabled={!matrixPerm.manage} onClick={() => void toggle(acctId, perm)}>开启</button>
        <select className="btn sm" style={{ maxWidth: 92 }} value={g.scope} disabled={!matrixPerm.manage}
          title="数据范围：本人 / 本组织 / 本业务线 / 全局"
          onChange={(e) => void setScope(acctId, perm, e.target.value)}>
          {SCOPES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        {conflict ? <AlertBadge tone="warn" jump={{ page: '/ops/opctl-queue', label: '这个账号同时握着执行与复核：同人复核会被 g5 拒，配成两个账号更省事' }}>兼任</AlertBadge> : null}
      </span>
    )
  }

  return (
    <>
      <PageHead title="操作控制 · 操作权限（逐账号）"
        desc="按「动作 × 职责」给每个账号单独开关：能发起 / 能审批 / 能执行 / 能复核 / 能改配置是五件事；角色只作参考，不代表能力集合相同" />

      {st.error ? <div className="mt14"><Callout warn text={`权限数据读不到：${st.error}（服务端未启动或未登录；页面不会用默认值假装有数据）`} /></div> : null}
      {msg ? <div className="mt14"><Callout text={msg} /></div> : null}

      <div className="grid g-4" style={{ marginTop: 14 }}>
        <Kpi label="操作权限项" value={String(perms.items.length)} unit="项" foot="按动作域分组，对应操作目录里每条动作" />
        <Kpi label="已授权记录" value={String(perms.grants.length)} unit="条" foot="没有记录即视为关闭（默认全关）" />
        <Kpi label="权限变更留痕" value={String(perms.changes.length)} unit="条" foot="每条都带变更前后值与关联工单" />
        <Kpi label="执行+复核同人" value={String(conflicts.length)} unit="个" foot={conflicts.length ? '允许配置，但执行时仍强制两个账号' : '没有账号同时握着执行与复核'} />
      </div>

      {!matrixPerm.manage
        ? <div className="mt14"><Callout warn text="当前账号没有「权限矩阵」操作权：只能看不能改。权限项开关属于实际变更，必须由系统管理员依据变更工单办理（原文 1.3；服务端也已按 matrix 权限判定，改前端无效）。" /></div>
        : <div className="mt14"><Callout text="每次开关都由服务端生成关联变更工单并记录变更前后值；改完立即对该账号的后续操作生效（下一次动作即拒或放行）。" /></div>}

      {conflicts.length ? (
        <div className="mt14"><Callout warn text={`有账号同时握着执行与复核：${conflicts.map((id) => perms.accounts.find((a) => a.id === id)?.name ?? id).join('、')}。允许这么配，但执行与复核仍必须是两个不同账号，未复核不得标记发放成功（原文 2.6-3）。`} /></div>
      ) : null}

      <Panel focus title="逐账号操作权限矩阵" className="mt14" noPad
        extra="单元格 = 该账号是否有这一项 + 数据范围；数据范围是独立一维，不与权限项耦合">
        <div style={{ padding: '10px 12px 0' }}><Tabs items={domains} active={dom} onChange={setDomain} /></div>
        <Table minWidth={1120} rowKeys={perms.accounts.map((a) => a.id)}
          head={['账号（角色）', ...items.map((p) => <span key={p.code}>{p.label}<br /><span className="tiny faint mono">{p.code}</span></span>)]}
          rows={perms.accounts.map((a) => [
            <span className="small">{a.name}<br /><span className="tiny faint">{a.role === 'admin' ? '系统管理员' : a.role === 'ops' ? '运营人员' : a.role === 'dev' ? '业务开发者' : '普通用户'} · {a.note}</span></span>,
            ...items.map((p) => cell(a.id, p.code)),
          ])} />
        <div className="tiny faint" style={{ padding: '8px 12px 12px' }}>
          优先级：<span className="strong">显式关闭 &gt; 显式开启 &gt; 角色默认 &gt; 全关</span>。
          <Tip label="为什么不给管理员全开" text="原文 1.2：管理员身份不自动获得全部业务操作或全部数据访问权限——管理员 A有审批权与配置权，但没有发 Key 的执行权。" />
        </div>
      </Panel>

      <Panel title="权限变更留痕（关联工单 · 变更前后值 · 执行人 · 时间）" noPad className="mt14">
        {perms.changes.length === 0 ? <div className="tiny faint" style={{ padding: 12 }}>还没有变更记录。开一项或关一项，这里就会出现一条带关联工单的留痕。</div> : (
          <Table minWidth={980} head={['时间', '账号', '权限项', '变更前', '变更后', '执行人', '关联工单']}
            rows={perms.changes.map((c, i) => [
              <span className="tiny mono" key={i}>{c.at}</span>,
              <span className="tiny">{c.account}</span>,
              <span className="mono tiny">{c.perm}</span>,
              <Badge tone="muted">{c.before}</Badge>,
              <Badge tone={c.after.includes('关闭') ? 'bad' : 'good'}>{c.after}</Badge>,
              <span className="tiny">{c.actor}</span>,
              <span className="mono tiny">{c.ticketId}</span>,
            ])} />
        )}
      </Panel>

      <Panel title="口径与依据" className="mt14">
        <ul className="tiny" style={{ lineHeight: 1.9, margin: 0, paddingLeft: 18 }}>
          <li>系统管理员通过工单指定或调整角色，并依据变更工单通过权限矩阵逐项开关权限（原文 1.3）。</li>
          <li>账号能力授权<span className="strong">不能替代工单审批、安全审核或实际资源分配</span>，也不能绕过凭证一人执行、另一人复核（原文 1.3）。</li>
          <li>拥有申请权限只表示可以提交申请，不等于审批通过、已开通模型或已分配算力（原文 1.2）。</li>
          <li>前端隐藏按钮只是体验，<span className="strong">服务端必须校验实际操作权限与数据访问范围</span>——本页的开关由 <span className="mono">POST /api/opctl/perm/toggle</span> 落库，判定在 <span className="mono">server/opctl.py</span>。</li>
          <li>谁能查看他人信息、敏感数据与审计记录、以及权限委派边界，须另行确认，不因角色或页面可见自动放开（原文 1.3）。</li>
          <li>当前登录：{me ? `${me.name}` : '未登录'}；改动需要「权限矩阵」操作权，否则服务端直接 403。</li>
        </ul>
      </Panel>
    </>
  )
}
