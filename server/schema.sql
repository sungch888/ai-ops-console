-- AI 运营管理平台 演示版 v2.2 数据层（SQLite 起步，SQL 尽量按 PostgreSQL 兼容写法）
-- 说明：
--   kv_store   前端各状态模块的完整快照（传输层，保证与前端行为一致）
--   entities   从快照投影出来的通用实体行（可查询、可分页）
--   orders / order_trace / events / accounts / role_permissions / notifications
--              核心业务实体表（正式版继续扩展）
--   settings   开关与配置类数据
--   audit_log  服务端写入审计（每一次写都留痕）
-- 迁移到 PostgreSQL 时：把 INTEGER PRIMARY KEY AUTOINCREMENT 改为 GENERATED ALWAYS AS IDENTITY，
-- TEXT 与 JSON 文本列可改为 JSONB，时间戳建议改为 TIMESTAMPTZ。

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 通用实体投影：kind 来自快照里的数组名（例如 creds / channels / connectors / governed / rectify）
CREATE TABLE IF NOT EXISTS entities (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  applicant TEXT,
  dept TEXT,
  level TEXT,
  target TEXT,
  amount TEXT,
  reason TEXT,
  status TEXT,
  auto INTEGER DEFAULT 0,
  created_at INTEGER,
  decided_at INTEGER,
  executed_at INTEGER,
  decided_by TEXT,
  reject_reason TEXT,
  spec TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_trace (
  order_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time TEXT,
  actor TEXT,
  action TEXT,
  note TEXT,
  PRIMARY KEY (order_id, seq)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT,
  level TEXT,
  text TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  time TEXT,
  level TEXT,
  title TEXT,
  body TEXT,
  channels TEXT,
  read_flag INTEGER DEFAULT 0,
  handled INTEGER DEFAULT 0,
  source TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT,
  dept TEXT,
  org TEXT,
  domain TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  perm_kind TEXT NOT NULL,   -- view | manage | cls
  perm TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role, perm_kind, perm)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,      -- state_put | state_delete | reset | seed
  target TEXT NOT NULL,      -- 状态键
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (time);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities (kind);

-- --------------------------------------------------------------------------- v3.0 账号 / 会话 / 登录记录
-- 演示版：口令用 PBKDF2-HMAC-SHA256 + 每账号随机盐存库；正式版接统一身份认证时，
-- users 的来源换成身份源同步（或只留本地兜底账号），sessions 换 Redis / 会话服务。
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL,
  dept TEXT,
  org TEXT,
  domain TEXT,
  note TEXT,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  algo TEXT NOT NULL DEFAULT 'pbkdf2_sha256',
  status TEXT NOT NULL DEFAULT 'active',
  must_change INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at REAL NOT NULL,
  last_seen TEXT,
  ip TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  username TEXT,
  ok INTEGER NOT NULL,
  reason TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_username ON login_log(username, at);

-- --------------------------------------------------------------------------- v3.1 身份源适配器与账号策略
-- 口径：试运行用内建账号（users.provider='local'）独立运行；成熟后接外部身份源，
-- 外部账号先只读同步进 identity_links（影子同步），平台用户与外部 uid 一一对应。
CREATE TABLE IF NOT EXISTS identity_links(
  provider TEXT NOT NULL,          -- local | cas | oauth2 | ldap
  external_id TEXT NOT NULL,       -- 外部 uid / 工号
  user_id TEXT,                    -- 对应平台用户；未匹配为空
  name TEXT, role TEXT, dept TEXT,
  matched INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'sync',   -- sync(影子同步) | manual(人工绑定)
  first_seen TEXT, last_seen TEXT,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_links_user ON identity_links(user_id);

CREATE TABLE IF NOT EXISTS password_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id, id);

-- --------------------------------------------------------------------------- v3.3 审批来源（内建 / 外部回写）
-- approval_source=local 时审批在平台内完成；切成 external 时外部单据走同一状态机：
-- 回写入口 /api/approvals/callback，按 (order_id, external_ref, decision) 幂等。
CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- local | external
  external_ref TEXT,               -- 外部单据号
  state TEXT NOT NULL,             -- 待审 | 已审 | 驳回 | 超时
  decision TEXT,                   -- approve | reject | （空=未回写）
  note TEXT,
  actor TEXT,
  due_at TEXT,                     -- 期望回写时间，过期即标黄
  at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_order ON approvals(order_id, at);

-- --------------------------------------------------------------------------- v3.4 排班与派单（试运行由建设团队安排）
CREATE TABLE IF NOT EXISTS duty_shifts(
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,              -- 值班岗位
  name TEXT, phone TEXT, lead TEXT, scope TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS duty_routes(
  kind TEXT PRIMARY KEY,           -- 例外类型
  duty_role TEXT NOT NULL,         -- 派给哪个值班岗位
  escalate_role TEXT NOT NULL DEFAULT '值班长',
  updated_at TEXT NOT NULL
);

-- --------------------------------------------------------------------------- v3.6 控制指令与人工兜底
CREATE TABLE IF NOT EXISTS commands(
  id TEXT PRIMARY KEY,
  target_class TEXT NOT NULL,      -- 安全设备类型
  target TEXT,                     -- 目标设备 / 资源池
  action TEXT NOT NULL,            -- 指令动作
  params TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,     -- 1=演练，不产生外部调用
  status TEXT NOT NULL,            -- 草稿 | 预检通过 | 已下发 | 设备已确认 | 失败 | 已回滚 | 待人工兜底
  impact TEXT,                     -- 影响面清单（JSON，由平台台账推导）
  precheck TEXT,                   -- 预检结论（JSON）
  emergency INTEGER NOT NULL DEFAULT 0,
  issued_by TEXT, issued_at TEXT,
  ack_at TEXT, ack_by TEXT, fail_reason TEXT,
  rollback_of TEXT,                -- 反向指令对应的原指令
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status, created_at);

CREATE TABLE IF NOT EXISTS fallback_tasks(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- command_timeout | approval_overdue | ...
  ref TEXT,                        -- 关联对象（指令号 / 工单号）
  title TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT '待接管',   -- 待接管 | 已接管 | 已关闭
  owner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fallback_status ON fallback_tasks(status, created_at);

-- --------------------------------------------------------------------------- v3.7 监控探针与真实采样
-- 探针只读拉取外部模型服务的 /metrics 与 /health，采样结果入 metric_samples（权威副本在库里）。
-- 密钥不落库：monitor_targets.api_key_env 存的是「环境变量名」，值由启动环境提供。
CREATE TABLE IF NOT EXISTS monitor_targets(
  id TEXT PRIMARY KEY,             -- T-xxxx
  name TEXT NOT NULL,              -- 目标显示名
  base TEXT NOT NULL,              -- 例：http://10.20.14.21:8081
  api_key_env TEXT,                -- 取密钥的环境变量名（不存密钥本身）
  metric_format TEXT NOT NULL DEFAULT 'json',  -- json（自带 /metrics JSON）| prometheus（文本 /metrics）| openai（只有 OpenAI 兼容接口）
  active_probe INTEGER NOT NULL DEFAULT 0,     -- 1 = 每轮主动发一个极小 chat 请求测时延（默认 0，只读）
  pool TEXT NOT NULL DEFAULT 'hp',
  cards INTEGER NOT NULL DEFAULT 1,
  window_seconds INTEGER NOT NULL DEFAULT 300,
  interval_seconds INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,                -- 最近一轮：已采集 | 取数失败
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_samples(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,            -- monitor_targets.id
  service TEXT, model TEXT, version TEXT,
  status TEXT NOT NULL,            -- 已采集 | 取数失败
  instances INTEGER, ready INTEGER, cards INTEGER,
  qps REAL, tokens_per_sec REAL, ttft_ms REAL, p99_ms REAL,
  queue_depth INTEGER, kv_hit_pct REAL, hbm_pct REAL, err_pct REAL,
  gpu_name TEXT, gpu_util REAL, gpu_temp_c REAL, gpu_power_w REAL,
  gpu_mem_used_mib REAL, gpu_mem_total_mib REAL,
  req_window INTEGER,              -- 统计窗口内的请求条数
  req_total REAL,                  -- 对方累计请求计数（prometheus 型用来算增量）
  req_failed REAL,                 -- 对方累计失败计数
  req_seconds_sum REAL,            -- 对方累计处理时长（用来算平均时延）
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_target ON metric_samples(target, at);
CREATE INDEX IF NOT EXISTS idx_samples_at ON metric_samples(at);

CREATE TABLE IF NOT EXISTS gpu_cards(
  id TEXT PRIMARY KEY,             -- 目标 + 卡序号
  target TEXT NOT NULL, node TEXT, model TEXT,
  util_pct REAL, mem_used_mib REAL, mem_total_mib REAL,
  temp_c REAL, power_w REAL, cpu_pct REAL, ram_used_mib REAL, ram_total_mib REAL,
  health TEXT, note TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gpu_cards_target ON gpu_cards(target);

-- --------------------------------------------------------------------------- v3.8 资源接入配置（不改代码加资源）
-- 采集源全部在系统里配（配置中心 → 资源接入与采集）：collector/config.json 只作为一次性导入来源。
-- 密钥不入库：config_json 里只允许 "api_key": "env:环境变量名" 这种引用形式，值由启动环境提供。
CREATE TABLE IF NOT EXISTS data_sources(
  id TEXT PRIMARY KEY,             -- DS-xxxx
  kind TEXT NOT NULL,              -- cards | services | gateway | routes | apps | deploy
  name TEXT NOT NULL,              -- 显示名
  config_json TEXT NOT NULL,       -- 该源的采集配置（base / format / 查询指标名 / env:密钥引用 等）
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,                -- 已采集 | 取数失败
  last_error TEXT,
  last_run_at TEXT,
  approval_state TEXT NOT NULL DEFAULT '已生效',  -- 已生效 | 待审批 | 已驳回（配置项 data-source-approval 打开时先走工单）
  order_id TEXT,                        -- 资源接入工单号（WO-xxxx）
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON data_sources(kind, enabled);

CREATE TABLE IF NOT EXISTS collect_payloads(
  kind TEXT PRIMARY KEY,           -- 与 data_sources.kind 对应
  rows_json TEXT NOT NULL,         -- 采集到的行（各页面主表格的数据来源）
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sources INTEGER NOT NULL DEFAULT 0,   -- 这个类型由几个源合起来的
  at TEXT NOT NULL
);
