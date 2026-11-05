/* =====================================================================
 * 演示数据（全部为虚拟 mock，仅用于方案交流）
 * 口径：某省示例主管单位 · AI 算力服务平台（演示环境）
 * ===================================================================== */

export const ORG = {
  bureau: '某省示例主管单位',
  cities: ['示范市01', '示范市02', '示范市03', '示范市04', '示范市05', '示范市06', '示范市07', '示范市08', '示范市09', '示范市10', '示范市11', '示范市12', '示范市13', '示范市14'],
}

/* ---------------- 算力中心 ---------------- */

export const computeCards = [
  { type: '昇腾 Ascend 910B', count: 48, util: 72, mem: 81, temp: 68, power: '29.4kW' },
  { type: '寒武纪 MLU590', count: 24, util: 64, mem: 74, temp: 71, power: '12.1kW' },
  { type: '海光 DCU Z100L', count: 16, util: 58, mem: 66, temp: 65, power: '8.7kW' },
]

export const computeNodes = [
  { name: 'AI-Train-01', card: 'Ascend 910B', cards: 8, util: 86, mem: 91, temp: 74, status: 'busy', pool: '训练池', net: '参数面 400G' },
  { name: 'AI-Train-02', card: 'Ascend 910B', cards: 8, util: 82, mem: 88, temp: 72, status: 'busy', pool: '训练池', net: '参数面 400G' },
  { name: 'AI-Infer-01', card: 'Ascend 910B', cards: 8, util: 71, mem: 78, temp: 66, status: 'ok', pool: '高保集群', net: '业务面 400G' },
  { name: 'AI-Infer-02', card: 'Ascend 910B', cards: 8, util: 66, mem: 72, temp: 64, status: 'ok', pool: '高保集群', net: '业务面 400G' },
  { name: 'AI-Infer-03', card: '寒武纪 MLU590', cards: 8, util: 58, mem: 63, temp: 67, status: 'ok', pool: '共享集群', net: '业务面 400G' },
  { name: 'AI-Infer-04', card: '寒武纪 MLU590', cards: 8, util: 52, mem: 57, temp: 63, status: 'ok', pool: '共享集群', net: '业务面 400G' },
  { name: 'AI-Infer-05', card: '海光 DCU Z100L', cards: 8, util: 47, mem: 52, temp: 61, status: 'ok', pool: '共享集群', net: '业务面 400G' },
  { name: 'AI-Infer-06', card: '海光 DCU Z100L', cards: 8, util: 0, mem: 3, temp: 42, status: 'fault', pool: '共享集群', net: '业务面 400G' },
]

export const computePools = [
  { name: '高保服务集群', cards: 16, used: 14.2, policy: '优先级抢占 · 核心业务优先', sla: '99.95%' },
  { name: '共享推理集群', cards: 24, used: 15.6, policy: '权重分流 · 延迟优先', sla: '99.9%' },
  { name: '训练资源池', cards: 16, used: 15.8, policy: '队列排队 · 长任务保障', sla: '—' },
]

export const storageInfo = {
  total: 50,
  used: 38.2,
  items: [
    { name: '模型权重仓库', used: 6.8, total: 10, tone: 'green' },
    { name: '训练数据集', used: 14.6, total: 20, tone: 'green' },
    { name: '推理缓存 / KV', used: 8.4, total: 12, tone: 'warn' },
    { name: '日志与审计', used: 5.4, total: 8, tone: 'green' },
  ],
  trend30d: [33.1, 33.4, 33.9, 34.2, 34.8, 35.1, 35.6, 35.9, 36.3, 36.5, 36.8, 37.1, 37.3, 37.5, 37.6, 37.8, 37.9, 38.0, 38.0, 38.1, 38.1, 38.2, 38.2, 38.2, 38.2, 38.2, 38.2, 38.2, 38.2, 38.2],
}

export const netPlanes = [
  { name: '业务面', spec: '400G 无损以太网', traffic: 62, desc: '推理流量 · 业务系统接入' },
  { name: '管理面', spec: '25G 双上联', traffic: 12, desc: '带外管理 · 监控采集' },
  { name: '样本面', spec: '400G RoCEv2', traffic: 34, desc: '训练数据读取 · 高带宽' },
  { name: '参数面', spec: '400G RoCEv2', traffic: 71, desc: '多机多卡参数同步' },
]

export const computeEvents = [
  { time: '11-04 21:32', level: '紧急', text: 'AI-Infer-06 节点 NPU 掉卡（ECC 错误累积），已自动隔离并迁移 3 个推理实例', status: '已恢复' },
  { time: '11-04 14:05', level: '重要', text: '参数面网络 AI-Train-02 端口协商降速，已切换备用上联', status: '已闭环' },
  { time: '11-03 22:47', level: '一般', text: 'AI-Train-01 温度 84℃ 超阈值 5 分钟，触发降频保护', status: '已闭环' },
]

/* ---------------- 模型中心 ---------------- */

export const models = [
  { name: 'Qwen3-32B · 业务微调 v2.3', base: 'Qwen3-32B', stage: '运行中', channel: '昇腾本地推理', util: 68, rpm: '240/300', tokens: 4120, status: 'ok', ver: 'v2.3.1', cls: '核心' },
  { name: 'DeepSeek-V3（渠道接入）', base: 'DeepSeek-V3', stage: '运行中', channel: '厂商渠道 A', util: 54, rpm: '180/200', tokens: 2860, status: 'ok', ver: '官方', cls: '核心' },
  { name: 'GLM-4-9B · 咨询问答', base: 'GLM-4-9B', stage: '运行中', channel: '寒武纪本地', util: 41, rpm: '96/150', tokens: 980, status: 'ok', ver: 'v1.2', cls: '专业' },
  { name: 'BGE-M3（Embedding）', base: 'BGE-M3', stage: '运行中', channel: '昇腾本地推理', util: 33, rpm: '—', tokens: 1240, status: 'ok', ver: 'v1.0', cls: '基础' },
  { name: 'BGE-Reranker-v2', base: 'BGE-Reranker', stage: '运行中', channel: '昇腾本地推理', util: 22, rpm: '—', tokens: 460, status: 'ok', ver: 'v2.0', cls: '基础' },
  { name: 'Whisper-large · 语音转写', base: 'Whisper', stage: '运行中', channel: '海光 DCU', util: 28, rpm: '—', tokens: 320, status: 'ok', ver: 'v1.0', cls: '基础' },
  { name: 'Qwen2.5-VL · 视频理解', base: 'Qwen2.5-VL', stage: '微调审核', channel: '—（待部署）', util: 0, rpm: '—', tokens: 0, status: 'review', ver: 'v0.9', cls: '专业' },
  { name: 'Yi-34B（旧版）', base: 'Yi-34B', stage: '待下线', channel: '寒武纪本地', util: 4, rpm: '12/100', tokens: 35, status: 'off', ver: 'v1.1', cls: '退役' },
]

export const lifecycleStages = [
  { stage: '模型准入与评测', desc: '来源登记 · 权重校验 · 许可证审查', cur: '2 在办' },
  { stage: '训练数据治理', desc: '来源合规 · 版本固化 · 异常筛查', cur: '3 数据集' },
  { stage: '模型微调训练', desc: 'LoRA 训练 · 任务监控', cur: '1 运行中' },
  { stage: '微调模型审核', desc: '权重复检 · 评测复核 · 安全审批', cur: '1 在审' },
  { stage: '模型部署上线', desc: '滚动发布 · 健康检查 · 网络隔离', cur: '—' },
  { stage: '推理服务配置', desc: '渠道映射 · 鉴权 · 凭证', cur: '—' },
  { stage: '推理服务运行', desc: '路由调度 · 限流降级 · 全链审计', cur: '6 在线' },
  { stage: '运行监控运维', desc: '算力监控 · 容量趋势 · 自愈', cur: '实时' },
  { stage: '模型变更下线', desc: '版本回退 · 下线审批 · 快照恢复', cur: '1 待下线' },
]

export const gatewayChannels = [
  { name: '昇腾本地推理（AI-Infer-01/02）', type: '本地', status: 'ok', latency: '38ms', err: '0.21%', qps: '186/260', weight: 50 },
  { name: '厂商渠道 A（DeepSeek-V3）', type: '外部', status: 'ok', latency: '142ms', err: '0.44%', qps: '92/140', weight: 30 },
  { name: '寒武纪本地（GLM-4-9B）', type: '本地', status: 'warn', latency: '220ms', err: '1.82%', qps: '54/120', weight: 20 },
]

export const gatewayEndpoints = [
  { api: 'Chat Completions', desc: '对话生成', status: 'ok', today: '128.4万' },
  { api: 'Embeddings', desc: '向量嵌入', status: 'ok', today: '46.2万' },
  { api: 'Rerank', desc: '重排序', status: 'ok', today: '38.9万' },
  { api: '语音转写', desc: 'ASR', status: 'ok', today: '2.6万' },
  { api: 'Batch 批处理', desc: '离线任务', status: 'warn', today: '0.8万' },
]

export const credentials = [
  { id: 'SA-0092', type: '平台代理', holder: '业务报告系统', app: '报告撰写助手', model: 'Qwen3-32B 微调', rpm: 300, tpm: '60万', ip: '10.20.1.0/24', exp: '2026-12-02', status: 'ok', tokens: '412万' },
  { id: 'SA-0117', type: '平台代理', holder: '咨询问答服务', app: '咨询问答助手', model: 'GLM-4-9B', rpm: 150, tpm: '30万', ip: '10.20.2.0/24', exp: '2026-11-28', status: 'ok', tokens: '98万' },
  { id: 'SA-0074', type: '平台代理', holder: '交通违规识别', app: '违法图像审核', model: 'Qwen2.5-VL（灰度）', rpm: 80, tpm: '16万', ip: '10.21.3.0/24', exp: '2026-11-20', status: 'warn', tokens: '52万' },
  { id: 'PK-2481', type: '个人密钥', holder: '示例××（示范市01单位）', app: '个人使用', model: 'Qwen3-32B 微调', rpm: 60, tpm: '12万', ip: '10.30.8.21', exp: '2026-11-25', status: 'ok', tokens: '3.2万' },
  { id: 'PK-2503', type: '个人密钥', holder: '李××（省级单位信息化管理部）', app: '个人使用', model: 'DeepSeek-V3', rpm: 60, tpm: '12万', ip: '10.30.5.7', exp: '2026-11-18', status: 'ok', tokens: '1.8万' },
  { id: 'PK-2399', type: '个人密钥', holder: '示例××（示范市02单位）', app: '个人使用', model: 'Qwen3-32B 微调', rpm: 60, tpm: '12万', ip: '10.31.2.44', exp: '2026-11-11', status: 'warn', tokens: '11.6万' },
  { id: 'PK-2210', type: '个人密钥', holder: '罗××（示范市03单位）', app: '个人使用', model: 'DeepSeek-V3', rpm: 60, tpm: '12万', ip: '10.31.6.19', exp: '2026-10-30', status: 'off', tokens: '0' },
]

export const credOrders = [
  { id: 'WO-1104-08', type: '凭证申请', applicant: '示例业务六部 · 示例××', model: 'DeepSeek-V3', quota: 'RPM 120', status: 'review', time: '11-04 16:40' },
  { id: 'WO-1104-05', type: '配额提升', applicant: '示例业务二部部门 · 平台代理', model: 'Qwen3-32B 微调', quota: 'TPM 60万→90万', status: 'pass', time: '11-04 10:22' },
  { id: 'WO-1103-11', type: '凭证吊销', applicant: '安全值守', model: '—', quota: 'PK-2210（疑似泄露）', status: 'done', time: '11-03 21:07' },
  { id: 'WO-1103-02', type: '凭证申请', applicant: '涉外 · 示例××', model: 'GLM-4-9B', quota: 'RPM 60', status: 'pending', time: '11-03 09:15' },
]

export const datasets = [
  { name: '业务业务受理语料集 v3.2', size: '12.4GB', rows: '86万条', cls: '内部', owner: '信息化管理部', state: '已终审', ver: 'v3.2' },
  { name: '报告范式语料 v2.0', size: '3.1GB', rows: '21万条', cls: '内部', owner: '示例业务一部', state: '已终审', ver: 'v2.0' },
  { name: '交通违规判例集 v1.4', size: '8.9GB', rows: '45万条', cls: '敏感', owner: '示例业务二部', state: '已终审', ver: 'v1.4' },
  { name: '咨询问答标准话术 v1.1', size: '1.2GB', rows: '6.8万条', cls: '内部', owner: '示例业务五部', state: '终审中', ver: 'v1.1' },
  { name: '公开信息案例集 v1.0', size: '2.6GB', rows: '18万条', cls: '敏感', owner: '示例业务四部', state: '前置过滤', ver: 'v1.0' },
]

export const trainTasks = [
  { name: 'Qwen2.5-VL 视频理解微调', method: 'LoRA r=64', data: '交通违规判例集 v1.4', gpu: '8× Ascend 910B', progress: 78, state: 'run', eta: '约 6 小时' },
  { name: 'Qwen3-32B 业务微调 v2.3', method: 'LoRA r=32', data: '报告范式语料 v2.0', gpu: '8× Ascend 910B', progress: 100, state: 'done', eta: '已完成' },
  { name: 'GLM-4-9B 咨询话术微调', method: 'LoRA r=16', data: '咨询问答标准话术 v1.0', gpu: '8× MLU590', progress: 100, state: 'done', eta: '已完成' },
]

export const fineTuneReviews = [
  { model: 'Qwen2.5-VL · 视频理解 v0.9', items: ['训练台账 ✓', '数据版本一致 ✓', '评测记录 ✓', '权重扫描 ✓'], verdict: '评测复核中', approver: '安全审批人：待签', state: 'review' },
  { model: 'Qwen3-32B 业务微调 v2.3', items: ['训练台账 ✓', '数据版本一致 ✓', '评测记录 ✓', '权重扫描 ✓'], verdict: '已放行', approver: '安全审批人：已签（11-02）', state: 'pass' },
]

export const traces = [
  { id: 'tr-9f3a7c21e8b4', time: '11-04 21:47:12', user: '示例××（示范市01单位）', app: '报告撰写助手', kb: '典型案例库', tools: '业务系统查询', model: 'Qwen3-32B 微调', tokens: 8642, sec: 'pass', result: '正常返回' },
  { id: 'tr-77b2d90c1f3a', time: '11-04 21:41:55', user: '系统 · 交通违规识别', app: '违法图像审核', kb: '—', tools: 'OCR 插件', model: 'Qwen2.5-VL（灰度）', tokens: 4210, sec: 'pass', result: '正常返回' },
  { id: 'tr-5e18aa02d977', time: '11-04 21:36:08', user: '示例××（示范市02单位）', app: '个人对话', kb: '—', tools: '—', model: 'DeepSeek-V3', tokens: 2380, sec: 'block', result: '注入攻击已拦截' },
  { id: 'tr-40cc19b7e2aa', time: '11-04 21:22:41', user: '示例××（示范市03单位）', app: '咨询问答助手', kb: '咨询话术库', tools: '法规库检索', model: 'GLM-4-9B', tokens: 6120, sec: 'mask', result: '敏感字段已脱敏' },
  { id: 'tr-2b88e04f6c12', time: '11-04 20:58:33', user: '罗××（示范市03单位）', app: '个人对话', kb: '—', tools: '—', model: 'DeepSeek-V3', tokens: 980, sec: 'pass', result: '正常返回' },
  { id: 'tr-1d64f7a2b903', time: '11-04 20:44:19', user: '系统 · 公开信息监测', app: '公开信息筛选', kb: '公开信息案例库', tools: '—', model: 'Qwen3-32B 微调', tokens: 15230, sec: 'pass', result: '正常返回' },
]

export const secDetection = {
  todayInput: 1284000,
  inputBlocked: 23,
  inputSuspicious: 146,
  outputBlocked: 31,
  outputMasked: 412,
  injectHit: 19,
  injectFalse: 2,
  queue: 3,
  byType: [
    { name: '提示词注入', v: 19 },
    { name: '敏感词（输入）', v: 23 },
    { name: '敏感信息（输出）', v: 31 },
    { name: '越权意图', v: 9 },
    { name: '违规内容', v: 14 },
    { name: '上下文污染', v: 6 },
  ],
  policyLogs: [
    { time: '11-04 21:36', target: 'tr-5e18aa02d977', action: '输入含指令绕过（“忽略以上指令”变体），已拦截并告警', level: 'bad' },
    { time: '11-04 21:22', target: 'tr-40cc19b7e2aa', action: '输出含身份证号，按策略掩码后返回', level: 'warn' },
    { time: '11-04 19:52', target: 'tr-88e1…', action: '知识片段越权复核：命中跨密级引用，已过滤', level: 'warn' },
    { time: '11-04 18:10', target: '策略变更', action: '敏感词库 v2.41 → v2.42（新增 36 条），审批单 SP-1104', level: 'info' },
  ],
}

/* ---------------- 应用中心 ---------------- */

export const apps = [
  { name: '报告撰写助手', dept: '示例业务一部', users: 1240, calls: '8.6万/日', success: 99.2, status: 'ok', level: '高保', model: 'Qwen3-32B 微调' },
  { name: '咨询问答助手', dept: '综合业务', users: 860, calls: '4.2万/日', success: 98.7, status: 'ok', level: '高保', model: 'GLM-4-9B' },
  { name: '法规知识问答', dept: '全体业务人员', users: 3210, calls: '12.4万/日', success: 99.5, status: 'ok', level: '高保', model: 'DeepSeek-V3' },
  { name: '交通违规图像审核', dept: '示例业务二部', users: 320, calls: '2.8万/日', success: 97.9, status: 'gray', level: '灰度', model: 'Qwen2.5-VL' },
  { name: '社区走访风险预测', dept: '综合业务', users: 450, calls: '1.1万/日', success: 98.2, status: 'ok', level: '共享', model: 'Qwen3-32B 微调' },
  { name: '公开信息筛选', dept: '示例业务四部', users: 180, calls: '0.9万/日', success: 96.8, status: 'ok', level: '共享', model: 'Qwen3-32B 微调' },
  { name: '记录结构化助手', dept: '示例业务一部', users: 980, calls: '3.6万/日', success: 99.0, status: 'ok', level: '高保', model: 'Qwen3-32B 微调' },
  { name: '装备维保知识库', dept: '信息化管理部', users: 260, calls: '0.4万/日', success: 98.9, status: 'ok', level: '共享', model: 'BGE + GLM' },
  { name: '新车驾管知识问答', dept: '示例业务二部', users: 540, calls: '1.6万/日', success: 99.1, status: 'ok', level: '共享', model: 'DeepSeek-V3' },
  { name: '新人带教助手', dept: '训练', users: 1230, calls: '2.2万/日', success: 98.4, status: 'ok', level: '共享', model: 'DeepSeek-V3' },
  { name: '专项数据检索助手', dept: '专项手段', users: 96, calls: '0.7万/日', success: 97.6, status: 'gray', level: '高保', model: 'DeepSeek-V3' },
  { name: '无人机飞行计划审核', dept: '低空巡检', users: 42, calls: '0.1万/日', success: 95.2, status: 'off', level: '试点', model: 'Qwen2.5-VL' },
]

export const kbs = [
  { name: '业务法规条例库', docs: 12480, calls: '128万/月', recall: 92.4, cls: '公开', status: 'ok' },
  { name: '典型案例库（刑事）', docs: 8600, calls: '96万/月', recall: 88.1, cls: '内部', status: 'ok' },
  { name: '咨询标准话术库', docs: 3200, calls: '64万/月', recall: 90.7, cls: '内部', status: 'ok' },
  { name: '交通违规判例库', docs: 5400, calls: '41万/月', recall: 84.3, cls: '内部', status: 'ok' },
  { name: '示例省地方性法规库', docs: 2100, calls: '22万/月', recall: 91.2, cls: '公开', status: 'ok' },
  { name: '装备维保手册库', docs: 1800, calls: '8.4万/月', recall: 87.6, cls: '公开', status: 'ok' },
  { name: '公开信息案例库', docs: 1500, calls: '6.2万/月', recall: 79.8, cls: '敏感', status: 'warn' },
  { name: '培训教材 2023（停更）', docs: 960, calls: '200/月', recall: 0, cls: '内部', status: 'zombie' },
]

export const tools = [
  { name: '业务系统查询', type: 'MCP', version: 'v2.1', calls: '32万/日', success: 99.6, status: 'ok', owner: '信息化管理部' },
  { name: '人口基础信息查询', type: 'MCP', version: 'v1.8', calls: '28万/日', success: 99.4, status: 'ok', owner: '人口部门' },
  { name: '车辆管理查询', type: 'MCP', version: 'v1.5', calls: '18万/日', success: 99.1, status: 'ok', owner: '示例业务二部' },
  { name: '视频图像检索', type: 'MCP', version: 'v0.9', calls: '6.2万/日', success: 94.8, status: 'warn', owner: '信息化管理部' },
  { name: '法规库检索', type: '插件', version: 'v3.0', calls: '46万/日', success: 99.8, status: 'ok', owner: '示例业务三部' },
  { name: '文档 OCR', type: '插件', version: 'v2.2', calls: '22万/日', success: 98.9, status: 'ok', owner: '信息化管理部' },
  { name: '报告撰写 Skill', type: 'Skill', version: 'v1.6', calls: '9.8万/日', success: 99.2, status: 'ok', owner: '示例业务一部' },
  { name: '会议纪要 Skill', type: 'Skill', version: 'v1.2', calls: '3.4万/日', success: 98.7, status: 'ok', owner: '办公室' },
  { name: '地图服务', type: 'MCP', version: 'v1.1', calls: '1.2万/日', success: 99.9, status: 'ok', owner: '信息化管理部' },
  { name: '日历/排班查询', type: 'MCP', version: 'v1.0', calls: '0.8万/日', success: 99.7, status: 'ok', owner: '办公室' },
]

export const secEvents = [
  { id: 'EV-1104-012', time: '11-04 21:36', level: '紧急', type: '提示词注入攻击', desc: '个人对话入口出现指令绕过（变体），目标为越权获取他人口径', action: '已拦截 · 凭证 PK-2399 限流 · 溯源至示范市02', status: '处置中' },
  { id: 'EV-1104-009', time: '11-04 18:22', level: '重要', type: '凭证异常调用', desc: 'SA-0074 调用量短时激增 8 倍，来源 IP 变化', action: '自动限流 · 已通知业务方', status: '已闭环' },
  { id: 'EV-1104-006', time: '11-04 15:47', level: '一般', type: '敏感信息输出', desc: '咨询问答输出含身份证号', action: '脱敏放行 · 策略复核', status: '已闭环' },
  { id: 'EV-1103-011', time: '11-03 21:07', level: '紧急', type: '凭证疑似泄露', desc: 'PK-2210 异地 IP 高频调用', action: '即时吊销 · 重发 · 纳入事件台账', status: '已闭环' },
  { id: 'EV-1103-004', time: '11-03 14:30', level: '一般', type: '工具返回越权数据', desc: '视频图像检索返回超权限片段', action: '运行时权限校验拦截', status: '已闭环' },
]

export const secDefenses = [
  { name: '身份访问防线', alerts: 42, handled: 42, rate: '100%' },
  { name: '数据知识防线', alerts: 18, handled: 18, rate: '100%' },
  { name: '模型内容防线', alerts: 76, handled: 74, rate: '97%' },
  { name: '工具调用防线', alerts: 12, handled: 12, rate: '100%' },
]

export const accounts = [
  { name: '平台管理员（信息化管理部）', role: '管理员', count: 6, high: 2, last: '11-04' },
  { name: '运营值班（运营服务团队）', role: '运营', count: 8, high: 0, last: '11-04' },
  { name: '业务开发者（各部门）', role: '开发者', count: 46, high: 3, last: '11-03' },
  { name: '业务用户（全区业务人员）', role: '普通用户', count: 5600, high: 0, last: '—' },
]

/* ---------------- 运营分析 ---------------- */

export const callTrend24h = [
  1.2, 0.9, 0.7, 0.6, 0.5, 0.8, 2.4, 6.8, 12.5, 15.8, 16.2, 15.1,
  12.8, 13.6, 14.9, 15.4, 13.2, 11.8, 10.4, 8.6, 6.2, 4.4, 3.1, 2.2,
].map((v) => v * 10000) // 万次

export const tokenTrend30d = Array.from({ length: 30 }, (_, i) => Math.round(1800 + i * 38 + Math.sin(i / 2.4) * 260)) // 万 token/日

export const topApps = [
  { name: '法规知识问答', v: 124000 },
  { name: '报告撰写助手', v: 86000 },
  { name: '咨询问答助手', v: 42000 },
  { name: '记录结构化助手', v: 36000 },
  { name: '交通违规图像审核', v: 28000 },
  { name: '新车驾管知识问答', v: 16000 },
  { name: '新人带教助手', v: 12000 },
  { name: '社区走访风险预测', v: 11000 },
]

export const cityUsage = [
  { name: '示范市01', v: 21.4 }, { name: '示范市02', v: 14.2 }, { name: '示范市03', v: 12.8 },
  { name: '示范市04', v: 6.2 }, { name: '示范市05', v: 5.4 }, { name: '示范市07', v: 4.8 },
  { name: '示范市08', v: 4.6 }, { name: '示范市09', v: 8.9 }, { name: '示范市10', v: 7.1 },
  { name: '示范市11', v: 3.2 }, { name: '示范市12', v: 5.8 }, { name: '示范市13', v: 3.9 },
  { name: '示范市14', v: 4.1 }, { name: '示范市06', v: 3.6 },
] // 万次/日

export const costByLine = [
  { name: '示例业务一部', value: 32 },
  { name: '示例业务二部', value: 18 },
  { name: '综合业务', value: 15 },
  { name: '示例业务四部', value: 10 },
  { name: '示例业务三部/训练', value: 12 },
  { name: '其他条线', value: 13 },
]

export const reports = [
  { name: '模型服务运行周报（W43）', type: '周报', time: '11-01', state: '已报送' },
  { name: '模型服务运行周报（W42）', type: '周报', time: '10-25', state: '已报送' },
  { name: '10 月运营月报', type: '月报', time: '11-03', state: '审核中' },
  { name: 'Q3 容量评估报告', type: '季度', time: '10-31', state: '已报送' },
  { name: '安全态势月报（10 月）', type: '月报', time: '11-05', state: '编制中' },
]

/* ---------------- 概览 KPI ---------------- */

export const overview = {
  npuCards: 88,
  npuUtil: 67,
  modelsOnline: 6,
  appsOnline: 10,
  usersTotal: 5600,
  callsToday: 128.4, // 万次
  tokensToday: 3.2, // 亿
  keysActive: 328,
  eventsToday: 7,
  sla: 99.93,
  secRate: 99.98,
}
