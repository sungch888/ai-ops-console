/* =====================================================================
 * 运营模板库（需求 应用 35：FAQ / 操作手册 / 编排模板 等）
 * 模板可订阅引用、可提交新增（须审批）、可停用与恢复；密级决定能否下载
 * 与引擎联动：处置预案对应处置动作库，提示词模板对应检测策略库
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine } from './engine'
import { notifyStore } from './ops'

export type TemplateKind = 'FAQ 知识库' | '操作手册' | '编排模板' | '提示词模板' | '处置预案' | '培训课件'
export type TemplateStatus = '已发布' | '待审核' | '已停用'

export interface Template {
  id: string
  name: string
  kind: TemplateKind
  owner: string
  version: string
  cls: '公开' | '内部' | '敏感'
  status: TemplateStatus
  refs: number
  updatedAt: string
  related: string
  desc: string
}

const KEY = 'dsh-demo-templates-v1'

export const DEFAULT_TEMPLATES: Template[] = [
  { id: 'TP-01', name: '咨询问答标准应答 FAQ', kind: 'FAQ 知识库', owner: '示例业务五部', version: 'v3.4', cls: '公开', status: '已发布', refs: 186, updatedAt: '11-02', related: '咨询问答助手 · 咨询服务项目组', desc: '常见咨询问题标准应答与转人工条件，含 42 条问答对' },
  { id: 'TP-02', name: '报告生成编排模板', kind: '编排模板', owner: '示例业务一部', version: 'v2.1', cls: '内部', status: '已发布', refs: 124, updatedAt: '11-03', related: '报告撰写助手 · 记录结构化助手', desc: '接警摘要 → 要素抽取 → 法条引用 → 成文校验的四步编排链' },
  { id: 'TP-03', name: '敏感问询处置预案', kind: '处置预案', owner: '示例业务四部', version: 'v1.6', cls: '敏感', status: '已发布', refs: 38, updatedAt: '11-04', related: '检测策略 P-03 / P-07 · 处置动作 限流保护', desc: '命中敏感词与越权提问时的处置顺序：提示 → 转人工 → 限流 → 上报' },
  { id: 'TP-04', name: '图像审核标注操作手册', kind: '操作手册', owner: '示例业务二部', version: 'v4.0', cls: '内部', status: '已发布', refs: 92, updatedAt: '10-29', related: '交通违规图像审核（灰度）', desc: '模型预标注结果的人工复核规则、误报判定与申诉流程' },
  { id: 'TP-05', name: '法条引用校验提示词模板', kind: '提示词模板', owner: '示例业务三部', version: 'v2.8', cls: '内部', status: '已发布', refs: 158, updatedAt: '11-01', related: '法规知识问答 · 检测策略 P-05', desc: '要求逐条给出法条出处与生效日期，禁止生成未列明条文的结论' },
  { id: 'TP-06', name: '新员工模型使用培训课件', kind: '培训课件', owner: '训练处', version: 'v1.2', cls: '公开', status: '已发布', refs: 214, updatedAt: '10-24', related: '新人带教助手', desc: '能做什么 / 不能做什么 / 哪些内容禁止输入，含 6 个反面案例' },
  { id: 'TP-07', name: '知识库入库质量核查手册', kind: '操作手册', owner: '信息化管理部', version: 'v2.2', cls: '内部', status: '已发布', refs: 66, updatedAt: '11-03', related: '判例库 / 咨询 FAQ 库 · 处置动作 暂停入库', desc: '入库前查重、来源标注、时效性复核与失效下架流程' },
  { id: 'TP-08', name: '工具调用失败应急处置预案', kind: '处置预案', owner: '信息化管理部', version: 'v1.1', cls: '内部', status: '待审核', refs: 0, updatedAt: '11-04', related: 'MCP 工具目录 · 处置动作 隔离出目录', desc: '工具连续失败时的隔离、降级话术与业务方通知模板（待归口确认）' },
  { id: 'TP-09', name: '批量导出与下载审批手册', kind: '操作手册', owner: '示例业务三部', version: 'v1.0', cls: '敏感', status: '已停用', refs: 12, updatedAt: '10-18', related: '报表台账 · 审计检索', desc: '批量导出的审批路径、留痕要求与数量上限（新版待发布）' },
]

const listeners = new Set<() => void>()
let templates: Template[] = load()
let seq = 10

function load(): Template[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) { const p = JSON.parse(raw) as Template[]; if (Array.isArray(p) && p.length >= 5) return p }
  } catch { /* 演示环境忽略损坏数据 */ }
  return DEFAULT_TEMPLATES.map((t) => ({ ...t }))
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(templates)) } catch { /* 忽略 */ } }
function emit() { listeners.forEach((f) => f()) }
function event(text: string, level: '一般' | '重要' = '一般') { engine.get().events.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5), level, text }); engine.refresh() }

export const templateStore = {
  list: () => templates,
  subscribe(id: string) {
    const t = templates.find((x) => x.id === id)
    if (!t) return { ok: false as const, reason: '未找到该模板' }
    if (t.status !== '已发布') return { ok: false as const, reason: `${t.name} 当前状态为「${t.status}」，不可引用` }
    templates = templates.map((x) => (x.id === id ? { ...x, refs: x.refs + 1 } : x))
    const refs = templates.find((x) => x.id === id)!.refs
    persist(); emit()
    event(`模板引用：${t.name} ${t.version}（归口 ${t.owner}）· 累计引用 ${t.refs} 次`)
    notifyStore.push('一般', `模板已引用：${t.name}`, `${t.kind} · ${t.version} · 归口 ${t.owner} · 关联 ${t.related}。引用记录已写入运营台账，供模板有效性评估。`, '应用中心 / 运营模板库')
    return { ok: true as const, refs }
  },
  submit(input: { name: string; kind: TemplateKind; owner: string; cls: Template['cls']; desc: string; related: string; by: string }) {
    if (!input.name.trim() || !input.owner.trim()) return { ok: false as const, reason: '模板名称与归口单位不能为空' }
    const dup = templates.find((t) => t.name === input.name.trim())
    if (dup) return { ok: false as const, reason: `已存在同名模板 ${dup.id}（${dup.status}），请改名或申请改版` }
    const id = `TP-${String(seq++).padStart(2, '0')}`
    templates = [...templates, { id, name: input.name.trim(), kind: input.kind, owner: input.owner.trim(), version: 'v0.1', cls: input.cls, status: '待审核', refs: 0, updatedAt: new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace(/\//g, '-'), related: input.related || '（待归口确认）', desc: input.desc || '（待补充说明）' }]
    persist(); emit()
    event(`模板新增申请：${input.name.trim()}（${input.kind} · ${input.cls}）已提交归口 ${input.owner} 审核`, '重要')
    notifyStore.push('重要', `模板新增待审核：${input.name.trim()}`, `${input.kind} · 归口 ${input.owner} · 密级 ${input.cls} · 提交人 ${input.by}。审核通过后方可被业务引用。`, '应用中心 / 运营模板库')
    return { ok: true as const, id }
  },
  approve(id: string) {
    const t = templates.find((x) => x.id === id)
    if (!t || t.status !== '待审核') return { ok: false as const, reason: '仅待审核模板可通过' }
    templates = templates.map((x) => (x.id === id ? { ...x, status: '已发布' as TemplateStatus } : x))
    persist(); emit()
    event(`模板审核通过：${t.name} ${t.version} 已发布至业务目录`)
    return { ok: true as const, id }
  },
  reject(id: string) {
    const t = templates.find((x) => x.id === id)
    if (!t || t.status !== '待审核') return { ok: false as const, reason: '仅待审核模板可驳回' }
    templates = templates.map((x) => (x.id === id ? { ...x, status: '已停用' as TemplateStatus } : x))
    persist(); emit()
    event(`模板审核驳回：${t.name}（归口 ${t.owner}）· 驳回原因已记录`, '重要')
    notifyStore.push('重要', `模板新增被驳回：${t.name}`, `归口 ${t.owner} 驳回该新增申请（演示口径：需补充与已发布模板的差异化说明）。驳回同样留痕，可修改后重新提交。`, '应用中心 / 运营模板库')
    return { ok: true as const, id }
  },
  toggle(id: string) {
    const t = templates.find((x) => x.id === id)
    if (!t) return { ok: false as const, reason: '未找到该模板' }
    if (t.status === '待审核') return { ok: false as const, reason: '待审核模板请走审核流程' }
    const next: TemplateStatus = t.status === '已发布' ? '已停用' : '已发布'
    templates = templates.map((x) => (x.id === id ? { ...x, status: next } : x))
    persist(); emit()
    event(`模板状态变更：${t.name} → ${next}（归口 ${t.owner}）`)
    return { ok: true as const, id, status: next }
  },
  reset() { templates = DEFAULT_TEMPLATES.map((t) => ({ ...t })); seq = 10; persist(); emit() },
  subscribeStore(f: () => void) { listeners.add(f); return () => { listeners.delete(f) } },
}

export function useTemplates() {
  return useSyncExternalStore(templateStore.subscribeStore, templateStore.list, templateStore.list)
}
