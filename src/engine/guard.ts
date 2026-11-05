/* =====================================================================
 * 模型安全检测流程（前端接口已留位）
 * 流程本身在平台里跑通并可视化；真正的检测引擎（内容安全 / 重点敏感词 / 输出合规）
 * 通过一个标准契约接进来：改配置即接真实引擎，不改页面
 * ===================================================================== */
import { useSyncExternalStore } from 'react'

export type GuardStage = '前置检测' | '路由与推理' | '后置检测' | '判定与动作' | '审计与留痕'
export type GuardScenario = '正常问答' | '含敏感词' | '越权查询' | '输出异常'
export interface GuardStep {
  stage: GuardStage
  api: string
  method: string
  ms: number
  request: Record<string, unknown>
  response: Record<string, unknown>
  verdict: '通过' | '拦截' | '降级'
  note: string
}
export interface GuardConfig { mode: '平台内模拟' | '真实检测引擎'; endpoint: string; auth: string; timeoutMs: number; everyField: string }
export interface GuardRun { id: string; input: string; scenario: GuardScenario; at: string; total: number; steps: GuardStep[]; verdict: '放行' | '拦截' | '放行并告警' }

const KEY = 'dsh-demo-guard-v1'
const DEFAULT_CONFIG: GuardConfig = {
  mode: '平台内模拟',
  endpoint: '（待填）http://content-guard.intra.local:8080/api/v1/check',
  auth: 'AppKey + 签名（与接入配置中心一致）',
  timeoutMs: 600,
  everyField: 'text, session_id, level, scene, caller',
}

const SENSITIVE = ['内部', '内部编号', '住址', '身份证', '手机号', '原始记录原文', '调查手段']
const OVERREACH = ['专项手段', '全库', '所有人', '越权', '导出全部']

let config: GuardConfig = loadCfg()
const runs: GuardRun[] = []
const listeners = new Set<() => void>()

function loadCfg(): GuardConfig {
  try { const r = localStorage.getItem(KEY); if (r) return { ...DEFAULT_CONFIG, ...JSON.parse(r) as GuardConfig } } catch { /* 演示环境忽略 */ }
  return { ...DEFAULT_CONFIG }
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(config)) } catch { /* 忽略 */ } }
function emit() { listeners.forEach((l) => l()) }
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 8)

let seq = 0

export const guardStore = {
  config: () => config,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  set(patch: Partial<GuardConfig>) { config = { ...config, ...patch }; persist(); emit() },
  runs: () => runs.slice(0, 8),

  /** 跑一遍检测流程：mode=平台内模拟时本地按契约出结果；切到真实引擎后同一份契约发给检测服务 */
  run(input: string, scenario: GuardScenario): GuardRun {
    seq += 1
    const text = input.trim() || '示例：请调取 2201 号业务事件的原始记录原文与当事人住址'
    const hitWords = SENSITIVE.filter((w) => text.includes(w))
    const overreach = scenario === '越权查询' || OVERREACH.some((w) => text.includes(w))
    const outBroken = scenario === '输出异常'
    const level = overreach ? '敏感' : '内部'
    const t0 = Date.now()
    const steps: GuardStep[] = [
      {
        stage: '前置检测', api: '/api/v1/check/pre', method: 'POST', ms: 86,
        request: { text, session_id: `S-${1000 + seq}`, level, scene: '咨询问答', caller: '平台网关 SA-0117' },
        response: {
          risk: hitWords.length ? 'high' : 'low',
          matched: hitWords.length ? hitWords : [],
          policy_ids: hitWords.length ? ['P-SEC-03', 'P-PII-01'] : ['P-NORMAL'],
          action: hitWords.length ? 'mask_and_block' : 'pass',
        },
        verdict: hitWords.length ? '拦截' : '通过',
        note: hitWords.length ? `命中 ${hitWords.length} 条策略（敏感字段 / 个人信息），输入侧直接不进模型` : '未命中策略，允许进入推理',
      },
      {
        stage: '路由与推理', api: '/v1/chat/completions', method: 'POST', ms: 412,
        request: { model: 'GLM-4-9B', messages: [{ role: 'user', content: hitWords.length ? '[已脱敏占位]' : text }], max_tokens: 1024 },
        response: { model: 'GLM-4-9B@v4.9-1', channel: '本地昇腾集群', tokens_out: 486, finish_reason: 'stop' },
        verdict: hitWords.length ? '降级' : '通过',
        note: hitWords.length ? '被拦截的内容不进模型：只走脱敏占位，模型侧不接触原文' : '高保集群副本 2 · 首包 186ms',
      },
      {
        stage: '后置检测', api: '/api/v1/check/post', method: 'POST', ms: 118,
        request: { output_ref: `O-${2000 + seq}`, level, check: ['合规表述', '个人信息外溢', '结论与依据一致', '长度与格式'] },
        response: {
          issues: outBroken ? ['输出超出长度上限', '出现未经核验的事项编号'] : [],
          pii_found: outBroken ? 2 : 0,
          consistent: !outBroken,
          action: outBroken ? 'block_and_alert' : 'pass',
        },
        verdict: outBroken ? '拦截' : '通过',
        note: outBroken ? '输出侧拦截：结果不下发给业务方，并产生告警' : '输出侧通过：未发现个人信息与不一致结论',
      },
      {
        stage: '判定与动作', api: '（平台内）处置引擎', method: 'SUBMIT', ms: 24,
        request: { verdict: (hitWords.length || outBroken) ? 'block' : overreach ? 'alert' : 'pass', caller: '安全检测流程' },
        response: {
          order_type: (hitWords.length || outBroken) ? 'containment' : overreach ? 'quota_adjust' : 'none',
          target: hitWords.length ? '调用方会话 SA-0117' : overreach ? '凭证 SA-0117 限流' : '—',
          notify: '安全值班（内线 8060）',
        },
        verdict: (hitWords.length || outBroken) ? '拦截' : overreach ? '降级' : '通过',
        note: (hitWords.length || outBroken) ? '生成处置工单（不回收卡位、不停模型，只切这条调用）' : overreach ? '限流保护：不吊销凭证，先压用量并通知归口' : '无动作',
      },
      {
        stage: '审计与留痕', api: '（平台内）审计检索', method: 'WRITE', ms: 9,
        request: { trace_id: `TR-${3000 + seq}`, keep: '输入摘要 / 命中策略 / 判定 / 工单号' },
        response: { written: true, retention: '演示 30 天（真实留存期待客户方确认）', searchable: true },
        verdict: '通过',
        note: '审计只写摘要与判定，不写业务事件原文全文',
      },
    ]
    const verdict: GuardRun['verdict'] = (hitWords.length || outBroken) ? '拦截' : overreach ? '放行并告警' : '放行'
    const run: GuardRun = { id: `GF-${4000 + seq}`, input: text, scenario, at: nowTime(), total: Date.now() - t0 + steps.reduce((s, x) => s + x.ms, 0), steps, verdict }
    runs.unshift(run)
    emit()
    return run
  },
}

export function useGuardConfig() {
  const snap = () => config
  return useSyncExternalStore(guardStore.subscribe, snap, snap)
}
export function useGuardRuns() {
  const snap = () => guardStore.runs()
  return useSyncExternalStore(guardStore.subscribe, snap, snap)
}

/** 接真实检测引擎时要对齐的契约（写进接口清单，厂商按这个交） */
export const GUARD_CONTRACT: { api: string; method: string; req: string; resp: string; must: string }[] = [
  { api: '/api/v1/check/pre', method: 'POST', req: 'text · session_id · level · scene · caller', resp: 'risk · matched[] · policy_ids[] · action', must: '超时按「降级=放行并告警」还是「拦截」要定口径' },
  { api: '/api/v1/check/post', method: 'POST', req: 'output_ref · level · check[]', resp: 'issues[] · pii_found · consistent · action', must: '输出侧检测要能引用原文位置，否则复核无从做起' },
  { api: '/api/v1/policy/list', method: 'GET', req: '—', resp: 'policy_id · name · kind · enabled · version', must: '策略清单要与平台策略库对齐，避免两边各判各的' },
]
