/* =====================================================================
 * 外部接入配置中心（配置化接入，不是硬编码）
 * 原则：外部系统与外部资源都以「接入配置」描述——传输协议 / 接入方式 / 鉴权 /
 *       频率 / 超时重试 / 降级策略 / 配额与计费口径 / 前置条件清单。
 * 现在 mode=virtual（虚拟模拟）；真实资源接入时只改这条配置（mode=real + endpoint + 鉴权），
 * 平台侧代码不变；协议与字段可在版本迭代中逐步完善（每次改动 version +1 并留痕）。
 * 本模块不依赖引擎与通知模块，避免循环引用；需要通知时由页面侧调用。
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { dbRead, dbWrite, dbSeed } from './db'


export type IntStatus = '已定' | '待商定' | '待客户方提供'
export type ConnMode = 'virtual' | 'real'
export type ConnKind = '已建子系统' | '安全设备' | '基础服务' | '外部算力资源' | '外部模型渠道' | '外部存储与备份' | '外部数据源' | '监控与日志外送'

export const TRANSPORTS = ['REST / JSON', 'WebService / SOAP', 'MCP 协议', 'Kafka 消息订阅', 'Syslog / SNMP Trap', '数据库视图 / 定时导入', 'SFTP 文件交换', 'gRPC / Protobuf'] as const
export const AUTHS = ['内网白名单（免鉴权）', 'AppKey + 签名', 'OAuth2 / OIDC 票据', '账号口令 + IP 白名单', '双向 TLS + 国密（待定）'] as const
export const FALLBACKS = ['保留最近一次数据', '标记为不可采集', '转人工填报', '降级到备用通道'] as const
/** 旁路检测外部数据源：流量探针 / 设备 Syslog / CMDB 台账比对 */
export const PROBE_IDS = ['p-flow', 'p-syslog', 'p-cmdb']
export const PROBE_LABEL: Record<string, string> = { 'p-flow': '网络侧流量探针', 'p-syslog': '设备 Syslog / SNMP', 'p-cmdb': 'CMDB 台账比对' }
export const MODE_LABEL: Record<ConnMode, string> = { virtual: '虚拟模拟', real: '真实接口' }
export const KIND_GROUP: Record<ConnKind, '系统' | '资源'> = {
  已建子系统: '系统', 安全设备: '系统', 基础服务: '系统',
  外部算力资源: '资源', 外部模型渠道: '资源', 外部存储与备份: '资源', 外部数据源: '资源', 监控与日志外送: '资源',
}

export interface ConnQuota { cards?: number; pricePerCardDay?: number; tokensWanPerDay?: number; pricePerTokenWan?: number; tb?: number }
export interface ProbeRec { time: string; ok: boolean; ms: number; rows: number; msg: string }

export interface Connector {
  id: string
  name: string
  kind: ConnKind
  direction: string
  mode: ConnMode
  transport: string
  endpoint: string
  auth: string
  dataItems: string
  intervalSec: number
  timeoutMs: number
  retries: number
  fallback: string
  enabled: boolean
  status: IntStatus
  owner: string
  health: 'ok' | 'warn' | 'fault'
  blocking: string
  /** 部分阻断：只停采集项 / 时段 / 来源 IP，通道整体仍可用 */
  blockedScope?: string
  blockedValue?: string
  prereq: string[]
  prereqDone: string[]
  quota?: ConnQuota
  version: number
  updatedAt: string
  changes: { time: string; text: string }[]
  probe?: ProbeRec
}

const DEFAULTS: Connector[] = [
  { id: 'i-agent', name: '智能体开发平台', kind: '已建子系统', direction: '子系统 → 平台', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '应用元数据、运行日志、调用统计、告警', intervalSec: 300, timeoutMs: 3000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '接口规格与字段清单未提供', prereq: ['接口文档与字段清单', '联调测试环境', '告警去重与定级口径'], prereqDone: [], quota: undefined, version: 1, updatedAt: '11-02', changes: [{ time: '11-02', text: '初始配置：虚拟模拟通道，采集 4 类数据' }], probe: { time: '11-04 09:12', ok: true, ms: 18, rows: 42, msg: '虚拟通道模拟响应正常' } },
  { id: 'i-kb', name: '向量知识库构建平台', kind: '已建子系统', direction: '子系统 → 平台', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '库清单、文档量、检索量、召回率、密级标签', intervalSec: 300, timeoutMs: 3000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '密级标签口径待确认', prereq: ['密级标签取值口径', '库与文档唯一标识规则', '检索指标计算方式'], prereqDone: [], version: 1, updatedAt: '11-02', changes: [{ time: '11-02', text: '初始配置：虚拟模拟通道' }] },
  { id: 'i-market', name: '智能体应用广场', kind: '已建子系统', direction: '双向', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'OAuth2 / OIDC 票据', dataItems: '发布状态、访问入口、用户与调用统计', intervalSec: 60, timeoutMs: 2000, retries: 3, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '三种入口的鉴权票据方式待定', prereq: ['入口票据方式与时效', '应用唯一标识', '用户口径（与统一身份认证）'], prereqDone: [], version: 1, updatedAt: '11-03', changes: [{ time: '11-03', text: '采集频率由 5 分钟调整为 60 秒' }] },
  { id: 'i-plugin', name: '插件 / Skill 仓库', kind: '已建子系统', direction: '子系统 → 平台', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '目录、版本、使用统计、上架申请', intervalSec: 86400, timeoutMs: 5000, retries: 2, fallback: '转人工填报', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '上架审批结果回写字段待定', prereq: ['上架审批结果回写字段', '版本与依赖描述规范'], prereqDone: [], version: 1, updatedAt: '11-01', changes: [] },
  { id: 'i-mcp', name: 'MCP 服务平台', kind: '已建子系统', direction: '双向', mode: 'virtual', transport: 'MCP 协议', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '注册目录、健康探针、调用统计、隔离状态', intervalSec: 60, timeoutMs: 2000, retries: 3, fallback: '降级到备用通道', enabled: true, status: '待商定', owner: '子系统厂商', health: 'warn', blocking: '技术目录与使用目录同步机制待定', prereq: ['目录同步方向与冲突处理规则', '健康探针字段定义', '隔离指令下发与回执'], prereqDone: [], version: 2, updatedAt: '11-04', changes: [{ time: '11-04', text: '新增「隔离状态」采集项（配合双目录一致性核查）' }] },
  { id: 'i-personal', name: '个人模型中心（用户端）', kind: '已建子系统', direction: '双向', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'OAuth2 / OIDC 票据', dataItems: 'Key 列表、用量、积分兑换记录', intervalSec: 300, timeoutMs: 3000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '积分规则与配额联动方式待定', prereq: ['积分与配额换算规则', 'Key 掩码与轮换策略'], prereqDone: [], version: 1, updatedAt: '11-04', changes: [] },
  { id: 'i-train', name: '模型训练平台', kind: '已建子系统', direction: '子系统 → 平台', mode: 'virtual', transport: 'Kafka 消息订阅', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '训练任务状态、数据版本绑定、评测记录', intervalSec: 60, timeoutMs: 3000, retries: 3, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '子系统厂商', health: 'ok', blocking: '数据版本快照标识口径待定', prereq: ['任务事件主题与字段', '数据版本快照标识'], prereqDone: [], version: 1, updatedAt: '10-31', changes: [] },
  { id: 'd-llmsec', name: '大模型安全网关（一体机）', kind: '安全设备', direction: '设备 → 平台', mode: 'virtual', transport: 'Syslog / SNMP Trap', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '拦截日志、命中类型、策略版本', intervalSec: 10, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: true, status: '待商定', owner: '安全设备厂商', health: 'ok', blocking: '策略统一下发接口与执行主体待定', prereq: ['拦截日志字段与去重', '策略下发方向（平台下发 / 设备执行）', '执行结果回执'], prereqDone: [], version: 1, updatedAt: '11-03', changes: [] },
  { id: 'd-content', name: '内容鉴定系统', kind: '安全设备', direction: '设备 → 平台', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '风险类型、等级、样本摘要', intervalSec: 10, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: true, status: '待商定', owner: '安全设备厂商', health: 'ok', blocking: '去重口径与误报反馈字段待定', prereq: ['风险等级取值表', '误报反馈回写字段'], prereqDone: [], version: 1, updatedAt: '11-03', changes: [] },
  { id: 'd-monitor', name: '互联网共址监测审计', kind: '安全设备', direction: '设备 → 平台', mode: 'virtual', transport: 'Syslog / SNMP Trap', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '暴露面监测、注入攻击告警', intervalSec: 60, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: true, status: '待商定', owner: '安全设备厂商', health: 'ok', blocking: '告警分析定级归口待定', prereq: ['告警定级归口与 SLA'], prereqDone: [], version: 1, updatedAt: '10-28', changes: [] },
  { id: 'd-flow', name: '数据流转监测', kind: '安全设备', direction: '设备 → 平台', mode: 'virtual', transport: 'Syslog / SNMP Trap', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '异常流转、越权访问', intervalSec: 60, timeoutMs: 1500, retries: 1, fallback: '转人工填报', enabled: true, status: '待商定', owner: '安全设备厂商', health: 'ok', blocking: '与平台权限冻结的联动动作待定', prereq: ['联动动作清单（冻结 / 限流 / 吊销）', '动作执行主体与回执'], prereqDone: [], version: 1, updatedAt: '10-28', changes: [] },
  { id: 's-idaas', name: '统一身份认证 / 零信任', kind: '基础服务', direction: '双向', mode: 'virtual', transport: 'OAuth2 / OIDC 票据', endpoint: '（未填）', auth: 'OAuth2 / OIDC 票据', dataItems: '账号、组织、角色、票据', intervalSec: 0, timeoutMs: 2000, retries: 2, fallback: '降级到备用通道', enabled: true, status: '待客户方提供', owner: '客户方侧', health: 'ok', blocking: '示例单位信息网侧认证源与协议待客户方确认', prereq: ['认证源与协议（OIDC / CAS /  Radius）', '角色映射表', '会话时效与强制下线策略'], prereqDone: [], version: 1, updatedAt: '11-01', changes: [] },
  { id: 's-org', name: '组织与地市口径', kind: '基础服务', direction: '基础服务 → 平台', mode: 'virtual', transport: '数据库视图 / 定时导入', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '单位、地市、部门层级标签', intervalSec: 86400, timeoutMs: 10000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '待客户方提供', owner: '客户方侧', health: 'ok', blocking: '地市归集口径与更新频率待确认', prereq: ['组织层级视图与编码', '区县归集规则（属地 / 业务单位）'], prereqDone: [], version: 1, updatedAt: '11-01', changes: [] },
  { id: 's-oa', name: 'OA / 工单系统', kind: '基础服务', direction: '双向', mode: 'virtual', transport: 'WebService / SOAP', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '审批流、工单流转、办结状态', intervalSec: 300, timeoutMs: 5000, retries: 2, fallback: '转人工填报', enabled: true, status: '待客户方提供', owner: '客户方侧', health: 'ok', blocking: '是否复用现网 OA 待决策', prereq: ['是否复用现网 OA 的决策', '审批节点与平台工单的映射'], prereqDone: [], version: 1, updatedAt: '10-26', changes: [] },

  { id: 'r-gpu', name: '外部算力扩租池（第三方 GPU）', kind: '外部算力资源', direction: '平台 → 外部资源', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '可用卡位、卡型、单价、开卡与回收结果', intervalSec: 300, timeoutMs: 3000, retries: 2, fallback: '降级到备用通道', enabled: false, status: '待商定', owner: '客户方侧 + 资源方', health: 'ok', blocking: '扩租通道未开通：额度、单价、开卡审批归口待定', prereq: ['卡型与单价书面确认', '跨网访问白名单与网络策略', '扩租开卡审批归口与限额', '卡位交付 / 回收接口联调'], prereqDone: [], quota: { cards: 8, pricePerCardDay: 260 }, version: 1, updatedAt: '11-04', changes: [{ time: '11-04', text: '建立扩租接入配置：额度 8 卡 · 260 元/卡/日 · 通道未启用' }] },
  { id: 'r-llm', name: '外部大模型 API 渠道（厂商 A / B）', kind: '外部模型渠道', direction: '平台 → 外部资源', mode: 'virtual', transport: 'REST / JSON', endpoint: '（未填）', auth: 'AppKey + 签名', dataItems: '渠道可用性、Token 用量、限流与错误率', intervalSec: 60, timeoutMs: 2000, retries: 2, fallback: '降级到备用通道', enabled: true, status: '待商定', owner: '厂商渠道', health: 'ok', blocking: 'Token 计费口径与数据出网范围待确认', prereq: ['数据出网范围与脱敏要求', 'Token 计费口径与对账方式', '限流与配额协商'], prereqDone: [], quota: { tokensWanPerDay: 3000, pricePerTokenWan: 0.9 }, version: 2, updatedAt: '11-04', changes: [{ time: '11-04', text: '日 Token 配额上限设为 3000 万（异常渠道降权联动）' }] },
  { id: 'r-backup', name: '外部备份与冷存储', kind: '外部存储与备份', direction: '平台 → 外部资源', mode: 'virtual', transport: 'SFTP 文件交换', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '备份批次、容量占用、恢复演练结果', intervalSec: 86400, timeoutMs: 20000, retries: 1, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '客户方侧', health: 'ok', blocking: '备份保留期与恢复演练频次待定', prereq: ['备份保留期与归档密级', '恢复演练频次与 RTO 目标'], prereqDone: [], quota: { tb: 120 }, version: 1, updatedAt: '10-30', changes: [] },
  { id: 'r-siem', name: '态势 / SIEM 日志外送', kind: '监控与日志外送', direction: '平台 → 外部资源', mode: 'virtual', transport: 'Syslog / SNMP Trap', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '运行事件、告警、处置动作、审计摘要', intervalSec: 10, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: true, status: '待商定', owner: '客户方侧', health: 'ok', blocking: '外送字段范围与密级边界待确认', prereq: ['外送字段清单与脱敏规则', '密级边界（敏感字段是否外送）', '留存期限与检索权限'], prereqDone: [], version: 1, updatedAt: '11-02', changes: [] },
  { id: 'a-dify', name: 'Dify 应用平台（公司内网已部署）', kind: '已建子系统', direction: '双向', mode: 'virtual', transport: 'REST / JSON', endpoint: 'https://dify.intra.local/console/api', auth: '账号口令 + IP 白名单', dataItems: '应用清单与发布状态、应用类型与归口、绑定模型、日调用量', intervalSec: 300, timeoutMs: 5000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '已定', owner: '信息化管理部 + 应用厂商', health: 'ok', blocking: '第一期只读应用清单与发布状态；调用日志与配额下发属第二期，需厂商开放接口', prereq: ['只读账号与 API 访问网段确认', '应用与平台归口目录的对应关系确认'], prereqDone: ['只读账号与 API 访问网段确认'], quota: undefined, version: 3, updatedAt: '11-05', changes: [{ time: '11-05', text: '第一期接口范围确认：应用清单 + 发布状态（只读）' }, { time: '10-28', text: '建立接入配置：协议 REST / JSON · 每 5 分钟拉取' }] },
  { id: 'a-ragflow', name: 'RAGFlow 知识库平台（公司内网已部署）', kind: '已建子系统', direction: '双向', mode: 'virtual', transport: 'REST / JSON', endpoint: 'http://ragflow.intra.local:9380/api/v1', auth: 'AppKey + 签名', dataItems: '应用与数据集清单、文档条目数、发布与停用状态、绑定嵌入模型', intervalSec: 300, timeoutMs: 5000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '已定', owner: '信息化管理部 + 示例业务三部', health: 'ok', blocking: '检索质量指标（召回 / 命中率）字段口径待厂商确认', prereq: ['只读 API Token 与访问网段确认', '数据集与平台知识库目录对账口径'], prereqDone: ['只读 API Token 与访问网段确认'], quota: undefined, version: 2, updatedAt: '11-05', changes: [{ time: '11-05', text: '第一期接口范围确认：应用与数据集清单 + 发布状态（只读）' }] },
  { id: 'c-deploy', name: '容器平台部署与执行回执', kind: '基础服务', direction: '平台 → 容器平台 → 回执', mode: 'virtual', transport: 'REST / JSON', endpoint: 'https://ops-deploy.intra.local/api/v1/jobs', auth: 'AppKey + 签名', dataItems: '部署工单下发、执行结果回执、实例清单与镜像版本、目标节点、完成时间', intervalSec: 0, timeoutMs: 15000, retries: 1, fallback: '转人工填报', enabled: true, status: '已定', owner: '信息化管理部 + 容器平台运维', health: 'ok', blocking: '部署动作由容器平台执行：平台发单、验收回执，不直接下发容器指令（回执接口客户方已确认可提供，剩联调与超时口径）', prereq: ['工单下发与回执接口联调', '回执字段字典（结果 / 实例清单 / 镜像 / 节点 / 完成时间）', '超时未回执的告警口径'], prereqDone: ['回执字段字典（结果 / 实例清单 / 镜像 / 节点 / 完成时间）'], quota: undefined, version: 2, updatedAt: '11-06', changes: [{ time: '11-06', text: '客户方确认：执行回执接口可提供（结果 / 实例清单 / 镜像 / 节点 / 完成时间）；采集层按此字段取回执' }, { time: '11-05', text: '新增部署执行通道：模型部署工单等回执生效' }] },
  { id: 'm-npu', name: '昇腾卡指标源（NPU Exporter + npu-smi 兜底）', kind: '基础服务', direction: '节点 → 平台（只读）', mode: 'virtual', transport: 'REST / JSON', endpoint: 'http://prometheus.intra.local:9090/api/v1/query', auth: '内网白名单（免鉴权）', dataItems: '卡利用率、HBM 占用、温度、功耗、ECC 可纠正错误、卡与节点归属', intervalSec: 30, timeoutMs: 5000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '已定', owner: '机房运维 + 昇腾厂商', health: 'ok', blocking: '两种取法均可用：Prometheus 指标优先，节点侧 npu-smi 兜底；驱动不输出的字段（如 ECC）留空并标「不可采集」，不允许推算', prereq: ['指标名与驱动版本对照表', '卡 → 资源池归属口径确认', '采集机与节点网段放行'], prereqDone: ['指标名与驱动版本对照表'], quota: undefined, version: 1, updatedAt: '11-06', changes: [{ time: '11-06', text: '客户方确认：昇腾侧 Prometheus 导出器与 npu-smi 两种取法都可用，采集脚本按优先 + 兜底走' }] },
  { id: 'm-mindie', name: 'MindIE 推理服务指标源', kind: '基础服务', direction: '推理集群 → 平台（只读）', mode: 'virtual', transport: 'REST / JSON', endpoint: 'http://10.20.14.21:8081/metrics', auth: '内网白名单（免鉴权）', dataItems: '服务副本与就绪、QPS、吞吐、首包时延、P99、队列深度、KV 缓存命中、HBM 占用、错误率、重启次数', intervalSec: 15, timeoutMs: 8000, retries: 2, fallback: '保留最近一次数据', enabled: true, status: '待商定', owner: '信息化管理部 + 推理引擎厂商', health: 'ok', blocking: '首包时延与队列深度的指标名要厂商给口径；KV 命中率与 HBM 占用若不暴露，页面标「厂商未开放」', prereq: ['指标名清单与首包时延口径确认', '每副本占卡数与卡位口径', '服务名与模型名映射规则'], prereqDone: ['每副本占卡数与卡位口径'], quota: undefined, version: 1, updatedAt: '11-06', changes: [{ time: '11-06', text: '新增服务级指标源：推理服务监控页按此字段字典渲染' }] },
  { id: 'n-node', name: '算力节点入网通道（自建 NPU 集群北向）', kind: '基础服务', direction: '双向', mode: 'virtual', transport: '数据库视图 / 定时导入', endpoint: 'http://10.20.14.9:8443/node-acl/v1', auth: '账号口令 + IP 白名单', dataItems: '入网白名单变更、会话来源、端口与访问时段', intervalSec: 300, timeoutMs: 2000, retries: 2, fallback: '标记为不可采集', enabled: true, status: '已定', owner: '信息化管理部 + 网运', health: 'ok', blocking: '入网白名单变更须网运执行并回执', prereq: ['入网白名单变更接口联调', '白名单变更执行回执'], prereqDone: ['入网白名单变更接口联调'], version: 2, updatedAt: '11-05', changes: [{ time: '11-05', text: '建立入网通道配置：可按采集项 / 时段 / 来源 IP 做部分阻断' }] },
  { id: 'p-flow', name: '网段流量探针（算力节点直连检测）', kind: '安全设备', direction: '探针 → 平台', mode: 'virtual', transport: 'Kafka 消息订阅', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '节点直连会话、非常规端口调用、来源 IP 与卡位会话数', intervalSec: 30, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: false, status: '待商定', owner: '网运 + 安全设备厂商', health: 'ok', blocking: '探针部署网段与直连判定口径待商定', prereq: ['探针部署网段清单（算力节点所在 VLAN）', '直连判定口径（合法来源白名单）', '会话日志留存期与检索权限'], prereqDone: [], version: 1, updatedAt: '11-05', changes: [{ time: '11-05', text: '新增旁路检测数据源：接入后喂入直连会话检出结果（演示为模拟喂数）' }] },
  { id: 'p-syslog', name: '机房设备 Syslog / SNMP 上报（未纳管设备发现）', kind: '监控与日志外送', direction: '设备 → 平台', mode: 'virtual', transport: 'Syslog / SNMP Trap', endpoint: '（未填）', auth: '内网白名单（免鉴权）', dataItems: '设备上电与入网、GPU 型号与序列号、带外管理地址', intervalSec: 120, timeoutMs: 1500, retries: 1, fallback: '标记为不可采集', enabled: false, status: '待商定', owner: '机房运维 + 厂商', health: 'ok', blocking: '上报字段字典与未纳管判定规则待商定', prereq: ['机房设备上报字段字典', '未纳管设备判定规则', '带外管理网段白名单'], prereqDone: [], version: 1, updatedAt: '11-05', changes: [{ time: '11-05', text: '新增旁路检测数据源：接入后喂入机房侧未纳管设备检出结果' }] },
  { id: 'p-cmdb', name: 'CMDB 资产台账比对', kind: '基础服务', direction: 'CMDB → 平台', mode: 'virtual', transport: '数据库视图 / 定时导入', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '卡位台账、设备序列号、归属单位、维保与退役状态', intervalSec: 86400, timeoutMs: 10000, retries: 2, fallback: '转人工填报', enabled: false, status: '待客户方提供', owner: '客户方侧', health: 'ok', blocking: '台账口径与平台账本对账规则待客户方确认', prereq: ['台账卡位与平台账本对账口径', '退役与未登记设备判定规则'], prereqDone: [], version: 1, updatedAt: '11-05', changes: [{ time: '11-05', text: '新增旁路检测数据源：接入后喂入台账与账本差异检出结果' }] },
  { id: 'r-extdata', name: '外部数据源（地理 / 气象 / 12345 业务事件）', kind: '外部数据源', direction: '外部 → 平台', mode: 'virtual', transport: 'WebService / SOAP', endpoint: '（未填）', auth: '账号口令 + IP 白名单', dataItems: '地理编码、气象预警、12345 转办工单', intervalSec: 3600, timeoutMs: 5000, retries: 2, fallback: '转人工填报', enabled: false, status: '待客户方提供', owner: '客户方侧 + 第三方', health: 'ok', blocking: '数据授权与交换通道未开通', prereq: ['数据授权文件与使用范围', '交换通道（专线 / 网闸 / 单向光闸）', '字段字典与更新频率'], prereqDone: [], version: 1, updatedAt: '10-26', changes: [] },
]

const KEY = 'dsh-demo-connectors-v1'
const listeners = new Set<() => void>()
let connectors: Connector[] = load()
dbSeed(KEY, connectors)

function load(): Connector[] {
  try {
    const raw = dbRead(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Connector[]
      if (Array.isArray(parsed) && parsed.length >= 10 && parsed.every((c) => c && typeof c.mode === 'string' && Array.isArray(c.prereq))) {
        const known = parsed.map((c) => c.id)
        const added = DEFAULTS.filter((d) => !known.includes(d.id)).map((d) => ({ ...d, changes: [...(d.changes ?? [])], prereqDone: [...(d.prereqDone ?? [])] }))
        return [...parsed.map((c) => ({ ...c, changes: c.changes ?? [], prereqDone: c.prereqDone ?? [] })), ...added]
      }
    }
  } catch { /* 演示环境忽略损坏配置 */ }
  return DEFAULTS.map((c) => ({ ...c, changes: [...(c.changes ?? [])], prereqDone: [...(c.prereqDone ?? [])] }))
}
function persist() { try { dbWrite(KEY, JSON.stringify(connectors)) } catch { /* 落库失败已在数据层记录 */ } }
function emit() { listeners.forEach((l) => l()) }
function stamp() { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }

/** 切换真实接入前的就绪校验：返回缺失项（空数组表示就绪） */
export function readiness(c: Connector): string[] {
  const miss: string[] = []
  if (c.status !== '已定') miss.push(`接口状态为「${c.status}」，需先定为「已定」`)
  if (!c.endpoint.trim() || c.endpoint === '（未填）') miss.push('未填写接入地址（endpoint）')
  const undone = c.prereq.filter((p) => !c.prereqDone.includes(p))
  if (undone.length) miss.push(`前置条件未完成 ${undone.length} 项：${undone[0]}`)
  if (c.quota && Object.values(c.quota).some((v) => typeof v === 'number' && v > 0) === false) miss.push('外部资源配额未设置（额度为 0）')
  return miss
}

const dependents = new Map<string, string[]>()

export const connectorStore = {
  get: () => connectors,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  find(id: string) { return connectors.find((c) => c.id === id) },
  group(group: '系统' | '资源') { return connectors.filter((c) => KIND_GROUP[c.kind] === group) },

  /** 旁路检测的三外部数据源：接入与否决定能检出哪几类旁路 */
  probes() { return connectors.filter((c) => PROBE_IDS.includes(c.id)) },
  setProbe(id: string, on: boolean) {
    if (!PROBE_IDS.includes(id)) return { ok: false as const, reason: '不是检测数据源' }
    if (on) { connectorStore.setEnabled(id, true); connectorStore.setHealth(id, 'ok') } else { connectorStore.setEnabled(id, false); connectorStore.setHealth(id, 'fault') }
    return { ok: true as const }
  },

  /** 新增一条接入配置（新外部系统 / 新外部资源）：先虚拟模拟，后续改配置切真实 */
  add(input: { name: string; kind: ConnKind; direction?: string; transport: string; endpoint?: string; auth?: string; dataItems: string; intervalSec?: number; timeoutMs?: number; retries?: number; fallback?: string; owner: string; quota?: ConnQuota; prereq?: string[]; mode?: ConnMode }) {
    if (!input.name.trim() || !input.owner.trim()) return { ok: false as const, reason: '接入对象名称与责任方不能为空' }
    if (connectors.some((c) => c.name === input.name.trim())) return { ok: false as const, reason: `已有同名接入配置 ${connectors.find((c) => c.name === input.name.trim())!.id}，请改名或编辑既有条目` }
    if (!TRANSPORTS.includes(input.transport as (typeof TRANSPORTS)[number])) return { ok: false as const, reason: `传输协议「${input.transport}」不在支持列表内（${TRANSPORTS.join(' / ')}）` }
    if (input.quota && Object.values(input.quota).every((v) => !v)) return { ok: false as const, reason: '外部资源必须给出配额或计费口径（额度为 0 无法接入）' }
    const prefix = KIND_GROUP[input.kind] === '资源' ? 'r' : 'i'
    const id = `${prefix}-${connectors.filter((c) => c.id.startsWith(prefix + '-')).length + 1}${String(Date.now()).slice(-3)}`
    const basePrereq = ['接口文档与字段清单', '联调测试环境', '处置指令执行主体与回执']
    const rec: Connector = {
      id, name: input.name.trim(), kind: input.kind, direction: input.direction ?? (KIND_GROUP[input.kind] === '资源' ? '平台 → 外部资源' : '外部 → 平台'),
      mode: input.mode ?? 'virtual', transport: input.transport, endpoint: input.endpoint?.trim() || '（未填）', auth: input.auth ?? 'AppKey + 签名',
      dataItems: input.dataItems.trim() || '（待归口确认）', intervalSec: Number(input.intervalSec ?? 300), timeoutMs: Number(input.timeoutMs ?? 3000), retries: Number(input.retries ?? 2),
      fallback: input.fallback ?? '保留最近一次数据', enabled: false, status: '待商定', owner: input.owner.trim(), health: 'ok',
      blocking: '新增接入：通道未启用，接口状态待确认', prereq: input.prereq?.length ? input.prereq : basePrereq, prereqDone: [], quota: input.quota,
      version: 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: `新增接入配置（${input.kind} · ${input.transport} · 虚拟模拟）` }],
    }
    connectors = [...connectors, rec]
    persist(); emit()
    return { ok: true as const, id, name: rec.name }
  },

  update(id: string, patch: Partial<Connector>) {
    const cur = connectors.find((c) => c.id === id)
    if (!cur) return { ok: false as const, reason: '未找到该接入配置' }
    const diffs: string[] = []
    const fields: (keyof Connector)[] = ['transport', 'endpoint', 'auth', 'intervalSec', 'timeoutMs', 'retries', 'fallback', 'dataItems', 'direction', 'blocking', 'owner', 'enabled', 'status', 'mode']
    fields.forEach((f) => {
      if (patch[f] !== undefined && patch[f] !== cur[f]) diffs.push(`${LABEL[f] ?? String(f)}：${fmt(cur[f])} → ${fmt(patch[f])}`)
    })
    if (patch.quota && JSON.stringify(patch.quota) !== JSON.stringify(cur.quota)) diffs.push('配额 / 计费口径已调整')
    if (!diffs.length) return { ok: true as const, id, version: cur.version, diffs: [] }
    connectors = connectors.map((c) => (c.id === id ? { ...c, ...patch, quota: patch.quota ?? c.quota, version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: diffs.join('；') }, ...c.changes].slice(0, 6) } : c))
    persist(); emit()
    return { ok: true as const, id, version: connectors.find((c) => c.id === id)!.version, diffs }
  },

  togglePrereq(id: string, item: string) {
    const cur = connectors.find((c) => c.id === id)
    if (!cur) return { ok: false as const, reason: '未找到该接入配置' }
    const done = cur.prereqDone.includes(item) ? cur.prereqDone.filter((x) => x !== item) : [...cur.prereqDone, item]
    connectors = connectors.map((c) => (c.id === id ? { ...c, prereqDone: done, version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: `前置条件${done.includes(item) ? '已完成' : '回退'}：${item}` }, ...c.changes].slice(0, 6) } : c))
    persist(); emit()
    return { ok: true as const, id }
  },

  setEnabled(id: string, enabled: boolean) {
    const cur = connectors.find((c) => c.id === id)
    if (!cur) return { ok: false as const, reason: '未找到该接入配置' }
    if (enabled && cur.mode === 'real') {
      const miss = readiness(cur)
      if (miss.length) return { ok: false as const, reason: `真实接入未就绪：${miss.join(' / ')}` }
    }
    connectors = connectors.map((c) => (c.id === id ? { ...c, enabled, version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: `通道${enabled ? '启用' : '停用'}（${MODE_LABEL[c.mode]}）` }, ...c.changes].slice(0, 6) } : c))
    persist(); emit()
    return { ok: true as const, id }
  },

  /** 虚拟 → 真实：只改配置，不改代码；未就绪则逐项列出缺什么 */
  switchMode(id: string, mode: ConnMode) {
    const cur = connectors.find((c) => c.id === id)
    if (!cur) return { ok: false as const, reason: '未找到该接入配置' }
    if (mode === 'virtual') {
      connectors = connectors.map((c) => (c.id === id ? { ...c, mode, version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: '接入方式改为虚拟模拟（演示 / 联调前的占位通道）' }, ...c.changes].slice(0, 6) } : c))
      persist(); emit()
      return { ok: true as const, id, version: cur.version + 1 }
    }
    const miss = readiness(cur)
    if (miss.length) return { ok: false as const, reason: `不能切到真实接入，缺：${miss.join(' / ')}` }
    connectors = connectors.map((c) => (c.id === id ? { ...c, mode, health: 'ok', version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: `接入方式：虚拟模拟 → 真实接口（${cur.transport} · ${cur.endpoint}）` }, ...c.changes].slice(0, 6) } : c))
    persist(); emit()
    return { ok: true as const, id, version: cur.version + 1 }
  },

  /** 探活：虚拟通道返回模拟结果；真实通道未就绪时如实返回缺失项 */
  probe(id: string) {
    const c = connectors.find((x) => x.id === id)
    if (!c) return { ok: false as const, reason: '未找到该接入配置' }
    if (!c.enabled) return { ok: false as const, reason: '通道已停用，探活不执行' }
    let res: ProbeRec
    if (c.mode === 'virtual') {
      const ms = 8 + (c.timeoutMs % 37)
      res = { time: stamp(), ok: c.health !== 'fault', ms, rows: c.health === 'fault' ? 0 : 24 + (c.intervalSec % 17), msg: c.health === 'fault' ? '虚拟通道模拟中断：采集中断，纳管数据缺口' : '虚拟通道模拟响应正常（真实接入后此处为真实探测）' }
    } else {
      const miss = readiness(c)
      if (miss.length) { res = { time: stamp(), ok: false, ms: c.timeoutMs, rows: 0, msg: `真实接入未就绪：${miss.join(' / ')}` } }
      else {
        const ms = 30 + (c.timeoutMs % 91)
        res = { time: stamp(), ok: true, ms, rows: 40 + (c.intervalSec % 29), msg: `真实通道探活成功：${c.transport} · ${c.endpoint} · 返回 ${40 + (c.intervalSec % 29)} 条样本` }
      }
    }
    connectors = connectors.map((x) => (x.id === id ? { ...x, probe: res, health: res.ok ? (x.health === 'fault' ? 'warn' : 'ok') : 'fault' } : x))
    persist(); emit()
    return { ok: res.ok as boolean, id, rec: res, reason: res.ok ? undefined : res.msg }
  },

  /** 登记对象与该接入的依赖关系（由接管登记册写入，供阻断影响面提示） */
  registerDependent(connectorId: string, name: string) {
    if (!connectorId) return
    const cur = dependents.get(connectorId) ?? []
    if (!cur.includes(name)) dependents.set(connectorId, [...cur, name])
  },
  clearDependents(connectorId: string) { dependents.set(connectorId, []) },
  dependentsOf(idOrName: string): string[] {
    const c = connectors.find((x) => x.id === idOrName || x.name === idOrName)
    return c ? [...(dependents.get(c.id) ?? [])] : []
  },
  readinessOf(c: Connector) { return readiness(c) },
  setHealth(id: string, health: Connector['health']) {
    connectors = connectors.map((c) => (c.id === id ? { ...c, health } : c))
    persist(); emit()
  },
  setStatus(id: string, status: IntStatus) {
    connectors = connectors.map((c) => (c.id === id ? { ...c, status, version: c.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: `接口状态：${c.status} → ${status}` }, ...c.changes].slice(0, 6) } : c))
    persist(); emit()
  },

  exportJson() {
    return JSON.stringify(connectors.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, direction: c.direction, mode: c.mode, transport: c.transport, endpoint: c.endpoint, auth: c.auth,
      dataItems: c.dataItems, intervalSec: c.intervalSec, timeoutMs: c.timeoutMs, retries: c.retries, fallback: c.fallback, enabled: c.enabled,
      status: c.status, owner: c.owner, quota: c.quota ?? null, prereq: c.prereq, prereqDone: c.prereqDone, version: c.version,
    })), null, 2)
  },
  /** 支持列表（给页面做下拉与校验提示） */
  transports: () => [...TRANSPORTS],
  auths: () => [...AUTHS],
  fallbacks: () => [...FALLBACKS],
  exportCsv() {
    const head = ['编号', '接入对象', '类别', '方向', '接入方式', '传输协议', '地址', '鉴权', '采集项', '频率(秒)', '超时(ms)', '重试', '降级策略', '通道', '接口状态', '配额', '版本']
    const rows = connectors.map((c) => [c.id, c.name, c.kind, c.direction, MODE_LABEL[c.mode], c.transport, c.endpoint, c.auth, c.dataItems, c.intervalSec, c.timeoutMs, c.retries, c.fallback, c.enabled ? '启用' : '停用', c.status, c.quota ? JSON.stringify(c.quota) : '', c.version])
    return { head, rows }
  },
  /** 导入配置：JSON 数组；按 id 合并，协议 / 字段可逐版补齐 */
  importText(text: string) {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch (e) { return { ok: false as const, created: 0, updated: 0, errors: [`配置文本不是合法 JSON：${(e as Error).message}`] } }
    if (!Array.isArray(parsed)) return { ok: false as const, created: 0, updated: 0, errors: ['配置文本需为 JSON 数组，每个元素是一条接入配置'] }
    const errors: string[] = []
    let created = 0
    let updated = 0
    parsed.forEach((raw, i) => {
      const o = raw as Partial<Connector>
      if (!o || typeof o !== 'object' || !o.id || !o.name) { errors.push(`第 ${i + 1} 条缺少 id 或 name，已跳过`); return }
      if (o.transport && !TRANSPORTS.includes(o.transport as (typeof TRANSPORTS)[number])) { errors.push(`${o.id} 传输协议「${o.transport}」不在支持列表内，已跳过`); return }
      if (o.mode && o.mode !== 'virtual' && o.mode !== 'real') { errors.push(`${o.id} 接入方式只能是 virtual 或 real，已跳过`); return }
      const cur = connectors.find((c) => c.id === o.id)
      const merged: Connector = cur
        ? { ...cur, ...o, id: o.id, name: o.name ?? cur.name, version: cur.version + 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: '导入配置更新' }, ...cur.changes].slice(0, 6) }
        : { ...DEFAULTS[0], ...o, id: o.id, name: o.name, version: 1, updatedAt: stamp().slice(0, 5), changes: [{ time: stamp(), text: '导入新增接入配置' }], prereq: o.prereq ?? [], prereqDone: o.prereqDone ?? [], health: 'ok' } as Connector
      if (cur) updated++; else created++
      connectors = cur ? connectors.map((c) => (c.id === o.id ? merged : c)) : [...connectors, merged]
    })
    persist(); emit()
    return { ok: errors.length === 0, created, updated, errors }
  },
  reset() { connectors = DEFAULTS.map((c) => ({ ...c, changes: [...(c.changes ?? [])], prereqDone: [...(c.prereqDone ?? [])] })); persist(); emit() },
}

const LABEL: Record<string, string> = {
  transport: '传输协议', endpoint: '接入地址', auth: '鉴权方式', intervalSec: '采集频率（秒）', timeoutMs: '超时（ms）', retries: '重试次数',
  fallback: '降级策略', dataItems: '采集项', direction: '方向', blocking: '卡点', owner: '责任方', enabled: '通道', status: '接口状态', mode: '接入方式',
}
function fmt(v: unknown) { return typeof v === 'boolean' ? (v ? '启用' : '停用') : String(v) }

export function useConnectors() {
  return useSyncExternalStore(connectorStore.subscribe, connectorStore.get, connectorStore.get)
}

/* ---------- 供引擎使用的两个「真实生效」配置读取 ---------- */
export const RENT_ID = 'r-gpu'
export const LLM_CHANNEL_ID = 'r-llm'

export function rentConfig() {
  const primary = connectorStore.find(RENT_ID)
  const all = connectors.filter((c) => c.kind === '外部算力资源')
  const live = all.filter((c) => c.enabled && c.health !== 'fault')
  const quota = all.reduce((sum, c) => sum + (c.quota?.cards ?? 0), 0)
  const liveQuota = live.reduce((sum, c) => sum + (c.quota?.cards ?? 0), 0)
  const weighted = liveQuota ? Math.round(live.reduce((sum, c) => sum + (c.quota?.cards ?? 0) * (c.quota?.pricePerCardDay ?? 0), 0) / liveQuota) : (primary?.quota?.pricePerCardDay ?? 0)
  const names = live.length ? live.map((c) => c.name).join(' + ') : (primary?.name ?? '外部算力扩租池')
  const status: IntStatus = live.some((c) => c.status === '已定') ? '已定' : '待商定'
  const mode: ConnMode = live.some((c) => c.mode === 'real') ? 'real' : 'virtual'
  const health: Connector['health'] = live.some((c) => c.health === 'fault') ? 'warn' : live.length ? 'ok' : (primary?.health ?? 'ok')
  const blocked = live.length
    ? ''
    : `外部算力扩租通道未启用（${primary?.name ?? '外部算力扩租池'} · 额度 ${primary?.quota?.cards ?? 0} 卡 · ${primary?.status ?? '待商定'}）`
  return { enabled: live.length > 0, quota, liveQuota, price: weighted, mode, status, health, name: names, blocking: primary?.blocking ?? '', sources: live.map((c) => ({ id: c.id, name: c.name, cards: c.quota?.cards ?? 0, price: c.quota?.pricePerCardDay ?? 0, status: c.status, mode: c.mode })) }
}
export function llmChannelConfig() {
  const c = connectorStore.find(LLM_CHANNEL_ID)
  return { enabled: Boolean(c?.enabled), quotaTokensWan: c?.quota?.tokensWanPerDay ?? 0, price: c?.quota?.pricePerTokenWan ?? 0.9, mode: (c?.mode ?? 'virtual') as ConnMode, status: (c?.status ?? '待商定') as IntStatus, name: c?.name ?? '外部大模型 API 渠道' }
}
