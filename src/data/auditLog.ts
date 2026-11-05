/* =====================================================================
 * 调用审计日志（演示数据源）
 * 由引擎凭证台账 + 固定人员/应用池生成，字段对齐需求：
 * 唯一 traceId · 调用人员 · 所属应用 · 租户/地市 · 模型渠道 · Token · 安全处置结果 · 人员标识来源等级
 * ===================================================================== */
import { engine } from '../engine/engine'

export interface ChainNode { label: string; name: string; note: string }
export interface AuditEntry {
  id: string
  ts: number
  time: string
  traceId: string
  person: string
  jobNo: string
  org: string
  city: string
  app: string
  entry: 'Web 页面' | '嵌入页面' | 'API 调用'
  cred: string
  credKind: '平台代理' | '个人密钥'
  model: string
  channel: string
  tokens: number
  latency: number
  result: '放行' | '脱敏放行' | '拦截' | '限流' | '网关拒绝'
  risk: string
  identityGrade: '平台保证' | '统一身份认证' | '低信任 · 自建工具' | '标识缺失'
  chain: ChainNode[]
}

const PERSONS = [
  { person: '管理员 A', jobNo: 'U-0001', org: '信息化管理部 · 平台运营', city: '示范市01', level: '高保' },
  { person: '运营 B', jobNo: 'U-0002', org: '示例业务六部', city: '示范市01', level: '共享' },
  { person: '开发者 C', jobNo: 'U-0003', org: '示例业务二部 · 科技信息化', city: '示范市02', level: '灰度' },
  { person: '用户 D', jobNo: 'U-0004', org: '示例业务四部', city: '示范市03', level: '共享' },
  { person: '示例甲', jobNo: 'U-1032', org: '示例业务一部 · 数据分析', city: '示范市01', level: '高保' },
  { person: '示例乙', jobNo: 'U-1188', org: '示例业务二部 · 违规处理', city: '示范市02', level: '共享' },
  { person: '苏梅', jobNo: 'U-1204', org: '涉外管理', city: '示范市05', level: '共享' },
  { person: '张涛', jobNo: 'U-1377', org: '示范市10专项业务部门', city: '示范市10', level: '灰度' },
  { person: '何俊', jobNo: 'U-1420', org: '自建的值班查询工具', city: '示范市08', level: '灰度' },
  { person: '吴琳', jobNo: 'U-1505', org: '示范市06口岸', city: '示范市06', level: '共享' },
]
const APPS = ['报告生成助手', '示例业务六部话术问答助手', '交通违规图像审核', '记录摘要与要素提取', '口岸涉外问答', '专项业务线索关联分析', '值班知识问答机器人', '12389 智能坐席', '涉外材料预审', '公开信息要素抽取']
const KBS = ['示例单位法规知识库', '交通违规处置知识库', '示例业务六部话术知识库', '涉外业务手册', '记录规范知识库']
const TOOLS = ['MCP · 车辆轨迹查询', 'MCP · 身份证核验', 'MCP · 违法记录查询', '插件 · 文书模板渲染', '无工具调用']

function rng(seed: number) {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
}
function hash(str: string) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return Math.abs(h) }

let cache: { key: string; rows: AuditEntry[] } | null = null

export function auditLog(): AuditEntry[] {
  const st = engine.get()
  const key = st.creds.map((c) => c.id).join(',') + '|' + st.channels.map((c) => c.id).join(',')
  if (cache && cache.key === key) return cache.rows

  const liveCreds = st.creds
  const chName = (id: string) => st.channels.find((c) => c.id === id)?.name ?? id
  const rows: AuditEntry[] = []
  const now = Date.now()
  let seed = 7

  for (let i = 0; i < 186; i++) {
    seed += 1
    const r = rng(hash(key) + seed * 977)
    const p = PERSONS[Math.floor(r() * PERSONS.length)]
    const cred = liveCreds.length ? liveCreds[Math.floor(r() * liveCreds.length)] : null
    const model = st.models[Math.floor(r() * st.models.length)]
    const channel = cred ? cred.channel : st.channels[Math.floor(r() * st.channels.length)].id
    const app = cred && cred.app && r() > 0.42 ? cred.app : APPS[Math.floor(r() * APPS.length)]
    const isSelf = p.org.includes('自建')
    const entry = (['Web 页面', '嵌入页面', 'API 调用'] as const)[Math.floor(r() * 3)]
    const minutesAgo = Math.floor(Math.pow(r(), 2.6) * 10080)
    const ts = now - minutesAgo * 60000
    const tokens = Math.round((260 + r() * 4200) * (p.level === '高保' ? 1.6 : 1))
    const latency = Math.round(60 + r() * 320)
    const roll = r()
    const revoked = cred?.status === 'off'
    const result: AuditEntry['result'] = revoked ? '网关拒绝' : isSelf && roll > 0.86 ? '网关拒绝' : roll > 0.93 ? '拦截' : roll > 0.85 ? '脱敏放行' : roll > 0.8 ? '限流' : '放行'
    const risk = revoked ? '凭证已吊销 · 网关拒绝并记录来源 IP'
      : result === '拦截' ? (r() > 0.5 ? '提示词注入特征（角色改写指令）' : '内部字段命中敏感词库')
      : result === '脱敏放行' ? '身份证 / 手机号已脱敏'
      : result === '限流' ? '单位时间调用量超阈值（限流保护）'
      : result === '网关拒绝' ? '人员标识缺失 · 网关拒绝请求' : '无风险命中'
    const identityGrade: AuditEntry['identityGrade'] = isSelf ? '低信任 · 自建工具' : entry === 'API 调用' ? '统一身份认证' : result === '网关拒绝' ? '标识缺失' : '平台保证'
    const kb = KBS[Math.floor(r() * KBS.length)]
    const tool = TOOLS[Math.floor(r() * TOOLS.length)]
    const hex = (n: number) => n.toString(16).padStart(4, '0').slice(0, 4)
    const traceId = `TR-${hex(seed)}${hex(hash(key + seed) % 65536)}${hex(tokens % 65536)}`
    const d = new Date(ts)
    const p2 = (x: number) => String(x).padStart(2, '0')

    rows.push({
      id: `L-${String(i + 1).padStart(4, '0')}`,
      ts,
      time: `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
      traceId,
      person: p.person,
      jobNo: p.jobNo,
      org: p.org,
      city: p.city,
      app,
      entry,
      cred: cred ? cred.id : 'SA-0000',
      credKind: cred ? cred.kind : '平台代理',
      model: model.short,
      channel: chName(channel),
      tokens,
      latency,
      result,
      risk,
      identityGrade,
      chain: [
        { label: '调用人员', name: `${p.person}（${p.jobNo}）`, note: `${p.org} · ${p.city} · 标识来源：${identityGrade}` },
        { label: '访问入口', name: entry, note: entry === '嵌入页面' ? '业务系统内嵌（x-app-id 校验通过）' : entry === 'API 调用' ? '统一身份认证令牌提取工号' : '平台 Web 会话' },
        { label: '智能体 / 应用', name: app, note: '上架审批状态：已发布 · 权限校验一致' },
        { label: '知识库检索', name: kb, note: `召回 5 片段 · 检索前权限过滤已执行 · 密级相符` },
        { label: 'MCP / 工具', name: tool, note: tool === '无工具调用' ? '本次未调用工具' : '入参与结果均已检测 · 未发现参数篡改' },
        { label: '模型渠道', name: `${model.short} · ${chName(channel)}`, note: `凭证 ${cred ? cred.id : 'SA-0000'} · ${cred ? cred.kind : '平台代理'} · 处置：${result}` },
      ],
    })
  }
  rows.sort((a, b) => b.ts - a.ts)
  cache = { key, rows }
  return rows
}

export const AUDIT_FILTER_OPTIONS = {
  persons: PERSONS.map((p) => `${p.person}（${p.jobNo}）`),
  apps: APPS,
  models: ['Qwen3-32B', 'GLM-4-9B', 'BGE-M3', 'Reranker', 'Whisper', 'Qwen2.5-VL'],
  cities: ['示范市01', '示范市02', '示范市03', '示范市05', '示范市10', '示范市08', '示范市06'],
  results: ['放行', '脱敏放行', '拦截', '限流', '网关拒绝'],
}
