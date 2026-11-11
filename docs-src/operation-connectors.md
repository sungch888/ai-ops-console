# 资源操作连接器设计 v0.1

> 回答三件事：连接器要做哪些接口；GPUWorks / GPUStack / CubeStudio 怎么摆；资源监控与故障从平台转还是从物理机采。
> 依据 2026-11 公开资料核实：GPUWorks（云轴 ZStack，2026-11-04 Apache-2.0 开源）、GPUStack（docs.gpustack.ai 2.3）、CubeStudio（data-infra/cube-studio，cubestudio.vip）。

## 0. 结论

1. **连接器只做一套统一接口（10 个），每个平台一个适配器**；能力按四态逐条声明（已有 / 需计算 / 需补采 / 暂不能提供），沿用 P0 的 `GET /api/opctl/capabilities`。
2. **角色分工，不做双重纳管**（同一批机器只能进一个池，否则两份真相、调度打架）：
   - **GPUWorks = 推理主池首选连接器**。它把"部署→网关→API Key→用量→休眠唤醒→灰度→硬件健康入调度"做成闭环，和本单元的操作目录重叠度最高，大部分写接口只是"翻译"。刚开源 6 天，REST API 面要靠 PoC 确认。
   - **GPUStack = 第二连接器**。成熟、内置 Swagger、OpenAI 兼容、Prometheus/Grafana 现成；但缺分时复用和多租户配额，B/C/H 类动作要我们自己补。若现有机器已用 GPUStack，它升为第一。
   - **CubeStudio 不当推理主池**（K8s 全栈太重、部署语义不同），只作为 **D 类（训练资源）的通道**和只读联邦视图来源；它有真多租户、资源组、国产异构调度，训练配额反而最全。
3. **监控/故障：底层指标必须从物理机独立采集，平台接口只供"映射与调度语义 + 业务层事件"**。故障判定不允许只依赖第三方 agent 上报值（SLA 与计费对账的根据要自己攥着），但也不自建采集轮子——直接用 Prometheus 生态。

## 1. 连接器统一接口（10 个）

控制面（写，供 opctl 执行器调用）：

| # | 接口 | 用途 / 门禁挂点 |
|---|------|----------------|
| 1 | `probe` | 连通性 + 版本 + capabilities 四态自述；不可用时前端必须显示"读不到"（T08） |
| 2 | `plan` | dry-run：放置建议 + 参数校验，g3 预检的数据源 |
| 3 | `apply` | 创建/变更，**必须带幂等键**；回执写 `external_txn_id`（g9 分段、回执查重 T12） |
| 4 | `verify` | 分段状态：实例就绪 → 网关注册 → 试调用通过，逐段回写 |
| 5 | `action/rollback` | 补偿动作：排空再摘除、扩停、休眠唤醒、流量比例 |

数据面（读，供预检、影响面、看板）：

| # | 接口 | 用途 |
|---|------|------|
| 6 | `inventory` | 机器/GPU 卡粒度：芯片型号、显存、SN、健康态、归属机器 |
| 7 | `capacity` | 按芯片/显存分档的空闲与可调度数（OC-A/D 预检） |
| 8 | `workload` | 模型实例、训练任务 ↔ GPU 卡映射（故障影响面、费用归属） |
| 9 | `gateway` | API Key 发放/吊销/限流、配额、流量比例（B/C 类） |
| 10 | `events` | webhook 推送 + 增量轮询兜底（告警、生命周期） |

横切规矩：凭证按池只读/写分离；超时熔断显示"读不到"不用默认值；所有写动作先 plan 后 apply（工单里存 plan 结果做比对，执行偏离 plan 即拦下）。

## 2. 三平台逐接口对照（四态）

| 接口 | GPUWorks | GPUStack | CubeStudio |
|------|----------|----------|------------|
| probe/inventory/capacity | ✅ 已有（异构纳管、显存评估给候选节点排除原因） | ✅ 已有（nodes/devices，聚合需算） | ✅ 已有（K8s 请求聚合） |
| 模型部署 plan/apply/verify | ✅ 已有（300+ 模型、1200+ 模板，vLLM/SGLang，PD 分离） | ✅ 已有（model_instances，无回滚→重建） | ⛔ 暂不能提供（非定位） |
| 排空/维护（先建副本再摘） | ✅ 已有 | ⚠️ 需计算（手动摘 worker） | ⚠️ 需计算（K8s cordon） |
| API Key/配额/限流 | ✅ 已有（OpenAI 网关+Key 鉴权+用量统计，**粒度待 PoC**） | ⚠️ 需计算（有 Key 弱配额） | ⚠� 需计算（token 中转+多租户） |
| 流量灰度/分时休眠唤醒 | ✅ 已有（副本路由、唤醒 3.6s） | ⛔ 暂不能提供 | ⛔ 暂不能提供 |
| 训练资源与队列（D 类） | ⛔ 官方说未来扩展 | ⛔ 无 | ✅ 已有（pipeline、多机多卡、资源组、VGPU、国产卡） |
| events 推送 | ⚠️ 需补采（PoC 确认） | ⚠️ 需补采（轮询 + 我们直采 Prometheus） | ⚠️ 需补采（K8s events） |
| 底层 GPU 指标 | 有但只作参考 | ✅ Prometheus 指标/Grafana 现成 | ✅ 内置监控（同源参考） |

选型提醒：**GPUWorks 与 GPUStack 功能高度重叠，是"二选一入池"关系，不是叠加关系**；连接器做多厂商是为了兼容不同批次资源池。

## 3. 监控与故障的路线

三层分工，别混：

- **L1 物理机层（源真值，自建）**：`node_exporter` + DCGM-exporter（N 卡）/ npu-exporter（昇腾）/ 对应 DCU、寒武纪 exporter + **BMC/IPMI 带外**（电源、风扇、温度墙）+ RDMA 网卡计数 → Prometheus/VictoriaMetrics，告警走 Alertmanager。
- **L2 平台层（映射与调度语义）**：实例↔卡映射、摘卡/排空动作、放置建议。轮询 + webhook。平台的"节点失联"只当**线索**，不当宕机依据（agent 断 ≠ 机器坏，网络分区会误报）。
- **L3 业务层**：tokens、时延、首 token、队列长度，从网关侧采（GPUWorks 已有用量统计），直接挂 SLA 和配额。

故障判定与转接规则：

1. 硬件故障（掉卡/ECC/NVLink/温度/电源）**以 L1 判定**，BMC 兜底；平台事件只做影响面标注。
2. 服务故障（实例崩溃/OOM/无流量）= L2 事件 + L3 拨测**双源确认**：单源→警告，双源→严重。
3. 全部翻译进统一事件表：`event_id / source / severity / subject(raw_gpu_sn) / occurred_at / raw`；同卡+同故障类 5 分钟窗口合并去重。
4. 故障"转接"= 运维中心收事件 → 建故障工单 → 触发本单元动作（摘卡出调度、副本迁移），动作仍走连接器 plan/apply——**故障本身不是绕过门禁的通道**。

## 4. 落地顺序与 PoC 必验清单

- **S0**：GPUWorks 只读接入（probe/inventory/events），把 capabilities 四态表填实。
- **S1**：GPUWorks 写操作（plan/apply/verify/rollback）灰度小池；接 events 推送。
- **S2**：L1 采集层上线（exporter + Alertmanager → 事件合流去重）。
- **S3**：GPUStack 适配器（如已有该池）；CubeStudio 只做 D 类：先只读，写动作走工单。

PoC 必验（GPUWorks 刚开源，公开资料未写全）：
1. Web UI / OpenAI 端点之外是否有**完整 REST 管理 API**（纳节点、部署、Key 管理），token 鉴权方式；
2. 有无 events/webhook 接口，还是只有界面日志（无推送则我们轮询）；
3. 官方只读 MCP 接口能否当只读面兜底数据源；
4. 是否支持多实例/多集群（决定"一池一连接器"还是全局）；
5. API Key 粒度：能否按应用建 Key、有没有 rate limit/配额字段（决定 C 类是否要在我们这层补）。

## 5. 网关 / 容器平台 / K8s 要不要同时对接

判定规则一句话：**每个操作只有一个执行通道，每份资源只有一条变更路径**——对"能真正改资源的那层"对接，对"只是镜像的那层"不重复接。

| 对象 | 接不接 | 说明 |
|------|--------|------|
| 统一对外网关 | ✅ 必接（第 4 连接器） | 若对外流量入口是独立网关（Higress/APISIX/自建），OC-B 发 Key、OC-C 调配额、模型灰度切流必须下发在它这层；GPUWorks 的 Key 只是**池内凭证**，不能当对外的用，它的用量统计只做对账源。若确定对外全部走 GPUWorks 网关，才不单接。**灰度比例以外层网关为准**（用户流量从这进），池网关只做池内副本均衡 |
| 容器平台（应用发布侧） | ❌ 不对接 | 应用容器化部署归应用中心（OC-G-05 边界既定）；本单元只出「资源影响校验单」，两单走工单不对接 API。自己再做一个部署通道必然双真相 |
| K8s | ⚠️ 受限接入 | 只接两类：① 训练池的配额/队列（ResourceQuota / Volcano / Kueue）读，CubeStudio 未暴露接口时才补写；② 跨池 workload↔节点映射（只读，供故障影响面与计费归属）。**不做通用 YAML 下发**。注意 GPUWorks 池是进程级部署、不在 K8s 里——K8s 通道永远盖不住它，执行面必须走平台连接器 |

最终连接器清单（5 个，同一套 10 接口的适配器）：GPUWorks、GPUStack、CubeStudio、统一对外网关、K8s（受限只读+可选配额写）。

## 6. 局域网模拟环境（联调前置，v0.2 已落地）

`sim/start-sim.sh` 一个进程起 5 个端口，5 个连接器按同一套 10 接口应答：

| 端口 | 连接器 | 特点 |
|------|--------|------|
| 9101 | GPUWorks 模拟池 | 4 段部署任务（实例健康检查→网关注册→路由生效→经网关试调用）、sleep/wake |
| 9102 | GPUStack 模拟池 | 3 段部署；**无休眠（501）**，能力自述四态如实标注 |
| 9103 | CubeStudio 模拟 | 只做训练：排队→资源就绪→任务运行；**单申请 >8 卡 plan 拒绝** |
| 9104 | 统一对外网关 | 发 Key 3 段生效、PUT 改配额、吊销；traffic 灰度 |
| 9105 | K8s 受限通道 | 只读 inventory/workload；**quota 写默认关闭（501）**，`SIM_K8S_WRITE=1` 才开 |

- 接口路径：`GET /v1/probe|capacity|inventory|workload|events?cursor=`、`POST /v1/plan|apply`、`GET /v1/deployments/{id}`、`POST /v1/deployments/{id}/action|rollback`、`GET|POST /v1/gateway/keys`、`PUT|DELETE /v1/gateway/keys/{id}`。
- apply 幂等（同 `idem` 重放返回同一 `ext_txn_id` + `replayed` 标记，对应 T12）。
- 故障注入：`POST /v1/sim/fail {"scenario":"stuck","index":1 | "reject_next" | "node_down","node":"N-2" | "flaky","ttl":30 | "clear"}`。
- 内核侧配置：`OPCTL_SIM_HOST / OPCTL_SIM_PORT_BASE / OPCTL_SIM_TOKEN`；探测不通即回退人工演示路径，绝不默认成功。
- 已接到执行体的动作（`opctl.CONN_MAP`）：OC-B-02/06→GPUWorks、OC-C-03/D-03/D-08→对外网关、OC-E-04→CubeStudio。规则：**双人复核未放行不下发**；分段判定以执行体回报为准（没回报点"通过"被拒，T04）；回退透传到执行体，执行体读不到→保持事件在途转人工兜底。
- 新端点：`GET /api/opctl/connectors`（5 个连接器实时探测，显示"读不到"）。
- 回归：`python3 tools/test_connectors.py`（28 项断言，隔离库 + 独立端口，不起在演示端口上）。

## 7. 参考

参考：GPUWorks 开源公告 <https://www.geekpark.net/news/373452>、实操 <https://www.ithome.com/1/022/152.htm>；GPUStack 可观测 <https://docs.gpustack.ai/2.3/>；CubeStudio <https://github.com/data-infra/cube-studio>。
