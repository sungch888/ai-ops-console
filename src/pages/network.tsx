/* =====================================================================
 * 部署形态与网络分区视图（选型决策项）
 * 一套平台跨网（逻辑分区） vs 三套网各自部署（物理分区）
 * 切换视图后，可见模型 / 渠道 / 应用 / 工具 / 凭证类型与用量成本随之变化
 * ===================================================================== */
import { useState } from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Callout } from '../components/ui'
import { useEngine, poolUtil } from '../engine/engine'
import { ledgerOf } from '../engine/ledger'
import { apps as mockApps, tools as mockTools } from '../data/mock'
import { useMatrix, useSession } from '../engine/auth'

type NetView = {
  key: string
  name: string
  clsCap: string
  desc: string
  credKinds: string[]
  notes: string[]
  appOK: (a: { name: string; dept: string; model: string }) => boolean
  modelOK: (short: string) => boolean
  channelOK: (kind: string) => boolean
  toolOK: (name: string) => boolean
}

const VIEWS: NetView[] = [
  {
    key: 'all', name: '一套平台 · 跨网逻辑分区', clsCap: '敏感（受权限矩阵约束）',
    desc: '平台单套部署在示例单位信息网，视频专网与接入区通过前置服务与单向数据交换接入，按密级与权限控制可见范围。',
    credKinds: ['平台代理', '个人密钥'],
    notes: ['一套运维值班 · 一份变更窗口排期', '跨网调用需前置网关与审计留痕', '投资与上线周期最省'],
    appOK: () => true, modelOK: () => true, channelOK: () => true, toolOK: () => true,
  },
  {
    key: 'intra', name: '示例单位信息网（内网）', clsCap: '敏感',
    desc: '承载核心业务与内部数据：业务事件、记录、专项手段、综合业务与示例业务三部类应用；仅本地推理渠道，禁止厂商公网渠道。',
    credKinds: ['平台代理'],
    notes: ['仅平台代理凭证 · 个人密钥不在内网发放', '渠道仅本地推理集群', '需独立权限矩阵与独立审计'],
    appOK: (a) => ['示例业务一部', '综合业务', '示例业务三部', '信息化管理部', '专项手段', '训练'].includes(a.dept),
    modelOK: (s) => ['Qwen3-32B', 'GLM-4-9B', 'BGE-M3', 'Reranker', 'Whisper'].includes(s),
    channelOK: (k) => k === '本地',
    toolOK: (n) => ['业务系统查询', '人口基础信息查询', '法规库检索', '文档 OCR', '报告撰写 Skill', '会议纪要 Skill', '日历/排班查询'].includes(n),
  },
  {
    key: 'video', name: '视频图像专网', clsCap: '内部',
    desc: '承载视频图像解析与图像审核类能力：监测点图像、无人机影像、语音转写；卡位独立于内网集群。',
    credKinds: ['平台代理'],
    notes: ['独立卡位与独立副本池', '图像与语音数据不出专网', '需与内网做结果回传（结构化结论）'],
    appOK: (a) => ['示例业务二部', '低空巡检'].includes(a.dept),
    modelOK: (s) => ['Qwen2.5-VL', 'Whisper', 'BGE-M3'].includes(s),
    channelOK: (k) => k === '本地',
    toolOK: (n) => ['视频图像检索', '车辆管理查询', '地图服务', '文档 OCR'].includes(n),
  },
  {
    key: 'open', name: '互联网+业务接入区', clsCap: '公开',
    desc: '面向对外服务与基层轻量使用：法规问答、驾管问答、带教问答；可调用厂商渠道，个人密钥在此区发放。',
    credKinds: ['个人密钥'],
    notes: ['个人密钥在此区发放（默认 120 RPM 上限）', '仅公开密级内容与脱敏输入', '需内容安全与敏感词策略前置'],
    appOK: (a) => ['全体业务人员', '示例业务二部'].includes(a.dept) && a.name !== '交通违规图像审核',
    modelOK: (s) => ['GLM-4-9B', 'BGE-M3'].includes(s),
    channelOK: (k) => k === '外部',
    toolOK: (n) => ['法规库检索', '地图服务', '日历/排班查询'].includes(n),
  },
]

export default function Network() {
  const st = useEngine()
  const L = ledgerOf(st)
  const acc = useSession()
  const matrix = useMatrix()
  const [key, setKey] = useState('all')
  const v = VIEWS.find((x) => x.key === key)!

  const visibleApps = mockApps.filter(v.appOK)
  const visibleModels = st.models.filter((m) => v.modelOK(m.short))
  const visibleChannels = st.channels.filter((c) => v.channelOK(c.kind))
  const visibleTools = st.managed.filter((m) => (m.kind === 'MCP工具' || m.kind === '插件') && v.toolOK(m.name))
  const visibleCreds = st.creds.filter((c) => v.credKinds.includes(c.kind))
  const appRows = visibleApps.map((a) => L.perApp.find((r) => r.name === a.name)).filter(Boolean)
  const calls = appRows.reduce((s, r) => s + (r?.calls ?? 0), 0)
  const tokens = appRows.reduce((s, r) => s + (r?.tokens ?? 0), 0)
  const cost = appRows.reduce((s, r) => s + (r?.cost ?? 0), 0)
  const liveModels = visibleModels.filter((m) => m.replicas > 0 && m.state === '运行中')
  const cards = liveModels.reduce((s, m) => s + m.replicas * m.perReplica, 0)
  const otherViews = VIEWS.filter((x) => x.key !== 'all')

  return (
    <div>
      <PageHead
        title="部署形态与网络分区视图"
        desc="一套平台跨网（逻辑分区） 与 三套网各自部署（物理分区） 的可见范围对比 · 选型阶段需客户方确认"
        extra={<><Badge tone="info">当前角色可见密级 {acc ? matrix[acc.role].cls.join('/') : '—'}</Badge><Badge tone="warn">待客户方确认口径</Badge></>}
      />

      <div className="row wrap gap6" style={{ marginBottom: 14 }}>
        {VIEWS.map((x) => (
          <button key={x.key} className={`btn sm ${x.key === key ? 'primary' : ''}`} onClick={() => setKey(x.key)}>{x.name}</button>
        ))}
        <span className="small faint" style={{ marginLeft: 'auto' }}>切换视图即切换该网络内的可见资产与用量口径</span>
      </div>

      <Callout text={<><b>{v.name}</b> · {v.desc}<div className="small" style={{ color: '#a9c4e8', marginTop: 6 }}>数据密级上限：{v.clsCap} · 可发放凭证：{v.credKinds.join(' / ')} · {v.notes.join(' · ')}</div></>} />

      <div className="grid g-6">
        <Kpi label="可见模型" value={visibleModels.length} unit={`/ ${st.models.length}`} foot={`其中 ${liveModels.length} 个有存活副本 · 承载 ${cards} 卡`} />
        <Kpi label="可用渠道" value={visibleChannels.length} unit={`/ ${st.channels.length}`} foot={`本地 ${visibleChannels.filter((c) => c.kind === '本地').length} · 外部 ${visibleChannels.filter((c) => c.kind === '外部').length}`} />
        <Kpi label="可见应用" value={visibleApps.length} unit={`/ ${mockApps.length}`} foot={`承接中 ${appRows.filter((r) => (r?.calls ?? 0) > 0).length} 个`} />
        <Kpi label="可见工具 / 插件" value={visibleTools.length} unit={`/ ${mockTools.filter((t) => t.type !== 'Skill').length}`} foot={`业务目录在册 ${visibleTools.filter((m) => m.biz).length} · 已摘除 ${visibleTools.filter((m) => !m.biz).length}`} />
        <Kpi label="本视图今日调用" value={(calls / 10000).toFixed(1)} unit="万次" foot={`Token ${tokens.toLocaleString('zh-CN')} 万 · 占全平台 ${Math.round((calls / Math.max(1, L.callsToday)) * 100)}%`} />
        <Kpi label="本视图今日成本" value={(cost / 10000).toFixed(2)} unit="万元" foot={`全平台 ${(L.costToday / 10000).toFixed(2)} 万元 · 凭证 ${visibleCreds.length} 个`} />
      </div>

      <Panel title="该网络内的模型与渠道" extra="渠道种类决定该视图能否调用厂商渠道" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={900}
            head={['模型', '版本', '副本与卡位', '池利用率', '该视图可用渠道', '状态']}
            rows={visibleModels.map((m) => [
              <span className="strong small">{m.short}<div className="tiny faint">{m.name}</div></span>,
              <span className="mono small">{m.ver}</span>,
              <span className="num small">{m.replicas} × {m.perReplica} 卡</span>,
              <span className="num small">{poolUtil(st, m.pool)}%</span>,
              <span className="small">{visibleChannels.map((c) => c.name.split('（')[0]).join(' / ') || '无可用渠道'}</span>,
              m.replicas > 0 ? <Badge tone="good">可在该视图部署</Badge> : <Badge tone={m.state === '已下线' ? 'bad' : 'warn'}>{m.state === '已下线' ? '已下线' : '无存活副本'}</Badge>,
            ])}
          />
        </div>
      </Panel>

      <div className="grid g-2 mt14">
        <Panel title="该网络内的应用与用量" noPad>
          <div className="panel-body">
            <Table
              minWidth={760}
              head={['应用', '归口', '今日调用', '今日 Token（万）', '状态']}
              rows={visibleApps.map((a) => {
                const r = L.perApp.find((x) => x.name === a.name)
                return [
                  <span className="small strong">{a.name}</span>,
                  <span className="tag gray">{a.dept}</span>,
                  <span className="num small">{((r?.calls ?? 0) / 10000).toFixed(2)} 万</span>,
                  <span className="num small">{(r?.tokens ?? 0).toLocaleString('zh-CN')}</span>,
                  r && (r?.calls ?? 0) === 0 ? <Badge tone="bad">未承接（{r?.note ?? '受限'}）</Badge> : <State s={a.status} />,
                ]
              })}
            />
          </div>
        </Panel>
        <Panel title="该网络内的工具 / 插件与凭证" noPad>
          <div className="panel-body">
            <Table
              minWidth={760}
              head={['工具 / 插件', '类型', '模型侧注册', '业务目录', '归口']}
              rows={visibleTools.map((m) => [
                <span className="small strong">{m.name}</span>,
                <span className="tag gray">{m.kind}</span>,
                m.tech ? <Badge tone="good">已注册</Badge> : <Badge tone="bad">已摘除</Badge>,
                m.biz ? <Badge tone="good">在册</Badge> : <Badge tone="warn">待同步</Badge>,
                <span className="small">{m.owner}</span>,
              ])}
            />
            <div className="divider" />
            <Table
              minWidth={760}
              head={['凭证（该视图可发放类型）', '持有方', '配额', '状态']}
              rows={visibleCreds.map((c) => [
                <span className={`tag ${c.kind === '个人密钥' ? '' : 'green'}`}>{c.kind}</span>,
                <span className="small">{c.holder}</span>,
                <span className="num small">{c.rpm} RPM</span>,
                c.status === 'off' ? <Badge tone="bad">已吊销</Badge> : c.status === 'warn' ? <Badge tone="warn">临期</Badge> : <State s="ok" />,
              ])}
            />
          </div>
        </Panel>
      </div>

      <Panel title="两种部署形态对比（需客户方选型确认）" extra="同一套引擎分别按三套网视图与一套跨网视图计算" className="mt14" noPad>
        <div className="panel-body">
          <Table
            minWidth={1000}
            head={['对比项', '一套平台跨网部署（逻辑分区）', '三套网各自部署（物理分区）']}
            rows={[
              ['平台实例与运维', <span className="small">1 套平台 · 1 份变更窗口排期 · 1 支值班队伍</span>, <span className="small">3 套平台 · 3 份排期与值班 · 版本需同步发布</span>],
              ['资产可见范围', <span className="small">全部 {st.models.length} 个模型 / {mockApps.length} 个应用按权限矩阵可见</span>, <span className="small">{otherViews.map((o) => `${o.name.split('（')[0]} ${o.appOK ? mockApps.filter(o.appOK).length : 0} 应用`).join(' · ')}</span>],
              ['卡位与渠道', <span className="small">{st.pools.map((p) => `${p.name} ${p.cards} 卡`).join(' · ')} 统一调度，跨池可借用</span>, <span className="small">三套各建推理池，无法互相借用：合计需 {st.pools.reduce((s, p) => s + p.cards, 0) + 12} 卡以上（含冗余）</span>],
              ['跨网数据交换', <span className="small">前置网关 + 单向导入 + 全链路审计（本演示已按渠道与权限体现）</span>, <span className="small">需网闸 / 数据交换平台，结论回传延迟与失败率需单独监控</span>],
              ['凭证与配额', <span className="small">统一凭证台账，个人密钥限接入区使用</span>, <span className="small">三套独立台账，同一人多凭证，配额与积分需跨套汇总</span>],
              ['厂商渠道（外部模型）', <span className="small">仅接入区可调用，内网视图强制本地渠道（本演示已按渠道种类过滤）</span>, <span className="small">内网与视频专网物理不可达，接入区单独报批</span>],
              ['上线周期与投资', <span className="small">一次上线 · 投资较低 · 等保与密评一套范围</span>, <span className="small">三次上线 · 硬件与运维投资约 2～3 倍 · 三套独立定级与密评</span>],
            ]}
          />
          <Callout text={<>本页为选型演示：切换视图看到的资产与用量，就是「三套各自部署」时每套的可见范围；切换回「一套平台 · 跨网逻辑分区」则是单套部署下的统一视图。<b>需客户方确认：平台部署在哪张网、跨网数据交换由谁提供、三套部署时的卡位与运维主体。</b>演示版不预设结论，两种形态均可现场演示。</>} />
        </div>
      </Panel>
    </div>
  )
}
