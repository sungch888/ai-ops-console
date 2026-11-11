import React from 'react'
import { Kpi, Panel, PageHead, Badge, State, Table, Progress, Callout, AlertBadge } from '../../components/ui'
import { Chart, CHART_COLORS, AXIS_COLOR, SPLIT_COLOR, TOOLTIP_STYLE, GRID } from '../../components/Chart'
import { kbs } from '../../data/mock'
import { useMatrix, useSession } from '../../engine/auth'
import { useIntegrations } from '../../engine/ops'
import { useEngine } from '../../engine/engine'
import { Jump, useAlertPick, usePickFlash } from '../../engine/alertJump'

export default function AppKb() {
  const st = useEngine()
  /** 别的页面的红 / 黄告警点过来：?pick=<知识库名> → 高亮这一行 */
  const pick = useAlertPick()
  usePickFlash(pick)
  const matrix = useMatrix()
  const acc = useSession()
  const ints = useIntegrations()
  const allowedCls = acc ? matrix[acc.role].cls : []
  const visible = kbs.filter((k) => allowedCls.includes(k.cls))
  const hidden = kbs.length - visible.length
  const kbInt = ints.find((i) => i.name === '向量知识库构建平台')
  const degraded = kbInt && kbInt.health !== 'ok'
  const recallOpt = {
    color: CHART_COLORS,
    tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: GRID,
    xAxis: { type: 'category', data: kbs.slice(0, 7).map((k) => k.name.replace('（', '\n（')), axisLine: { lineStyle: { color: 'rgba(64,130,220,.3)' } }, axisLabel: { color: AXIS_COLOR, fontSize: 10.5, interval: 0 } },
    yAxis: { type: 'value', name: '召回率 %', min: 70, max: 100, axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: SPLIT_COLOR } } },
    series: [
      { name: '召回率', type: 'bar', barWidth: 20, data: kbs.slice(0, 7).map((k) => k.recall), itemStyle: { borderRadius: 6, color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#22d3ee' }, { offset: 1, color: '#2a6db8' }] } }, label: { show: true, position: 'top', color: '#9ec5ff', fontSize: 11 }, markLine: { silent: true, symbol: 'none', data: [{ yAxis: 85, name: '优化阈值' }], lineStyle: { color: '#f5b83d', type: 'dashed' }, label: { color: '#ffd98a', formatter: '优化阈值 85%' } } },
    ],
  }

  return (
    <div>
      <PageHead
        title="知识库纳管"
        desc="开通审批 · 密级与权限边界 · 检索效果运营 · 知识资产治理"
        extra={<><Badge tone="good">7 个库正常</Badge><Badge tone="muted">1 个僵尸库</Badge></>}
      />

      <div className="grid g-5">
        <Kpi label="纳管知识库" value={kbs.length} unit="个" foot="按组织 / 密级隔离" />
        <Kpi label="文档总量" value={(kbs.reduce((s, k) => s + k.docs, 0) / 10000).toFixed(1)} unit="万篇" foot="含向量化切片 42 万片" />
        <Kpi label="月检索次数" value="366" unit="万次" foot={<span className="up">▲ 11%</span>} />
        <Kpi label="平均召回率" value="88" unit="%" foot="低于 85% 触发优化建议" />
        <Kpi label="入库拦截" value={6} unit="篇" foot="密级不符 / 来源不明" />
      </div>

      <div className="grid g-32 mt14">
        <Panel title="检索效果运营分析" extra="召回率 · 低于阈值进入优化队列">
          <Chart option={recallOpt} height={280} />
        </Panel>
        <Panel title="检索前权限过滤" noPad>
          <div className="panel-body">
            <div className="small" style={{ color: 'var(--text-dim)', lineHeight: 2 }}>
              向量检索与关键词检索均携带权限过滤条件（租户 / 组织 / 业务线 / 密级），从源头阻断跨租户、跨密级知识泄露。
            </div>
            <div className="divider" />
            <Table
              head={['脱敏层', '策略', '示例字段']}
              rows={[
                ['展示层', <Badge tone="info">掩码</Badge>, '身份证号 · 手机号'],
                ['存储层', <Badge tone="info">摘要化</Badge>, '案事件编号'],
                ['传输层', <Badge tone="good">TLS / 国密</Badge>, '高密级禁止明文'],
              ]}
            />
            <Callout text="检索返回片段进入模型上下文前，须完成安全与权限复核；命中跨密级引用自动过滤并记录。" />
          </div>
        </Panel>
      </div>

      <Panel title="知识库清单" extra={`文档量 / 调用量 / 密级 / 状态 · 当前角色可访问密级：${allowedCls.join('、') || '无'}`} className="mt14" noPad>
        <div className="panel-body">
          {degraded ? (
            <Callout
              warn
              jump={Jump.connector(kbInt!.id, '点过去到外部对接清单这一条接入：探活 / 恢复通道 / 改配置')}
              icon={<svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 16H3l9-16z" /><path d="M12 10v4M12 17v.5" /></svg>}
              text={<><b>数据缺口：{kbInt!.name} 通道{kbInt!.health === 'fault' ? '中断' : '异常'}</b>　检索量、召回率与文档量自 {new Date().toLocaleTimeString('zh-CN', { hour12: false })} 起停止采集，下方数值为中断前最后一次汇总。</>}
            />
          ) : null}
          <Table
            minWidth={820}
            head={['知识库', '文档数', '月检索', '召回率', '密级', '状态', '处置状态（实时）']}
            rowKeys={visible.map((k) => k.name)} pick={pick}
            rows={visible.map((k) => {
              const m = st.managed.find((x) => x.name === k.name)
              return [
              <span className="strong">{k.name}</span>,
              <span className="num">{k.docs.toLocaleString('zh-CN')}</span>,
              <span className="num small">{k.calls}</span>,
              <div style={{ minWidth: 130 }}>
                {k.recall ? (
                  <>
                    <Progress value={(k.recall - 70) * (100 / 30)} tone={k.recall < 85 ? 'warn' : 'green'} jump={k.recall < 85 ? Jump.kb(k.name, '召回率低于优化阈值：点这条进度落到这个库那一行（优化 / 复核都在这里）') : undefined} />
                    <span className="tiny faint">{k.recall}%</span>
                  </>
                ) : <span className="faint small">—（无有效检索）</span>}
              </div>,
              <span className={`tag ${k.cls === '敏感' ? 'red' : k.cls === '公开' ? 'green' : 'gray'}`}>{k.cls}</span>,
              <State s={k.status} />,
              m ? (m.status === '正常' ? <Badge tone="good">正常</Badge> : <AlertBadge tone={m.status === '限流' ? 'warn' : 'bad'} jump={Jump.kb(m.name, '这个库的处置状态异常：点过去看这一行（暂停入库 / 队列滞留都要有人处理）')}>{m.status}{m.status === '暂停' ? ` · 队列滞留 ${m.queue} 项` : ''}</AlertBadge>) : <span className="tiny faint">未纳管</span>,
              ]
            })}
          />
          {hidden > 0 ? (
            <div className="small" style={{ marginTop: 10, color: 'var(--bad-text)' }}>
              按当前角色可访问密级已过滤 <b>{hidden}</b> 个知识库：{kbs.filter((k) => !allowedCls.includes(k.cls)).map((k) => `${k.name}（${k.cls}）`).join('，')}。授权范围在「跨平台运营 · 权限矩阵」调整后立即生效。
            </div>
          ) : (
            <div className="small" style={{ marginTop: 10, color: 'var(--text-dim)' }}>当前角色可访问全部 {kbs.length} 个知识库（密级范围：{allowedCls.join('、')}）。</div>
          )}
        </div>
      </Panel>

      <div className="grid g-3 mt14">
        <Panel title="开通与准入审批">
          {['受理创建申请：名称 / 用途 / 权限边界 / 密级标签', '审核通过后方可授权接入构建平台', '文档入库核验来源、审批记录与密级标签', '无审批、来源不明、密级不符不得入库'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
        </Panel>
        <Panel title="运行异常告警与处置">
          {['解析失败率升高 · 向量化队列阻塞 · 检索超时突增', '存储容量触顶 → 暂停入库任务，恢复后自动解除', '处置过程全程留痕并纳入事件台账'].map((t) => (
            <div key={t} className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>{t}</div>
          ))}
        </Panel>
        <Panel title="知识资产治理">
          <div className="row between small"><span>培训教材 2023（停更）</span><Badge tone="muted">僵尸库</Badge></div>
          <div className="small" style={{ color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.8 }}>月检索 200 次 · 12 个月未更新 · 建议归档或销毁</div>
          <div className="divider" />
          <div className="small" style={{ color: 'var(--text-dim)', lineHeight: 1.9 }}>月盘点数据量 / 使用频率 / 更新状态，维护知识资产台账；含敏感或超权限开放风险的知识库提请权限复核。</div>
        </Panel>
      </div>
    </div>
  )
}
