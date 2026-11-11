/* =====================================================================
 * 运营模板库（需求 应用 35）
 * FAQ / 操作手册 / 编排模板 / 提示词模板 / 处置预案 / 培训课件
 * 引用即计数并通知归口；新增须审核；停用与恢复留痕；密级决定可否引用
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout, AlertBadge } from '../../components/ui'
import { useEngine, KIND_ACTIONS, DIRECTORY_KINDS } from '../../engine/engine'
import { useTemplates, templateStore, type TemplateKind } from '../../engine/templates'
import { usePolicies } from '../../engine/policies'
import { usePerm, useSession, clsAllowed } from '../../engine/auth'
import { downloadCsv } from '../../engine/ops'
import { useAlertPick, usePickFlash } from '../../engine/alertJump'

const KINDS: TemplateKind[] = ['FAQ 知识库', '操作手册', '编排模板', '提示词模板', '处置预案', '培训课件']

export default function Templates() {
  const st = useEngine()
  const templates = useTemplates()
  const { prompts } = usePolicies()
  const app = usePerm('app')
  const approvePerm = usePerm('approve')
  const acc = useSession()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TemplateKind>('操作手册')
  const [owner, setOwner] = useState(acc?.dept ?? '')
  const [cls, setCls] = useState<'公开' | '内部' | '敏感'>('内部')
  const [related, setRelated] = useState('')
  const [desc, setDesc] = useState('')
  const [flash, setFlash] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  const published = templates.filter((t) => t.status === '已发布')
  const pending = templates.filter((t) => t.status === '待审核')
  const stopped = templates.filter((t) => t.status === '已停用')
  const owners = new Set(templates.map((t) => t.owner)).size
  const refsTotal = templates.reduce((s, t) => s + t.refs, 0)
  /** 别处点过来：?pick=<模板编号> → 高亮这一行（审核通过 / 驳回 / 引用都在这条行上） */
  const pick = useAlertPick()
  usePickFlash(pick)
  const toRow = (id: string) => ({ page: '/app/templates', pick: id, label: '点过去落到这条模板那一行：通过 / 驳回 / 引用都在这里做' })

  const submitTemplate = () => {
    const r = templateStore.submit({ name, kind, owner, cls, desc, related, by: acc?.name ?? '运营值班' })
    setFlash({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `模板 ${r.id} 已提交归口 ${owner} 审核，审核通过后方可被业务引用` : `提交失败：${r.reason}` })
    if (r.ok) { setName(''); setDesc(''); setRelated('') }
  }

  return (
    <div>
      <PageHead
        title="运营模板库"
        desc="FAQ · 操作手册 · 编排模板 · 提示词模板 · 处置预案 · 培训课件（引用计数、审核发布、停用恢复）"
        extra={<><Badge tone="info">当前可引用密级 {acc ? ['公开', '内部', '敏感'].filter(clsAllowed).join(' / ') : '—'}</Badge><Badge tone="muted">待审核 {pending.length} 项</Badge></>}
      />

      {flash ? (
        <div className={`callout ${flash.tone === 'bad' ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
          <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="grid g-6">
        <Kpi label="模板总数" value={templates.length} unit="份" foot={`${published.length} 已发布 · ${pending.length} 待审核 · ${stopped.length} 已停用`} />
        <Kpi label="累计引用" value={refsTotal} unit="次" foot="引用即计数并通知归口，用于模板有效性评估" />
        <Kpi label="归口单位" value={owners} unit="个" foot="模板由业务归口维护，平台只做版本与发布管控" />
        <Kpi label="敏感级模板" value={templates.filter((t) => t.cls === '敏感').length} unit="份" foot="仅具备对应密级的角色可引用" />
        <Kpi label="关联纳管对象" value={st.managed.length} unit="个" foot="模板关联的应用 / 知识库 / 工具 / 插件（实时）" />
        <Kpi label="关联检测策略" value={prompts.length} unit="条" foot="提示词模板与系统提示词版本联动" />
      </div>

      <Panel title="模板台账" extra={app.manage ? '可引用 · 可停用与恢复 · 可导出' : '当前角色只读'} className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1120}
            head={['模板', '类型', '归口 / 版本', '密级', '引用次数', '状态', '关联对象（实时）', '操作']}
            rowKeys={templates.map((t) => t.id)} pick={pick}
            rows={templates.map((t) => {
              const locked = !clsAllowed(t.cls)
              return [
                <span className="strong small">{t.name}<div className="tiny faint" style={{ maxWidth: 300 }}>{t.desc}</div></span>,
                <span className={`tag ${t.kind === '处置预案' ? 'red' : t.kind === '提示词模板' ? 'purple' : 'gray'}`}>{t.kind}</span>,
                <span className="small">{t.owner}<div className="tiny faint mono">{t.version} · 更新 {t.updatedAt}</div></span>,
                <span className={`tag ${t.cls === '敏感' ? 'red' : t.cls === '内部' ? '' : 'green'}`}>{t.cls}</span>,
                <span className="num">{t.refs}</span>,
                t.status === '已发布' ? <State s="ok" /> : t.status === '待审核' ? <AlertBadge tone="warn" jump={toRow(t.id)}>{`待审核 ${t.id}`}</AlertBadge> : <Badge tone="muted">已停用</Badge>,
                <span className="tiny faint" style={{ maxWidth: 260 }}>{t.related}</span>,
                <div className="row gap6">
                  {t.status === '待审核' ? (
                    approvePerm.manage ? (
                      <>
                        <button className="btn sm primary" onClick={() => { const r = templateStore.approve(t.id); setFlash({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `${t.name} 审核通过，已发布至业务目录` : `操作失败：${r.reason}` }) }}>通过</button>
                        <button className="btn sm danger" onClick={() => { const r = templateStore.reject(t.id); setFlash({ tone: 'bad', text: r.ok ? `${t.name} 已驳回并留痕，可修改后重新提交` : `操作失败：${r.reason}` }) }}>驳回</button>
                      </>
                    ) : <span className="tiny faint">无审批权（当前角色）</span>
                  ) : (
                    <>
                      <button className="btn sm" disabled={!app.manage || locked || t.status !== '已发布'} title={locked ? '当前角色密级不足' : ''} onClick={() => { const r = templateStore.subscribe(t.id); setFlash({ tone: r.ok ? 'good' : 'bad', text: r.ok ? `已引用 ${t.name}（累计 ${r.refs} 次），归口 ${t.owner} 已收到引用通知` : `引用失败：${r.reason}` }) }}>引用</button>
                      <button className="btn sm ghost" disabled={!app.manage} onClick={() => { const r = templateStore.toggle(t.id); setFlash({ tone: 'good', text: r.ok ? `${t.name} 状态已变更为 ${r.status}` : `操作失败：${r.reason}` }) }}>{t.status === '已发布' ? '停用' : '恢复'}</button>
                    </>
                  )}
                </div>,
              ]
            })}
          />
          <div className="row gap6" style={{ marginTop: 12 }}>
            <button className="btn sm" disabled={!app.manage} onClick={() => downloadCsv('运营模板台账', ['编号', '模板名称', '类型', '归口', '版本', '密级', '状态', '引用次数', '更新日期', '关联对象'], templates.map((t) => [t.id, t.name, t.kind, t.owner, t.version, t.cls, t.status, t.refs, t.updatedAt, t.related]))}>导出模板台账 CSV</button>
            <button className="btn sm ghost" disabled={!app.manage} onClick={() => { templateStore.reset(); setFlash({ tone: 'good', text: '模板台账已恢复默认演示数据' }) }}>恢复默认台账</button>
            <span className="small faint">引用与审核动作会写入运行事件流与通知中心，可在「运营通知」查看处置闭环。</span>
          </div>
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="提交新模板（须归口审核）" extra="审核通过后才进入业务目录可被引用" noPad>
          <div className="panel-body">
            <div className="col gap6">
              <div>
                <div className="tiny faint">模板名称</div>
                <input className="btn sm" style={{ marginTop: 4, width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：视频图像复核标注操作手册" />
              </div>
              <div className="row gap6 wrap">
                <div>
                  <div className="tiny faint">类型</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div>
                  <div className="tiny faint">归口单位</div>
                  <input className="btn sm" style={{ marginTop: 4 }} value={owner} onChange={(e) => setOwner(e.target.value)} />
                </div>
                <div>
                  <div className="tiny faint">密级</div>
                  <select className="btn sm" style={{ marginTop: 4 }} value={cls} onChange={(e) => setCls(e.target.value as '公开' | '内部' | '敏感')}>
                    <option value="公开">公开</option><option value="内部">内部</option><option value="敏感">敏感</option>
                  </select>
                </div>
              </div>
              <div>
                <div className="tiny faint">关联纳管对象（当前纳管 {st.managed.length} 个）</div>
                <select className="btn sm" style={{ marginTop: 4, width: '100%' }} value={related} onChange={(e) => setRelated(e.target.value)}>
                  <option value="">（待归口确认）</option>
                  {st.managed.map((m) => <option key={m.id} value={`${m.name} · ${m.kind}`}>{m.name}（{m.kind} · {m.owner}）</option>)}
                </select>
              </div>
              <div>
                <div className="tiny faint">用途说明</div>
                <textarea className="btn sm" style={{ marginTop: 4, width: '100%', minHeight: 64 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="写清适用场景、步骤与禁止事项；敏感级须注明依据" />
              </div>
              <button className="btn primary" disabled={!app.manage || !name.trim() || !owner.trim()} onClick={submitTemplate}>提交模板新增申请</button>
            </div>
          </div>
        </Panel>

        <Panel title="模板与平台能力的联动关系" extra="联动对象取自实时引擎状态" noPad>
          <div className="panel-body">
            <Table
              minWidth={760}
              head={['模板类型', '在平台里落到哪里', '当前对象数（实时）', '示例对象']}
              rows={[
                [<span className="small strong">FAQ 知识库</span>, <span className="small">知识库纳管与问答类应用的应答来源</span>, <span className="num">{st.managed.filter((m) => m.kind === '知识库').length}</span>, <span className="tiny faint">{st.managed.filter((m) => m.kind === '知识库').slice(0, 2).map((m) => m.name).join(' / ') || '—'}</span>],
                [<span className="small strong">编排模板</span>, <span className="small">智能体应用的编排链参考（平台侧只作模板管理，不自带编排器）</span>, <span className="num">{st.managed.filter((m) => m.kind === '智能体应用').length}</span>, <span className="tiny faint">{st.managed.filter((m) => m.kind === '智能体应用').slice(0, 2).map((m) => m.name).join(' / ') || '—'}</span>],
                [<span className="small strong">操作手册</span>, <span className="small">工具与插件目录、报表与审计的操作规程</span>, <span className="num">{st.managed.filter((m) => DIRECTORY_KINDS.includes(m.kind)).length}</span>, <span className="tiny faint">{st.managed.filter((m) => m.kind === 'MCP工具').slice(0, 2).map((m) => m.name).join(' / ') || '—'}</span>],
                [<span className="small strong">提示词模板</span>, <span className="small">与系统提示词版本管理、检测策略库联动（改版须审批）</span>, <span className="num">{prompts.length}</span>, <span className="tiny faint">{prompts.slice(0, 2).map((p) => p.name).join(' / ') || '—'}</span>],
                [<span className="small strong">处置预案</span>, <span className="small">与处置动作库一一对应，预案描述动作顺序与通知对象</span>, <span className="num">{KIND_ACTIONS['MCP工具'].length + KIND_ACTIONS['智能体应用'].length}</span>, <span className="tiny faint">{KIND_ACTIONS['智能体应用'].slice(0, 3).join(' / ')}</span>],
                [<span className="small strong">培训课件</span>, <span className="small">面向业务用户的 usage 指引，与权限矩阵可见范围一致</span>, <span className="num">{st.creds.filter((c) => c.kind === '个人密钥').length}</span>, <span className="tiny faint">个人密钥持有者 {st.creds.filter((c) => c.kind === '个人密钥').length} 人</span>],
              ]}
            />
            <Callout text={<>模板库管的是<b>可复用内容与版本</b>：谁引用了哪个版本、归口是否审核、停用后哪些业务受影响。编排、Prompt 调试、向量化与插件安装等<b>开发能力属于各子系统自身</b>，平台侧不做（详见盘点文档「明确不补」）。模板内容本身需客户方提供，演示版为示例条目。</>} />
          </div>
        </Panel>
      </div>
    </div>
  )
}
