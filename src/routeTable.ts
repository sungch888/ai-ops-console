/* =====================================================================
 * routeTable.ts — 路由唯一来源（S4）
 *
 * 原来 App.tsx 手写 41 条 <Route>、navCatalog.ts 手写 40 条菜单，
 * 两处靠人肉对齐，加页面就要改两处、漏一处就是白屏。
 * 现在这一张表是唯一事实：path → 组件 → 菜单 → 权限点。
 *   · App.tsx 用 ROUTE_TABLE.map() 自动生成 <Route>
 *   · navCatalog.ts 的 NAV / ROUTE_PERM / NAV_ITEMS 从这里派生
 * ===================================================================== */
import { lazy, type ComponentType } from 'react'
import type { PermKey } from './engine/auth'

export interface RouteDef {
  /** 路由路径（与菜单 to 一致） */
  path: string
  /** 页面组件 */
  Comp: ComponentType
  /** 菜单分组（hidden 的不显示） */
  group: string
  /** 菜单标题 */
  label: string
  /** 菜单图标 */
  icon: string
  /** 访问所需权限点（缺省按 overview 处理） */
  perm?: PermKey
  /** 不进侧栏（如「更多入口」页） */
  hidden?: boolean
}

/* ---- 页面组件（全部懒加载，按需分包）---- */
const C = {
  login: lazy(() => import('./pages/login')),
  overview: lazy(() => import('./pages/overview')),
  more: lazy(() => import('./pages/more')),
  account: lazy(() => import('./pages/account')),
  briefing: lazy(() => import('./pages/briefing')),
  network: lazy(() => import('./pages/network')),
  govern: lazy(() => import('./pages/govern')),

  computeOverview: lazy(() => import('./pages/compute/overview')),
  computeSchedule: lazy(() => import('./pages/compute/schedule')),
  computeStorage: lazy(() => import('./pages/compute/storage')),
  computeExceptions: lazy(() => import('./pages/compute/exceptions')),
  computeCards: lazy(() => import('./pages/compute/cards')),

  modelDeploy: lazy(() => import('./pages/model/deploy')),
  modelAssets: lazy(() => import('./pages/model/assets')),
  modelMonitor: lazy(() => import('./pages/model/monitor')),
  modelGateway: lazy(() => import('./pages/model/gateway')),
  modelLiteLLM: lazy(() => import('./pages/model/litellm')),
  modelEngine: lazy(() => import('./pages/model/engine')),
  modelCredentials: lazy(() => import('./pages/model/credentials')),
  modelPersonal: lazy(() => import('./pages/model/personal')),
  modelFineTune: lazy(() => import('./pages/model/fineTune')),
  modelTrace: lazy(() => import('./pages/model/trace')),
  modelAudit: lazy(() => import('./pages/model/audit')),
  modelSecurity: lazy(() => import('./pages/model/security')),
  modelSafetyFlow: lazy(() => import('./pages/model/safetyFlow')),

  appMarket: lazy(() => import('./pages/app/market')),
  appAgents: lazy(() => import('./pages/app/agents')),
  appKb: lazy(() => import('./pages/app/kb')),
  appTools: lazy(() => import('./pages/app/tools')),
  appTemplates: lazy(() => import('./pages/app/templates')),
  appSecurity: lazy(() => import('./pages/app/security')),
  appDify: lazy(() => import('./pages/app/dify')),
  appAccounts: lazy(() => import('./pages/app/accounts')),

  opsWorkflow: lazy(() => import('./pages/ops/workflow')),
  opsAlertRules: lazy(() => import('./pages/ops/alertRules')),
  opsAnalytics: lazy(() => import('./pages/ops/analytics')),
  opsRecords: lazy(() => import('./pages/ops/records')),
  opsNotifications: lazy(() => import('./pages/ops/notifications')),
  opsIntegrations: lazy(() => import('./pages/ops/integrations')),
  opsApply: lazy(() => import('./pages/ops/apply')),
  opsSettings: lazy(() => import('./pages/ops/settings')),
  opsCommands: lazy(() => import('./pages/ops/commands')),
  opctlCatalog: lazy(() => import('./pages/ops/opctl')),
  opctlQueue: lazy(() => import('./pages/ops/opctlQueue')),
  opctlAudit: lazy(() => import('./pages/ops/opctlAudit')),
  opctlPerm: lazy(() => import('./pages/ops/opctlPerm')),
}

/** 全量路由表（含不进侧栏的页面） */
export const ROUTE_TABLE: RouteDef[] = [
  { path: '/', Comp: C.overview, group: '总览', label: '运营总览', icon: 'overview', perm: 'overview' },
  { path: '/account', Comp: C.account, group: '总览', label: '账号与安全', icon: 'accounts' },
  { path: '/govern', Comp: C.govern, group: '总览', label: '统一接管范围', icon: 'compute', perm: 'overview' },
  { path: '/briefing', Comp: C.briefing, group: '总览', label: '投屏汇报首页', icon: 'screen', perm: 'overview' },
  { path: '/network', Comp: C.network, group: '总览', label: '部署形态与网络分区', icon: 'compute', perm: 'overview' },
  { path: '/more', Comp: C.more, group: '总览', label: '更多入口', icon: 'more', perm: 'overview', hidden: true },

  { path: '/compute/overview', Comp: C.computeOverview, group: '算力中心', label: '算力资源总览', icon: 'compute', perm: 'compute' },
  { path: '/compute/schedule', Comp: C.computeSchedule, group: '算力中心', label: '资源池与调度', icon: 'schedule', perm: 'compute' },
  { path: '/compute/storage', Comp: C.computeStorage, group: '算力中心', label: '存储与网络', icon: 'storage', perm: 'compute' },
  { path: '/compute/exceptions', Comp: C.computeExceptions, group: '算力中心', label: '例外监控与阻断', icon: 'alert', perm: 'compute' },
  { path: '/compute/cards', Comp: C.computeCards, group: '算力中心', label: '算力卡监控（昇腾）', icon: 'compute', perm: 'compute' },

  { path: '/model/deploy', Comp: C.modelDeploy, group: '模型中心', label: '模型部署与发布', icon: 'assets', perm: 'gateway' },
  { path: '/model/assets', Comp: C.modelAssets, group: '模型中心', label: '模型资产管理', icon: 'assets', perm: 'gateway' },
  { path: '/model/monitor', Comp: C.modelMonitor, group: '模型中心', label: '推理服务监控', icon: 'gateway', perm: 'gateway' },
  { path: '/model/gateway', Comp: C.modelGateway, group: '模型中心', label: '推理网关', icon: 'gateway', perm: 'gateway' },
  { path: '/model/litellm', Comp: C.modelLiteLLM, group: '模型中心', label: 'LiteLLM 网关仪表', icon: 'gateway', perm: 'gateway' },
  { path: '/model/engine', Comp: C.modelEngine, group: '模型中心', label: '推理引擎指标', icon: 'gateway', perm: 'gateway' },
  { path: '/model/credentials', Comp: C.modelCredentials, group: '模型中心', label: '凭证与配额', icon: 'credential', perm: 'cred' },
  { path: '/model/personal', Comp: C.modelPersonal, group: '模型中心', label: '个人模型中心', icon: 'credential', perm: 'cred' },
  { path: '/model/fineTune', Comp: C.modelFineTune, group: '模型中心', label: '微调训练', icon: 'fineTune', perm: 'cred' },
  { path: '/model/trace', Comp: C.modelTrace, group: '模型中心', label: '调用溯源', icon: 'trace', perm: 'audit' },
  { path: '/model/audit', Comp: C.modelAudit, group: '模型中心', label: '调用审计检索', icon: 'trace', perm: 'audit' },
  { path: '/model/security', Comp: C.modelSecurity, group: '模型中心', label: '安全检测', icon: 'security', perm: 'security' },
  { path: '/model/safety-flow', Comp: C.modelSafetyFlow, group: '模型中心', label: '安全检测流程（接口留位）', icon: 'security', perm: 'security' },

  { path: '/app/market', Comp: C.appMarket, group: '应用中心', label: '应用广场', icon: 'market', perm: 'app' },
  { path: '/app/agents', Comp: C.appAgents, group: '应用中心', label: '智能体纳管', icon: 'agents', perm: 'agent' },
  { path: '/app/kb', Comp: C.appKb, group: '应用中心', label: '知识库纳管', icon: 'kb', perm: 'kb' },
  { path: '/app/tools', Comp: C.appTools, group: '应用中心', label: '工具生态', icon: 'tools', perm: 'tool' },
  { path: '/app/templates', Comp: C.appTemplates, group: '应用中心', label: '运营模板库', icon: 'kb', perm: 'app' },
  { path: '/app/security', Comp: C.appSecurity, group: '应用中心', label: '安全事件', icon: 'security', perm: 'security' },
  { path: '/app/dify', Comp: C.appDify, group: '应用中心', label: 'Dify / RAGFlow 纳管', icon: 'link', perm: 'app' },
  { path: '/app/accounts', Comp: C.appAccounts, group: '应用中心', label: '跨平台运营', icon: 'accounts', perm: 'matrix' },

  { path: '/ops/workflow', Comp: C.opsWorkflow, group: '运营分析', label: '资源调配工作台', icon: 'schedule', perm: 'workflow' },
  { path: '/ops/alert-rules', Comp: C.opsAlertRules, group: '运营分析', label: '告警规则管理', icon: 'alert', perm: 'analytics' },
  { path: '/ops/analytics', Comp: C.opsAnalytics, group: '运营分析', label: '运营分析报表', icon: 'analytics', perm: 'analytics' },
  { path: '/ops/records', Comp: C.opsRecords, group: '运营分析', label: '台账与审计（查库）', icon: 'trace', perm: 'audit' },
  { path: '/ops/notifications', Comp: C.opsNotifications, group: '运营分析', label: '通知中心', icon: 'bell', perm: 'overview' },
  { path: '/ops/integrations', Comp: C.opsIntegrations, group: '运营分析', label: '外部对接清单', icon: 'link', perm: 'integration' },
  { path: '/ops/apply', Comp: C.opsApply, group: '运营分析', label: '申请与审批台', icon: 'accounts', perm: 'workflow' },
  { path: '/ops/settings', Comp: C.opsSettings, group: '运营分析', label: '配置中心（来源与派单）', icon: 'link', perm: 'workflow' },
  { path: '/ops/commands', Comp: C.opsCommands, group: '运营分析', label: '处置指令台（预检/下发/兜底）', icon: 'security', perm: 'security' },

  { path: '/ops/opctl', Comp: C.opctlCatalog, group: '操作控制', label: '操作目录与发起', icon: 'tools', perm: 'opctl' },
  { path: '/ops/opctl-queue', Comp: C.opctlQueue, group: '操作控制', label: '执行队列与变更窗口', icon: 'schedule', perm: 'opctl' },
  { path: '/ops/opctl-audit', Comp: C.opctlAudit, group: '操作控制', label: '操作审计与回退', icon: 'trace', perm: 'opctl' },
  { path: '/ops/opctl-perm', Comp: C.opctlPerm, group: '操作控制', label: '操作权限（逐账号）', icon: 'accounts', perm: 'opctl' },
]

/** 登录页不进路由表（未登录时整页切换渲染） */
export const LoginPage = C.login
