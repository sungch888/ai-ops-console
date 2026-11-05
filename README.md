# AI 运营管理平台 · 演示版（脱敏公开版）

面向「算力 / 模型 / 应用」三中心统一运行管理的**演示原型**：前端可交互、流程有门禁、数据可追溯来源。
用于选型与方案交流，**作为正式版本的初级版本迭代**（升级路线见 `docs-src/architecture.md`）。

仓库名：`ai-ops-console` · 许可证：MIT

> 本仓库已脱敏：机构名称、地市名称、演示账号均为中性示例（示范市01、示例业务一部、管理员 A 等）；
> 所有数字、事件、外部系统均为虚拟模拟，不含任何真实业务数据。

## 演示什么

| 中心 | 关键能力 |
|---|---|
| 算力中心 | 三池（高保 / 共享 / 灰度）卡位与调度、昇腾卡位级监控、例外监控与阻断、整改闭环与派单、部分阻断、变更窗口与工单队列 |
| 模型中心 | 模型资产与版本、部署工单（发单 → 审批 → 下发 → 执行回执到位才生效）、MindIE 服务级监控、LiteLLM 网关仪表与凭证对账、安全检测流程（接口留位）、调用审计与溯源 |
| 应用中心 | 应用 / 智能体 / 知识库 / 工具（MCP·插件·Skill）纳管与目录一致性、Dify 与 RAGFlow 第一期只读纳管、安全事件处置、权限矩阵 |
| 运营分析 | 资源调配工作台、告警规则、报表与 CSV 导出、通知中心、外部接入配置中心（28 条配置）、申请与审批台 |

## 口径（重要）

- **平台只做运行态管理**：不做智能体编排、Prompt 调试、向量化、插件安装。
- **动作边界**：平台负责准入校验 + 审批 + 发单 + 验收回执 + 留痕；容器侧执行由容器平台 / 运维做，设备侧动作由设备与机房做。未收到执行回执前不生效、不占卡位。
- **数据来源透明**：每个页面标当前来源是「采集层」还是「平台推导」；某路取不到就写「取数失败」并回落推导，不猜数、不补数。

## 快速开始

```bash
# 直接跑演示（Python 标准库，不用装第三方包；dist 已在仓库里）
python3 server/server.py    # 或 ./start.sh（Mac/Linux）、双击 start.bat（Windows，无 Python 自动改用 PowerShell）

# 改代码后重新构建
npm install                 # 或 pnpm install
npm run build
```

浏览器打开 `http://127.0.0.1:8090/`，登录页选中账号会自动填好登录名与演示口令：
`admin/admin123`（管理员 A）、`ops/ops123`（运营 B）、`dev/dev123`（开发者 C）、`user/user123`（用户 D）。
**演示口令是弱口令，二次开发或交付前必须全部替换。**

## 登录、会话与权限

- 登录 `POST /api/login`，会话是 `HttpOnly` + `SameSite=Lax` Cookie（8 小时，访问时滑动续期）；前端没有 token，也改不了自己的角色。
- 口令存库：PBKDF2-HMAC-SHA256（12 万次迭代）+ 每账号随机盐；接口不返回口令字段；比较用常数时间比较。
- 同一账号 5 分钟内失败 5 次 → 429 暂时拒绝；成功与失败都写 `login_log`。
- 权限在服务端判定：写状态键要对应权限点，批量写 / 重置要「资源调配」，查审计要「审计日志」查看权，导出要「报表导出」；
  越权 403 并写 `denied_put` 审计。未登录访问 `/api`（health / login / logout / session 除外）返回 401。

## 数据存哪里

**业务状态存数据库，浏览器本地不存任何东西**（不用 localStorage / sessionStorage / IndexedDB）。

- 数据服务：`server/server.py`（Python 标准库 + SQLite），既托管页面也提供 `/api`。
- 数据文件：`server/data/aiops.db`（演示数据落这里，已 gitignore；拷走文件就等于带走数据）。
- 表：状态快照 `kv_store` + 投影表 `orders` / `order_trace` / `events` / `notifications` / `accounts` /
  `role_permissions` / `entities` / `settings` + 写入审计 `audit_log`（`server/schema.sql`）。
- 自检与查询：`/api/health`、`/api/orders?status=待审批`、`/api/audit?limit=50`、
  `/api/entities?kind=connector`、`/api/export`（全量导出，便于换库迁移）。
- 接口契约：`docs-src/api-contract.md`；换 PostgreSQL 的做法：`docs-src/architecture.md`。

## 只读采集层

`collector/collect.py`（Python 标准库，只读）把外部指标落成 `dist/data/*.json`，前端只读展示：

```bash
python3 collector/collect.py --selftest --out dist/data                 # 先验证字段结构
python3 collector/collect.py --config collector/config.json --loop 30   # 接真实接口（密钥写 env:变量名）
```

支持六路：昇腾卡指标（Prometheus 优先、`npu-smi` 自动兜底）、MindIE 服务指标、LiteLLM（`/key/info`、`/spend/logs`、`/model/info`）、Dify Console API、RAGFlow API、容器平台执行回执。
**采集脚本不向任何外部系统写数据。**

## 目录

| 路径 | 说明 |
|---|---|
| `src/` | React 19 + TypeScript 前端；`src/engine/` 是演示引擎（工单、准入校验、例外监控、接管深度、整改闭环、权限矩阵） |
| `dist/` | 构建产物，可直接起服务 |
| `server/` | 数据服务（`server.py`）与表结构（`schema.sql`）：SQLite 存储 + 登录会话 + 权限判定 |
| `collector/` | 只读采集脚本与配置样例 |
| `docs-src/operation-manual.md` / `.docx` | 系统操作说明书（37 个小节，含表单校验规则表与常见问题） |
| `docs-src/api-contract.md` | 接口契约（登录与会话、权限点映射、状态键、过滤分页、CSV、失败语义） |
| `docs-src/architecture.md` | 当前结构、数据模型与 v2.2 → v3.x 正式版迭代计划 |
| `serve.py` `start.bat` `start.ps1` `start.sh` `README-START.txt` | 启动与打包 |

## 还没做（别当成已交付）

接真实身份源（本版是本地账号 + 口令 + 服务端会话；SSO / LDAP / OAuth、CSRF 令牌、口令策略与首次改口令排在下一版）；多人并发写的一致性保护；告警规则中心与例外监控两套尚未打通；多租户 / 项目组上下文切换；移动端布局适配；审计长期留存与分页；整改闭环接真实工单与值班系统；安全设备真实联动；真实统一身份认证；国密改造与密评。

## 授权

MIT License，见 `LICENSE`。可自由使用、修改、再分发（保留版权声明即可）。
再次提醒：仓库里的数据、单位名、人员名、外部系统名全部是虚构演示内容，不构成任何产品承诺。
