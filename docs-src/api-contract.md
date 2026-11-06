# 数据服务接口契约（v3.7）

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

## v3.1 ~ v3.6 新增接口

写操作的通用前置条件（三条都在服务端守卫里，前端改了没用）：

| 条件 | 不满足时 |
|---|---|
| 带有效会话 Cookie | 401 「未登录或会话已过期」 |
| 写操作带 `X-CSRF-Token`（登录 / 会话探测时下发的 `csrf`，服务端存在 `sessions.csrf`，用 `hmac.compare_digest` 比对） | 403「跨站请求伪造防护」，并写审计 `denied_csrf` |
| 账号不处于「必须改口令」状态（`POST /api/password/change` 与 `logout` 除外） | 403「还没改口令」，并写审计 `denied_password_pending` |

### 身份与口令（v3.1）

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /api/config` | 已登录 | 返回配置项、四个身份适配器状态、配置项中文名 |
| `PUT /api/config` | 权限矩阵·操作 | `{"key":"auth-provider","value":"oauth2"}`；取值白名单校验，非法值 400 并回可选项 |
| `GET /api/sessions` | 已登录（无矩阵查看权时只返回本人会话） | 会话列表：`ref` / 账号 / IP / 建立与最近活动时间 / 剩余分钟 / 是否当前会话 |
| `POST /api/session/revoke` | 本人 or 矩阵查看权 | `{"ref":"..."}` 撤销会话；撤销本人会话同时清 Cookie |
| `POST /api/password/change` | 本人 | `{"old_password","new_password"}`；成功后当前会话撤销、需重新登录 |
| `POST /api/password/reset` | 权限矩阵·操作 | 管理员给某账号设临时口令，置为「下次登录必须改」，并撤销该账号全部会话 |
| `POST /api/account/toggle` | 权限矩阵·操作 | `{"user_id":"U-0004","enabled":false}` 停用账号（登录 403 + 会话全撤） |
| `POST /api/links/sync` | 权限矩阵·操作 | 影子同步：`{"provider":"cas","accounts":[{"external_id","name","role"}]}`；只读导入，按 `(provider, external_id)` 幂等，返回 `total / matched / unmatched` |
| `GET /api/links` | 矩阵查看权（查询层） | 账号映射表，可按 `provider` / `matched` / `q` 过滤 |

口令策略（服务端判定）：长度 ≥ 8、必须同时含字母与数字、不在常见弱口令表、不等于账号、不等于当前口令或最近 3 次用过的口令（`password_history`）、有效期 90 天（超期登录即置 `must_change=1`）。

配置项（`settings` 表，可 `PUT /api/config` 修改）：

| 配置项 | 取值 | 口径 |
|---|---|---|
| `auth-provider` | `local` / `cas` / `oauth2` / `ldap` | 先内建独立运行；外部适配器未配置时明确拒绝，不静默降级 |
| `approval-source` | `local` / `external` | 外部来源时本系统只登记「待回写」并跟踪超时 |
| `notify-channels` | `site` / `site,email` / `site,email,sms,im` | 一期只保证站内 + 邮件；短信 / IM 需客户方通道 |
| `duty-source` | `local` / `external` | 试运行由建设团队排班；切外部后本系统只派单与跟踪 |
| `command-ack-timeout-min` | 1 ~ 1440 | 处置指令超时未确认即转人工兜底 |

### 审批来源与外部回写（v3.3）

| 接口 | 权限 | 说明 |
|---|---|---|
| `POST /api/approval/create` | 工单审批权·操作 | 给已存在的工单登记「外部审批待回写」：`{"order_id","external_ref","due_minutes","note"}` → `state=待审`、`due_at` |
| `POST /api/approval/decide` | 工单审批权·操作 | 平台内人工判定（`decision=approve|reject`） |
| `POST /api/approval/callback` | 工单审批权·操作 | 外部系统回写，按 `(order_id, external_ref, decision)` 幂等；重复回写返回 `deduped:true` |
| `GET /api/approvals` | 资源调配·查看 | 可按 `order` / `source` / `state` / `q` 过滤 |

超时扫描（`GET /api/approvals` 时惰性执行）：`state=待审` 且 `due_at` 已过 → 标 `超时`，同时写 `fallback_tasks`（`kind=approval_overdue`）与审计 `approval_overdue`。

### 排班与派单（v3.4）

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /api/duty` | 资源调配·查看 | 值班岗位表（`duty_shifts`）：岗位 / 当班人 / 内线 / 上级 / 范围 / 是否启用 |
| `GET /api/duty_routes` | 资源调配·查看 | 派单映射（例外类型 → 岗位 → 超时升级岗位） |
| `POST /api/duty/shift` | 资源调配·操作 | 新增或修改岗位（按 `id` 覆盖） |
| `POST /api/duty/route` | 资源调配·操作 | 修改某类例外的派单岗位与超时升级岗位 |

### 处置指令与人工兜底（v3.6）

| 接口 | 权限 | 说明 |
|---|---|---|
| `POST /api/commands/dry-run` | 处置下发·操作 | 预检：返回影响面清单（由平台台账推导）与预检项；`dry_run=1`，不产生外部调用 |
| `POST /api/commands/issue` | 处置下发·操作（`emergency=true` 需「紧急处置」） | 必须已有预检记录 + `confirm:true`，否则 400；成功后写事件流与审计 |
| `POST /api/commands/ack` | 处置下发·操作 | `{"id","ok":true/false,"reason"}`；失败即生成 `fallback_tasks` |
| `POST /api/commands/rollback` | 处置下发·操作 | 生成反向指令（`rollback_of` 指向原指令），原指令标 `已回滚` |
| `GET /api/commands` | 安全事件·查看 | 指令台账，可按 `status` / `target_class` / `dry_run` / `q` 过滤 |
| `GET /api/fallback` | 安全事件·查看 | 人工兜底工单 |
| `POST /api/fallback/claim` | 安全事件·操作 | 接管 / 关闭兜底工单，经办人写入 |

状态机：`草稿 → 预检通过 → 已下发 →（设备已确认 / 失败 / 待人工兜底）→ 已回滚`。
超时扫描（`GET /api/commands` 时惰性执行）：`已下发` 且超过 `command-ack-timeout-min` 未确认 → `待人工兜底` + 兜底工单 + 事件 + 审计。

权限点新增两项（v3.6，权限矩阵页面可直接勾选）：

| 权限点 | 中文 | 默认给谁 |
|---|---|---|
| `security_issue` | 处置下发 | 管理员、运营值班 |
| `security_emergency` | 紧急处置 | 仅管理员 |

### 新增数据表（v3.1 ~ v3.6）

`identity_links`（账号映射，主键 `provider+external_id`）、`password_history`（口令历史）、
`approvals`（审批登记与回写）、`duty_shifts` / `duty_routes`（排班与派单）、
`commands`（处置指令）、`fallback_tasks`（人工兜底工单）。
旧库原地升级：启动时 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 补 `users.enabled / provider / pw_changed_at`
与 `sessions.ref / csrf`，权限矩阵只补新权限点、不覆盖已改过的勾选。

### 监控探针（v3.7）

平台内置一个只读探针线程（启动环境 `AIOPS_MONITOR=0` 可关），按每个目标自己设定的间隔拉取外部推理服务的
`GET /metrics` 与 `GET /health`，把采样写进 `metric_samples`，卡指标写进 `gpu_cards`。**探针不向被监控的服务写任何东西。**

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /api/monitor` | 算力中心·查看 | 目标清单、每个目标的最近一轮、探针线程状态、采样总数、密钥环境变量是否已给 |
| `POST /api/monitor/target` | 算力中心·操作 | 新增或修改目标：`{"name","base","api_key_env","interval_seconds","window_seconds","cards","pool","enabled","probe"}`；`probe:true` 表示存完立刻采一轮 |
| `POST /api/monitor/probe` | 算力中心·操作 | `{"id":"T-7096"}` 或空体 = 采全部启用的目标 |
| `GET /api/samples` | 算力中心·查看 | 采样台账，可按 `target` / `status` / `q` / `since` 过滤与分页 |
| `GET /api/gpu_cards` | 算力中心·查看 | 实连卡台账（探针写入），可按 `target` / `q` 过滤 |

- 密钥只在启动环境的环境变量里，库里与前端只存**环境变量名**（`api_key_env`）。
- 取数失败也写一条 `status='取数失败'` 的样本 + 审计 `monitor_probe_failed`：断连在台账里看得见，不会静默变空页。
- 采样保留 `SAMPLE_RETENTION_HOURS`（默认 24 小时）与上限 20000 行，超出的按最旧的删。
- `metric_samples` / `gpu_cards` / `monitor_targets` 不在「重置演示数据」的清理范围里（真实观测不被演示重置抹掉）。
- 取数口径三种，按目标选（字段 `metric_format`）：
  | 口径 | 对方要有什么 | 采得到 | 采不到时怎么写 |
  |---|---|---|---|
  | `json` | 自己的 `/metrics` 返回 JSON（engine / live / requests / hardware / totals 这种结构） | QPS、吞吐、TTFT、P99、队列、KV 命中、显存、卡利用率 / 温度 / 功耗、主机 CPU 与内存 | — |
  | `prometheus` | `/metrics` 是 Prometheus 文本（llama-server 加 `--metrics`、vLLM、NVML / NPU Exporter） | 用「本轮 − 上一轮」的累计计数增量算 QPS / 错误率 / 平均时延；解析 KV 占用、排队、卡利用率 / 温度 / 功耗 / 显存 | 对方没写的字段存 NULL，界面显示「对方未开放」 |
  | `openai` | 只有 OpenAI 兼容接口（`/health` + `/v1/models`） | 可用性 + 往返时延 + 已注册模型与量化口径；`active_probe=1` 时再加一次 16 词元小请求的时延与吞吐 | QPS / 队列 / KV 命中 / 全部卡指标 → NULL，卡台账那一行标「对方未开放卡指标」 |
- `active_probe`（默认 0）：开了才会主动发一个 16 词元的 `POST /v1/chat/completions`；关掉就完全只读。
- 卡指标 NULL 不会被写成 0：`gpu_cards.health = 'unknown'`，界面显示「无卡指标」而不是「正常」。
