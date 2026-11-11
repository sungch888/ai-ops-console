import React from 'react'
import { Kpi, Panel, PageHead, Badge, Table, Callout, AlertBadge } from '../../components/ui'
import { accounts } from '../../data/mock'
import { useMatrix, matrixStore, usePerm, useSession, ROLE_LABEL, PERM_LABEL, CLS_LEVELS, type Role, type PermKey } from '../../engine/auth'
import { Jump, useAlertPick, usePickFlash, type AlertJump } from '../../engine/alertJump'

const PERM_KEYS: PermKey[] = ['approve', 'overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool', 'security', 'security_issue', 'security_emergency', 'audit', 'matrix', 'export', 'integration', 'analytics']

const AUDITS: { time: string; obj: string; act: string; res: 'ok' | 'block' | 'warn'; jump?: AlertJump }[] = [
  { time: '11-04 16:20', obj: 'SA-0074 平台代理密钥', act: '配额调整 TPM 60万→90万', res: 'ok' },
  { time: '11-04 14:05', obj: '管理员 罗××', act: '导出调用日志（近 30 日 · 128 万条）', res: 'ok' },
  { time: '11-03 19:40', obj: '开发者 示例××', act: '尝试访问未授权知识库 → 已拦截', res: 'block', jump: { page: '/app/accounts', pick: '业务开发者（各部门）', label: '点过去落到这个角色那一行：知识库权限要不要给，就在下面权限矩阵这一行改' } },
  { time: '11-03 10:12', obj: '账号 PK-2210', act: '疑似泄露吊销并重发', res: 'warn', jump: Jump.credential('PK-2210', '点过去落到这条凭证那一行：重发 / 配额 / 回收都在那一行处理') },
]

export default function AppAccounts() {
  const matrix = useMatrix()
  const matrixPerm = usePerm('matrix')
  const session = useSession()
  const matrixPermRole: Role = session?.role ?? 'user'
  /** 别处点过来：?pick=<角色行主键（本页用账号名）> → 高亮这一行 */
  const pick = useAlertPick()
  usePickFlash(pick)
  const toRoleRow = (name: string) => ({ page: '/app/accounts', pick: name, label: '点过去落到这个角色那一行：授权 / 收回就在下面「权限矩阵」这一行改' })
  return (
    <div>
      <PageHead
        title="跨平台运营"
        desc="统一认证与 SSO · RBAC 与资源标签 · 权限复核与操作审计"
        extra={<><Badge tone="info">用户域 SSO 已对接</Badge><Badge tone="purple">数据域零信任</Badge></>}
      />

      <div className="grid g-5">
        <Kpi label="账号总数" value={5660} unit="个" foot="含 14 地市组织层级" />
        <Kpi label="管理员" value={6} unit="个" foot="双人复核制" />
        <Kpi label="开发者" value={46} unit="个" foot="按业务线归属" />
        <Kpi label="高权限账号" value={5} unit="个" foot="季度复核已回收 3 个" />
        <Kpi label="本月权限变更" value={62} unit="次" foot="全部审批留痕" />
      </div>

      <Panel title="角色权限矩阵" extra="分级角色 · 标签控制资源边界" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={760}
            head={['角色', '定位', '账号数', '高权限', '最近复核']}
            rowKeys={accounts.map((a) => a.name)} pick={pick}
            rows={accounts.map((a) => [
              <span className="strong">{a.name}</span>,
              <span className="tag gray">{a.role}</span>,
              <span className="num">{a.count.toLocaleString('zh-CN')}</span>,
              a.high > 0 ? <AlertBadge tone="warn" jump={toRoleRow(a.name)}>{a.high} 个待复核</AlertBadge> : <Badge tone="good">0</Badge>,
              <span className="mono small">{a.last}</span>,
            ])}
          />
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="统一认证与双域账号">
          <ul className="tl">
            <li><div className="tl-time">用户域</div><div className="small" style={{ color: 'var(--table-text)' }}>平台账号直接登录，支持与各子系统 SSO 单点登录对接；处置登录异常与身份同步失败工单</div></li>
            <li><div className="tl-time">数据域</div><div className="small" style={{ color: 'var(--table-text)' }}>须通过申请注册或统一身份认证（零信任）账号登录，与用户域隔离部署</div></li>
            <li><div className="tl-time">权限模型</div><div className="small" style={{ color: 'var(--table-text)' }}>RBAC 加载功能权限 + 租户 / 组织 / 业务线 / 条线 / 密级 / 项目组标签控制资源访问边界</div></li>
          </ul>
          <Callout text="不得孤立维护与组织体系割裂的账号；账号开通、权限变更、注销均须记录台账并按分级审批办理。" />
        </Panel>
        <Panel title="操作审计" noPad>
          <div className="panel-body">
            <Table
              head={['时间', '对象', '操作', '结果']}
              rows={AUDITS.map((a) => [
                <span className="mono small">{a.time}</span>,
                <span className="small">{a.obj}</span>,
                <span className="muted small">{a.act}</span>,
                a.res === 'block' ? <AlertBadge tone="bad" jump={a.jump ?? toRoleRow(a.obj)}>{`已拦截 · ${a.obj}`}</AlertBadge> : a.res === 'warn' ? <AlertBadge tone="warn" jump={a.jump ?? toRoleRow(a.obj)}>{`已处置 · ${a.obj}`}</AlertBadge> : <Badge tone="good">留痕</Badge>,
              ])}
            />
            <div className="row wrap gap6" style={{ marginTop: 12 }}>
              {['配置变更', '审批操作', '密钥发放', '权限调整', '批量导出'].map((t) => <span key={t} className="tag red">{t}</span>)}
              <span className="small faint">高危操作全程审计：操作人 / 审批单号 / 变更前后值</span>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title="权限矩阵（可编辑 · 立即生效）"
        extra={matrixPerm.manage ? '✔ 当前角色可编辑：勾选后菜单、按钮与数据范围实时变化' : '当前角色只读，需平台管理员编辑'}
        className="mt14"
        noPad
      >
        <div className="panel-body">
          <div className="tbl-scroll">
            <table className="tbl" style={{ minWidth: 1060 }}>
              <thead>
                <tr>
                  <th>角色</th>
                  <th>可访问密级</th>
                  {PERM_KEYS.map((k) => <th key={k} style={{ textAlign: 'center' }}>{PERM_LABEL[k]}</th>)}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(matrix) as Role[]).map((role) => (
                  <tr key={role}>
                    <td>
                      <span className="strong small">{ROLE_LABEL[role]}</span>
                      <div className="tiny faint">{matrix[role].view.length} 个功能点可见</div>
                    </td>
                    <td>
                      <div className="row wrap gap6">
                        {CLS_LEVELS.map((c) => (
                          <span
                            key={c}
                            className={`tag ${matrix[role].cls.includes(c) ? (c === '敏感' ? 'red' : 'green') : 'gray'}`}
                            style={{ cursor: matrixPerm.manage ? 'pointer' : 'default', opacity: matrix[role].cls.includes(c) ? 1 : 0.45 }}
                            onClick={() => matrixPerm.manage && matrixStore.toggleCls(role, c)}
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    {PERM_KEYS.map((k) => {
                      const v = matrix[role].view.includes(k)
                      const m = matrix[role].manage.includes(k)
                      return (
                        <td key={k} style={{ textAlign: 'center' }}>
                          <div className="row gap6" style={{ justifyContent: 'center' }}>
                            <span
                              className={`tag ${m ? 'green' : v ? '' : 'gray'}`}
                              title={m ? '可操作' : v ? '只可见' : '不可见'}
                              style={{ cursor: matrixPerm.manage ? 'pointer' : 'default', opacity: v ? 1 : 0.4 }}
                              onClick={() => matrixPerm.manage && matrixStore.toggleView(role, k)}
                            >
                              {m ? '操作' : v ? '只读' : '—'}
                            </span>
                            {v ? (
                              <button
                                className="btn sm ghost"
                                style={{ padding: '2px 7px', fontSize: 11 }}
                                disabled={!matrixPerm.manage}
                                onClick={() => matrixStore.toggleManage(role, k)}
                              >
                                {m ? '收回' : '授权'}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row between mt14" style={{ marginTop: 14, flexWrap: 'wrap', gap: 10 }}>
            <div className="small" style={{ color: 'var(--text-dim)', maxWidth: 720 }}>
              生效范围：<b>菜单可见性</b>（不可见即导航消失）、<b>操作按钮</b>（无权限即隐藏或只读）、<b>数据范围</b>（密级不在可访问范围时，知识库与应用列表直接过滤掉）。
              当前登录角色：<span className="strong">{ROLE_LABEL[matrixPermRole]}</span>
            </div>
            <div className="row gap6">
              <button className="btn sm ghost" onClick={() => matrixStore.reset()}>恢复默认矩阵</button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid g-3 mt14">
        <Panel title="权限复核与回收">
          {['每月：盘点高权限账号与长期未用权限', '每季：冗余授权清理并输出复核报告', '回收动作登记台账，变更前后值留痕'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
        </Panel>
        <Panel title="集成配置支撑">
          {['存量系统对接、单点登录、专属报表等配置类需求受理', '平台内完成参数配置与连通性验证（不含代码开发）', '输出集成操作指引与用户培训'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
        </Panel>
        <Panel title="日志留存核验">
          {['核验调用日志与操作日志采集完整性（关键字段缺失率 ≤1%）', '每周抽样核验脱敏策略执行', '审计查询 4 小时内完成日志批量导出'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
        </Panel>
      </div>
    </div>
  )
}
