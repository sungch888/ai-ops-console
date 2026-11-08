/* 菜单与权限点目录：外壳与「正式实施再启用」页共用一份，避免两处菜单长歪 */
import type { PermKey } from './engine/auth'

export const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  { group: '总览', items: [{ to: '/', label: '运营总览', icon: 'overview' }, { to: '/account', label: '账号与安全', icon: 'accounts' }, { to: '/govern', label: '统一接管范围', icon: 'compute' }, { to: '/briefing', label: '投屏汇报首页', icon: 'screen' }, { to: '/network', label: '部署形态与网络分区', icon: 'compute' }] },
  {
    group: '算力中心',
    items: [
      { to: '/compute/overview', label: '算力资源总览', icon: 'compute' },
      { to: '/compute/schedule', label: '资源池与调度', icon: 'schedule' },
      { to: '/compute/storage', label: '存储与网络', icon: 'storage' },
      { to: '/compute/exceptions', label: '例外监控与阻断', icon: 'alert' },
      { to: '/compute/cards', label: '算力卡监控（昇腾）', icon: 'compute' },
    ],
  },
  {
    group: '模型中心',
    items: [
      { to: '/model/deploy', label: '模型部署与发布', icon: 'assets' },
      { to: '/model/assets', label: '模型资产管理', icon: 'assets' },
      { to: '/model/monitor', label: '推理服务监控', icon: 'gateway' },
      { to: '/model/gateway', label: '推理网关', icon: 'gateway' },
      { to: '/model/litellm', label: 'LiteLLM 网关仪表', icon: 'gateway' },
      { to: '/model/engine', label: '推理引擎指标', icon: 'gateway' },
      { to: '/model/credentials', label: '凭证与配额', icon: 'credential' },
      { to: '/model/personal', label: '个人模型中心', icon: 'credential' },
      { to: '/model/fineTune', label: '微调训练', icon: 'fineTune' },
      { to: '/model/trace', label: '调用溯源', icon: 'trace' },
      { to: '/model/audit', label: '调用审计检索', icon: 'trace' },
      { to: '/model/security', label: '安全检测', icon: 'security' },
      { to: '/model/safety-flow', label: '安全检测流程（接口留位）', icon: 'security' },
    ],
  },
  {
    group: '应用中心',
    items: [
      { to: '/app/market', label: '应用广场', icon: 'market' },
      { to: '/app/agents', label: '智能体纳管', icon: 'agents' },
      { to: '/app/kb', label: '知识库纳管', icon: 'kb' },
      { to: '/app/tools', label: '工具生态', icon: 'tools' },
      { to: '/app/templates', label: '运营模板库', icon: 'kb' },
      { to: '/app/security', label: '安全事件', icon: 'security' },
      { to: '/app/dify', label: 'Dify / RAGFlow 纳管', icon: 'link' },
      { to: '/app/accounts', label: '跨平台运营', icon: 'accounts' },
    ],
  },
  { group: '运营分析', items: [{ to: '/ops/workflow', label: '资源调配工作台', icon: 'schedule' }, { to: '/ops/alert-rules', label: '告警规则管理', icon: 'alert' }, { to: '/ops/analytics', label: '运营分析报表', icon: 'analytics' }, { to: '/ops/records', label: '台账与审计（查库）', icon: 'trace' }, { to: '/ops/notifications', label: '通知中心', icon: 'bell' }, { to: '/ops/integrations', label: '外部对接清单', icon: 'link' }, { to: '/ops/apply', label: '申请与审批台', icon: 'accounts' }, { to: '/ops/settings', label: '配置中心（来源与派单）', icon: 'link' }, { to: '/ops/commands', label: '处置指令台（预检/下发/兜底）', icon: 'security' }] },
]

/** 路由 → 权限点（权限矩阵编辑后立即生效） */
export const ROUTE_PERM: Record<string, PermKey> = {
  '/briefing': 'overview', '/more': 'overview',
  '/network': 'overview',
  '/compute/exceptions': 'compute', '/compute/cards': 'compute',
  '/model/deploy': 'gateway', '/model/monitor': 'gateway', '/model/litellm': 'gateway',
  '/model/safety-flow': 'security', '/app/dify': 'app', '/ops/apply': 'workflow', '/ops/records': 'audit',
  '/govern': 'overview',
  '/': 'overview',
  '/compute/overview': 'compute', '/compute/schedule': 'compute', '/compute/storage': 'compute',
  '/model/assets': 'gateway', '/model/gateway': 'gateway', '/model/engine': 'gateway', '/model/credentials': 'cred',
  '/model/fineTune': 'cred', '/model/trace': 'audit', '/model/audit': 'audit', '/model/security': 'security',
  '/model/personal': 'cred',
  '/app/market': 'app', '/app/agents': 'agent', '/app/kb': 'kb', '/app/tools': 'tool', '/app/templates': 'app',
  '/app/security': 'security', '/app/accounts': 'matrix',
  '/ops/workflow': 'workflow', '/ops/alert-rules': 'analytics', '/ops/analytics': 'analytics', '/ops/notifications': 'overview', '/ops/integrations': 'integration',
  '/ops/settings': 'workflow', '/ops/commands': 'security',
}
