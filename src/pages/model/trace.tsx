import { Kpi, Panel, PageHead, Badge, AlertBadge, Table, Callout, fmtCN } from '../../components/ui'
import { traces } from '../../data/mock'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

const STEPS = [
  { time: '21:47:12.003', title: '用户发起请求', desc: '示例××（示范市01单位）· SSO 登录 · 人员标识 user 校验通过' },
  { time: '21:47:12.011', title: '入口应用', desc: '报告撰写助手（高保级）· x-app-id 与凭证授权范围一致' },
  { time: '21:47:12.046', title: '知识库检索', desc: '典型案例库 · 检索前权限过滤通过 · 召回 5 片段并安全复核' },
  { time: '21:47:12.089', title: 'MCP 工具调用', desc: '业务系统查询 · 运行时权限校验通过 · 返回结果注入 / 越权审查' },
  { time: '21:47:12.142', title: '模型推理', desc: 'Qwen3-32B 业务微调（昇腾本地）· 输入 / 输出内容安全检测通过' },
  { time: '21:47:12.151', title: '网关审计归档', desc: 'traceId 全链路日志写入 · Token 8,642 · 处置结果：放行' },
]

/** 本页 traceId ↔ 安全事件单（定责闭环在那一行做）；没有事件单的拦截落回策略库那条命中策略 */
const TRACE_EVENT: Record<string, string> = { 'tr-5e18aa02d977': 'EV-1104-012', 'tr-40cc19b7e2aa': 'EV-1104-006' }

function secCell(sec: string, result: string, jump?: AlertJump) {
  return (
    <div>
      {sec === 'block'
        ? <AlertBadge tone="bad" jump={jump ?? Jump.securityEvent('EV-1104-012', '去安全事件那一行做处置与闭环')}>已拦截</AlertBadge>
        : sec === 'mask'
        ? <AlertBadge tone="warn" jump={jump ?? { page: '/model/security', pick: 'P-03', label: '到「身份证 / 手机号脱敏」策略那一行：脱敏放行要复核，改版 / 提交变更都在那一行' }}>已脱敏 · 待复核</AlertBadge>
        : <Badge tone="good">通过</Badge>}
      <div className="muted small" style={{ marginTop: 3 }}>{result}</div>
    </div>
  )
}

export default function Trace() {
  /* 告警直达口径（本页主键：traceId）
     别处点进来：?pick=<traceId> → 高亮这条调用的那一行（六节点链路与安全处置都在这一行）
     本页红 / 黄：已拦截 → 安全事件那一行（处置动作执行在这一屏）；已脱敏 → 策略库那条脱敏策略那一行 */
  const pick = useAlertPick()
  usePickFlash(pick)
  const blockJump = (id: string): AlertJump => {
    const ev = TRACE_EVENT[id]
    return ev
      ? Jump.securityEvent(ev, `去安全事件 ${ev} 那一行：这起拦截的处置与闭环都在那一行（对应调用 ${id}）`)
      : { page: '/model/security', pick: 'P-05', label: `这条拦截（${id}）没有事件单：到「角色改写型注入特征」策略那一行看命中模式与处置等级` }
  }
  const maskJump = (id: string): AlertJump => ({ page: '/model/security', pick: 'P-03', label: `这条脱敏放行（${id}）要策略复核：到「身份证 / 手机号脱敏」那一行，改版 / 停用 / 提交变更都在那一行` })
  const blocked = traces.filter((t) => t.sec === 'block')
  const masked = traces.filter((t) => t.sec === 'mask')

  return (
    <div>
      <PageHead
        title="调用溯源"
        desc="唯一 traceId 全链路追踪 · 人员标识强制传递 · 用户 → 入口 → 智能体 → 知识库 → MCP 工具 → 模型渠道 可还原（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">可溯源率 100%</Badge>
            {blocked.length ? <AlertBadge tone="bad" jump={blockJump(blocked[0].id)}>今日拦截 {blocked.length} 条 · 待闭环</AlertBadge> : null}
            <Badge tone="info">日志留存 ≥ 6 个月</Badge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="今日调用链路" value="128.4" unit="万条" foot="全部生成唯一 traceId" />
        <Kpi label="可溯源率" value="100" unit="%" foot="人员标识强制传递 · 缺失即拒绝" />
        <Kpi label="安全拦截" value={19} unit="次" foot={<span className="down">{`● 提示词注入 · 已溯源定责 · ${blocked.length} 条调用待闭环`}</span>}
          jump={blocked.length ? blockJump(blocked[0].id) : undefined} />
        <Kpi label="敏感信息脱敏" value={412} unit="次" foot={masked.length
          ? <span className="down">{`● ${masked.length} 条按策略掩码后放行 · 脱敏策略要复核`}</span>
          : '输出侧按策略掩码后放行'}
          jump={masked.length ? maskJump(masked[0].id) : undefined} />
      </div>

      <div className="mt14">
        <Panel
          title="调用链路检索"
          extra="支持按 人员 / 应用 / 凭证 / 模型 / 时间窗口 多维检索"
          noPad
        >
          <div className="panel-body">
            <Table
              head={['traceId', '时间', '调用人员', '应用', '知识库', '工具', '模型', 'Token', '安全处置']}
              rowKeys={traces.map((t) => t.id)} pick={pick}
              rows={traces.map((t) => [
                <span className="mono small">{t.id}</span>,
                <span className="mono small">{t.time}</span>,
                t.user,
                t.app,
                t.kb,
                t.tools,
                t.model,
                <span className="num">{fmtCN(t.tokens)}</span>,
                secCell(t.sec, t.result, t.sec === 'block' ? blockJump(t.id) : t.sec === 'mask' ? maskJump(t.id) : undefined),
              ])}
              minWidth={1180}
            />
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Panel title="链路还原示例" extra="tr-9f3a7c21e8b4 · 11-04 21:47:12 · 全链路 148ms">
          <div className="tl">
            {STEPS.map((s, i) => (
              <div key={s.title} className="tl-item">
                <span className="mono" style={{ color: 'var(--cyan)' }}>{String(i + 1).padStart(2, '0')}</span>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="row between">
                    <span className="strong">{s.title}</span>
                    <span className="mono small muted">{s.time}</span>
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          warn={blocked.length > 0}
          jump={blocked.length ? blockJump(blocked[0].id) : undefined}
          text={
            <>
            溯源规则：平台代理密钥调用<b>强制携带可映射至具体人员的人员标识（user）</b>，缺失则网关拒绝请求；数据域调用从统一身份认证令牌中提取工号等标识；个人密钥场景下<b>调用者即密钥持有人</b>。开发者自建工具等低信任场景标注人员标识来源等级，支撑分级审计。<b>今日已拦截 {blocked.length} 条、脱敏放行 {masked.length} 条：点过去落到要闭环的那一行。</b>
            </>
          }
        />
      </div>
    </div>
  )
}
