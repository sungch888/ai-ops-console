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
import json
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(HERE, 'data', 'aiops.db')
SCHEMA = os.path.join(HERE, 'schema.sql')
STATIC_DIR = os.path.join(ROOT, 'dist')
API_PREFIX = '/api'
MAX_BODY = 8 * 1024 * 1024
SCHEMA_VERSION = '1'
SERVER_VERSION = '2.2.0'

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
    """演示版：账号来自前端声明的 header，不是安全认证。正式版换成会话 / token。"""
    a = handler.headers.get('X-Demo-Account') or ''
    a = re.sub(r'[^0-9A-Za-z\u4e00-\u9fa5 _\-.]', '', a)[:40]
    return a or 'anonymous'


def audit(conn, actor: str, action: str, target: str, detail: str = '') -> None:
    conn.execute('INSERT INTO audit_log(at, actor, action, target, detail) VALUES(?, ?, ?, ?, ?)',
                 (now_iso(), actor, action, target, detail[:500]))


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
    conn.execute('DELETE FROM events WHERE source=?', ('engine',))
    for e in events[-500:]:
        if not isinstance(e, dict):
            continue
        conn.execute('INSERT INTO events(time, level, text, source, created_at) VALUES(?, ?, ?, ?, ?)',
                     (str(e.get('time') or ''), str(e.get('level') or ''), str(e.get('text') or '')[:1000], 'engine', updated_at))


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
    def do_GET(self):
        path = urlparse(self.path).split('?')[0] if False else urlparse(self.path).path
        if path.startswith(API_PREFIX):
            return self._api_get(path, parse_qs(urlparse(self.path).query))
        return self._static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
            return self._api_put(urlparse(self.path).path)
        self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})

    def do_POST(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
            return self._api_post(urlparse(self.path).path)
        self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})

    def do_DELETE(self):
        if urlparse(self.path).path.startswith(API_PREFIX):
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
        if key in ('orders', 'events', 'audit', 'notifications', 'accounts', 'entities', 'permissions', 'settings'):
            limit, offset = num('limit', 100, 500), num('offset', 0, 100000)
            if key == 'orders':
                sql, params = 'SELECT * FROM orders', []
                if (qs.get('status') or [''])[0]:
                    sql += ' WHERE status=?'
                    params = [(qs['status'][0])[:40]]
                sql += ' ORDER BY created_at DESC'
            elif key == 'events':
                sql, params = 'SELECT * FROM events ORDER BY id DESC', []
            elif key == 'audit':
                sql, params = 'SELECT * FROM audit_log ORDER BY id DESC', []
            elif key == 'notifications':
                sql, params = 'SELECT * FROM notifications ORDER BY time DESC', []
            elif key == 'accounts':
                sql, params = 'SELECT * FROM accounts ORDER BY id', []
            elif key == 'permissions':
                sql, params = 'SELECT * FROM role_permissions ORDER BY role, perm_kind, perm', []
            elif key == 'settings':
                sql, params = 'SELECT * FROM settings ORDER BY key', []
            else:
                sql = 'SELECT * FROM entities'
                kind = (qs.get('kind') or [''])[0]
                params = []
                if kind:
                    sql += ' WHERE kind=?'
                    params = [kind[:60]]
                sql += ' ORDER BY kind, id'
            return self._json(HTTPStatus.OK, {'ok': True, 'limit': limit, 'offset': offset,
                                             'rows': query_rows(sql, params, limit, offset)})
        return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口', 'key': key})

    def _api_put(self, path: str) -> None:
        name = path[len(API_PREFIX):].strip('/')
        if not name.startswith('state/'):
            return self._json(HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        key = name[len('state/'):]
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key):
            return self._json(HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '状态键名不合法'})
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
        conn = db()
        conn.execute('DELETE FROM kv_store WHERE key=?', (key,))
        conn.execute('DELETE FROM settings WHERE key=?', (key,))
        audit(conn, actor_of(self), 'state_delete', key, '')
        return self._json(HTTPStatus.OK, {'ok': True, 'key': key})

    def _api_post(self, path: str) -> None:
        key = path[len(API_PREFIX):].strip('/')
        conn = db()
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

    if args.reset:
        conn = db()
        clear_all(conn)
        print('Database cleared:', DB_PATH)
        return

    if not os.path.isfile(os.path.join(STATIC_DIR, 'index.html')):
        print('WARNING: %s/index.html not found - run npm run build first' % STATIC_DIR, file=sys.stderr)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print('AI Ops Console demo v%s' % SERVER_VERSION)
    print('  UI        http://%s:%d/' % (args.host, args.port))
    print('  Data API  http://%s:%d%s/health' % (args.host, args.port, API_PREFIX))
    print('  Database  %s (SQLite; browser storage no longer used)' % DB_PATH)
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
