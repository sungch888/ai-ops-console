# 数据服务接口契约（v2.2）

数据服务：`server/server.py`（Python 3 标准库 + SQLite）。前端不再使用浏览器本地存储，
所有业务状态的权威副本在数据库；浏览器只保留一份内存副本。

## 启动与访问

```bash
python3 server/server.py                     # 页面 http://127.0.0.1:8090/ ，接口 /api
python3 server/server.py --port 8091 --db server/data/aiops.db --dist dist
python3 server/server.py --reset             # 清空数据库后退出
```

| 环境变量 | 等价参数 | 默认 |
|---|---|---|
| `AIOPS_PORT` | `--port` | 8090 |
| `AIOPS_HOST` | `--host` | 127.0.0.1（演示版无鉴权，默认不对外） |
| `AIOPS_DB` | `--db` | `server/data/aiops.db` |
| `AIOPS_DIST` | `--dist` | `dist` |
| `VITE_API_BASE` | 前端构建时指定 | 空（同源 `/api`） |

前端指向别的后端时：`VITE_API_BASE=http://10.0.0.5:8090 npm run build`。

## 通用约定

- 请求 / 响应均为 `application/json; charset=utf-8`。
- 错误返回 `{"ok": false, "error": "中文说明"}`，HTTP 状态同步（400 / 403 / 404 / 500）。
- 每个写请求可带请求头 `X-Demo-Account: <账号编号>`（只允许 ASCII），写入 `audit_log.actor`。
  这是演示用的留痕字段，**不是身份认证**。
- 单个请求体上限 8 MB。
- 同键重复 PUT = 覆盖（幂等）。

## 接口

### GET /api/health
`{"ok":true,"service":"...","version":"2.2.0","schema_version":"1","db":"server/data/aiops.db","uptime_s":12,"counts":{"kv_store":19,"entities":46,"orders":15,...}}`

用于页面顶部数据状态、部署自检、演示前检查。

### GET /api/state
`{"ok":true,"state":{"dsh-demo-engine-v4":{...}, ...},"updated_at":{...}}`

前端启动时一次性取回全部状态（水合）。库里没有的键，前端使用代码默认值并在首次改动时写入。

### GET /api/state/&lt;key&gt;
`{"ok":true,"key":"...","updated_at":"2026-11-05T14:52:28Z","payload":{...}}`；未写入过返回 404。

### PUT /api/state/&lt;key&gt;
请求体＝该键的完整内容（对象 / 数组 / 字符串均可）。
返回 `{"ok":true,"key":"...","updated_at":"...","projected_rows":8}`。
键名限制 `[A-Za-z0-9_-]{1,64}`。服务端同时把内容投影到关系表并写审计。

### DELETE /api/state/&lt;key&gt;
删除该键（含配置项）。

### POST /api/state/bulk
`{"state": {"键": 内容, ...}}` → 批量写入，返回写入键数与投影行数。

### POST /api/reset
`{"state": {初始演示数据}}` → **清空全部业务表**再写入给定的初始状态，写一条 `reset` 审计。
对应界面上的「重置演示数据 / 恢复初始演示数据」。

### POST /api/seed
`{"state": {...}}` → 只写库里**尚不存在**的键（首次播种，不覆盖已有数据）。

### 查询接口（分页，供报表与审计）

| 接口 | 说明 | 常用参数 |
|---|---|---|
| `GET /api/orders` | 工单表 | `limit`（≤500，默认 100）、`offset`、`status` |
| `GET /api/events` | 运行事件 | `limit`、`offset` |
| `GET /api/audit` | 服务端写入审计 | `limit`、`offset` |
| `GET /api/notifications` | 通知中心 | `limit`、`offset` |
| `GET /api/accounts` | 演示账号（正式版换真实用户表） | `limit`、`offset` |
| `GET /api/permissions` | 角色权限矩阵展开行 | `limit`、`offset` |
| `GET /api/settings` | 开关与配置 | `limit`、`offset` |
| `GET /api/entities?kind=cred` | 通用实体投影 | `kind`、`limit`、`offset` |
| `GET /api/export` | 全部 kv 快照（带 updated_at），用于迁移与备份 | — |

## 静态托管

`/api` 之外的路径按文件从 `dist` 读取；目录回落到 `index.html`；找不到的路径也回落 `index.html`
（HashRouter 单页）。带 `..` 的越界路径返回 403。

## 状态键一览（19 个）

| 键 | 内容 | 投影去向 |
|---|---|---|
| `dsh-demo-engine-v4` | 池 / 模型 / 托管对象 / 训练算例 / 凭证 / 渠道 / 工单 / 事件 / 变更窗口 | `orders`、`order_trace`、`events` + `entities` |
| `dsh-demo-matrix-v1` | 角色权限矩阵 | `role_permissions` + `settings.permission_matrix` |
| `dsh-demo-accounts-v1` | 演示账号清单 | `accounts` |
| `dsh-demo-session-v1` | 当前演示账号编号 | `settings.session` |
| `dsh-demo-connectors-v1` | 接入配置（28 条） | `entities.connector` |
| `dsh-demo-govern-v1` | 接管范围与深度 | `entities.govern` |
| `dsh-demo-monitor-v1` / `dsh-demo-monitor-handled-v1` | 例外监控设置 / 处置记录 | `settings` + `entities` |
| `dsh-demo-rectify-v1` / `dsh-demo-duty-v1` | 整改台账 / 值班设置 | `entities.rectify` + `settings` |
| `dsh-demo-guard-v1` | 模型安全检测接口配置（留位） | `settings` |
| `dsh-demo-inference-v1` | 推理引擎参数配置 | `settings` |
| `dsh-demo-policy-v1` | 安全策略与变更 | `entities.policy`、`entities.policy_change` |
| `dsh-demo-templates-v1` | 编排模板与 Skill | `entities.template` |
| `dsh-demo-notif-v1` / `dsh-demo-route-v1` | 通知 / 通知路由 | `notifications` + `settings` |
| `dsh-demo-reports-v1` | 报表台账 | `entities.report` |
| `dsh-demo-alert-rules-v1` / `dsh-demo-alert-baseline-v1` | 告警规则 / 基线 | `entities.alert_rule` + `settings` |
| `dsh-demo-allocation-v1` | 成本分摊口径（`usage` / `budget`） | `settings` |

## 写入与失败语义

- 前端写入顺序：先更新内存（界面立即生效）→ 排队 `PUT` → 成功后标「数据已存库」。
- 写入失败：自动退避重试（0.8s / 1.6s / 2.4s，最多 4 次）；仍失败则界面顶部持续显示
  「写入失败 · 重试中」和具体原因，**不会静默丢弃，也不会退回浏览器本地存储**。
- 数据服务不可用时界面仍可操作（内存演示），但顶部显示「数据服务未连接 · 本次不保存」。
