"""API 路由处理器 — 从 server.py 拆分的 GET / PUT / DELETE 路由分发。

C1 修复：_api_get（~650 行）和 _api_put/_api_delete 拆分到本模块。
server.py 的 Handler 通过 Router 委托给本模块，每个路由一个函数。
"""

from http import HTTPStatus
import hmac
import json
import os
import re
import time
from datetime import datetime, timezone


def _num(qs, name, default, cap):
    """从 qs 取整数参数，超限则 cap。"""
    try:
        return max(0, min(cap, int((qs.get(name) or [default])[0])))
    except Exception:
        return default


def _cookie_token(handler):
    cookie = handler.headers.get('Cookie') or ''
    for part in cookie.split(';'):
        part = part.strip()
        if part.startswith('dsh_session='):
            return part[len('dsh_session='):]
    return None


def _ser(handler, code, obj):
    """统一发送 JSON 响应（避免 handler._json 在导入时不存在）。"""
    from server import CONTENT_TYPES
    handler._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), CONTENT_TYPES['.json'])


# ═══════════════════════════════════════════════════════════════════════
# GET 路由
# ═══════════════════════════════════════════════════════════════════════

def _r_health(conn, handler):
    from server import ROOT, DB_PATH, _START_TS, counts, SERVER_VERSION
    return _ser(handler, HTTPStatus.OK, {
        'ok': True, 'service': 'ai-ops-console data service', 'version': SERVER_VERSION,
        'schema_version': '5',
        'db': os.path.relpath(DB_PATH, ROOT),
        'uptime_s': int(time.time() - _START_TS),
        'counts': counts(),
    })


def _r_state(conn, handler):
    rows = conn.execute('SELECT key, payload, updated_at FROM kv_store ORDER BY key').fetchall()
    out = {}
    for r in rows:
        try:
            out[r['key']] = json.loads(r['payload'])
        except Exception:
            out[r['key']] = None
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'state': out,
                                          'updated_at': {r['key']: r['updated_at'] for r in rows}})


def _r_state_key(conn, key, handler):
    row = conn.execute('SELECT payload, updated_at FROM kv_store WHERE key=?', (key,)).fetchone()
    if not row:
        return _ser(handler, HTTPStatus.NOT_FOUND, {'ok': False, 'error': '该状态尚未写入数据库', 'key': key})
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'key': key, 'updated_at': row['updated_at'],
                                          'payload': json.loads(row['payload'])})


def _r_export(conn, handler):
    out = {}
    for r in conn.execute('SELECT key, payload, updated_at FROM kv_store ORDER BY key'):
        out[r['key']] = {'payload': json.loads(r['payload']), 'updated_at': r['updated_at']}
    from server import now_iso
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'generated_at': now_iso(), 'kv': out})


def _r_users(conn, user, handler):
    rows = [{k: v for k, v in dict(r).items() if k not in ('pw_salt', 'pw_hash', 'algo')}
            for r in conn.execute('SELECT * FROM users ORDER BY id')]
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'rows': rows})


def _r_login_accounts(conn, user, handler):
    from server import hash_password, DEMO_USERS
    out = []
    for r in conn.execute('SELECT id, username, name, role, pw_salt, pw_hash FROM users ORDER BY id').fetchall():
        seed = next((x for x in DEMO_USERS if x['username'] == r['username']), None)
        out.append({'id': r['id'], 'username': r['username'], 'name': r['name'], 'role': r['role'],
                    'seed_active': bool(seed) and hmac.compare_digest(hash_password(seed['password'], r['pw_salt']), r['pw_hash'])})
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'rows': out,
        'note': 'seed_active=false 表示该账号已改过口令，初始演示口令对它无效'})


def _r_session(conn, user, handler):
    if not user:
        return _ser(handler, HTTPStatus.OK, {'ok': True, 'signed_in': False})
    from server import (public_user, perms_of, SESSION_TTL, public_config,
                        PASSWORD_MIN_LEN, PASSWORD_MAX_AGE_DAYS, PASSWORD_REUSE_CHECK)
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'signed_in': True, 'user': public_user(user),
                                         'perms': perms_of(user['role']),
                                         'csrf': getattr(handler, 'csrf', '') or '',
                                         'session_ref': getattr(handler, 'session_ref', '') or '',
                                         'session_idle_minutes': round(SESSION_TTL / 60),
                                         'config': public_config(),
                                         'password_policy': {'min_len': PASSWORD_MIN_LEN,
                                                             'max_age_days': PASSWORD_MAX_AGE_DAYS,
                                                             'reuse_check': PASSWORD_REUSE_CHECK}})


def _r_config(conn, user, handler):
    from server import PROVIDERS, CONFIG_LABEL_CN, KEY_PERM, MATRIX_KEYS, public_config
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'config': public_config(),
                                         'providers': PROVIDERS,
                                         'labels': CONFIG_LABEL_CN,
                                         'perm_map': {k: v for k, v in KEY_PERM.items() if k in MATRIX_KEYS},
                                         'note': '口径：先内建独立运行，外部来源做成适配器 + 配置开关；'
                                                 '切换不改业务代码，未配置的来源会明确拒绝'})


def _r_sessions(conn, user, handler):
    from server import has_perm
    mine_only = not has_perm(user, 'matrix', 'view')
    sql = ('SELECT s.ref, s.user_id, s.created_at, s.last_seen, s.expires_at, s.ip, s.revoked,'
           ' u.username, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id ')
    params = []
    if mine_only:
        sql += 'WHERE s.user_id=? '
        params.append(user['id'])
    sql += 'ORDER BY s.created_at DESC'
    rows = []
    for r in query_rows(sql, params, 100, 0):
        rows.append({**dict(r), 'expired': time.time() > r['expires_at'],
                     'current': r['ref'] == getattr(handler, 'session_ref', ''),
                     'expires_left_min': max(0, round((r['expires_at'] - time.time()) / 60))})
    from server import SESSION_TTL
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'rows': rows, 'total': len(rows),
                                         'mine_only': mine_only, 'ttl_minutes': round(SESSION_TTL / 60)})


def _r_collect(conn, user, handler):
    from server import COLLECT_STATE, COLLECT_KINDS, cfg
    rows = [dict(r) for r in conn.execute('SELECT * FROM data_sources ORDER BY kind, id')]
    payloads = {}
    for r in conn.execute('SELECT kind, items, error, sources, at FROM collect_payloads'):
        payloads[r['kind']] = {'items': r['items'], 'error': r['error'] or '', 'sources': r['sources'],
                               'at': r['at']}
    return _ser(handler, HTTPStatus.OK, {
        'ok': True, 'sources': rows, 'status': payloads, 'state': COLLECT_STATE,
        'kinds': list(COLLECT_KINDS), 'approval_mode': cfg('data-source-approval', 'off'),
        'rows': {r['kind']: json.loads(r['rows_json']) for r in
                 conn.execute('SELECT kind, rows_json FROM collect_payloads')},
        'fallback': [dict(r) for r in conn.execute(
            "SELECT id, ref, title, status, owner, created_at, updated_at FROM fallback_tasks"
            " WHERE kind='monitor_unreachable' ORDER BY CASE status WHEN '待接管' THEN 0"
            " WHEN '已升级' THEN 1 ELSE 2 END, created_at DESC LIMIT 12")],
        'note': '资源接入全部在系统里配（配置中心 → 资源接入与采集）；采集只读拉取，平台不向外部系统写数据；'
                '密钥只存 env:环境变量名 引用，值由启动环境提供'})


def _r_monitor(conn, user, handler):
    from server import has_perm, MONITOR_STATE, MONITOR_TICK, SAMPLE_RETENTION_HOURS, audit, actor_of
    if not has_perm(user, 'compute', 'view'):
        audit(conn, actor_of(handler), 'denied_get', 'monitor', '没有「算力中心」查看权')
        return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False, 'error': '这个接口要「算力中心」查看权'})
    targets = [dict(r) for r in conn.execute('SELECT * FROM monitor_targets ORDER BY id')]
    latest = []
    for t in targets:
        r = conn.execute('SELECT * FROM metric_samples WHERE target=? ORDER BY id DESC LIMIT 1',
                         (t['id'],)).fetchone()
        latest.append(dict(r) if r else None)
    return _ser(handler, HTTPStatus.OK, {
        'ok': True, 'targets': targets, 'latest': latest,
        'key_env_present': {t['id']: bool(os.environ.get(t['api_key_env'] or '')) for t in targets},
        'state': MONITOR_STATE, 'tick_seconds': MONITOR_TICK,
        'retention_hours': SAMPLE_RETENTION_HOURS,
        'fallback': [dict(r) for r in conn.execute(
            "SELECT id, ref, title, status, owner, created_at, updated_at FROM fallback_tasks"
            " WHERE kind='monitor_unreachable' ORDER BY CASE status WHEN '待接管' THEN 0"
            " WHEN '已升级' THEN 1 ELSE 2 END, created_at DESC LIMIT 12")],
        'total_samples': conn.execute('SELECT COUNT(*) c FROM metric_samples').fetchone()['c'],
        'note': '探针只读拉取外部服务的 /metrics 与 /health；库里只存环境变量名，不存密钥'})


def _r_tables(conn, handler):
    out = []
    for t in ('kv_store', 'entities', 'orders', 'order_trace', 'events', 'notifications',
              'accounts', 'role_permissions', 'settings', 'audit_log', 'users', 'sessions', 'login_log',
              'identity_links', 'password_history', 'approvals', 'duty_shifts', 'duty_routes',
              'commands', 'fallback_tasks', 'monitor_targets', 'metric_samples', 'gpu_cards'):
        c = conn.execute('SELECT COUNT(*) c FROM %s' % t).fetchone()['c']
        col = 'updated_at' if conn.execute("PRAGMA table_info(%s)" % t).fetchone() and any(
            r['name'] == 'updated_at' for r in conn.execute('PRAGMA table_info(%s)' % t)) else None
        last = conn.execute('SELECT MAX(%s) m FROM %s' % (col, t)).fetchone()['m'] if col else ''
        out.append({'table': t, 'rows': c, 'last_change': last or ''})
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'tables': out})


# ═══════════════════════════════════════════════════════════════════════
# 通用查询路由
# ═══════════════════════════════════════════════════════════════════════

def _r_table_query(conn, handler, table, where, params, order, qs):
    limit = _num(qs, 'limit', 100, 500)
    offset = _num(qs, 'offset', 0, 100000)
    total = conn.execute('SELECT COUNT(*) c FROM %s%s' % (table, where), params).fetchone()['c']
    return _ser(handler, HTTPStatus.OK, {'ok': True, 'limit': limit, 'offset': offset, 'total': total,
                                          'rows': query_rows('SELECT * FROM %s%s %s' % (table, where, order), params, limit, offset)})


def _r_csv_export(conn, handler, table, where, params, qs, order):
    from server import CSV_PERM, CSV_COLUMNS, _csv_cell, has_perm
    limit = _num(qs, 'limit', 5000, 20000)
    cols = CSV_COLUMNS[table]
    rows = query_rows('SELECT %s FROM %s%s%s' % (','.join(cols), table, where, ' ' + order if order else ''),
                      params, limit, 0)
    lines = [','.join(cols)]
    for r in rows:
        lines.append(','.join(_csv_cell(r.get(c)) for c in cols))
    body = ('\ufeff' + '\r\n'.join(lines) + '\r\n').encode('utf-8')
    fname = (qs.get('name') or [table])[0]
    fname = re.sub(r'[^0-9A-Za-z_\-]', '_', fname)[:40] or table
    handler.send_response(HTTPStatus.OK)
    handler.send_header('Content-Type', 'text/csv; charset=utf-8')
    handler.send_header('Content-Disposition', 'attachment; filename="%s.csv"' % fname)
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
    return None


# ═══════════════════════════════════════════════════════════════════════
# Router：GET / PUT / DELETE 路由分发（server.py Handler 委托给此类）
# ═══════════════════════════════════════════════════════════════════════

class Router:
    """所有 GET / PUT / DELETE 路由的入口。"""

    def __init__(self, handler):
        self.handler = handler

    def dispatch_get(self, key, qs):
        handler = self.handler
        conn = db()

        # ---- 公开端点 ----
        if key in ('', 'health'):
            return _r_health(conn, handler)
        if key == 'state':
            return _r_state(conn, handler)
        if key.startswith('state/'):
            return _r_state_key(conn, key[len('state/'):], handler)
        if key == 'export':
            return _r_export(conn, handler)

        # ---- 需要权限 ----
        from server import QUERY_PERM, PERM_LABEL_CN, has_perm, actor_of, audit
        user = getattr(handler, 'user', None) or {}

        if key.startswith('opctl/'):
            if not has_perm(user, 'opctl', 'view'):
                audit(conn, actor_of(handler), 'denied_get', key, '没有「操作控制」查看权')
                return _ser(handler, HTTPStatus.FORBIDDEN,
                            {'ok': False, 'error': '这个接口要「操作控制」查看权（权限点 opctl）'})
            import importlib
            try:
                mod = importlib.import_module('opctl')
            except ImportError:
                mod = importlib.import_module('server.opctl')
            if key == 'opctl/state':
                return _ser(handler, HTTPStatus.OK, mod.state(conn, user))
            if key == 'opctl/connectors':
                return _ser(handler, HTTPStatus.OK, mod.connectors_state())
            return _ser(handler, HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口 ' + key})

        need = QUERY_PERM.get(key)
        if need and not has_perm(user, need, 'view'):
            return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有「%s」的查看权限（权限点 %s）' % (user.get('role', '?'), PERM_LABEL_CN.get(need, need), need)})

        if key == 'users':
            return _r_users(conn, user, handler)
        if key == 'login-accounts':
            return _r_login_accounts(conn, user, handler)
        if key == 'session':
            return _r_session(conn, user, handler)
        if key == 'config':
            return _r_config(conn, user, handler)
        if key == 'sessions':
            return _r_sessions(conn, user, handler)
        if key == 'collect':
            return _r_collect(conn, user, handler)
        if key == 'monitor':
            if not has_perm(user, 'compute', 'view'):
                audit(conn, actor_of(handler), 'denied_get', 'monitor', '没有「算力中心」查看权')
                return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False, 'error': '这个接口要「算力中心」查看权'})
            return _r_monitor(conn, user, handler)

        # ---- 通用查询 / CSV ----
        from server import CSV_PERM, CSV_COLUMNS, _query_plan
        plan = _query_plan(key, qs)
        if plan:
            table, where, params, order = plan
            if key == 'csv':
                need_csv = CSV_PERM.get(table)
                if need_csv and not (has_perm(user, need_csv, 'view') and has_perm(user, 'export')):
                    return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False,
                        'error': '角色「%s」没有导出「%s」的权限' % (user['role'], table)})
                return _r_csv_export(conn, handler, table, where, params, qs, order)
            return _r_table_query(conn, handler, table, where, params, order, qs)

        if key == 'tables':
            return _r_tables(conn, handler)

        # ---- 未知 ----
        from server import now_iso
        audit(conn, actor_of(handler), 'unknown_api', key, '接口不存在：前端路径可能多写了一层 /api')
        hint = ('（路径多写了一层 /api，应该是 /api/' + key[4:] + '）') if key.startswith('api/') else ''
        return _ser(handler, HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口 ' + key + hint, 'key': key})

    def dispatch_put(self, name):
        handler = self.handler
        conn = db()

        from server import (cfg as cfg_fn, has_perm, actor_of, audit, public_config,
                           project_state, now_iso, KEY_PERM, PERM_LABEL_CN, CONFIG_DEFAULTS,
                           CONFIG_CHOICES)

        if name == 'config':
            if not handler._need('matrix'):
                return
            payload, err = handler._body()
            if err:
                return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
            k = str((payload or {}).get('key') or '')[:60]
            if k not in CONFIG_DEFAULTS:
                return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False,
                    'error': '不能改这个配置项', 'allowed': list(CONFIG_DEFAULTS.keys())})
            msg = cfg_fn(conn, k, str((payload or {}).get('value') or ''), actor_of(handler))
            if msg:
                return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': msg,
                    'allowed': CONFIG_CHOICES.get(k, [])})
            return _ser(handler, HTTPStatus.OK, {'ok': True, 'key': k, 'config': public_config(),
                'note': '只改配置就切换来源：业务代码与 /api 契约不变，未配置好的外部来源会明确拒绝而不是静默降级'})

        if not name.startswith('state/'):
            return _ser(handler, HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        key = name[len('state/'):]
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key):
            return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '状态键名不合法'})
        if key == 'dsh-demo-session-v1':
            return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '会话由数据服务管理，前端不再写这个键'})
        need = KEY_PERM.get(key, 'overview')
        user = getattr(handler, 'user', None) or {}
        if not has_perm(user, need):
            audit(conn, actor_of(handler), 'denied_put', key, '角色 %s 缺少权限点 %s' % (user.get('role', '?'), need))
            return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有「%s」的写入权限（权限点 %s）' % (user.get('role', '?'), PERM_LABEL_CN.get(need, need), need)})
        payload, err = handler._body()
        if err:
            return _ser(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': err})
        ts = now_iso()
        rows = project_state(conn, key, payload, ts)
        audit(conn, actor_of(handler), 'state_put', key, '投影 %d 行，payload %d 字节' % (rows, len(json.dumps(payload, ensure_ascii=False))))
        return _ser(handler, HTTPStatus.OK, {'ok': True, 'key': key, 'updated_at': ts, 'projected_rows': rows})

    def dispatch_delete(self, name):
        handler = self.handler
        conn = db()

        from server import has_perm, actor_of, audit, KEY_PERM, PERM_LABEL_CN
        if not name.startswith('state/'):
            return _ser(handler, HTTPStatus.NOT_FOUND, {'ok': False, 'error': '未知接口'})
        key = name[len('state/'):]
        need = KEY_PERM.get(key, 'overview')
        user = getattr(handler, 'user', None) or {}
        if not has_perm(user, need):
            audit(conn, actor_of(handler), 'denied_delete', key, '角色 %s 缺少权限点 %s' % (user.get('role', '?'), need))
            return _ser(handler, HTTPStatus.FORBIDDEN, {'ok': False,
                'error': '角色「%s」没有删除「%s」的权限' % (user.get('role', '?'), PERM_LABEL_CN.get(need, need))})
        conn.execute('DELETE FROM kv_store WHERE key=?', (key,))
        conn.execute('DELETE FROM settings WHERE key=?', (key,))
        audit(conn, actor_of(handler), 'state_delete', key, '')
        return _ser(handler, HTTPStatus.OK, {'ok': True, 'key': key})


# ── 延迟导入：db() / query_rows ──
def db():
    import server
    return server.db()

def query_rows(sql, params, limit, offset):
    import server
    return server.query_rows(sql, params, limit, offset)
