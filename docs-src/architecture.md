# 架构与正式版升级路线（v2.2 → v3.x）

这一版是**正式版本的初级版本**：界面与流程已经能演示，数据已经从浏览器本地搬到数据库，
后面按阶段替换成正式实现，**前端与接口契约基本不动**。

## 1. 当前结构（v2.2）

```
浏览器（React 19 + TS + Vite）
  ├─ 界面层  pages/*                     只渲染与交互
  ├─ 引擎层  engine/*                    工单、准入校验、例外监控、整改闭环、权限矩阵
  └─ 数据层  engine/db.ts                内存副本 + 写队列（唯一出入口）
                     │  HTTP JSON（同源 /api）
数据服务  server/server.py（Python 标准库）
  ├─ 静态托管 dist/
  ├─ REST：state / orders / events / audit / notifications / accounts / entities …
  └─ 投影与审计：kv_store → 关系表 → audit_log
数据库  SQLite（server/data/aiops.db，WAL）
只读采集  collector/collect.py → dist/data/*.json → 前端只读展示（不写回外部）
```

要点：
- **浏览器本地不存任何东西**（不用 localStorage / sessionStorage / IndexedDB）。
- 引擎层只通过 `dbRead / dbWrite / dbRemove` 读写，切换后端不用改业务代码。
- 采集层保持只读：外部指标进 `dist/data/*.json`，前端展示；权威状态在数据库。

## 2. 数据模型

| 表 | 作用 | 正式版去向 |
|---|---|---|
| `kv_store(key, payload, updated_at)` | 各状态模块完整快照（传输层） | 逐步被下面的实体表取代 |
| `entities(kind, id, name, payload, updated_at)` | 快照里的数组投影成行（凭证 / 渠道 / 接入 / 接管 / 模板 / 策略 / 报表 / 告警规则…） | 拆成各自的正式表 |
| `orders` / `order_trace` | 工单主表 + 处置轨迹（提交、审批、下发、回执、执行、驳回、关闭） | 正式工单表（加索引、外键、状态机约束） |
| `events` | 运行事件流 | 事件表 + 分区/归档 |
| `notifications` | 通知中心 | 通知表 + 外送任务表 |
| `accounts` / `role_permissions` | 演示账号与权限矩阵展开行 | 用户 / 角色 / 权限三表 + 统一身份认证 |
| `settings(key, value, updated_at)` | 开关与配置（分摊口径、监控设置、值班、检测接口配置、路由、基线） | 配置表 + 配置变更审批 |
| `audit_log(at, actor, action, target, detail)` | 服务端写入审计 | 正式审计表（不可改、分区留存） |
| `meta(key, value)` | 结构与版本 | 迁移版本表 |

为什么先做「快照 + 投影」：演示阶段数据形状还在变，先用一份快照保证行为一致，
同时把核心实体落成可查询的表；正式版按表逐个接管，接口不变，前端不改。

## 3. SQLite → PostgreSQL / MySQL 迁移

1. 换连接层：`server/server.py` 里只有 `db()`、`project_state()`、查询 SQL 三处接触数据库，
   替换为 psycopg / asyncpg 或 SQLAlchemy，接口契约不变。
2. 建表：`server/schema.sql` 已有 PostgreSQL 迁移注记——
   `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`；
   JSON 文本列 → `JSONB`；时间戳 → `TIMESTAMPTZ`；`ON CONFLICT … DO UPDATE` 语法一致。
3. 迁数据：`GET /api/export` 导出全部快照 → 新库执行同一套投影函数 → 校验行数一致（`/api/health` 的 counts 对比）。
4. 并发：SQLite 用 WAL + busy_timeout；PostgreSQL 增加行级锁与版本号字段（`updated_at` 乐观锁），
   写请求加 `If-Match`/`version` 参数避免多人互相覆盖。

## 4. 迭代计划

| 版本 | 目标 | 主要内容 | 验收标准 |
|---|---|---|---|
| **v2.2（本版）** | 数据入数据库 | 数据服务 + SQLite + 关系表投影 + 服务端审计；前端去本地存储 | 关浏览器换电脑数据仍在；`/api/health` 可查；写入失败界面明确提示 |
| v2.3 | 查询与留存 | 工单/事件/审计分页界面、CSV 导出走服务端、例外与整改台账入库可视化 | 报表数字与数据库查询一致；审计可按时间翻 |
| v3.0 | 正式认证与权限 | 真实账号（统一身份认证 / LDAP / OAuth）、服务端会话与令牌、权限在服务端判定 | 前端伪造角色无效；越权请求返回 403 |
| v3.1 | 多租户与并发 | 租户 / 项目组上下文、数据按租户隔离、乐观锁与冲突提示 | 两个浏览器同时操作不互相覆盖 |
| v3.2 | 外部系统真接 | 容器平台工单与回执、告警规则中心与例外监控打通、整改闭环对接真实工单/值班系统、采集层写库 | 工单号原样回传；回执超时可见；失败原因可追溯 |
| v3.3 | 生产化 | PostgreSQL、备份与恢复演练、日志外送、HTTPS 与内网部署、性能与容量基线 | 恢复演练通过；接口有速率与容量基线 |

## 5. 这一版明确不做（避免误解）

- 不做真实身份认证与令牌（演示免密；账号仍入库，便于 v3.0 替换）。
- 不做多人并发一致性（先单机；换库时补乐观锁）。
- 不做安全设备真实联动、国密改造与密评、SLA 双活。
- 采集层只读，数据服务不向任何外部系统写数据。
- 所有业务数字仍是演示数据；接真实接口后按「采集层 / 部分采集 / 平台推导」标来源。

## 6. 演示与交付注意

- 演示数据落库位置：`server/data/aiops.db`（已加 `.gitignore`，不进仓库）。
- 恢复初始演示数据：页面「重置演示数据 / 恢复初始演示数据」＝ 调 `POST /api/reset` 清库再写初始值。
- 换电脑 / 换内网机器：拷整个目录（含 `dist`）即可跑；要带走数据就拷 `server/data/aiops.db`。
- 演示前检查：`GET /api/health` 能通、`counts` 不为 0。
