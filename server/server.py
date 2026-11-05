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
SCHEMA_VERSION = '2'
SERVER_VERSION = '3.0.0'

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
QUERY_PERM = {'audit': 'audit', 'export': 'export', 'accounts': 'matrix', 'permissions': 'matrix', 'users': 'matrix'}
CSV_PERM = {'audit_log': 'audit', 'accounts': 'matrix', 'role_permissions': 'matrix'}

# 权限矩阵默认值（与前端默认一致；库里没有矩阵时服务端自己播种，保证登录即可判定）
DEFAULT_MATRIX = {
    'admin': {
        'view': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                 'security', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'],
        'manage': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                   'security', 'audit', 'matrix', 'export', 'integration', 'analytics', 'approve'],
        'cls': ['公开', '内部', '敏感']},
    'ops': {
        'view': ['overview', 'compute', 'gateway', 'cred', 'workflow', 'app', 'agent', 'kb', 'tool',
                 'security', 'audit', 'export', 'integration', 'analytics', 'approve'],
        'manage': ['compute', 'gateway', 'cred', 'workflow', 'security', 'export', 'analytics', 'approve'],
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
        conn.execute('INSERT INTO users(id, username, name, role, dept, org, domain, note, pw_salt, pw_hash,'
                     ' algo, status, must_change, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                     (u['id'], u['username'], u['name'], u['role'], u['dept'], u['org'], u['domain'], u['note'],
                      salt, hash_password(u['password'], salt), 'pbkdf2_sha256', 'active', 1, ts, ts))
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
    return dict(user)


def public_user(u) -> dict:
    return {'id': u['id'], 'username': u['username'], 'name': u['name'], 'role': u['role'],
            'dept': u['dept'], 'org': u['org'], 'domain': u['domain'], 'note': u['note'],
            'must_change': bool(u['must_change'])}


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
              'notifications', 'accounts', 'role_permissions', 'audit_log'):
        conn.execute('DELETE FROM %s' % t)
    conn.execute("DELETE FROM sqlite_sequence")


# --------------------------------------------------------------------------- 查询
def counts() -> dict:
    conn = db()
    out = {}
    for t in ('kv_store', 'entities', 'orders', 'order_trace', 'events', 'notifications', 'role_permissions', 'audit_log'):
        out[t] = conn.execute('SELECT COUNT(*) c FROM %s' % t).fetchone()['c']
    return out


TABLE_OF = {'orders': 'orders', 'events': 'events', 'audit': 'audit_log', 'notifications': 'notifications',
            'accounts': 'accounts', 'entities': 'entities', 'permissions': 'role_permissions', 'settings': 'settings'}
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
}


def _flt(where, params, col, value, maxlen=120):
    value = (value or '').strip()
    if value:
        where.append('%s=?' % col)
        params.append(value[:maxlen])


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
        cookie = getattr(self, '_set_cookie', None)
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
    def _guard(self, key: str) -> bool:
        """除登录 / 会话探测 / 健康检查外，所有 /api 都要带有效会话。"""
        self.user = session_user(self)
        if key in PUBLIC_API:
            return True
        if not self.user:
            self._json(HTTPStatus.UNAUTHORIZED, {'ok': False, 'error': '未登录或会话已过期，请重新登录'})
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
                                             'session_idle_minutes': round(SESSION_TTL / 60)})
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
                      'accounts', 'role_permissions', 'settings', 'audit_log'):
                c = db().execute('SELECT COUNT(*) c FROM %s' % t).fetchone()['c']
                col = 'updated_at' if db().execute("PRAGMA table_info(%s)" % t).fetchone() and any(
                    r['name'] == 'updated_at' for r in db().execute('PRAGMA table_info(%s)' % t)) else None
                last = db().execute('SELECT MAX(%s) m FROM %s' % (col, t)).fetchone()['m'] if col else ''
                out.append({'table': t, 'rows': c, 'last_change': last or ''})
            return self._json(HTTPStatus.OK, {'ok': True, 'tables': out})
        return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口', 'key': key})

    def _api_put(self, path: str) -> None:
        name = path[len(API_PREFIX):].strip('/')
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
            ok = bool(u) and u['status'] == 'active' and hmac.compare_digest(
                hash_password(password, u['pw_salt']), u['pw_hash'])
            reason = '' if ok else ('账号不存在' if not u else '口令不正确')
            conn.execute('INSERT INTO login_log(at, username, ok, reason, ip) VALUES(?,?,?,?,?)',
                         (now_iso(), username, 1 if ok else 0, reason, ip))
            if not ok:
                return self._json(HTTPStatus.UNAUTHORIZED, {'ok': False, 'error': '账号或口令不正确',
                                                           'remaining': max(0, LOGIN_FAIL_LIMIT - fails - 1)})
            conn.execute('DELETE FROM sessions WHERE expires_at < ?', (time.time(),))
            token = secrets.token_urlsafe(32)
            conn.execute('INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen, ip) VALUES(?,?,?,?,?,?)',
                         (token, u['id'], now_iso(), time.time() + SESSION_TTL, now_iso(), ip))
            audit(conn, u['id'], 'login', 'session', '登录成功，会话有效期 %d 分钟' % (SESSION_TTL // 60))
            self._set_cookie = '%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (SESSION_COOKIE, token, SESSION_TTL)
            return self._json(HTTPStatus.OK, {'ok': True, 'user': public_user(u), 'perms': perms_of(u['role']),
                                             'expires_in': SESSION_TTL})
        if key == 'logout':
            token = _cookie_token(self)
            if token:
                conn.execute('UPDATE sessions SET revoked=1 WHERE token=?', (token,))
            if self.user:
                audit(conn, self.user['id'], 'logout', 'session', '')
            self._set_cookie = '%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' % SESSION_COOKIE
            return self._json(HTTPStatus.OK, {'ok': True})
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

    if args.reset:
        conn = db()
        clear_all(conn)          # 只清业务数据；账号 / 会话 / 登录记录保留
        seed_default_matrix()
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
