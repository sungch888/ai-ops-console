# 操作控制能力单元 · 落地说明（v0.2 · 判定已搬到服务端）

> 本页记「已经跑起来的东西」。v0.2 的关键变化：**十道门禁从浏览器搬到了服务端**（`server/opctl.py`），
> 前端只发请求、展示结果和原因；权限、双人复核、分段判定、归属边界都由服务端会话账号判定。
> 设计口径见 `operation-control-unit.md` / `operation-control-p0.md`；待确认见 `operation-control-decisions.md`。

## 1. 架构（v0.2）

```
页面（/ops/opctl · opctl-queue · opctl-audit · opctl-perm）
   │  只调接口：GET /api/opctl/state、POST /api/opctl/<action>
   ↓
server/server.py  _opctl()  ← 先按角色权限点判（opctl / opctl_exec / opctl_review / approve / matrix）
   ↓
server/opctl.py  门禁链 g0–g10 + 状态机 + 分段判定 + 逐账号授权
   ↓
SQLite：operations / op_stages / op_trace / op_windows / op_fallbacks / op_notify / op_perms / op_perm_changes / op_meta
```

**前端不再做判定**：`src/engine/opctl.ts` 已改成 API 客户端（`refresh()` + 各动作返回 Promise），
读不到数据时明确显示「读不到」，不会用默认值假装成功。

## 2. 新增/改动文件

| 文件 | 改动 |
| --- | --- |
| `server/opctl.py` | **新增**：服务端内核。14 条操作定义、g0–g10 门禁、状态机、逐账号权限、种子数据（`seed()` 幂等，只补缺失） |
| `server/schema.sql` | **新增 9 张表**：operations / op_stages / op_trace / op_windows / op_fallbacks / op_notify / op_perms / op_perm_changes / op_meta |
| `server/server.py` | 新增 `_opctl()` 路由与权限映射表；`POST /api/opctl/*` 分支；启动时 `opctl.seed()`；`seed_users()` 改为**只补缺失账号**（老库也能补上复核岗）；`sys.modules['server'] = __main__` 修掉「两份 server 模块读错库」的隐患；演示账号新增 `ops2`（复核岗） |
| `server/api_handlers.py` | `GET /api/opctl/state` 路由（要求「操作控制」查看权） |
| `src/engine/opctl.ts` | **重写**为服务端客户端（保留目录元数据与表单字段，判定字段以服务端为准） |
| `src/pages/ops/opctl.tsx` / `opctlQueue.tsx` / `opctlAudit.tsx` / `opctlPerm.tsx` | 四页改为异步调用服务端；队列页复核按钮收敛为一个（同人会被服务端拒）；权限页直接渲染服务端 `op_perms` |
| `src/engine/opctlPerm.ts` | **删除**（权限改由服务端 `op_perms` 表提供） |

## 3. 服务端接口清单

| 方法 | 路径 | 需要权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/opctl/state` | `opctl` view | 一次拿全：操作 / 窗口 / 兜底 / 策略 / 目录 / 逐账号权限 |
| POST | `opctl/precheck` | `opctl` manage | dry-run 预检（算影响面、不产生外部调用） |
| POST | `opctl/submit` | `opctl` manage | 提交并建/关联工单（g0 归属、g1 工单、g2 权限、g3 预检、g6 紧急白名单） |
| POST | `opctl/approve` / `reject` | `approve` | g4 审批（申请人不得自批，仅部署工单可自审） |
| POST | `opctl/execute` | `opctl_exec` | g5 前置、g6 窗口、g7 执行归属（外部动作转待回执） |
| POST | `opctl/review` | `opctl_review` | g5 双人复核：执行与复核必须两个不同账号 |
| POST | `opctl/receipt` | `opctl_exec` | 外部回执（<6 字拒收；失败转人工兜底） |
| POST | `opctl/stage` | `opctl_exec` | g8 分段判定（任一段失败即「部分成功」） |
| POST | `opctl/verify` / `close` | `opctl_exec` | g9 效果验证（要同口径证据）→ g10 闭环 |
| POST | `opctl/rollback` / `emergency` / `complement` | `opctl_exec` | 回退 / 紧急通道（24h 补审）/ 补审 |
| POST | `opctl/window` | `opctl_exec` | 变更窗口开启 / 结束 |
| POST | `opctl/autoscale` | `opctl_exec` | 三态判定：范围内部内先建单再执行 / 超范围转人工 / 未获批或建单失败即阻断 |
| POST | `opctl/takeover` / `sweep` | `opctl_exec` | 兜底接管 / 超时未回执扫描 |
| POST | `opctl/perm/toggle` / `perm/scope` | `matrix` | 逐账号权限开关与数据范围（每次自动生成关联工单并记前后值） |

所有拒绝都会写 `op_trace(result='拦下')` 与 `audit_log`，所以「平台拦了什么、依据哪条原文」可查。

## 4. 怎么演示

重启一次数据服务让新表生效：`python server/server.py`（或 `./start.sh`）。

1. **归属边界**：用任意有操作控制权限的账号，选 `OC-G-05 应用发布` → 预检直接返回「归应用中心」。服务端 g0 拦下。
2. **申请人不得自批**：用 `ops` 提交一张 `OC-D-03 发 Key` → 自己点「审批通过」→ 被 g4 拒；换 `admin` 审批才过。
3. **双人复核（重点）**：`ops` 审批通过后在队列里「执行下发」→ 状态进入「待复核」→ 用 `ops` 自己点「复核放行」→ 被 g5 拒（提示执行与复核必须两个账号）→ 换 **复核岗 `ops2 / ops123`** 登录再点 → 通过，进入分段判定。
4. **分段成功判定**：`OC-B-02` 部署推进到最后一段点「该段失败」→ 状态变「部分成功」，界面不显示上线成功；「重试失败段」推完 4 段才「已生效」。
5. **自动三态**：策略选「未获批」的策略 → 按策略评估 → 不执行、转人工；已获批策略点「模拟建单失败」→ 硬阻断 + 生成兜底待办。
6. **逐账号权限**：`/ops/opctl-perm` 用 admin 打开可改；把 `运营 B` 的 `key.execute` 关掉，他再点「执行下发」就被 g2 拒。用 `ops`（运营 B）打开这页是只读的（服务端按 `matrix` 拒写）。

## 5. 验证结果（隔离库端到端）

| 场景 | 实际返回 |
| --- | --- |
| 申请人自批 | `400 g4 审批 拦下：申请人不得自批本单，仅部署工单允许申请人自审并留痕（依据 原文 2.5-2 / 2.6-2）` |
| 同人复核 | `400 g5 双人复核 拦下：执行人与复核人必须是两个不同账号…（依据 原文 2.6-3 / 2.7-3）` |
| 复核岗复核 | `200` → 状态进入执行，分段逐段通过 → `已生效`，`reviewedBy=韦东` |
| 应用发布 | `400 g0 归属边界 拦下：该动作归应用中心…（原文 4.2 引言）` |
| 运营改权限 | `403 角色「ops」没有「权限矩阵」的操作权限（权限点 matrix）` |
| 管理员改权限 | `200`，`op_perm_changes` 新增一条（含前后值与关联工单） |
| 未预检就提交 | `400 g3 预检 拦下` |
| 无窗口执行 | `400 g6 变更窗口 拦下：已保留排队位次` |

自检：`tsc --noEmit` 0 错误 · `pnpm run build` 通过 · `check_api_paths` / `check_focus_panels`（44 页）/ `check_contrast` 通过 · `py_compile` 通过 · 演示实例重启后 `/api/health` 200、`/api/opctl/state` 未登录 401。

## 6. 还差什么

1. **连接器仍是模拟**：外部动作只写「待回执」，没有真正调容器平台 / 网关 / 训练平台；回执靠页面按钮模拟。
2. **触发源没接**：没有定时任务与指标订阅，`sweep`（超时转兜底）与 `autoscale` 目前靠页面手动触发。
3. **快照是文本**：`before_snap / after_snap` 只存说明，未真正序列化资源前后状态，回退靠人工确认。
4. **前端没做端到端自动化测试**：目前是接口级脚本验证（`/tmp/t_api.py` 那套），还没进仓库成为可重复的用例。
5. `tools/audit_ui_api.py` 仍然跑不起来（既有问题：脚本按 `_api_get/_api_put/_api_delete` 找处理器，当前只剩 `_api_post`）。
