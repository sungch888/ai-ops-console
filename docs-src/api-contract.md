# 数据服务接口契约（v3.0）

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

- 请求 / 响应均为 `application/json; charset=utf-8`（`/api/csv` 返回 `text/csv`）。
- 错误返回 `{"ok": false, "error": "中文说明"}`，HTTP 状态同步（400 / 401 / 403 / 404 / 429 / 500）。
- 单个请求体上限 8 MB。同键重复 PUT = 覆盖（幂等）。

## 登录与会话（v3.0）

除 `/api/health`、`/api/login`、`/api/logout`、`/api/session` 外，所有 `/api` 都要带有效会话，否则 401。

| 接口 | 说明 |
|---|---|
| `POST /api/login` | `{"username":"admin","password":"..."}` → 200 `{"ok":true,"user":{...},"perms":{"view":[…],"manage":[…]},"expires_in":28800}`，同时下发 Cookie |
| `POST /api/logout` | 撤掉当前会话（`sessions.revoked=1`）并清 Cookie |
| `GET /api/session` | 未登录 `{"ok":true,"signed_in":false}`；已登录返回用户与权限点 |
| `GET /api/users` | 账号清单（需要「权限矩阵」查看权）。**不返回** `pw_salt` / `pw_hash` / `algo` |

- 会话：Cookie 名 `dsh_session`，`HttpOnly` + `SameSite=Lax` + `Path=/`，有效期 8 小时，每次访问滑动续期（最多每分钟写一次库）。前端拿不到 token，也无法改自己的角色。
- 口令：库里存 PBKDF2-HMAC-SHA256（12 万次迭代）+ 每账号随机盐；比较用常数时间比较。演示口令 `admin/admin123`、`ops/ops123`、`dev/dev123`、`user/user123`（正式版必须改强口令并接统一身份认证）。
- 登录失败限流：同一账号 5 分钟内失败 5 次 → 429。成功与失败都写 `login_log(at, username, ok, reason, ip)`。
- 已登录时 `audit_log.actor` 取服务端会话的账号编号；未登录的公开接口才退回 `X-Demo-Account` 请求头。

### 服务端权限判定

- 写状态键要对应权限点（`manage`）：矩阵 → `matrix`；工单引擎 / 整改 / 值班 → `workflow`；接入配置 → `integration`；例外监控 → `compute`；策略与安全检测 → `security`；推理引擎 → `gateway`；模板 → `app`；报表 → `export`；告警规则 / 分摊 / 基线 → `analytics`；通知与路由 / 接管范围 → `overview`。未列出默认 `overview`。
- 批量写入、`/api/reset`、`/api/seed` 需要 `workflow`（资源调配）写入权。
- 查询接口要 `view`：`/api/audit` → `audit`；`/api/export` → `export`；`/api/accounts`、`/api/permissions`、`/api/users` → `matrix`。
- CSV 导出：对应资源的查看权 + `export` 写入权。
- `PUT /api/state/dsh-demo-session-v1` 一律 400：会话只由数据服务管理。
- 越权写会先写一条 `denied_put` / `denied_delete` 审计再返回 403，理由写在 `error` 里。

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

### 查询接口（服务端过滤 + 分页，返回 `total`）

| 接口 | 说明 | 可用参数 |
|---|---|---|
| `GET /api/orders` | 工单表 | `status`、`type`、`applicant`、`q`（标题 / 对象 / 理由 / 规模模糊匹配）、`limit`（≤500，默认 100）、`offset` |
| `GET /api/events` | 运行事件（长期留存） | `level`、`q`、`since`（时间起）、`limit`、`offset` |
| `GET /api/audit` | 服务端写入与越权审计 | `action`、`actor`、`since`、`limit`、`offset` |
| `GET /api/notifications` | 通知中心 | `level`、`q`、`limit`、`offset` |
| `GET /api/accounts` | 状态里的演示账号 | `limit`、`offset` |
| `GET /api/permissions` | 角色权限矩阵展开行 | `role`、`limit`、`offset` |
| `GET /api/settings` | 开关与配置 | `q`、`limit`、`offset` |
| `GET /api/entities?kind=cred` | 通用实体投影 | `kind`、`q`、`limit`、`offset` |
| `GET /api/tables` | 各表行数与最近变更 | — |
| `GET /api/export` | 全部 kv 快照（带 updated_at），迁移与备份用 | — |
| `GET /api/csv?resource=orders` | 服务端生成 CSV（UTF-8 BOM + CRLF），过滤参数同上，`limit` 上限 20000 | `resource` = `orders` / `events` / `audit` / `notifications` / `entities` / `permissions` / `settings` / `accounts` |

### 界面对应的页面

「运营分析 · 台账与审计（查库）」`/ops/records` 就是上面这组接口的界面版：页签对应 `orders` / `events` / `audit` / `tables`，
面板上显示本次请求的 URL，导出按钮直接打开 `/api/csv`。

### 事件长期留存

界面快照只保留最近 80 条事件，库里按 `(time, text, source)` 去重追加：快照覆盖不会删掉历史，
翻页可以看到更早的事件。正式版换分区表与归档策略（见 `docs-src/architecture.md`）。

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
