import type { CSSProperties } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout } from '../../components/ui'
import { apps } from '../../data/mock'

/* 应用广场（演示数据来自 mock.ts，外部系统已虚拟接入） */

const DESC: Record<string, string> = {
  '报告撰写助手': '自动归纳案情要素，生成结构化业务事件报告初稿',
  '咨询问答助手': '咨询场景标准话术问答，敏感信息自动脱敏',
  '法规知识问答': '全体业务人员通用法规政策问答，覆盖国家与示例省地方性法规',
  '交通违规图像审核': '违法图像智能识别与审核辅助，当前灰度验证',
  '社区走访风险预测': '社区走访重点对象与风险线索智能提示',
  '公开信息筛选': '公开信息自动筛选、定级与线索推送',
  '记录结构化助手': '记录内容结构化抽取与要素完整性校验',
  '装备维保知识库': '业务用装备维保标准问答与手册快速检索',
  '新车驾管知识问答': '新车上牌与驾管业务政策问答',
  '新人带教助手': '新警入警培训问答与考核辅助',
  '专项数据检索助手': '专项手段线索数据合规检索，灰度验证中',
  '无人机飞行计划审核': '无人机飞行计划合规性初审',
}

const card: CSSProperties = {
  background: 'rgba(13, 27, 52, 0.55)',
  border: '1px solid rgba(64, 130, 220, 0.22)',
  borderRadius: 10,
  padding: '12px 14px',
}

function Btn({ label, tone }: { label: string; tone: 'good' | 'warn' }) {
  const c = tone === 'good' ? '#2fd6a3' : '#f5b83d'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        fontSize: 12,
        lineHeight: '20px',
        color: c,
        border: `1px solid ${c}55`,
        borderRadius: 6,
        background: `${c}14`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

const RELEASE = ['交通违规图像审核', '专项数据检索助手', '法规知识问答', '无人机飞行计划审核']
const RELEASE_TIME: Record<string, string> = {
  '交通违规图像审核': '10-28',
  '专项数据检索助手': '10-30',
  '法规知识问答': '09-16',
  '无人机飞行计划审核': '08-22',
}

export default function Market() {
  const gray = apps.filter((a) => a.status === 'gray').length

  return (
    <div>
      <PageHead
        title="应用广场"
        desc="智能体应用统一发现入口 · 上架审核 / 灰度发布 / 下线管理（数据为虚拟演示）"
        extra={
          <>
            <Badge tone="good">广场访问可用</Badge>
            <Badge tone="info">三种访问方式均鉴权</Badge>
          </>
        }
      />

      <div className="grid g-4">
        <Kpi label="应用总数" value={apps.length} unit="个" foot="智能体应用广场目录" />
        <Kpi label="已发布" value={10} unit="个" foot="全量运行 · 含高保 / 共享" />
        <Kpi label="灰度中" value={gray} unit="个" foot="灰度观察 ≥30 分钟后全量" />
        <Kpi label="今日活跃用户" value="1.2" unit="万" foot="全区业务人员 · 双域账号" />
      </div>

      <div className="mt14">
        <Panel title="智能体应用广场" extra={`${apps.length} 个应用 · 按条线分类`}>
          <div className="grid g-4">
            {apps.map((a) => (
              <div key={a.name} style={card}>
                <div className="row between">
                  <span className="strong">{a.name}</span>
                  {a.status === 'gray' ? (
                    <Badge tone="warn">灰度中</Badge>
                  ) : a.status === 'off' ? (
                    <Badge tone="muted">已下线</Badge>
                  ) : (
                    <Badge tone="good">已发布</Badge>
                  )}
                </div>
                <div className="row between" style={{ marginTop: 8 }}>
                  <span className="tag gray">{a.dept}</span>
                  <span className="muted small">{a.model}</span>
                </div>
                <div className="muted small" style={{ marginTop: 8, minHeight: 34, lineHeight: 1.5 }}>
                  {DESC[a.name] ?? '面向业务场景的智能化应用'}
                </div>
                <div className="divider" style={{ margin: '10px 0' }} />
                <div className="row between small">
                  <span className="muted">{a.users.toLocaleString('zh-CN')} 业务人员</span>
                  <span className="num">{a.calls}</span>
                  <span className="num">{a.success}%</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid g-32 mt14">
        <Panel title="发布管理" extra="灰度发布 / 全量发布 / 下线 · 全程留痕" noPad>
          <div className="panel-body">
            <Table
              head={['应用', '等级', '灰度状态', '发布时间', '操作']}
              rows={apps
                .filter((a) => RELEASE.includes(a.name))
                .map((a) => [
                  <span className="strong">{a.name}</span>,
                  a.level === '高保' ? <Badge tone="info">高保</Badge> : <Badge tone="muted">{a.level}</Badge>,
                  <State s={a.status} />,
                  <span className="mono small">{RELEASE_TIME[a.name] ?? '—'}</span>,
                  a.status === 'gray' ? (
                    <Btn label="全量发布" tone="good" />
                  ) : a.status === 'off' ? (
                    <Btn label="重新上架" tone="good" />
                  ) : (
                    <Btn label="下线" tone="warn" />
                  ),
                ])}
            />
          </div>
        </Panel>
        <Panel title="访问与入口说明">
          <div className="row between" style={{ padding: '10px 0', borderBottom: '1px solid rgba(var(--line-rgb), .12)' }}>
            <div>
              <div className="strong" style={{ fontSize: 13 }}>Web 页面 / 嵌入页面 / API</div>
              <div className="muted small" style={{ marginTop: 4 }}>三种访问方式均须经鉴权，不提供匿名访问</div>
            </div>
            <Badge tone="good">统一鉴权</Badge>
          </div>
          <div className="row between" style={{ padding: '10px 0', borderBottom: '1px solid rgba(64,130,220,.12)' }}>
            <div>
              <div className="strong" style={{ fontSize: 13 }}>广场定位</div>
              <div className="muted small" style={{ marginTop: 4 }}>统一发现入口，但并非唯一使用入口</div>
            </div>
            <Badge tone="info">可直连</Badge>
          </div>
          <div className="row between" style={{ padding: '10px 0 0' }}>
            <div>
              <div className="strong" style={{ fontSize: 13 }}>业务分级配置</div>
              <div className="muted small" style={{ marginTop: 4 }}>按高保 / 共享 / 试点配置差异化上架范围与调用权限</div>
            </div>
            <Badge tone="warn">分级管控</Badge>
          </div>
          <div className="mt14">
            <Callout text="应用下线与替换须提前通知受影响用户；灰度发布观察稳定性与用户反馈后再执行全量确认，全过程纳入发布台账。" />
          </div>
        </Panel>
      </div>
    </div>
  )
}
