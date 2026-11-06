import React, { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Tabs, Callout } from '../../components/ui'
import { tools } from '../../data/mock'
import { GapBanner } from '../../components/Gap'
import { useEngine, DIRECTORY_KINDS } from '../../engine/engine'

export default function AppTools() {
  const st = useEngine()
  const [tab, setTab] = useState('全部')
  const list = tab === '全部' ? tools : tools.filter((t) => t.type === tab)

  return (
    <div>
      <PageHead
        title="工具生态"
        desc="插件仓库 · Skill 仓库 · MCP 服务 上架审核与运行纳管"
        extra={<><Badge tone="info">10 个工具在线</Badge><Badge tone="warn">1 个降级观察</Badge></>}
      />

      <GapBanner name="MCP 服务平台" />

      <div className="grid g-5">
        <Kpi label="工具总数" value={tools.length} unit="个" foot="MCP 5 · 插件 2 · Skill 2" />
        <Kpi label="今日调用" value="158" unit="万次" foot={<span className="up">▲ 6.2%</span>} />
        <Kpi label="平均成功率" value="98.7" unit="%" foot="超时率 0.9%" />
        <Kpi label="季度合规抽查" value="1" unit="次/季" foot="下次 2026-12-31" />
        <Kpi label="待审上架申请" value={3} unit="项" foot="功能审核 + 安全审查" />
      </div>

      <div className="row between mt14" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Tabs items={['全部', 'MCP', '插件', 'Skill']} active={tab} onChange={setTab} />
        <span className="small faint">共 {list.length} 项 · 按类型筛选</span>
      </div>

      <Panel title="工具目录（业务使用目录）" extra="运行时权限校验 · 调用异常自动隔离 · 与模型侧技术注册目录状态同步" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={860}
            head={['工具', '类型', '版本', '今日调用', '成功率', '负责人', '状态', '技术注册目录（模型侧）', '业务使用目录（本页）']}
            rows={list.map((t) => {
              const m = st.managed.find((x) => x.name === t.name)
              return [
              <span className="strong">{t.name}</span>,
              <span className={`tag ${t.type === 'MCP' ? 'green' : t.type === 'Skill' ? 'gray' : 'gray'}`}>{t.type}</span>,
              <span className="mono small">{t.version}</span>,
              <span className="num">{t.calls}</span>,
              <span className="num" style={{ color: t.success < 96 ? '#ffb3b3' : undefined }}>{t.success}%</span>,
              <span className="muted small">{t.owner}</span>,
              <State s={t.status} />,
              m ? <Badge tone={m.tech ? 'good' : 'bad'}>{m.tech ? '已注册' : '已摘除'}</Badge> : <span className="tiny faint">未纳管</span>,
              m ? <>{m.biz ? <Badge tone="good">在目录</Badge> : <Badge tone="warn">待同步 / 未上架</Badge>}{m.status !== '正常' ? <div className="tiny faint">{m.status}{m.status === '隔离' ? ' · 调用路由已摘除' : ''}</div> : null}</> : <span className="tiny faint">未纳管</span>,
              ]
            })}
          />
          {(() => {
            const reg = st.managed.filter((m) => DIRECTORY_KINDS.includes(m.kind))
            const diff = reg.filter((m) => m.tech !== m.biz || m.status === '隔离' || m.status === '禁用')
            return (
              <Callout text={<>目录一致性核查：纳管 MCP 工具 / 插件 <b>{reg.length}</b> 项，其中技术注册目录与业务使用目录状态不一致或已摘除 <b>{diff.length}</b> 项{diff.length ? `：${diff.map((m) => `${m.name}（技术侧${m.tech ? '在册' : '摘除'} / 业务侧${m.biz ? '在册' : '摘除'}）`).join('、')}` : ''}。模型侧执行「隔离出目录 / 禁用」会同时从两个目录摘除并断开调用路由，「重新纳入 / 启用」则同时恢复；不一致项需由模型中心与业务归口双方确认后同步。</>} />
            )
          })()}
        </div>
      </Panel>

      <div className="grid g-21 mt14">
        <Panel title="上架审核流程" noPad>
          <div className="panel-body">
            <ul className="tl">
              <li><div className="tl-time">01 功能审核</div><div className="small" style={{ color: '#b9cbe6' }}>验证工具能力与说明一致，接口规范与文档模板齐备</div></li>
              <li><div className="tl-time">02 安全审查</div><div className="small" style={{ color: '#b9cbe6' }}>MCP：注入 / 泄露 / 越权风险；Skill：提示词越狱与敏感内容生成风险</div></li>
              <li><div className="tl-time">03 目录纳管</div><div className="small" style={{ color: '#b9cbe6' }}>纳入业务使用目录，展示场景说明与开放范围</div></li>
              <li><div className="tl-time">04 权限配置</div><div className="small" style={{ color: '#b9cbe6' }}>按 RBAC / 租户配置可见性与调用权限，变更须审批留痕</div></li>
              <li><div className="tl-time">05 再审机制</div><div className="small" style={{ color: '#b9cbe6' }}>版本升级、权限调整、依赖变更按首次上架标准重新审核</div></li>
            </ul>
          </div>
        </Panel>
        <Panel title="运行时管控">
          {['调用前校验调用主体权限与工具授权范围', '参数安全审查：拦截注入指令与越权操作', '返回结果安全检测，含敏感信息须脱敏后进入上下文', '高危工具（数据查询 / 系统操作 / 外部访问）须二次确认或审批依据', '持续异常工具自动从可用目录隔离，恢复后重新纳入'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
          <Callout warn text="视频图像检索（v0.9）成功率 94.8%，已连续 3 日低于阈值：使用目录中标注不可选，并通知已绑定该工具的业务方。" />
        </Panel>
      </div>

      <div className="callout mt20">
        <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
        <div>
          <b>职责分离</b>：MCP 技术注册目录（服务地址、版本、依赖、健康探针）由模型中心承担；业务使用目录（场景说明、开放范围、调用权限）由应用中心承担，两者状态联动同步。
        </div>
      </div>
    </div>
  )
}
