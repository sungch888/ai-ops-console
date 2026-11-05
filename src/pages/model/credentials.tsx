import { Kpi, Panel, PageHead, Badge, State, Table, Callout } from '../../components/ui'
import { useEngine, engine, activeCreds, TYPE_LABEL } from '../../engine/engine'
import { usePerm } from '../../engine/auth'

export default function Credentials() {
  const st = useEngine()
  const canCred = usePerm('cred').manage
  const canApprove = usePerm('approve').manage
  const credentials = st.creds
  const credOrders = st.orders.filter((o) => o.type === 'credential_issue' || o.type === 'credential_revoke' || o.type === 'quota_adjust')
  return (
    <div>
      <PageHead
        title="凭证与配额"
        desc="Personal Key / Service Account Key 双 Key 分级管控 · 申请—审批—发放—轮换—吊销 全生命周期留痕（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">双人复核发放</Badge>
            <Badge tone="info">有效期 ≤ 90 天</Badge>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Kpi label="活跃凭证" value={activeCreds(st)} unit="个" foot={`平台代理 ${credentials.filter((c) => c.kind === '平台代理' && c.status !== 'off').length} · 个人密钥 ${credentials.filter((c) => c.kind === '个人密钥' && c.status !== 'off').length}`} />
        <Kpi label="待审批工单" value={credOrders.filter((o) => o.status === 'submitted').length} unit="项" foot={<span className="down">● 含自动盘点建议</span>} />
        <Kpi label="15 天内到期 / 僵尸" value={credentials.filter((c) => c.status !== 'off' && (c.expDays <= 15 || c.lastUsedDays >= 90)).length} unit="个" foot="盘点扫描自动生成回收建议" />
        <Kpi label="渠道配额占用" value={st.channels.map((c) => Math.round((c.allocatedRpm / c.capacityRpm) * 100)).join(' / ')} unit="%" foot="发放前先算余量，溢出即拒绝" />
      </div>

      <div className="mt14">
        <Panel title="凭证清单" extra="密钥纳入密钥管理服务统一保护 · 禁止明文存放" noPad>
          <div className="panel-body">
            <Table
              head={['凭证 ID', '类型', '持有方', '授权应用', '授权模型', 'RPM', 'TPM', 'IP 白名单', '剩余有效期', '状态', '操作']}
              rows={credentials.map((c) => [
                <span className="mono small">{c.id}</span>,
                c.kind === '平台代理' ? <Badge tone="purple">平台代理</Badge> : <Badge tone="info">个人密钥</Badge>,
                c.holder,
                c.app,
                <span className="small">{c.model}</span>,
                <span className="num">{c.rpm}</span>,
                <span className="num">{c.tpm}</span>,
                <span className="mono small">{c.ip}</span>,
                <span className="mono small">{c.expDays > 0 ? `${c.expDays} 天` : '已过期'}</span>,
                <State s={c.status} />,
                c.status !== 'off' ? (
                  canCred ? (
                    <div className="row gap6">
                      <button className="btn sm" onClick={() => { const r = engine.submit({ type: 'quota_adjust', applicant: `${c.holder}`, dept: '业务方', level: c.kind === '平台代理' ? '高保' : '共享', reason: '业务并发提升，申请配额调整', spec: { credId: c.id, rpm: Math.min(600, c.rpm + 60) } }); if (r.precheck.ok) engine.approve(r.order.id) }}>提额</button>
                      <button className="btn sm danger" onClick={() => { const r = engine.submit({ type: 'credential_revoke', applicant: '凭证管控岗', dept: '运营', level: '高保', reason: '安全值守发起吊销', spec: { credId: c.id } }); if (r.precheck.ok) engine.approve(r.order.id) }}>吊销</button>
                    </div>
                  ) : <span className="tiny faint">无凭证操作权</span>
                ) : <span className="tiny faint">已回收</span>,
              ])}
              minWidth={1180}
            />
          </div>
        </Panel>
      </div>

      <div className="grid g-21 mt14">
        <Panel title="待办工单" extra="凭证申请 / 配额调整 / 吊销 · 分级审批" noPad>
          <div className="panel-body">
            <Table
              head={['工单号', '类型', '申请人 / 对象', '配额', '结论或原因', '状态', '操作']}
              rows={credOrders.slice(0, 10).map((o) => [
                <span className="mono small">{o.id}{o.auto ? <span className="tag gray" style={{ marginLeft: 6 }}>自动</span> : null}</span>,
                <span className="small">{TYPE_LABEL[o.type]}</span>,
                <span className="small">{o.applicant}<div className="tiny faint">{o.target}</div></span>,
                <span className="small">{o.amount}</span>,
                <span className="small" style={{ color: o.rejectReason ? '#ffb3b3' : '#8fb0d6', maxWidth: 240 }}>{o.rejectReason ?? o.reason}</span>,
                <State s={o.status === 'submitted' ? 'pending' : o.status === 'rejected' ? 'block' : o.status === 'running' ? 'run' : o.status === 'rolled_back' ? 'warn' : 'done'} />,
                o.status === 'submitted' ? (
                  canApprove ? (
                    <div className="row gap6">
                      <button className="btn sm primary" onClick={() => engine.approve(o.id)}>通过并发放</button>
                      <button className="btn sm danger" onClick={() => engine.reject(o.id, '用途说明不充分，须补充绑定应用与预期并发')}>驳回</button>
                    </div>
                  ) : <span className="tiny faint">待审批（无审批权）</span>
                ) : o.status === 'running' ? (canApprove ? <button className="btn sm ghost" onClick={() => engine.rollback(o.id)}>回滚</button> : <span className="tiny faint">已生效</span>) : <span className="tiny faint">{o.decidedBy ?? '—'}</span>,
              ])}
              minWidth={820}
            />
          </div>
        </Panel>
        <Panel title="双 Key 差异化管控" extra="网关强制校验 · 越权即拒绝">
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ border: '1px solid rgba(64,130,220,.18)', background: 'rgba(23,48,90,.28)', borderRadius: 10, padding: '10px 12px' }}>
              <div className="row between">
                <span className="strong">Personal Key 个人密钥</span>
                <Badge tone="info">低配额</Badge>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                一人一钥 · RPM 60 / TPM 12万 · IP 白名单 · 不校验 user / x-app-id · 调用者即密钥持有人，可溯源至申请人
              </div>
            </div>
            <div style={{ border: '1px solid rgba(64,130,220,.18)', background: 'rgba(23,48,90,.28)', borderRadius: 10, padding: '10px 12px' }}>
              <div className="row between">
                <span className="strong">Service Account Key 平台代理</span>
                <Badge tone="purple">高配额</Badge>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                绑定授权应用（x-app-id）· 网关强制校验应用标识、人员标识（user）与授权范围一致，缺失即拒绝 · 不得挪作个人用途
              </div>
            </div>
            <div style={{ border: '1px solid rgba(64,130,220,.18)', background: 'rgba(23,48,90,.28)', borderRadius: 10, padding: '10px 12px' }}>
              <div className="row between">
                <span className="strong">生命周期</span>
                <Badge tone="good">全程留痕</Badge>
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                申请（须说明场景并绑定用途）→ 审批 → 发放（双人复核）→ 轮换（到期前 15 天提醒）→ 吊销（泄露 / 滥用 15 分钟内即时处置）
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt14">
        <Callout
          text={
            <>
              凭证申请须<b>说明使用场景并绑定目标应用或用途</b>，审批通过后方可发放；疑似泄露、调用频率异常、来源 IP 异常时，平台自动执行<b>限流 / 冻结 / 吊销</b>并触发安全告警，协同应用中心开展影响面排查。
            </>
          }
        />
      </div>
    </div>
  )
}
