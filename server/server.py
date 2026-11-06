#!/usr/bin/env python3
"""AI 运营管理平台 演示版 v2.2 —— 数据服务（Python 标准库 + SQLite）

职责：
  1) 托管前端静态文件（dist）
  2) 提供 /api 读写接口，所有业务状态存 SQLite，浏览器本地不再保存任何业务数据
  3) 把状态快照投影成可查询的关系表（工单 / 轨迹 / 事件 / 通知 / 账号权限 / 通用实体）
  4) 每次写入都进 audit_log

用法：
  python3 server/server.py                     # http://127.0.0.1:8090
  python3 server/server.py --port 8091 --db server/data/aiops.db
  python3 server/server.py --reset             # 清空数据库后退出（下次启动重新写入初始演示数据）

接口契约见 docs-src/api-contract.md。默认只绑定 127.0.0.1：演示版没有鉴权，不要直接暴露到公网。
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(HERE, 'data', 'aiops.db')
SCHEMA = os.path.join(HERE, 'schema.sql')
STATIC_DIR = os.path.join(ROOT, 'dist')
API_PREFIX = '/api'
MAX_BODY = 8 * 1024 * 1024
SCHEMA_VERSION = '3'
SERVER_VERSION = '3.1.0'

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
}

_local = threading.local()
_START_TS = time.time()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def db() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA busy_timeout=8000')
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = db()
    with open(SCHEMA, encoding='utf-8') as f:
        conn.executescript(f.read())
    upgrade_schema(conn)
    conn.execute('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 ('schema_version', SCHEMA_VERSION))
    conn.execute('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 ('server_version', SERVER_VERSION))


def actor_of(handler) -> str:
    """已登录时账号取服务端会话；未登录（公开接口）才退回前端声明的 header。"""
    u = getattr(handler, 'user', None)
    if u:
        return str(u['id'])[:40]
    a = handler.headers.get('X-Demo-Account') or ''
    a = re.sub(r'[^0-9A-Za-z\u4e00-\u9fa5 _\-.]', '', a)[:40]
    return a or 'anonymous'


def audit(conn, actor: str, action: str, target: str, detail: str = '') -> None:
    conn.execute('INSERT INTO audit_log(at, actor, action, target, detail) VALUES(?, ?, ?, ?, ?)',
                 (now_iso(), actor, action, target, detail[:500]))



# --------------------------------------------------------------------------- 账号与会话（v3.0）
SESSION_COOKIE = 'dsh_session'
SESSION_TTL = 8 * 3600            # 会话有效期（每次访问滑动续期）
PBKDF2_ROUNDS = 120000
LOGIN_FAIL_LIMIT = 5              # 同一账号在窗口内失败次数上限
LOGIN_FAIL_WINDOW = 300
PUBLIC_API = {'', 'health', 'login', 'logout', 'session'}

# 演示口令：演示用，正式版必须改强口令并接统一身份认证 / LDAP / OAuth
DEMO_USERS = [
    {'id': 'U-0001', 'username': 'admin', 'name': '管理员 A（信息化管理部）', 'role': 'admin',
     'dept': '信息化管理部', 'org': '省级单位', 'domain': '用户域', 'note': '全部权限 · 可编辑权限矩阵 · 可审批与执行',
     'password': 'admin123'},
    {'id': 'U-0002', 'username': 'ops', 'name': '运营 B（运营服务团队）', 'role': 'ops',
     'dept': '运营服务', 'org': '省级单位', 'domain': '用户域', 'note': '可提交 / 执行 / 回滚 / 导出，不可改权限矩阵',
     'password': 'ops123'},
    {'id': 'U-0003', 'username': 'dev', 'name': '开发者 C（示例业务一部）', 'role': 'dev',
     'dept': '示例业务一部', 'org': '省级单位', 'domain': '用户域', 'note': '只看本单位业务线，可提交申请，不可审批',
     'password': 'dev123'},
    {'id': 'U-0004', 'username': 'user', 'name': '用户 D（示范市02单位）', 'role': 'user',
     'dept': '示范市02单位基层所队', 'org': '示范市02', 'domain': '数据域', 'note': '仅应用广场与个人用量，低权限个人密钥',
     'password': 'user123'},
]

PERM_LABEL_CN = {
    'overview': '运营总览', 'compute': '算力中心', 'gateway': '推理网关', 'cred': '凭证与配额',
    'workflow': '资源调配', 'app': '应用广场', 'agent': '智能体纳管', 'kb': '知识库纳管',
    'tool': '工具生态', 'security': '安全事件', 'audit': '审计日志', 'matrix': '权限矩阵',
    'export': '报表导出', 'integration': '外部对接', 'analytics': '运营分析', 'approve': '工单审批权',
    'security_issue': '处置下发', 'security_emergency': '紧急处置',
}

# 写某个状态键需要哪个权限点（服务端判定，前端伪造角色无效）
KEY_PERM = {
    'dsh-demo-matrix-v1': 'matrix',
    'dsh-demo-accounts-v1': 'matrix',
    'dsh-demo-engine-v4': 'workflow',
    'dsh-demo-connectors-v1': 'integration',
    'dsh-demo-govern-v1': 'overview',
    'dsh-demo-monitor-v1': 'compute',
    'dsh-demo-monitor-handled-v1': 'compute',
    'dsh-demo-rectify-v1': 'workflow',
    'dsh-demo-duty-v1': 'workflow',
    'dsh-demo-guard-v1': 'security',
    'dsh-demo-policy-v1': 'security',
    'dsh-demo-inference-v1': 'gateway',
    'dsh-demo-templates-v1': 'app',
    'dsh-demo-notif-v1': 'overview',
    'dsh-demo-route-v1': 'overview',
    'dsh-demo-reports-v1': 'export',
    'dsh-demo-alert-rules-v1': 'analytics',
    'dsh-demo-alert-baseline-v1': 'analytics',
    'dsh-demo-allocation-v1': 'analytics',
}
QUERY_PERM = {'audit': 'audit', 'export': 'export', 'accounts': 'matrix', 'permissions': 'matrix', 'users': 'matrix',
              'approvals': 'workflow', 'commands': 'security', 'fallback': 'security', 'links': 'matrix',
              'duty': 'workflow', 'duty_routes': 'workflow'}
MATRIX_KEYS = sorted([k for k, v in KEY_PERM.items() if v == 'matrix'])
CSV_PERM = {'audit_log': 'audit', 'accounts': 'matrix', 'role_permissions': 'matrix',
            'approvals': 'workflow', 'commands': 'security', 'fallback_tasks': 'security',
            'identity_links': 'matrix', 'duty_shifts': 'workflow', 'duty_routes': 'workflow'}

# 权限矩阵默认值（与前端默认一致；库里没有矩阵时服务端自己播种，保证登录即可判定）
DEFAULT_MATRIX = {
    'admin': {
        'view': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                 'security', 'security_issue', 'security_emergency', 'audit', 'matrix', 'export',
                 'integration', 'analytics', 'approve'],
        'manage': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                   'security', 'security_issue', 'security_emergency', 'audit', 'matrix', 'export',
                   'integration', 'analytics', 'approve'],
        'cls': ['公开', '内部', '敏感']},
    'ops': {
        'view': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                 'security', 'security_issue', 'audit', 'export', 'integration', 'analytics', 'approve'],
        'manage': ['compute', 'gateway', 'cred', 'workflow', 'security', 'security_issue', 'export',
                   'analytics', 'approve'],
        'cls': ['公开', '内部', '敏感']},
    'dev': {'view': ['overview', 'app', 'agent', 'kb', 'tool', 'workflow', 'cred', 'analytics'],
            'manage': ['workflow', 'agent'], 'cls': ['公开', '内部']},
    'user': {'view': ['app', 'cred'], 'manage': [], 'cls': ['公开']},
}


def hash_password(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), salt.encode('utf-8'), PBKDF2_ROUNDS).hex()


def seed_users() -> int:
    conn = db()
    if conn.execute('SELECT COUNT(*) c FROM users').fetchone()['c']:
        return 0
    ts = now_iso()
    for u in DEMO_USERS:
        salt = secrets.token_hex(16)
        # pw_changed_at 故意留空：首次登录即要求改口令（演示口令是弱口令，不能带进正式环境）
        conn.execute('INSERT INTO users(id, username, name, role, dept, org, domain, note, pw_salt, pw_hash,'
                     ' algo, status, must_change, created_at, updated_at, enabled, provider, pw_changed_at)'
                     ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL)',
                     (u['id'], u['username'], u['name'], u['role'], u['dept'], u['org'], u['domain'], u['note'],
                      salt, hash_password(u['password'], salt), 'pbkdf2_sha256', 'active', 1, ts, ts, 'local'))
    return len(DEMO_USERS)


def seed_default_matrix() -> int:
    conn = db()
    if conn.execute("SELECT 1 FROM kv_store WHERE key='dsh-demo-matrix-v1'").fetchone():
        return 0
    return project_state(conn, 'dsh-demo-matrix-v1', DEFAULT_MATRIX, now_iso())


def perms_of(role: str) -> dict:
    rows = db().execute('SELECT perm_kind, perm FROM role_permissions WHERE role=?', (role,)).fetchall()
    out = {'view': [], 'manage': [], 'cls': []}
    for r in rows:
        out.setdefault(r['perm_kind'], []).append(r['perm'])
    return out


def has_perm(user, perm: str, kind: str = 'manage') -> bool:
    if not user:
        return False
    return perm in perms_of(user['role']).get(kind, [])


def _cookie_token(handler) -> str:
    c = SimpleCookie()
    try:
        c.load(handler.headers.get('Cookie') or '')
    except Exception:
        return ''
    m = c.get(SESSION_COOKIE)
    return m.value if m else ''


def session_user(handler):
    """校验会话 Cookie：过期即删、被撤即拒、账号停用即拒。返回用户行 dict 或 None。"""
    token = _cookie_token(handler)
    if not token or not re.fullmatch(r'[0-9A-Za-z_\-]{8,64}', token):
        return None
    conn = db()
    row = conn.execute('SELECT * FROM sessions WHERE token=?', (token,)).fetchone()
    if not row or row['revoked']:
        return None
    if time.time() > row['expires_at']:
        conn.execute('DELETE FROM sessions WHERE token=?', (token,))
        return None
    user = conn.execute('SELECT * FROM users WHERE id=?', (row['user_id'],)).fetchone()
    if not user or user['status'] != 'active':
        return None
    last = row['last_seen'] or ''
    try:
        stale = time.time() - datetime.strptime(last, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp() > 60
    except Exception:
        stale = True
    if stale:   # 滑动续期，最多每分钟写一次库
        conn.execute('UPDATE sessions SET expires_at=?, last_seen=? WHERE token=?',
                     (time.time() + SESSION_TTL, now_iso(), token))
    handler.csrf = row['csrf'] or ''
    handler.session_ref = row['ref'] or ''
    return dict(user)


def public_user(u) -> dict:
    return {'id': u['id'], 'username': u['username'], 'name': u['name'], 'role': u['role'],
            'dept': u['dept'], 'org': u['org'], 'domain': u['domain'], 'note': u['note'],
            'provider': u['provider'] if 'provider' in u.keys() else 'local',
            'enabled': bool(u['enabled']) if 'enabled' in u.keys() else True,
            'must_change': bool(u['must_change'])}


# --------------------------------------------------------------------------- v3.1 身份源适配器 / 口令策略 / CSRF
# 口径：试运行用内建账号独立运行（auth-provider=local）；成熟后按「影子同步 → 双写核对 → 切主源」
# 转移到客户方统一身份认证。外部协议未定也能先开工：provider 走同一套接口，未配置即明确拒绝。
PASSWORD_MIN_LEN = 8
PASSWORD_MAX_AGE_DAYS = 90          # 口令有效期，超期即强制改
PASSWORD_REUSE_CHECK = 3            # 不许复用最近 N 次口令
WEAK_PASSWORDS = {'admin123', 'ops123', 'dev123', 'user123', '12345678', '87654321',
                  'password', 'passw0rd', 'abcd1234', 'abc12345', 'a1234567', '00000000'}
CSRF_COOKIE = 'dsh_csrf'

PROVIDERS = {
    'local': {'label': '平台内建账号（默认 · 试运行独立运行）', 'ready': True, 'note': '账号与口令存 users 表'},
    'cas': {'label': 'CAS 单点登录（适配器占位）', 'ready': False, 'note': '待客户方给协议版本与服务地址'},
    'oauth2': {'label': 'OAuth2 / OIDC（适配器占位）', 'ready': False, 'note': '待客户方给签发方与字段映射'},
    'ldap': {'label': 'LDAP 目录（适配器占位）', 'ready': False, 'note': '待客户方给目录基 DN 与字段映射'},
}

CONFIG_DEFAULTS = {
    'auth-provider': 'local',
    'approval-source': 'local',
    'notify-channels': 'site',
    'duty-source': 'local',
    'command-ack-timeout-min': '30',
}
CONFIG_CHOICES = {
    'auth-provider': list(PROVIDERS.keys()),
    'approval-source': ['local', 'external'],
    'notify-channels': ['site', 'site,email', 'site,email,sms,im'],
    'duty-source': ['local', 'external'],
}
CONFIG_LABEL_CN = {'auth-provider': '身份来源', 'approval-source': '审批来源', 'notify-channels': '通知渠道',
                   'duty-source': '排班来源', 'command-ack-timeout-min': '指令确认超时（分钟）'}

DUTY_DEFAULT = [
    ('D-01', '算力资源值班', '当班 · 陈××（网运）', '内线 8021', '值班长 · 刘××', '算力池与卡位异常'),
    ('D-02', '网络与接入值班', '当班 · 示例××（网运）', '内线 8035', '值班长 · 刘××', '旁路接入与通道'),
    ('D-03', '应用与智能体值班', '当班 · 李××（应用）', '内线 8048', '值班长 · 刘××', '智能体与知识库'),
    ('D-04', '安全值班', '当班 · 赵××（安全）', '内线 8060', '值班长 · 刘××', '例外与配额越界'),
    ('D-05', '值班长', '刘××', '内线 8000', '信息化管理部值班领导', '超时升级与决策'),
]
DUTY_ROUTES_DEFAULT = [
    ('旁路接入', '网络与接入值班', '值班长'), ('旁路调用', '应用与智能体值班', '值班长'),
    ('接管缺口', '算力资源值班', '值班长'), ('资源异常', '算力资源值班', '值班长'),
    ('配额越界', '安全值班', '值班长'),
]


def ensure_columns(conn, table: str, cols) -> None:
    """老库补新列：演示库允许原地升级，不要求删库重建。"""
    have = {r['name'] for r in conn.execute('PRAGMA table_info(%s)' % table)}
    for name, ddl in cols:
        if name not in have:
            conn.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, name, ddl))


NEW_PERM_KEYS = ('security_issue', 'security_emergency')


def migrate_matrix() -> int:
    """旧库补新权限点：只往已有矩阵里加「处置下发 / 紧急处置」，不动用户手动改过的其它勾。"""
    conn = db()
    row = conn.execute("SELECT payload FROM kv_store WHERE key='dsh-demo-matrix-v1'").fetchone()
    if not row:
        return 0
    try:
        data = json.loads(row['payload'])
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    changed = False
    for role, block in DEFAULT_MATRIX.items():
        cur = data.get(role)
        if not isinstance(cur, dict):
            continue
        for kind in ('view', 'manage'):
            have = list(cur.get(kind) or [])
            add = [p for p in (block.get(kind) or []) if p in NEW_PERM_KEYS and p not in have]
            if add:
                cur[kind] = have + add
                changed = True
        data[role] = cur
    if not changed:
        return 0
    project_state(conn, 'dsh-demo-matrix-v1', data, now_iso())
    audit(conn, 'system', 'matrix_migrate', 'dsh-demo-matrix-v1',
          '补入新权限点：' + ' / '.join(PERM_LABEL_CN[k] for k in NEW_PERM_KEYS))
    return 1


def upgrade_schema(conn) -> None:
    ensure_columns(conn, 'users', [('enabled', "INTEGER NOT NULL DEFAULT 1"),
                                   ('provider', "TEXT NOT NULL DEFAULT 'local'"),
                                   ('pw_changed_at', 'TEXT')])
    ensure_columns(conn, 'sessions', [('ref', 'TEXT'), ('csrf', 'TEXT')])


def cfg(key: str, default: str = '') -> str:
    row = db().execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return row['value'] if row else (CONFIG_DEFAULTS.get(key, default))


def set_cfg(conn, key: str, value: str, actor: str) -> str:
    value = str(value).strip()[:120]
    choices = CONFIG_CHOICES.get(key)
    if choices and value not in choices:
        return '取值只能是 %s' % ' / '.join(choices)
    if key == 'command-ack-timeout-min':
        try:
            n = int(value)
        except Exception:
            return '必须是分钟数（整数）'
        value = str(max(1, min(1440, n)))
    conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) '
                 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                 (key, value, now_iso()))
    audit(conn, actor, 'config_put', key, value)
    return ''


def seed_config() -> int:
    conn = db()
    n = 0
    for k, v in CONFIG_DEFAULTS.items():
        if not conn.execute('SELECT 1 FROM settings WHERE key=?', (k,)).fetchone():
            conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)', (k, v, now_iso()))
            n += 1
    return n


def seed_duty() -> int:
    conn = db()
    if conn.execute('SELECT COUNT(*) c FROM duty_shifts').fetchone()['c']:
        return 0
    ts = now_iso()
    for d in DUTY_DEFAULT:
        conn.execute('INSERT INTO duty_shifts(id, role, name, phone, lead, scope, enabled, updated_at)'
                     ' VALUES(?,?,?,?,?,?,1,?)', d + (ts,))
    for k, role, esc in DUTY_ROUTES_DEFAULT:
        conn.execute('INSERT INTO duty_routes(kind, duty_role, escalate_role, updated_at) VALUES(?,?,?,?)',
                     (k, role, esc, ts))
    return len(DUTY_DEFAULT)


def password_policy_error(username: str, pw: str, user_id: str) -> str:
    if len(pw) < PASSWORD_MIN_LEN:
        return '口令至少 %d 位' % PASSWORD_MIN_LEN
    if len(pw) > 200:
        return '口令过长（最多 200 位）'
    if not re.search(r'[A-Za-z]', pw) or not re.search(r'[0-9]', pw):
        return '口令要同时包含字母和数字'
    low = pw.lower()
    if low in WEAK_PASSWORDS:
        return '口令过于简单（常见弱口令）'
    if username and low == username.lower():
        return '口令不能与账号相同'
    conn = db()
    rows = conn.execute('SELECT pw_salt, pw_hash FROM users WHERE id=?', (user_id,)).fetchall()
    rows += conn.execute('SELECT pw_salt, pw_hash FROM password_history WHERE user_id=? ORDER BY id DESC LIMIT ?',
                         (user_id, PASSWORD_REUSE_CHECK)).fetchall()
    for r in rows:
        if hmac.compare_digest(hash_password(pw, r['pw_salt']), r['pw_hash']):
            return '不能复用当前口令或最近 %d 次用过的口令' % PASSWORD_REUSE_CHECK
    return ''


def change_password(conn, user_id: str, old_pw: str, new_pw: str, actor: str) -> tuple:
    u = conn.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
    if not u:
        return False, '账号不存在'
    if old_pw and not hmac.compare_digest(hash_password(old_pw, u['pw_salt']), u['pw_hash']):
        conn.execute('INSERT INTO login_log(at, username, ok, reason, ip) VALUES(?,?,?,?,?)',
                     (now_iso(), u['username'], 0, '改口令时旧口令不正确', ''))
        return False, '旧口令不正确'
    err = password_policy_error(u['username'], new_pw, u['id'])
    if err:
        return False, err
    salt = secrets.token_hex(16)
    ts = now_iso()
    conn.execute('INSERT INTO password_history(user_id, pw_salt, pw_hash, created_at) VALUES(?,?,?,?)',
                 (u['id'], u['pw_salt'], u['pw_hash'], ts))
    conn.execute('UPDATE users SET pw_salt=?, pw_hash=?, must_change=0, pw_changed_at=?, updated_at=? WHERE id=?',
                 (salt, hash_password(new_pw, salt), ts, ts, u['id']))
    audit(conn, actor, 'password_change', u['id'], '口令已更换，有效期 %d 天' % PASSWORD_MAX_AGE_DAYS)
    return True, ''


def pw_expired(u) -> bool:
    ts = (u['pw_changed_at'] if 'pw_changed_at' in u.keys() else '') or u['created_at'] or ''
    try:
        seen = datetime.strptime(ts, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return True
    return time.time() - seen > PASSWORD_MAX_AGE_DAYS * 86400


def sweep_commands(conn, actor: str = 'system') -> int:
    """已下发但设备超时未确认 → 标「待人工兜底」并生成兜底工单（口径：我方先接住）。"""
    try:
        mins = int(cfg('command-ack-timeout-min', '30'))
    except Exception:
        mins = 30
    cutoff = datetime.fromtimestamp(time.time() - mins * 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    rows = conn.execute("SELECT id, target_class, target, action FROM commands "
                        "WHERE status='已下发' AND issued_at IS NOT NULL AND issued_at < ?", (cutoff,)).fetchall()
    ts = now_iso()
    for r in rows:
        conn.execute("UPDATE commands SET status='待人工兜底', updated_at=?, fail_reason=? WHERE id=?",
                     (ts, '设备未在 %d 分钟内确认' % mins, r['id']))
        conn.execute('INSERT INTO fallback_tasks(id, kind, ref, title, detail, status, owner, created_at, updated_at)'
                     ' VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
                     ('FB-%s' % r['id'], 'command_timeout', r['id'],
                      '处置指令超时未确认，需人工接管：%s / %s' % (r['target_class'], r['action']),
                      '原指令 %s，目标 %s；可用反向指令回滚' % (r['id'], r['target'] or ''),
                      '待接管', '', ts, ts))
        conn.execute('INSERT INTO events(time, level, text, source, created_at) '
                     'SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE time=? AND text=? AND source=?)',
                     (ts, '严重', '处置指令 %s 超时未获设备确认，已转人工兜底（兜底工单 FB-%s）' % (r['id'], r['id']),
                      'command', ts, ts, '处置指令 %s 超时未获设备确认，已转人工兜底（兜底工单 FB-%s）' % (r['id'], r['id']), 'command'))
        audit(conn, actor, 'command_timeout', r['id'], '超过 %d 分钟未确认' % mins)
    return len(rows)


def public_config() -> dict:
    out = {k: cfg(k) for k in CONFIG_DEFAULTS}
    p = PROVIDERS.get(out['auth-provider'], {})
    out['auth_provider_label'] = p.get('label', '')
    out['auth_provider_ready'] = p.get('ready', False)
    out['auth_provider_note'] = p.get('note', '')
    return out


def sweep_approvals(conn, actor: str = 'system') -> int:
    """外部审批超时未回写 → 工单标「超时」并生成人工兜底（口径：我方先接住）。"""
    now = now_iso()
    rows = conn.execute("SELECT order_id, source, external_ref, due_at FROM approvals"
                        " WHERE state='待审' AND due_at IS NOT NULL AND due_at < ?", (now,)).fetchall()
    for r in rows:
        conn.execute("UPDATE approvals SET state='超时' WHERE order_id=? AND source=? AND IFNULL(external_ref,'')=?"
                     " AND state='待审'", (r['order_id'], r['source'], r['external_ref'] or ''))
        fid = 'FB-AP-%s' % r['order_id']
        conn.execute('INSERT INTO fallback_tasks(id, kind, ref, title, detail, status, owner, created_at, updated_at)'
                     ' VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
                     (fid, 'approval_overdue', r['order_id'],
                      '审批超时未回写，需人工跟进：工单 %s（来源 %s）' % (r['order_id'], r['source']),
                      '期望回写时间 %s；可在工单详情里点「平台内人工审批」接管' % (r['due_at'] or ''),
                      '待接管', '', now, now))
        audit(conn, actor, 'approval_overdue', r['order_id'], '来源 %s 未在 %s 前回写' % (r['source'], r['due_at']))
    return len(rows)


def impact_of(conn, target_class: str, target: str, action: str) -> dict:
    """下发前预检：影响面清单由平台台账推导（不是设备侧真实数据，界面须标注）。"""
    like = '%' + (target or '').strip()[:60] + '%'
    out = {'target_class': target_class, 'target': target, 'action': action, 'derived_from': '平台台账推导'}
    affected = []
    for kind in ('cred', 'model', 'managed', 'pool', 'channel'):
        rows = conn.execute('SELECT id, name FROM entities WHERE kind=? AND (id LIKE ? OR name LIKE ?) LIMIT 40',
                            (kind, like, like if target else '%')).fetchall()
        for r in rows:
            affected.append({'kind': kind, 'id': r['id'], 'name': r['name'] or ''})
    online = conn.execute("SELECT COUNT(*) c FROM duty_shifts WHERE enabled=1").fetchone()['c']
    device_ready = conn.execute('SELECT COUNT(*) c FROM entities WHERE kind=?', ('connector',)).fetchone()['c']
    out['affected'] = affected[:40]
    out['affected_count'] = len(affected)
    out['precheck'] = {
        '目标台账是否存在': bool(affected) or not target,
        '在线值班可接手': online > 0,
        '该类设备控制接口已接': device_ready > 0 and target_class != '未接设备',
        '回滚入口': '反向指令模板可用',
    }
    return out


# --------------------------------------------------------------------------- 投影
ID_FIELDS = ('id', 'key', 'orderId', 'credId', 'name')
CORE_ARRAYS = {
    'creds': 'cred', 'channels': 'channel', 'managed': 'managed', 'models': 'model',
    'pools': 'pool', 'jobs': 'train_job', 'windowSlots': 'window_slot', 'history': 'util_sample',
    'connectors': 'connector', 'probes': 'probe', 'prereqDone': 'prereq',
    'templates': 'template', 'policies': 'policy', 'changes': 'policy_change',
    'reports': 'report', 'rules': 'alert_rule', 'versions': 'policy_version',
    'steps': 'guard_step', 'runs': 'guard_run', 'logs': 'rect_log', 'roster': 'duty_role',
    'instances': 'instance', 'containerRows': 'container_row', 'metrics': 'model_metric',
    'options': 'exc_option', 'sources': 'exc_source', 'affectedApps': 'affected_app',
}


def _id_of(item, fallback: str) -> str:
    if isinstance(item, dict):
        for f in ID_FIELDS:
            v = item.get(f)
            if isinstance(v, (str, int)) and str(v).strip():
                return str(v)[:120]
    if isinstance(item, (str, int)):
        return str(item)[:120]
    return fallback


def project_state(conn, key: str, payload, updated_at: str) -> int:
    """把一份状态快照投影到关系表，返回投影出的实体行数。"""
    rows = 0
    conn.execute('INSERT INTO kv_store(key, payload, updated_at) VALUES(?, ?, ?) '
                 'ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
                 (key, json.dumps(payload, ensure_ascii=False), updated_at))

    if isinstance(payload, list) and key != 'dsh-demo-notif-v1':
        return _project_list(conn, _kind_of_key(key), payload, updated_at)

    if key == 'dsh-demo-engine-v4' and isinstance(payload, dict):
        _project_engine(conn, payload, updated_at)
        rows += _project_arrays(conn, payload, updated_at)

    elif key == 'dsh-demo-matrix-v1' and isinstance(payload, dict):
        conn.execute('DELETE FROM role_permissions')
        for role, row in payload.items():
            if not isinstance(row, dict):
                continue
            for kind in ('view', 'manage', 'cls'):
                for perm in row.get(kind) or []:
                    conn.execute('INSERT INTO role_permissions(role, perm_kind, perm, updated_at) VALUES(?, ?, ?, ?) '
                                 'ON CONFLICT(role, perm_kind, perm) DO UPDATE SET updated_at=excluded.updated_at',
                                 (str(role)[:40], kind, str(perm)[:40], updated_at))
                    rows += 1
        conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) '
                     'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                     ('permission_matrix', json.dumps(payload, ensure_ascii=False), updated_at))

    elif key == 'dsh-demo-notif-v1' and isinstance(payload, list):
        conn.execute('DELETE FROM notifications')
        for i, n in enumerate(payload):
            if not isinstance(n, dict):
                continue
            conn.execute('INSERT INTO notifications(id, time, level, title, body, channels, read_flag, handled, source, updated_at) '
                         'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, read_flag=excluded.read_flag',
                         (str(n.get('id') or 'N-%03d' % i)[:60], str(n.get('time') or ''), str(n.get('level') or ''),
                          str(n.get('title') or '')[:200], str(n.get('text') or '')[:1000],
                          json.dumps(n.get('channels') or [], ensure_ascii=False),
                          1 if n.get('read') else 0, 1 if n.get('handled') else 0,
                          str(n.get('source') or '')[:120], updated_at))
            rows += 1

    elif key == 'dsh-demo-accounts-v1' and isinstance(payload, list):
        conn.execute('DELETE FROM accounts')
        for a in payload:
            if not isinstance(a, dict) or not a.get('id'):
                continue
            conn.execute('INSERT INTO accounts(id, name, role, dept, org, domain, note) VALUES(?, ?, ?, ?, ?, ?, ?) '
                         'ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, dept=excluded.dept, '
                         'org=excluded.org, domain=excluded.domain, note=excluded.note',
                         (str(a['id'])[:40], str(a.get('name') or '')[:80], str(a.get('role') or '')[:40],
                          str(a.get('dept') or '')[:120], str(a.get('org') or '')[:120],
                          str(a.get('domain') or '')[:40], str(a.get('note') or '')[:300]))
            rows += 1

    elif key == 'dsh-demo-session-v1':
        conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) '
                     'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                     ('session', json.dumps(payload, ensure_ascii=False), updated_at))

    elif key in ('dsh-demo-monitor-v1', 'dsh-demo-duty-v1', 'dsh-demo-guard-v1',
                 'dsh-demo-inference-v1', 'dsh-demo-route-v1', 'dsh-demo-alert-baseline-v1',
                 'dsh-demo-allocation-v1'):
        conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) '
                     'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                     (key, json.dumps(payload, ensure_ascii=False), updated_at))
        rows += _project_arrays(conn, payload, updated_at)

    else:
        rows += _project_arrays(conn, payload, updated_at)

    return rows


def _kind_of_key(key: str) -> str:
    base = re.sub(r'^dsh-demo-', '', key)
    base = re.sub(r'-v\d+$', '', base)
    return base or key


def _project_list(conn, kind: str, items: list, updated_at: str) -> int:
    """整个快照就是一个数组的存储（connectors / govern / templates / policies / rectify …）。"""
    rows = 0
    seen = set()
    for i, item in enumerate(items):
        eid = _id_of(item, 'row-%03d' % i)
        if eid in seen:
            continue
        seen.add(eid)
        label = ''
        if isinstance(item, dict):
            label = str(item.get('name') or item.get('title') or item.get('target') or '')[:160]
        elif isinstance(item, str):
            label = item[:160]
        conn.execute('INSERT INTO entities(kind, id, name, payload, updated_at) VALUES(?, ?, ?, ?, ?) '
                     'ON CONFLICT(kind, id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at',
                     (kind[:60], eid, label, json.dumps(item, ensure_ascii=False), updated_at))
        rows += 1
    if seen:
        conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) '
                     'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                     ('array_count:' + kind, str(len(seen)), updated_at))
    return rows


def _project_arrays(conn, payload, updated_at: str) -> int:
    """通用投影：快照里的每个数组（元素带 id/name）落成 entities 行。"""
    if isinstance(payload, list):
        return 0
    if not isinstance(payload, dict):
        return 0
    rows = 0
    for name, value in payload.items():
        if name in ('events', 'orders', 'trace'):
            continue
        if not isinstance(value, list):
            continue
        kind = CORE_ARRAYS.get(name, name)
        seen = set()
        for i, item in enumerate(value):
            eid = _id_of(item, 'row-%03d' % i)
            if eid in seen:
                continue
            seen.add(eid)
            label = ''
            if isinstance(item, dict):
                label = str(item.get('name') or item.get('title') or item.get('target') or '')[:160]
            elif isinstance(item, str):
                label = item[:160]
            conn.execute('INSERT INTO entities(kind, id, name, payload, updated_at) VALUES(?, ?, ?, ?, ?) '
                         'ON CONFLICT(kind, id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at',
                         (kind[:60], eid, label, json.dumps(item, ensure_ascii=False), updated_at))
            rows += 1
        if seen:
            conn.execute('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) '
                         'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                         ('array_count:' + kind, str(len(seen)), updated_at))
    return rows


def _project_engine(conn, state: dict, updated_at: str) -> None:
    orders = state.get('orders') or []
    ids = set()
    for o in orders:
        if not isinstance(o, dict) or not o.get('id'):
            continue
        oid = str(o['id'])[:40]
        ids.add(oid)
        conn.execute(
            'INSERT INTO orders(id, type, title, applicant, dept, level, target, amount, reason, status, auto, '
            'created_at, decided_at, executed_at, decided_by, reject_reason, spec, updated_at) '
            'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
            'ON CONFLICT(id) DO UPDATE SET status=excluded.status, decided_at=excluded.decided_at, '
            'executed_at=excluded.executed_at, decided_by=excluded.decided_by, reject_reason=excluded.reject_reason, '
            'spec=excluded.spec, updated_at=excluded.updated_at',
            (oid, str(o.get('type') or ''), str(o.get('title') or '')[:200], str(o.get('applicant') or '')[:120],
             str(o.get('dept') or '')[:120], str(o.get('level') or ''), str(o.get('target') or '')[:200],
             str(o.get('amount') or '')[:120], str(o.get('reason') or '')[:500], str(o.get('status') or ''),
             1 if o.get('auto') else 0, o.get('createdAt'), o.get('decidedAt'), o.get('executedAt'),
             str(o.get('decidedBy') or '')[:120], str(o.get('rejectReason') or '')[:500],
             json.dumps(o.get('spec') or {}, ensure_ascii=False), updated_at))
        for seq, tr in enumerate(o.get('trace') or []):
            if not isinstance(tr, dict):
                continue
            conn.execute('INSERT INTO order_trace(order_id, seq, time, actor, action, note) VALUES(?, ?, ?, ?, ?, ?) '
                         'ON CONFLICT(order_id, seq) DO UPDATE SET time=excluded.time, actor=excluded.actor, '
                         'action=excluded.action, note=excluded.note',
                         (oid, seq, str(tr.get('time') or ''), str(tr.get('actor') or '')[:120],
                          str(tr.get('action') or '')[:120], str(tr.get('note') or tr.get('text') or '')[:500]))
    for oid in {r['id'] for r in conn.execute('SELECT id FROM orders')} - ids:
        conn.execute('DELETE FROM orders WHERE id=?', (oid,))
        conn.execute('DELETE FROM order_trace WHERE order_id=?', (oid,))

    events = state.get('events') or []
    # 长期留存：快照里只保留最近 80 条，库里按 (时间, 内容) 去重追加，历史不被快照覆盖掉
    for e in events[-500:]:
        if not isinstance(e, dict):
            continue
        t = str(e.get('time') or ''); txt = str(e.get('text') or '')[:1000]
        conn.execute('INSERT INTO events(time, level, text, source, created_at) '
                     'SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE time=? AND text=? AND source=?)',
                     (t, str(e.get('level') or ''), txt, 'engine', updated_at, t, txt, 'engine'))


def clear_all(conn) -> None:
    for t in ('kv_store', 'settings', 'entities', 'orders', 'order_trace', 'events',
              'notifications', 'accounts', 'role_permissions', 'audit_log',
              'identity_links', 'approvals', 'duty_shifts', 'duty_routes', 'commands', 'fallback_tasks'):
        conn.execute('DELETE FROM %s' % t)
    conn.execute("DELETE FROM sqlite_sequence")


# --------------------------------------------------------------------------- 查询
def counts() -> dict:
    conn = db()
    out = {}
    for t in ('kv_store', 'entities', 'orders', 'order_trace', 'events', 'notifications', 'role_permissions',
              'audit_log', 'identity_links', 'approvals', 'commands', 'fallback_tasks'):
        out[t] = conn.execute('SELECT COUNT(*) c FROM %s' % t).fetchone()['c']
    return out


TABLE_OF = {'orders': 'orders', 'events': 'events', 'audit': 'audit_log', 'notifications': 'notifications',
            'accounts': 'accounts', 'entities': 'entities', 'permissions': 'role_permissions', 'settings': 'settings',
            'approvals': 'approvals', 'commands': 'commands', 'fallback': 'fallback_tasks',
            'links': 'identity_links', 'duty': 'duty_shifts', 'duty_routes': 'duty_routes'}
CSV_COLUMNS = {
    'orders': ['id', 'type', 'title', 'applicant', 'dept', 'level', 'status', 'target', 'amount', 'reason',
               'decided_by', 'reject_reason', 'created_at', 'updated_at'],
    'events': ['id', 'time', 'level', 'text', 'source'],
    'audit_log': ['id', 'at', 'actor', 'action', 'target', 'detail'],
    'notifications': ['id', 'time', 'level', 'title', 'body', 'channels', 'read_flag', 'handled', 'source'],
    'entities': ['kind', 'id', 'name', 'updated_at'],
    'role_permissions': ['role', 'perm_kind', 'perm', 'updated_at'],
    'settings': ['key', 'value', 'updated_at'],
    'accounts': ['id', 'name', 'role', 'dept', 'org', 'domain', 'note'],
    'approvals': ['id', 'order_id', 'source', 'external_ref', 'state', 'decision', 'note', 'actor', 'due_at', 'at', 'decided_at'],
    'commands': ['id', 'target_class', 'target', 'action', 'dry_run', 'status', 'emergency', 'issued_by',
                 'issued_at', 'ack_at', 'ack_by', 'fail_reason', 'rollback_of', 'created_at'],
    'fallback_tasks': ['id', 'kind', 'ref', 'title', 'status', 'owner', 'created_at', 'updated_at'],
    'identity_links': ['provider', 'external_id', 'user_id', 'name', 'role', 'matched', 'source', 'last_seen'],
    'duty_shifts': ['id', 'role', 'name', 'phone', 'lead', 'scope', 'enabled', 'updated_at'],
    'duty_routes': ['kind', 'duty_role', 'escalate_role', 'updated_at'],
}


def _flt(where, params, col, value, maxlen=120):
    value = (value or '').strip()
    if value:
        where.append('%s=?' % col)
        params.append(value[:maxlen])


def _bit(where, params, col, value):
    v = (value or '').strip().lower()
    if v in ('1', 'true', 'yes', '是'):
        where.append('%s=1' % col)
    elif v in ('0', 'false', 'no', '否'):
        where.append('%s=0' % col)


def _like(where, params, cols, q):
    q = (q or '').strip()
    if q:
        where.append('(' + ' OR '.join('%s LIKE ?' % c for c in cols) + ')')
        params.extend(['%' + q[:60] + '%'] * len(cols))


def _since(where, params, col, since):
    since = (since or '').strip()
    if since:
        where.append('%s >= ?' % col)
        params.append(since[:40])


def _csv_cell(v) -> str:
    if v is None:
        return ''
    if isinstance(v, bool):
        return '1' if v else '0'
    t = str(v)
    if any(c in t for c in ',"\r\n'):
        return '"' + t.replace('"', '""') + '"'
    return t


def _query_plan(key: str, qs):
    """把查询接口与 CSV 导出共用一套过滤条件。key=csv 时用 resource 指定资源。"""
    name = (qs.get('resource') or [''])[0] if key == 'csv' else key
    table = TABLE_OF.get(name)
    if not table:
        return None
    def g(n, maxlen=120):
        return (qs.get(n) or [''])[0]
    where, params = [], []
    if table == 'orders':
        _flt(where, params, 'status', g('status', 40)); _flt(where, params, 'type', g('type', 40))
        _flt(where, params, 'applicant', g('applicant'))
        _like(where, params, ['title', 'target', 'reason', 'amount'], g('q'))
        order = 'ORDER BY created_at DESC'
    elif table == 'events':
        _flt(where, params, 'level', g('level', 20)); _like(where, params, ['text'], g('q'))
        _since(where, params, 'time', g('since', 40))
        order = 'ORDER BY id DESC'
    elif table == 'audit_log':
        _flt(where, params, 'action', g('action', 40)); _flt(where, params, 'actor', g('actor', 60))
        _since(where, params, 'at', g('since', 40))
        order = 'ORDER BY id DESC'
    elif table == 'notifications':
        _flt(where, params, 'level', g('level', 20)); _like(where, params, ['title', 'body', 'source'], g('q'))
        order = 'ORDER BY time DESC'
    elif table == 'entities':
        _flt(where, params, 'kind', g('kind', 60)); _like(where, params, ['name', 'id'], g('q'))
        order = 'ORDER BY kind, id'
    elif table == 'role_permissions':
        _flt(where, params, 'role', g('role', 40))
        order = 'ORDER BY role, perm_kind, perm'
    elif table == 'settings':
        _like(where, params, ['key'], g('q'))
        order = 'ORDER BY key'
    elif table == 'approvals':
        _flt(where, params, 'order_id', g('order', 40)); _flt(where, params, 'source', g('source', 20))
        _flt(where, params, 'state', g('state', 20)); _like(where, params, ['external_ref', 'note'], g('q'))
        order = 'ORDER BY at DESC'
    elif table == 'commands':
        _flt(where, params, 'status', g('status', 30)); _flt(where, params, 'target_class', g('target_class', 40))
        _bit(where, params, 'dry_run', g('dry_run')); _like(where, params, ['target', 'action', 'id'], g('q'))
        order = 'ORDER BY created_at DESC'
    elif table == 'fallback_tasks':
        _flt(where, params, 'status', g('status', 20)); _flt(where, params, 'kind', g('kind', 30))
        _like(where, params, ['title', 'ref'], g('q'))
        order = 'ORDER BY created_at DESC'
    elif table == 'identity_links':
        _flt(where, params, 'provider', g('provider', 20)); _bit(where, params, 'matched', g('matched'))
        _like(where, params, ['external_id', 'name'], g('q'))
        order = 'ORDER BY provider, external_id'
    elif table == 'duty_shifts':
        _bit(where, params, 'enabled', g('enabled')); _like(where, params, ['role', 'name', 'scope'], g('q'))
        order = 'ORDER BY id'
    elif table == 'duty_routes':
        _like(where, params, ['kind', 'duty_role'], g('q'))
        order = 'ORDER BY kind'
    else:
        order = 'ORDER BY id'
    return table, where, params, order


def query_rows(sql: str, params, limit: int, offset: int):
    conn = db()
    cur = conn.execute(sql + ' LIMIT ? OFFSET ?', tuple(params) + (limit, offset))
    return [dict(r) for r in cur.fetchall()]


# --------------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = 'AIopsDemo/' + SERVER_VERSION

    def log_message(self, fmt, *args):  # 精简访问日志
        sys.stdout.write('[%s] %s\n' % (datetime.now().strftime('%H:%M:%S'), fmt % args))

    # ---- 基础
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for cookie in getattr(self, '_set_cookies', []) or ([getattr(self, '_set_cookie', '')] if getattr(self, '_set_cookie', '') else []):
            if cookie:
                self.send_header('Set-Cookie', cookie)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), CONTENT_TYPES['.json'])

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            return None, '请求体超过 %d 字节上限' % MAX_BODY
        raw = self.rfile.read(n) if n else b''
        if not raw:
            return None, '请求体为空'
        try:
            return json.loads(raw.decode('utf-8')), None
        except Exception as e:
            return None, '请求体不是合法 JSON：%s' % e

    # ---- 路由
    CSRF_EXEMPT = {'login', 'logout'}
    MUST_CHANGE_EXEMPT = {'login', 'logout', 'password/change'}

    def _need(self, perm: str, kind: str = 'manage', action: str = 'denied_post') -> bool:
        """统一的服务端权限判定：判定失败即 403 并留审计，前端怎么改都没用。"""
        if has_perm(self.user, perm, kind):
            return True
        audit(db(), actor_of(self), action, perm, '角色 %s 缺少权限点 %s（%s）' % (self.user['role'], perm, kind))
        self._json(HTTPStatus.FORBIDDEN, {'ok': False,
            'error': '角色「%s」没有「%s」的%s权限（权限点 %s）'
            % (self.user['role'], PERM_LABEL_CN.get(perm, perm), '操作' if kind == 'manage' else '查看', perm)})
        return False

    def _guard(self, key: str) -> bool:
        """除登录 / 会话探测 / 健康检查外，所有 /api 都要带有效会话。
        写操作额外要求：① X-CSRF-Token 与服务端会话里存的一致；② 未改口令的账号只能改口令。"""
        self.user = session_user(self)
        if key in PUBLIC_API:
            return True
        if not self.user:
            self._json(HTTPStatus.UNAUTHORIZED, {'ok': False, 'error': '未登录或会话已过期，请重新登录'})
            return False
        if self.command in ('POST', 'PUT', 'DELETE'):
            if key not in self.CSRF_EXEMPT:
                got = self.headers.get('X-CSRF-Token') or ''
                want = getattr(self, 'csrf', '') or ''
                if not want or not hmac.compare_digest(got, want):
                    audit(db(), actor_of(self), 'denied_csrf', key, '缺少或错误的 X-CSRF-Token')
                    self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                        'error': '跨站请求伪造防护：请求缺少 X-CSRF-Token 或与会话不一致'})
                    return False
            if self.user['must_change'] and key not in self.MUST_CHANGE_EXEMPT:
                audit(db(), actor_of(self), 'denied_password_pending', key, '账号未改口令，禁止写操作')
                self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                    'error': '这个账号还没改口令（演示口令是弱口令），请先在「账号与安全」里更换口令'})
                return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX):
            if not self._guard(path[len(API_PREFIX):].strip('/')):
                return
            return self._api_get(path, parse_qs(urlparse(self.path).query))
        return self._static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
            if not self._guard(urlparse(self.path).path[len(API_PREFIX):].strip('/')):
                return
            return self._api_put(urlparse(self.path).path)
        self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})

    def do_POST(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
            if not self._guard(urlparse(self.path).path[len(API_PREFIX):].strip('/')):
                return
            return self._api_post(urlparse(self.path).path)
        self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})

    def do_DELETE(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
            if not self._guard(urlparse(self.path).path[len(API_PREFIX):].strip('/')):
                return
            return self._api_delete(urlparse(self.path).path)
        self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})

    # ---- 静态
    def _static(self, path: str) -> None:
        rel = (path or '/').lstrip('/')
        if rel.startswith(API_PREFIX):
            return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not target.startswith(os.path.abspath(STATIC_DIR)):
            return self._json(HTTPStatus.FORBIDDEN, {'ok': False, 'error': '路径越界'})
        if os.path.isdir(target):
            target = os.path.join(target, 'index.html')
        if not os.path.isfile(target):
            target = os.path.join(STATIC_DIR, 'index.html')   # HashRouter 单页
        if not os.path.isfile(target):
            return self._send(HTTPStatus.NOT_FOUND,
                              b'index.html not found: run "npm run build" first', CONTENT_TYPES['.txt'])
        ext = os.path.splitext(target)[1].lower()
        with open(target, 'rb') as f:
            self._send(HTTPStatus.OK, f.read(), CONTENT_TYPES.get(ext, 'application/octet-stream'))

    # ---- API
    def _api_get(self, path: str, qs) -> None:
        conn = db()
        key = path[len(API_PREFIX):].strip('/')

        def num(name, default, cap):
            try:
                return max(0, min(cap, int((qs.get(name) or [default])[0])))
            except Exception:
                return default

        if key in ('', 'health'):
            return self._json(HTTPStatus.OK, {
                'ok': True, 'service': 'ai-ops-console data service', 'version': SERVER_VERSION,
                'schema_version': SCHEMA_VERSION, 'db': os.path.relpath(DB_PATH, ROOT),
                'uptime_s': int(time.time() - _START_TS), 'counts': counts(),
            })
        if key == 'state':
            rows = conn.execute('SELECT key, payload, updated_at FROM kv_store ORDER BY key').fetchall()
            out = {}
            for r in rows:
                try:
                    out[r['key']] = json.loads(r['payload'])
                except Exception:
                    out[r['key']] = None
            return self._json(HTTPStatus.OK, {'ok': True, 'state': out,
                                             'updated_at': {r['key']: r['updated_at'] for r in rows}})
        if key.startswith('state/'):
            name = key[len('state/'):]
            row = conn.execute('SELECT payload, updated_at FROM kv_store WHERE key=?', (name,)).fetchone()
            if not row:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '该状态尚未写入数据库', 'key': name})
            return self._json(HTTPStatus.OK, {'ok': True, 'key': name, 'updated_at': row['updated_at'],
                                             'payload': json.loads(row['payload'])})
        if key == 'export':
            out = {}
            for r in conn.execute('SELECT key, payload, updated_at FROM kv_store ORDER BY key'):
                out[r['key']] = {'payload': json.loads(r['payload']), 'updated_at': r['updated_at']}
            return self._json(HTTPStatus.OK, {'ok': True, 'generated_at': now_iso(), 'kv': out})
        need = QUERY_PERM.get(key)
        if need and not has_perm(self.user, need, 'view'):
            return self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有「%s」的查看权限（权限点 %s）' % (self.user['role'], PERM_LABEL_CN.get(need, need), need)})
        if key == 'users':
            rows = [{k: v for k, v in dict(r).items() if k not in ('pw_salt', 'pw_hash', 'algo')}
                    for r in conn.execute('SELECT * FROM users ORDER BY id')]
            return self._json(HTTPStatus.OK, {'ok': True, 'rows': rows})
        if key == 'session':
            if not self.user:
                return self._json(HTTPStatus.OK, {'ok': True, 'signed_in': False})
            return self._json(HTTPStatus.OK, {'ok': True, 'signed_in': True, 'user': public_user(self.user),
                                             'perms': perms_of(self.user['role']),
                                             'csrf': getattr(self, 'csrf', '') or '',
                                             'session_ref': getattr(self, 'session_ref', '') or '',
                                             'session_idle_minutes': round(SESSION_TTL / 60),
                                             'config': public_config(),
                                             'password_policy': {'min_len': PASSWORD_MIN_LEN,
                                                                 'max_age_days': PASSWORD_MAX_AGE_DAYS,
                                                                 'reuse_check': PASSWORD_REUSE_CHECK}})
        if key == 'config':
            return self._json(HTTPStatus.OK, {'ok': True, 'config': public_config(),
                                             'providers': PROVIDERS,
                                             'labels': CONFIG_LABEL_CN,
                                             'perm_map': {k: v for k, v in KEY_PERM.items() if k in MATRIX_KEYS},
                                             'note': '口径：先内建独立运行，外部来源做成适配器 + 配置开关；'
                                                     '切换不改业务代码，未配置的来源会明确拒绝'})
        if key == 'sessions':
            mine_only = not has_perm(self.user, 'matrix', 'view')
            sql = ('SELECT s.ref, s.user_id, s.created_at, s.last_seen, s.expires_at, s.ip, s.revoked,'
                   ' u.username, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id ')
            params = []
            if mine_only:
                sql += 'WHERE s.user_id=? '
                params.append(self.user['id'])
            sql += 'ORDER BY s.created_at DESC'
            rows = []
            for r in query_rows(sql, params, 100, 0):
                rows.append({**dict(r), 'expired': time.time() > r['expires_at'],
                             'current': r['ref'] == getattr(self, 'session_ref', ''),
                             'expires_left_min': max(0, round((r['expires_at'] - time.time()) / 60))})
            return self._json(HTTPStatus.OK, {'ok': True, 'rows': rows, 'total': len(rows),
                                             'mine_only': mine_only, 'ttl_minutes': round(SESSION_TTL / 60)})
        if key == 'commands':
            sweep_commands(conn)
        elif key == 'approvals':
            sweep_approvals(conn)
        plan = _query_plan(key, qs)
        if plan:
            table, where, params, order = plan
            limit, offset = num('limit', 100, 500), num('offset', 0, 100000)
            where_sql = (' WHERE ' + ' AND '.join(where)) if where else ''
            if key == 'csv':
                need_csv = CSV_PERM.get(table)
                if need_csv and not (has_perm(self.user, need_csv, 'view') and has_perm(self.user, 'export')):
                    return self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                        'error': '角色「%s」没有导出「%s」的权限' % (self.user['role'], table)})
                cols = CSV_COLUMNS[table]
                rows = query_rows('SELECT %s FROM %s%s %s' % (','.join(cols), table, where_sql, order),
                                  params, num('limit', 5000, 20000), 0)
                lines = [','.join(cols)]
                for r in rows:
                    lines.append(','.join(_csv_cell(r.get(c)) for c in cols))
                body = ('\ufeff' + '\r\n'.join(lines) + '\r\n').encode('utf-8')
                fname = (qs.get('name') or [table])[0]
                fname = re.sub(r'[^0-9A-Za-z_\-]', '_', fname)[:40] or table
                self.send_response(HTTPStatus.OK)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.send_header('Content-Disposition', 'attachment; filename="%s.csv"' % fname)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            total = db().execute('SELECT COUNT(*) c FROM %s%s' % (table, where_sql), params).fetchone()['c']
            return self._json(HTTPStatus.OK, {'ok': True, 'limit': limit, 'offset': offset, 'total': total,
                                             'rows': query_rows('SELECT * FROM %s%s %s' % (table, where_sql, order), params, limit, offset)})
        if key == 'tables':
            out = []
            for t in ('kv_store', 'entities', 'orders', 'order_trace', 'events', 'notifications',
                      'accounts', 'role_permissions', 'settings', 'audit_log', 'users', 'sessions', 'login_log',
                      'identity_links', 'password_history', 'approvals', 'duty_shifts', 'duty_routes',
                      'commands', 'fallback_tasks'):
                c = db().execute('SELECT COUNT(*) c FROM %s' % t).fetchone()['c']
                col = 'updated_at' if db().execute("PRAGMA table_info(%s)" % t).fetchone() and any(
                    r['name'] == 'updated_at' for r in db().execute('PRAGMA table_info(%s)' % t)) else None
                last = db().execute('SELECT MAX(%s) m FROM %s' % (col, t)).fetchone()['m'] if col else ''
                out.append({'table': t, 'rows': c, 'last_change': last or ''})
            return self._json(HTTPStatus.OK, {'ok': True, 'tables': out})
        return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口', 'key': key})

    def _api_put(self, path: str) -> None:
        name = path[len(API_PREFIX):].strip('/')
        if name == 'config':
            if not self._need('matrix'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            k = str((payload or {}).get('key') or '')[:60]
            if k not in CONFIG_DEFAULTS:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False,
                    'error': '不能改这个配置项', 'allowed': list(CONFIG_DEFAULTS.keys())})
            msg = set_cfg(db(), k, str((payload or {}).get('value') or ''), actor_of(self))
            if msg:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': msg,
                    'allowed': CONFIG_CHOICES.get(k, [])})
            return self._json(HTTPStatus.OK, {'ok': True, 'key': k, 'config': public_config(),
                'note': '只改配置就切换来源：业务代码与 /api 契约不变，未配置好的外部来源会明确拒绝而不是静默降级'})
        if not name.startswith('state/'):
            return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        key = name[len('state/'):]
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key):
            return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '状态键名不合法'})
        if key == 'dsh-demo-session-v1':
            return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '会话由数据服务管理，前端不再写这个键'})
        need = KEY_PERM.get(key, 'overview')
        if not has_perm(self.user, need):
            audit(db(), actor_of(self), 'denied_put', key, '角色 %s 缺少权限点 %s' % (self.user['role'], need))
            return self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有「%s」的写入权限（权限点 %s）' % (self.user['role'], PERM_LABEL_CN.get(need, need), need)})
        payload, err = self._body()
        if err:
            return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
        conn = db()
        ts = now_iso()
        rows = project_state(conn, key, payload, ts)
        audit(conn, actor_of(self), 'state_put', key, '投影 %d 行，payload %d 字节' % (rows, len(json.dumps(payload, ensure_ascii=False))))
        return self._json(HTTPStatus.OK, {'ok': True, 'key': key, 'updated_at': ts, 'projected_rows': rows})

    def _api_delete(self, path: str) -> None:
        name = path[len(API_PREFIX):].strip('/')
        if not name.startswith('state/'):
            return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        key = name[len('state/'):]
        need = KEY_PERM.get(key, 'overview')
        if not has_perm(self.user, need):
            audit(db(), actor_of(self), 'denied_delete', key, '角色 %s 缺少权限点 %s' % (self.user['role'], need))
            return self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有删除「%s」的权限' % (self.user['role'], PERM_LABEL_CN.get(need, need))})
        conn = db()
        conn.execute('DELETE FROM kv_store WHERE key=?', (key,))
        conn.execute('DELETE FROM settings WHERE key=?', (key,))
        audit(conn, actor_of(self), 'state_delete', key, '')
        return self._json(HTTPStatus.OK, {'ok': True, 'key': key})

    def _api_post(self, path: str) -> None:
        key = path[len(API_PREFIX):].strip('/')
        conn = db()
        if key == 'login':
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            username = str((payload or {}).get('username') or '')[:40]
            password = str((payload or {}).get('password') or '')[:200]
            ip = self.client_address[0] if self.client_address else ''
            since = datetime.fromtimestamp(time.time() - LOGIN_FAIL_WINDOW, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            fails = conn.execute('SELECT COUNT(*) c FROM login_log WHERE username=? AND ok=0 AND at>=?',
                                 (username, since)).fetchone()['c']
            if fails >= LOGIN_FAIL_LIMIT:
                conn.execute('INSERT INTO login_log(at, username, ok, reason, ip) VALUES(?,?,?,?,?)',
                             (now_iso(), username, 0, '失败次数过多被暂时拒绝', ip))
                return self._json(HTTPStatus.TOO_MANY_REQUESTS, {'ok': False,
                    'error': '该账号 %d 分钟内失败 %d 次，已暂时拒绝登录，请稍后再试' % (LOGIN_FAIL_WINDOW // 60, fails)})
            u = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            if u is not None and 'enabled' in u.keys() and not u['enabled']:
                conn.execute('INSERT INTO login_log(at, username, ok, reason, ip) VALUES(?,?,?,?,?)',
                             (now_iso(), username, 0, '账号已停用', ip))
                return self._json(HTTPStatus.FORBIDDEN, {'ok': False, 'error': '这个账号已停用，请联系管理员开通'})
            ok = bool(u) and u['status'] == 'active' and hmac.compare_digest(
                hash_password(password, u['pw_salt']), u['pw_hash'])
            reason = '' if ok else ('账号不存在' if not u else '口令不正确')
            conn.execute('INSERT INTO login_log(at, username, ok, reason, ip) VALUES(?,?,?,?,?)',
                         (now_iso(), username, 1 if ok else 0, reason, ip))
            if not ok:
                return self._json(HTTPStatus.UNAUTHORIZED, {'ok': False, 'error': '账号或口令不正确',
                                                           'remaining': max(0, LOGIN_FAIL_LIMIT - fails - 1)})
            provider = cfg('auth-provider')
            if provider != 'local':
                # 口径：切到外部身份源后本地账号只留运维兜底；兜底账号由管理员逐个开
                note = '（本地兜底账号）' if conn.execute('SELECT 1 FROM identity_links WHERE user_id=?', (u['id'],)).fetchone() else ''
                audit(conn, u['id'], 'login_local_fallback', provider, '身份来源已切成 %s，本次用本地账号登录%s' % (provider, note))
            must_change = bool(u['must_change']) or pw_expired(u)
            why = '首次登录必须改口令' if u['must_change'] else ('口令已超过 %d 天未更换' % PASSWORD_MAX_AGE_DAYS)
            if must_change and not u['must_change']:
                conn.execute('UPDATE users SET must_change=1 WHERE id=?', (u['id'],))
            conn.execute('DELETE FROM sessions WHERE expires_at < ?', (time.time(),))
            token = secrets.token_urlsafe(32)
            ref = secrets.token_urlsafe(6)
            csrf = secrets.token_urlsafe(24)
            conn.execute('INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen, ip, ref, csrf)'
                         ' VALUES(?,?,?,?,?,?,?,?)', (token, u['id'], now_iso(), time.time() + SESSION_TTL, now_iso(), ip, ref, csrf))
            audit(conn, u['id'], 'login', 'session', '登录成功，会话有效期 %d 分钟%s'
                  % (SESSION_TTL // 60, '；' + why if must_change else ''))
            self._set_cookies = [
                '%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (SESSION_COOKIE, token, SESSION_TTL),
                '%s=%s; Path=/; SameSite=Lax; Max-Age=%d' % (CSRF_COOKIE, csrf, SESSION_TTL),
            ]
            return self._json(HTTPStatus.OK, {'ok': True, 'user': public_user(u), 'perms': perms_of(u['role']),
                                             'expires_in': SESSION_TTL, 'csrf': csrf, 'session_ref': ref,
                                             'must_change': must_change, 'change_reason': why if must_change else '',
                                             'password_policy': {'min_len': PASSWORD_MIN_LEN,
                                                                'max_age_days': PASSWORD_MAX_AGE_DAYS,
                                                                'reuse_check': PASSWORD_REUSE_CHECK}})
        if key == 'logout':
            token = _cookie_token(self)
            if token:
                conn.execute('UPDATE sessions SET revoked=1 WHERE token=?', (token,))
            if self.user:
                audit(conn, self.user['id'], 'logout', 'session', '')
            self._set_cookies = ['%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' % SESSION_COOKIE,
                                 '%s=; Path=/; SameSite=Lax; Max-Age=0' % CSRF_COOKIE]
            return self._json(HTTPStatus.OK, {'ok': True})

        # ---- v3.1 口令与账号（改口令是自助操作，不需要额外权限点）
        if key == 'password/change':
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            old = str((payload or {}).get('old_password') or '')[:200]
            new = str((payload or {}).get('new_password') or '')[:200]
            ok, msg = change_password(conn, self.user['id'], old, new, actor_of(self))
            if not ok:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '改口令失败：' + msg,
                    'policy': {'min_len': PASSWORD_MIN_LEN, 'need_letter_and_digit': True,
                               'max_age_days': PASSWORD_MAX_AGE_DAYS, 'reuse_check': PASSWORD_REUSE_CHECK}})
            token = _cookie_token(self)
            if token:
                conn.execute('UPDATE sessions SET revoked=1 WHERE token=?', (token,))
            audit(conn, actor_of(self), 'password_changed', self.user['id'], '改口令成功，需重新登录')
            self._set_cookies = ['%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' % SESSION_COOKIE,
                                 '%s=; Path=/; SameSite=Lax; Max-Age=0' % CSRF_COOKIE]
            return self._json(HTTPStatus.OK, {'ok': True, 'need_relogin': True,
                'note': '口令已更换（有效期 %d 天），请重新登录' % PASSWORD_MAX_AGE_DAYS})
        if key == 'password/reset':
            if not self._need('matrix'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            uid = str((payload or {}).get('user_id') or '')[:40]
            tmp = str((payload or {}).get('temp_password') or '')[:200]
            u = conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
            if not u:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '账号不存在'})
            bad = password_policy_error(u['username'], tmp, u['id'])
            if bad:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '临时口令不合策略：' + bad})
            salt = secrets.token_hex(16)
            ts = now_iso()
            conn.execute('INSERT INTO password_history(user_id, pw_salt, pw_hash, created_at) VALUES(?,?,?,?)',
                         (u['id'], u['pw_salt'], u['pw_hash'], ts))
            conn.execute('UPDATE users SET pw_salt=?, pw_hash=?, must_change=1, pw_changed_at=? WHERE id=?',
                         (salt, hash_password(tmp, salt), ts, u['id']))
            conn.execute('UPDATE sessions SET revoked=1 WHERE user_id=?', (u['id'],))
            audit(conn, actor_of(self), 'password_reset', u['id'], '管理员重置临时口令，下次登录必须更换')
            return self._json(HTTPStatus.OK, {'ok': True, 'must_change': True})
        if key == 'account/toggle':
            if not self._need('matrix'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            uid = str((payload or {}).get('user_id') or '')[:40]
            enabled = 1 if (payload or {}).get('enabled') else 0
            u = conn.execute('SELECT id FROM users WHERE id=?', (uid,)).fetchone()
            if not u:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '账号不存在'})
            conn.execute('UPDATE users SET enabled=?, status=?, updated_at=? WHERE id=?',
                         (enabled, 'active' if enabled else 'disabled', now_iso(), uid))
            if not enabled:
                n = conn.execute('UPDATE sessions SET revoked=1 WHERE user_id=?', (uid,)).rowcount
                audit(conn, actor_of(self), 'account_disable', uid, '账号已停用，同时撤销 %d 个会话' % n)
            else:
                audit(conn, actor_of(self), 'account_enable', uid, '账号已开通')
            return self._json(HTTPStatus.OK, {'ok': True, 'user_id': uid, 'enabled': bool(enabled)})
        if key == 'session/revoke':
            payload, _e = self._body()
            ref = str((payload or {}).get('ref') or '')[:40]
            mine = conn.execute('SELECT * FROM sessions WHERE ref=?', (ref,)).fetchone()
            if not mine:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '会话不存在或已撤销'})
            if mine['user_id'] != self.user['id'] and not has_perm(self.user, 'matrix', 'view'):
                audit(db(), actor_of(self), 'denied_post', 'session/revoke', '只能撤销自己的会话，除非有权限矩阵权限')
                return self._json(HTTPStatus.FORBIDDEN, {'ok': False, 'error': '只能撤销自己的会话（撤销他人需要权限矩阵权限）'})
            conn.execute('UPDATE sessions SET revoked=1 WHERE ref=?', (ref,))
            audit(conn, actor_of(self), 'session_revoke', mine['user_id'], '撤销会话 %s' % ref)
            if mine['user_id'] == self.user['id']:
                self._set_cookies = ['%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' % SESSION_COOKIE,
                                     '%s=; Path=/; SameSite=Lax; Max-Age=0' % CSRF_COOKIE]
            return self._json(HTTPStatus.OK, {'ok': True, 'revoked': ref})

        # ---- v3.1 身份源：影子同步（外部账号只读导入，先比差异，不覆盖本地账号）
        if key == 'links/sync':
            if not self._need('matrix'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            provider = str((payload or {}).get('provider') or cfg('auth-provider'))[:20]
            accounts = (payload or {}).get('accounts')
            if not isinstance(accounts, list) or not accounts:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': 'body 需要 {"accounts": [{"external_id": …}]}'})
            ts = now_iso()
            matched = unmatched = 0
            for a in accounts[:500]:
                if not isinstance(a, dict):
                    continue
                ext = str(a.get('external_id') or '').strip()[:80]
                if not ext:
                    continue
                uid = str(a.get('user_id') or '').strip()[:40]
                user = conn.execute('SELECT id FROM users WHERE id=? OR username=?', (uid or ext, ext)).fetchone()
                hit = 1 if user else 0
                matched += hit
                unmatched += 0 if hit else 1
                conn.execute('INSERT INTO identity_links(provider, external_id, user_id, name, role, dept, matched,'
                             ' source, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,?, ?,?)'
                             ' ON CONFLICT(provider, external_id) DO UPDATE SET user_id=excluded.user_id,'
                             ' name=excluded.name, role=excluded.role, dept=excluded.dept,'
                             ' matched=excluded.matched, last_seen=excluded.last_seen',
                             (provider, ext, (user['id'] if user else None), str(a.get('name') or '')[:120],
                              str(a.get('role') or '')[:40], str(a.get('dept') or '')[:120], hit, 'sync', ts, ts))
            audit(conn, actor_of(self), 'links_sync', provider, '影子同步 %d 条：可对应 %d，待绑定 %d'
                  % (len(accounts), matched, unmatched))
            return self._json(HTTPStatus.OK, {'ok': True, 'provider': provider, 'total': len(accounts),
                'matched': matched, 'unmatched': unmatched,
                'note': '影子同步只读导入，不改本地账号；差异清零后才切主源'})

        # ---- v3.3 审批来源：内建审批 / 外部回写（同一状态机，外部回写幂等）
        if key in ('approval/create', 'approval/decide', 'approval/callback'):
            if not self._need('approve'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            oid = str((payload or {}).get('order_id') or '')[:40]
            o = conn.execute('SELECT id, title, status FROM orders WHERE id=?', (oid,)).fetchone()
            if not o:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '工单不存在：%s（工单要先由业务操作产生）' % oid})
            ts = now_iso()
            source = str((payload or {}).get('source') or ('external' if key == 'approval/callback' else cfg('approval-source')))[:20]
            if key == 'approval/create':
                try:
                    due_min = int((payload or {}).get('due_minutes') or 30)
                except Exception:
                    due_min = 30
                due = datetime.fromtimestamp(time.time() + max(1, min(1440, due_min)) * 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
                conn.execute('INSERT INTO approvals(order_id, source, external_ref, state, note, actor, due_at, at)'
                             ' VALUES(?,?,?,?,?,?,?,?)',
                             (oid, source, str((payload or {}).get('external_ref') or '')[:80], '待审',
                              str((payload or {}).get('note') or '')[:500], actor_of(self), due, ts))
                audit(conn, actor_of(self), 'approval_create', oid, '审批来源 %s，期望 %s 前回写' % (source, due))
                return self._json(HTTPStatus.OK, {'ok': True, 'order_id': oid, 'source': source, 'due_at': due})
            decision = str((payload or {}).get('decision') or '')[:20]
            if decision not in ('approve', 'reject'):
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': 'decision 只能是 approve 或 reject'})
            ext_ref = str((payload or {}).get('external_ref') or '')[:80]
            dup = conn.execute("SELECT id FROM approvals WHERE order_id=? AND IFNULL(external_ref,'')=? AND decision=?",
                               (oid, ext_ref, decision)).fetchone()
            if dup:
                return self._json(HTTPStatus.OK, {'ok': True, 'deduped': True, 'id': dup['id'],
                    'note': '同一外部单据号的同一决定只生效一次（幂等回写）'})
            state = '已审' if decision == 'approve' else '驳回'
            cur = conn.execute("SELECT id FROM approvals WHERE order_id=? AND state='待审' ORDER BY at DESC LIMIT 1",
                               (oid,)).fetchone()
            if cur:
                conn.execute('UPDATE approvals SET state=?, decision=?, note=?, actor=?, decided_at=? WHERE id=?',
                             (state, decision, str((payload or {}).get('note') or '')[:500], actor_of(self), ts, cur['id']))
                aid = cur['id']
            else:
                conn.execute('INSERT INTO approvals(order_id, source, external_ref, state, decision, note, actor,'
                             ' due_at, at, decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                             (oid, source, ext_ref, state, decision, str((payload or {}).get('note') or '')[:500],
                              actor_of(self), ts, ts, ts))
                aid = conn.execute('SELECT last_insert_rowid() id').fetchone()['id']
            audit(conn, actor_of(self), 'approval_' + key.split('/')[1], oid,
                  '工单 %s 由 %s 判定为 %s（外部单据号 %s）' % (oid, source, state, ext_ref or '-'))
            conn.execute('INSERT INTO events(time, level, text, source, created_at) '
                         'SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE time=? AND text=? AND source=?)',
                         (ts, '一般', '工单 %s 审批结果回写（来源 %s）：%s' % (oid, source, state), 'approval', ts,
                          ts, '工单 %s 审批结果回写（来源 %s）：%s' % (oid, source, state), 'approval'))
            return self._json(HTTPStatus.OK, {'ok': True, 'id': aid, 'state': state, 'source': source})

        # ---- v3.6 控制指令：预检 / dry-run / 下发 / 确认 / 回滚 / 人工兜底
        if key == 'commands/dry-run':
            if not self._need('security_issue'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            p = payload or {}
            cls = str(p.get('target_class') or '')[:60]
            tgt = str(p.get('target') or '')[:120]
            act = str(p.get('action') or '')[:120]
            if not cls or not act:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '要选目标设备类型与指令动作'})
            info = impact_of(conn, cls, tgt, act)
            cid = 'CMD-' + secrets.token_hex(4).upper()
            ts = now_iso()
            conn.execute('INSERT INTO commands(id, target_class, target, action, params, dry_run, status, impact,'
                         ' precheck, emergency, issued_by, created_at, updated_at) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?)',
                         (cid, cls, tgt, act, json.dumps(p.get('params') or {}, ensure_ascii=False), '预检通过',
                          json.dumps(info, ensure_ascii=False), json.dumps(info['precheck'], ensure_ascii=False),
                          1 if p.get('emergency') else 0, actor_of(self), ts, ts))
            audit(conn, actor_of(self), 'command_dryrun', cid, 'dry-run：%s / %s，影响 %d 项（未产生外部调用）'
                  % (cls, act, info['affected_count']))
            return self._json(HTTPStatus.OK, {'ok': True, 'id': cid, 'dry_run': True, 'impact': info,
                'note': '演练模式：只算影响，不发指令、不产生外部调用'})
        if key == 'commands/issue':
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            p = payload or {}
            emergency = bool(p.get('emergency'))
            if not self._need('security_emergency' if emergency else 'security_issue'):
                return
            cid = str(p.get('id') or '')[:40]
            row = conn.execute('SELECT * FROM commands WHERE id=?', (cid,)).fetchone() if cid else None
            if not row:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False,
                    'error': '找不到预检记录：必须先做 dry-run 预检，再下发'})
            if row['status'] not in ('预检通过', '失败'):
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False,
                    'error': '这条指令当前是「%s」，不能直接下发（必须先预检通过）' % row['status']})
            if not p.get('confirm'):
                audit(conn, actor_of(self), 'command_need_confirm', cid, '缺二次确认')
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False,
                    'error': '下发需要二次确认：看过影响面清单后点「确认下发」'})
            info = impact_of(conn, row['target_class'], row['target'], row['action'])
            ts = now_iso()
            conn.execute("UPDATE commands SET status='已下发', dry_run=0, emergency=?, impact=?, precheck=?,"
                         " issued_by=?, issued_at=?, updated_at=? WHERE id=?",
                         (1 if emergency else 0, json.dumps(info, ensure_ascii=False),
                          json.dumps(info['precheck'], ensure_ascii=False), actor_of(self), ts, ts, cid))
            audit(conn, actor_of(self), 'command_issue', cid, '%s / %s 目标 %s，影响 %d 项%s'
                  % (row['target_class'], row['action'], row['target'] or '-', info['affected_count'],
                     '（紧急通道，不受变更窗口限制）' if emergency else ''))
            txt = '处置指令 %s 已下发：%s / %s（目标 %s，影响 %d 项）' % (
                cid, row['target_class'], row['action'], row['target'] or '-', info['affected_count'])
            conn.execute('INSERT INTO events(time, level, text, source, created_at) '
                         'SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE time=? AND text=? AND source=?)',
                         (ts, '严重', txt, 'command', ts, ts, txt, 'command'))
            return self._json(HTTPStatus.OK, {'ok': True, 'id': cid, 'status': '已下发', 'impact': info})
        if key == 'commands/ack':
            if not self._need('security_issue'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            cid = str((payload or {}).get('id') or '')[:40]
            ok = bool((payload or {}).get('ok'))
            row = conn.execute('SELECT * FROM commands WHERE id=?', (cid,)).fetchone()
            if not row:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '指令不存在'})
            ts = now_iso()
            if ok:
                conn.execute("UPDATE commands SET status='设备已确认', ack_at=?, ack_by=?, updated_at=? WHERE id=?",
                             (ts, actor_of(self), ts, cid))
                audit(conn, actor_of(self), 'command_ack', cid, '设备已确认')
            else:
                why = str((payload or {}).get('reason') or '设备侧失败')[:200]
                conn.execute("UPDATE commands SET status='失败', fail_reason=?, updated_at=? WHERE id=?",
                             (why, ts, cid))
                conn.execute('INSERT INTO fallback_tasks(id, kind, ref, title, detail, status, owner, created_at, updated_at)'
                             ' VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
                             ('FB-%s' % cid, 'command_failed', cid,
                              '处置指令失败，需人工接管：%s / %s' % (row['target_class'], row['action']),
                              why, '待接管', '', ts, ts))
                audit(conn, actor_of(self), 'command_fail', cid, why)
            return self._json(HTTPStatus.OK, {'ok': True, 'id': cid, 'status': '设备已确认' if ok else '失败'})
        if key == 'commands/rollback':
            if not self._need('security_issue'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            cid = str((payload or {}).get('id') or '')[:40]
            row = conn.execute('SELECT * FROM commands WHERE id=?', (cid,)).fetchone()
            if not row:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '指令不存在'})
            ts = now_iso()
            rid = 'CMD-' + secrets.token_hex(4).upper()
            conn.execute('INSERT INTO commands(id, target_class, target, action, params, dry_run, status, impact,'
                         ' precheck, emergency, issued_by, issued_at, rollback_of, created_at, updated_at)'
                         ' VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)',
                         (rid, row['target_class'], row['target'], '回滚：' + (row['action'] or ''), row['params'],
                          '已下发', row['impact'], row['precheck'], 0, actor_of(self), ts, cid, ts, ts))
            conn.execute("UPDATE commands SET status='已回滚', updated_at=? WHERE id=?", (ts, cid))
            audit(conn, actor_of(self), 'command_rollback', cid, '生成反向指令 %s' % rid)
            return self._json(HTTPStatus.OK, {'ok': True, 'rollback_id': rid, 'id': cid, 'status': '已回滚'})
        if key == 'fallback/claim':
            if not self._need('security'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            fid = str((payload or {}).get('id') or '')[:60]
            row = conn.execute('SELECT id FROM fallback_tasks WHERE id=?', (fid,)).fetchone()
            if not row:
                return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '兜底工单不存在'})
            state = str((payload or {}).get('status') or '已接管')[:20]
            if state not in ('已接管', '已关闭', '待接管'):
                state = '已接管'
            conn.execute('UPDATE fallback_tasks SET status=?, owner=?, updated_at=? WHERE id=?',
                         (state, actor_of(self), now_iso(), fid))
            audit(conn, actor_of(self), 'fallback_claim', fid, state)
            return self._json(HTTPStatus.OK, {'ok': True, 'id': fid, 'status': state})

        # ---- v3.4 排班与派单（试运行由建设团队安排：班次 / 当班人 / 派单 / 超时升级都可配）
        if key == 'duty/shift':
            if not self._need('workflow'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            p = payload or {}
            sid = str(p.get('id') or 'D-' + secrets.token_hex(2).upper())[:20]
            role = str(p.get('role') or '')[:60]
            if not role:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '要有值班岗位名'})
            conn.execute('INSERT INTO duty_shifts(id, role, name, phone, lead, scope, enabled, updated_at)'
                         ' VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,'
                         ' name=excluded.name, phone=excluded.phone, lead=excluded.lead, scope=excluded.scope,'
                         ' enabled=excluded.enabled, updated_at=excluded.updated_at',
                         (sid, role, str(p.get('name') or '')[:120], str(p.get('phone') or '')[:60],
                          str(p.get('lead') or '')[:120], str(p.get('scope') or '')[:200],
                          0 if p.get('enabled') is False else 1, now_iso()))
            audit(conn, actor_of(self), 'duty_shift_put', sid, '%s（%s）启用=%s'
                  % (role, p.get('name') or '', p.get('enabled', True)))
            return self._json(HTTPStatus.OK, {'ok': True, 'id': sid})
        if key == 'duty/route':
            if not self._need('workflow'):
                return
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            p = payload or {}
            kind = str(p.get('kind') or '')[:60]
            role = str(p.get('duty_role') or '')[:60]
            if not kind or not role:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '要有例外类型与派单岗位'})
            conn.execute('INSERT INTO duty_routes(kind, duty_role, escalate_role, updated_at) VALUES(?,?,?,?)'
                         ' ON CONFLICT(kind) DO UPDATE SET duty_role=excluded.duty_role,'
                         ' escalate_role=excluded.escalate_role, updated_at=excluded.updated_at',
                         (kind, role, str(p.get('escalate_role') or '值班长')[:60], now_iso()))
            audit(conn, actor_of(self), 'duty_route_put', kind, '%s → %s（超时升级 %s）'
                  % (kind, role, p.get('escalate_role') or '值班长'))
            return self._json(HTTPStatus.OK, {'ok': True, 'kind': kind})

        if key not in ('state/bulk', 'reset', 'seed'):
            return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口', 'key': key})
        if not has_perm(self.user, 'workflow'):
            return self._json(HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有批量写入 / 重置演示数据的权限（需要权限点 资源调配）' % self.user['role']})
        if key == 'state/bulk':
            payload, err = self._body()
            if err:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            items = (payload or {}).get('state') if isinstance(payload, dict) else None
            if not isinstance(items, dict) or not items:
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': 'body 需要是 {"state": {键: 内容}}'})
            ts = now_iso()
            total = 0
            for k, v in items.items():
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(k)):
                    continue
                total += project_state(conn, str(k), v, ts)
            audit(conn, actor_of(self), 'state_bulk', ','.join(list(items)[:12]), '投影 %d 行' % total)
            return self._json(HTTPStatus.OK, {'ok': True, 'keys': len(items), 'projected_rows': total})
        if key == 'reset':
            payload, _err = self._body()
            defaults = (payload or {}).get('state') if isinstance(payload, dict) else None
            clear_all(conn)
            ts = now_iso()
            total = 0
            if isinstance(defaults, dict):
                for k, v in defaults.items():
                    if re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(k)):
                        total += project_state(conn, str(k), v, ts)
            if not conn.execute("SELECT 1 FROM kv_store WHERE key='dsh-demo-matrix-v1'").fetchone():
                total += project_state(conn, 'dsh-demo-matrix-v1', DEFAULT_MATRIX, ts)
            seed_config()        # 配置与排班属系统设置：重置演示数据时把默认值放回去
            seed_duty()
            audit(conn, actor_of(self), 'reset', 'all', '清空后写入初始演示数据 %d 行' % total)
            return self._json(HTTPStatus.OK, {'ok': True, 'cleared': True, 'seeded_rows': total})
        if key == 'seed':
            payload, err = self._body()
            items = (payload or {}).get('state') if isinstance(payload, dict) else None
            if not isinstance(items, dict):
                return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': 'body 需要是 {"state": {键: 内容}}'})
            ts = now_iso()
            total = 0
            for k, v in items.items():
                exists = conn.execute('SELECT 1 FROM kv_store WHERE key=?', (str(k),)).fetchone()
                if exists:
                    continue
                if re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(k)):
                    total += project_state(conn, str(k), v, ts)
            audit(conn, actor_of(self), 'seed', ','.join(list(items)[:12]), '首次写入 %d 行' % total)
            return self._json(HTTPStatus.OK, {'ok': True, 'seeded_rows': total})
        return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口', 'key': key})


def main() -> None:
    global DB_PATH, STATIC_DIR
    ap = argparse.ArgumentParser(description='AI 运营管理平台 演示版数据服务')
    ap.add_argument('--port', type=int, default=int(os.environ.get('AIOPS_PORT', '8090')))
    ap.add_argument('--host', default=os.environ.get('AIOPS_HOST', '127.0.0.1'))
    ap.add_argument('--db', default=os.environ.get('AIOPS_DB', DB_PATH))
    ap.add_argument('--dist', default=os.environ.get('AIOPS_DIST', STATIC_DIR))
    ap.add_argument('--reset', action='store_true', help='清空数据库后退出')
    args = ap.parse_args()

    DB_PATH = os.path.abspath(args.db)
    STATIC_DIR = os.path.abspath(args.dist)
    init_db()
    users = seed_users()
    perms = seed_default_matrix()
    migrated = migrate_matrix()
    cfgs = seed_config()
    duty = seed_duty()
    if migrated:
        print('Matrix migrated: ' + ' / '.join(PERM_LABEL_CN[k] for k in NEW_PERM_KEYS))

    if args.reset:
        conn = db()
        clear_all(conn)          # 只清业务数据；账号 / 会话 / 登录记录 / 口令历史保留
        seed_default_matrix()
        seed_config()
        seed_duty()
        print('Database cleared:', DB_PATH, '(users/sessions/login_log kept)')
        return

    if not os.path.isfile(os.path.join(STATIC_DIR, 'index.html')):
        print('WARNING: %s/index.html not found - run npm run build first' % STATIC_DIR, file=sys.stderr)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print('AI Ops Console demo v%s' % SERVER_VERSION)
    print('  UI        http://%s:%d/' % (args.host, args.port))
    print('  Data API  http://%s:%d%s/health' % (args.host, args.port, API_PREFIX))
    print('  Database  %s (SQLite; browser storage no longer used)' % DB_PATH)
    print('  Login     %d accounts seeded: %s' % (users or len(DEMO_USERS),
          ' / '.join('%s=%s' % (u['username'], u['password']) for u in DEMO_USERS)))
    if users:
        print('            demo passwords are weak on purpose - change them and connect a real identity source')
    print('            sessions: HttpOnly cookie "%s", idle %d min; server checks permissions on every write'
          % (SESSION_COOKIE, SESSION_TTL // 60))
    print('  Stop      Ctrl+C')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped')
    finally:
        conn = getattr(_local, 'conn', None)
        if conn:
            conn.close()


if __name__ == '__main__':
    main()
