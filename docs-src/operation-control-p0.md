# 操作控制能力单元 · P0 内核设计（v0.1）

> 范围：只做 P0（第 11 章分期里的 P0 项）。P1/P2（自动扩缩、快照回退全量、灰度、MCP 自动隔离）只留接口占位，不实现；**应用发布不在本单元范围**（2026-11-10 确认归应用中心）。
> 前置阅读：`docs-src/operation-control-unit.md`（需求与门禁链）、`docs-src/operation-control-decisions.md`（8 条待确认的推荐默认值，本设计按推荐值落地）。
> 原则：**不重写现有工单与指令台，而是在它们下面垫一层统一内核**，三处入口逐步接进来。

---

## 1. P0 目标与非目标

**P0 交付（可验收）**
1. 统一操作内核：操作目录（56 条动作的元数据表）+ 状态机 + 十道门禁强制执行。
2. 强制策略三条：无覆盖工单不执行、操作级权限项后端强校验、双人执行复核（凭证/额度/权限项/下线）。
3. 分段成功判定（至少覆盖部署四段：实例健康 / 网关注册 / 路由生效 / 经网关试调用）。
4. 三段式操作审计落库（意图 / 执行 / 结果），与查询导出审计分开记录。
5. 三个界面：操作目录与发起、执行队列与变更窗口、操作审计与回退。

**P0 明确不做**
- 自动扩缩容真实执行（只做策略对象、三态判定 UI 与硬阻断逻辑，执行留占位）。
- 快照自动生成与自动回退（只保留 `before/after_snapshot` 字段与人工快照录入）。
- 应用发布（**不在本单元范围**，2026-11-10 确认归应用中心）：本单元只实现两个不越界接口——发布前只读资源影响校验、发布后状态交接登记。
- 连接器真实对接（只定 `capabilities` 自述表结构，逐能力标"已有/需计算/需补采/暂不能提供"）。→ 10 个接口契约与 GPUWorks/GPUStack/CubeStudio 对照、监控故障路线见 [operation-connectors.md](operation-connectors.md)。

---

## 2. 架构分层与与现有代码的关系

```
UI（三页 + 现有三处写入口）
      ↓ 只允许经 opctl 门面调用
opctl 门面（src/engine/opctl.ts ↔ server /api/opctl/*）
      ↓
门禁链 gates（顺序执行，任一不过即终止并写 trace）
      ↓
状态机 + 台账回写（orders / model_services / creds / pools / mcp_services）
      ↓
connector 层（网关 / 容器调度 / 训练 / 存储 / MCP / 通知 / 外部审批源）
```

| 现有资产 | P0 怎么用 |
| --- | --- |
| `engine/engine.ts` 工单（`WO-*`、`trace()`、变更窗口 `WindowSlot`、串行队列、`external`+回执、回滚） | **保留为工单与窗口的事实来源**。opctl 不复制工单，只引用 `ticket_id` 并订阅工单状态；窗口与队列判定仍复用 `engine` 的口径 |
| `server/server.py` `commands/dry-run|issue|ack|rollback`（强制先预检、二次确认、兜底工单、幂等回写） | **提取为通用 gate 的实现范式**：`precheck_required`、`confirm_required`、`ack_timeout→fallback`。新增 `opctl` 路由按同一写法实现，不改老路由 |
| `engine/auth.ts` `PermKey` view/manage + 服务端判定 | 保留模块级权限做**入口可见性**；在其上叠加操作级权限表做**执行判定**（见第 6 节迁移） |
| `fallback_tasks` / `events` / 通知中心 | 兜底待办、事件与通知复用同一张表，加 `source='opctl'` |
| `tools/unknown_api` 审计 | 保留，作为"未对接能力不外发"的兜底证据 |

---

## 3. 数据模型（SQLite，`server/schema.sql` 新增）

```sql
-- ① 操作目录（元数据，56 条，随版本发布；不是运行时数据）
CREATE TABLE op_catalog (
  code            TEXT PRIMARY KEY,        -- OC-D-03
  group_name      TEXT NOT NULL,           -- 凭证配额
  resource_type   TEXT NOT NULL,           -- API Key
  action          TEXT NOT NULL,           -- 发放密钥
  ticket_kind     TEXT NOT NULL,           -- 服务申请单/变更单/故障处理单/问题分析单/运营任务单
  exec_mode       TEXT NOT NULL,           -- manual | auto | external_receipt | tbd
  needs_dual      INTEGER NOT NULL DEFAULT 0,
  self_approve    INTEGER NOT NULL DEFAULT 0, -- 仅 OC-B-01
  auto_allowed    INTEGER NOT NULL DEFAULT 0,
  urgent_allowed  INTEGER NOT NULL DEFAULT 0,
  priority        TEXT NOT NULL,           -- P0|P1|P2
  success_stages  TEXT NOT NULL,           -- JSON 数组：分段成功判定
  gates           TEXT NOT NULL,           -- JSON 数组：启用的门禁编号
  params_schema   TEXT NOT NULL,           -- JSON：表单字段与校验
  external_system TEXT,
  source_ref      TEXT NOT NULL,           -- 原文 2.6-3
  enabled         INTEGER NOT NULL DEFAULT 1,
  version         TEXT NOT NULL DEFAULT 'v0.1'
);

-- ② 操作实例（一次真实变更 = 一行）
CREATE TABLE operations (
  op_id          TEXT PRIMARY KEY,          -- OP-20261110-0007
  code           TEXT NOT NULL REFERENCES op_catalog(code),
  ticket_id      TEXT NOT NULL,             -- 关联工单；无单不得进入可执行状态（gate 2）
  ticket_created_by_op INTEGER NOT NULL DEFAULT 0, -- 是否由本内核代建
  target_type    TEXT NOT NULL, target_id TEXT NOT NULL, target_ver TEXT,
  params         TEXT NOT NULL,             -- JSON
  data_scope     TEXT NOT NULL,             -- self|org|line|global
  status         TEXT NOT NULL,             -- 见第 4 节状态机
  requested_by   TEXT NOT NULL,
  approved_by    TEXT, approved_at TEXT, approval_note TEXT,
  executed_by    TEXT, executed_at TEXT,
  reviewed_by    TEXT, reviewed_at TEXT,     -- 双人复核；needs_dual 时不得为空且不得等于 executed_by
  exec_mode      TEXT NOT NULL,
  precheck_id    TEXT, precheck_ok INTEGER, precheck_at TEXT,
  strategy_id    TEXT, strategy_ver TEXT,   -- 自动动作必填（P1 使用）
  urgent         INTEGER NOT NULL DEFAULT 0,  -- 紧急通道
  complement_due TEXT, complement_state TEXT, -- 紧急事后补审：24h
  window_id      TEXT, queue_pos INTEGER,
  external_ref   TEXT,                       -- 外部系统单号
  fail_stage     TEXT, fail_reason TEXT,
  started_at TEXT, finished_at TEXT, effective_at TEXT,   -- 生效时点=回执/验证成功时刻
  rollback_of    TEXT, rolled_back INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_op_status ON operations(status);
CREATE INDEX idx_op_target ON operations(target_type, target_id);
CREATE INDEX idx_op_ticket ON operations(ticket_id);

-- ③ 分段成功判定（一个操作多段；全部 done 才算整体成功）
CREATE TABLE op_stages (
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  stage TEXT NOT NULL, seq INTEGER NOT NULL,
  state TEXT NOT NULL,          -- pending | running | done | failed | skipped
  evidence TEXT, fail_reason TEXT, checked_at TEXT,
  PRIMARY KEY (op_id, stage)
);

-- ④ 三段式审计轨迹（意图段 gate=intent，执行段 gate=exec，结果段 gate=result）
CREATE TABLE op_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  gate TEXT NOT NULL,          -- g1_ticket … g10_notify | intent | exec | result
  action TEXT NOT NULL,        -- precheck | approve | execute | review | receipt | stage_check | rollback | notify | denied
  result TEXT NOT NULL,        -- ok | denied | failed
  reason TEXT, detail TEXT, tone TEXT
);
CREATE INDEX idx_trace_op ON op_trace(op_id, at);

-- ⑤ 快照（人工录入或未来自动生成；下线/升级的前置条件）
CREATE TABLE op_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- before | after | manual
  payload TEXT NOT NULL, usable INTEGER NOT NULL DEFAULT 0,
  note TEXT, created_by TEXT, created_at TEXT
);

-- ⑥ 双人复核与门禁策略表（可配置，改表不改代码）
CREATE TABLE op_gate_policy (
  code TEXT NOT NULL, gate TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  params TEXT, version TEXT NOT NULL DEFAULT 'v0.1', updated_at TEXT NOT NULL,
  PRIMARY KEY (code, gate)
);

-- ⑦ 紧急补审与兜底（复用 fallback_tasks，新增来源标记）
--    fallback_tasks.kind 取值扩展：op_exec_failed | op_ack_timeout | op_complement_overdue | op_build_ticket_failed

-- ⑧ 操作级权限（新表；与权限矩阵并存，见第 6 节）
CREATE TABLE op_perms (
  account_id TEXT NOT NULL, perm TEXT NOT NULL,   -- key.execute / key.review / opctl.emergency …
  data_scope TEXT NOT NULL DEFAULT 'org',
  granted_by TEXT NOT NULL, ticket_id TEXT NOT NULL,  -- 权限变更必须关联工单（原文 1.3）
  granted_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY (account_id, perm, data_scope)
);

-- ⑨ 查询/导出审计（与管理变更审计分开，原文 GW-14）
CREATE TABLE op_query_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- query | drilldown | export_masked | export_raw
  filters TEXT, rows INTEGER, purpose TEXT, ticket_id TEXT, ok INTEGER NOT NULL
);
```

约束（应用层强制，SQLite 也可加 `CHECK`）：
- `needs_dual=1` 时：`reviewed_by IS NOT NULL AND reviewed_by != executed_by` 才允许 `status IN ('已生效','已验证','已闭环')`。
- `self_approve=0` 时：`approved_by != requested_by`。
- `exec_mode='external_receipt'` 时：`effective_at` 只能在 `external_ref` 回执成功后写入。
- `operations.ticket_id` 为空时禁止进入 `待窗口/执行中/待回执`。

---

## 4. 状态机

```
草稿 --(precheck ok)--> 预检通过 --(approve)--> [待复核 | 待窗口]
待复核 --(review by 另一账号)--> 待窗口
待窗口 --(有开放窗口或 urgent)--> 执行中
执行中 --(exec_mode=external_receipt)--> 待回执 --(receipt ok)--> 分段判定
执行中 --(auto/manual)--> 分段判定
分段判定 --(全段 done)--> 已生效 --(verify)--> 已验证 --> 已闭环
分段判定 --(任一段 failed)--> 部分成功（记 fail_stage，可重试该段 / 回退 / 转兜底）
执行中|待回执 --(失败/超时)--> 失败 --> 待人工兜底 --(人工接管)--> 已回滚 | 已闭环
任意可执行前状态 --(驳回)--> 已驳回（终态，可重提）
```

对现有 `OrderStatus` 的映射与新增：`预检通过 / 待复核 / 部分成功 / 待人工兜底` 四个为新增；其余沿用，避免双词表。

---

## 5. API（`server/server.py`，全部走服务端判定）

| 方法 | 说明 | 关键拒绝条件 |
| --- | --- | --- |
| `GET /api/opctl/catalog?group=&priority=` | 操作目录 + 当前账号每动作的 gate 预览（哪些会拦） | — |
| `POST /api/opctl/precheck` | dry-run：算影响面 + 逐条 gate 预演，**不产生任何外部调用**，返回 `precheck_id` | 目标不可定位；参数不合 schema |
| `POST /api/opctl/request` | 建操作 + 建/关联工单，必须带 `precheck_id` | **无 precheck_id → 400「必须先预检」**；g1 工单缺失 → 403 |
| `POST /api/opctl/approve` / `reject` | 审批 | 权限不足；`self_approve=0` 且同人 → 403 并在理由里点名"仅部署工单允许自审" |
| `POST /api/opctl/execute` | 执行（内部按 exec_mode 分流） | 状态不对；无开放窗口且非 urgent；`needs_dual` 且尚未复核 → 403 |
| `POST /api/opctl/review` | 复核放行 | 无 `*.review`；**与 `executed_by` 同人 → 403**；工单与配置不一致 |
| `POST /api/opctl/receipt` | 外部执行回执（幂等：同 `op_id + result` 只生效一次） | 状态不在 `待回执`；说明 < 6 字 |
| `POST /api/opctl/stage` | 分段推进/回查（供部署四段与扩缩容前后对比） | 跳段 → 400 |
| `POST /api/opctl/verify` | 效果验证 → 已验证 | 缺证据（同口径前后对比数据）→ 403 |
| `POST /api/opctl/rollback` | 生成反向操作（`rollback_of`） | 目录标"不可自动回滚"→ 403 并转兜底 |
| `POST /api/opctl/emergency` | 紧急通道执行 + 自动建关联变更单 + 置补审到期 24h | 无 `opctl.emergency`；动作在白名单外 |
| `GET /api/opctl/operations` / `GET /api/opctl/operations/:id` | 列表与详情（含 trace、stages、snapshots） | 按 `data_scope` 过滤；无权记录不得返回"不存在" |
| `GET /api/opctl/audit` | 三段式审计查询 | 写 `op_query_audit`；导出另走导出权限 |
| `GET /api/opctl/capabilities` | 连接器能力自述（已有/需计算/需补采/暂不能提供） | — |

统一响应：`{ok, op_id?, status, denied_gates?:[{gate, reason, source_ref}], impact?}`。**所有拒绝必须写 `op_trace(action='denied')`**，这样审计页能看到"平台拦了什么、为什么拦"。

幂等：`idempotency_key` 由客户端生成（动作 + 对象 + 参数哈希）；重复请求返回首次结果并标 `duplicated=true`。

---

## 6. 权限项迁移（模块级 → 操作级）

不能一刀切，三阶段：

1. **并存（P0）**：新增 `op_perms` 表 + P0 权限项（已定 30 项，见下）；入口可见性仍由 `PermKey` 决定；**执行判定一律查 `op_perms`**。缺表数据时按"角色默认值"回落，并在界面标"默认值，未逐项确认"。
   **进展（2026-11-10）**：权限项枚举已定并落地 —— `src/engine/opctlPerm.ts` 的 `PERM_ITEMS` 共 30 项、按 11 个动作域分组；逐账号授权、数据范围四档、变更留痕（前后值 + 关联工单）在原型可用；`g2` 已在内核真实拦截（`OP_PERMS` 把每条动作映射到 request / approve / execute / review 四项之一）。待做：落 `op_perms` 真表 + 服务端判定。
   **进展 v0.2（同日）**：上面这些已经落地——9 张表建好（`server/schema.sql`），门禁与状态机整体迁到 `server/opctl.py`，`/api/opctl/*` 19 个动作与 `GET /api/opctl/state` 上线，前端 `src/engine/opctl.ts` 改为纯客户端。第 3 节的数据模型与第 5 节的接口已是**实现现状**而非设计稿。
2. **对齐（P1）**：权限矩阵页把操作级权限项按资源域分组展示（矩阵行数从 18 扩到 ~40），支持逐账号开关 + 数据范围；`PermKey` 退化为"模块入口开关"。
3. **收口（P1 末）**：删除代码里所有按模块 `manage` 判定执行的分支，只保留入口判定。

P0 先落地的 16 项（对应本单元 3 个界面 + 4 类代表动作）：
`opctl.view`、`opctl.exec`、`opctl.review`、`opctl.emergency`、`opctl.config`、
`model.deploy.request/approve/execute`、`key.execute`、`key.review`、`key.quota.adjust.request/approve/execute/review`、`perm.item.configure`。

角色默认建议（决策单第 2 条）：显式关闭 > 显式开启 > 角色默认 > 全关；`*.review` 与 `*.execute` 同人授予时界面黄标提示"将导致双人复核形同虚设"（允许配置，但执行时仍强制 `executed_by != reviewed_by`）。

---

## 7. 门禁链实现要点（服务端一处，所有入口共用）

```python
GATES = [g1_ticket, g2_perm, g3_precheck, g4_approval, g5_dual,
         g6_window, g7_exec_mode, g8_stages, g9_verify, g10_notify]

def run_gates(op, action, actor):
    for g in GATES_FOR[op.code]:
        r = g(op, action, actor)      # 每个 gate 只做一个判断，纯函数、可单测
        trace(op, g.id, action, r.result, r.reason)
        if not r.ok:
            return deny(g.id, r.reason, source_ref=g.source_ref)
    return ok()
```

- **每个 gate 一个纯函数 + 一个单测**，理由必须带原文章节号（`source_ref`），界面直接显示"依据原文 2.6-3"。
- 顺序不可调换：先工单（g1）再权限（g2）再预检（g3），保证"绕过工单"永远排第一被拦。
- gate 开关来自 `op_gate_policy`（可配置，改动走工单并版本化）。
- 前端按钮禁用只是体验，**不作为安全边界**（原文 1.3）；每个写接口都必须独立跑一遍 gates。

关键 gate 的判据（对应验收断言）：
- g1：`ticket_id` 为空，或工单状态不是"审批通过且覆盖本动作"→ 拒。
- g5：`needs_dual && (reviewed_by IS NULL || reviewed_by == executed_by)` → 不得进入已生效。
- g7：`exec_mode='external_receipt' && status != '待回执'` 时不得写 `effective_at`。
- g8：`op_stages` 存在 `state != 'done'`（非 skipped）→ 不得返回整体成功；`fail_stage` 必填。
- g10：通知记录 `state` 必须区分 已发送/已送达/未送达；未送达生成待办，不得伪称已通知。

---

## 8. 与现有三处写入口的切换（灰度与回滚）

| 阶段 | 做什么 | 回滚路径 |
| --- | --- | --- |
| S0 | 三页新界面上线，内核只服务新界面上的 4 类代表动作（发 Key / 额度调整 / 算力分配 / MCP 隔离） | 关掉 `opctl` 权限即可，老入口不受影响 |
| S1 | **双写镜像**：`engine.ts` 工单执行时同步写一条 `operations` 记录（只记录不拦截），比对两边状态差异 | 停写 `operations`，无业务影响 |
| S2 | 切换拦截：`workflow`/`apply`/`commands` 的写请求改走 `/api/opctl/*`；老路由保留为薄壳（转发） | 配置开关 `opctl_enforce=0` 回到老路径 |
| S3 | 老路由收敛为壳并废弃；`commands` 保留为"紧急处置视图"但底层同一内核 | 保留 `URGENT_TYPES` 白名单 |

配置开关：`opctl_enforce`（0 关 / 1 记录 / 2 拦截），存配置中心，改动走工单。

---

## 9. 验收与测试

单元：10 个 gate 各 1 正 1 反；状态机非法迁移表驱动全遍历；幂等键重复回执只生效一次。

集成（对应需求文档第 11 章 12 条硬断言，逐条建用例）：
`T01 无工单被拒` · `T02 同人执行+复核被拒` · `T03 无预检不可下发` · `T04 仅实例健康不得显示上线成功` · `T05 策略未获批/建单失败不改变资源` · `T06 参数高于审批值时按审批值或拒绝` · `T07 部分成功如实展示且不回滚为未部署` · `T08 连接器不可用显示读不到不用默认值` · `T09 紧急通道必带补审待办` · `T10 导出含未脱敏数据即停止` · `T11 前端隐藏但直调接口 403` · `T12 回执重复只生效一次`。

回归：`tools/check_api_paths.py`（新路由必须注册）、`tools/check_focus_panels.py`（面板目录不漂移）、`tools/audit_ui_api.py`（无静默失败点）、`pnpm exec tsc --noEmit` + `pnpm run build`。

---

## 10. 工作量与拆解（P0，前端 + 数据服务口径）

| # | 任务 | 产出 | 估 |
| --- | --- | --- | --- |
| 1 | 目录与数据模型 | 56 条 `op_catalog` 落库（含 4 类动作可用）、schema 迁移脚本 | 2d |
| 2 | 内核 + 门禁链 | gates 纯函数 + 状态机 + `/api/opctl/*`（request/approve/execute/review/receipt/stage/verify） | 5d |
| 3 | 双人复核 + 操作级权限 | `op_perms`、16 权限项、同人拒绝、矩阵页提示 | 2d |
| 4 | 分段成功判定 | `op_stages` + 部署四段 + 扩缩容前后对比（先人工录入） | 2d |
| 5 | 三段式审计 + 兜底 | `op_trace`/`op_query_audit`、超时 sweep → 兜底工单、通知状态三态 | 3d |
| 6 | 三页界面 | 目录与发起 / 队列与窗口 / 审计与回退 | 5d |
| 7 | 双写镜像 + 测试 | S1 双写、12 条集成用例、自检脚本全绿 | 3d |

合计约 22 人日（含联调）。风险最高的两处：**执行归属未定**（决策单第 6 条，影响 2/4 号任务的接口形态）、**工单关联判据未定**（第 7 条，影响 g1）。建议这两条本周先拍暂定值。

---

## 11. 待确认（继承决策单，按推荐值先实现的部分）

- `op_catalog.exec_mode` 中 12 条动作仍为 `tbd`：待外部系统能力确认后逐条替换；界面在这些动作上显示"需人工在 XX 执行并回填回执"。
- 双人复核范围表（`needs_dual`）按决策单第 3 条推荐值先填，后续可配置调整。
- 紧急补审时限 24h、工单原单闭环判据（同对象/同动作/同窗口/≤24h）做成配置项，避免改代码。
