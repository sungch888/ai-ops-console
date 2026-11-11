# -*- coding: utf-8 -*-
"""
连接器客户端（opctl 内核 → 连接器统一 10 接口）。
真实联调时只需把 OPCTL_SIM_HOST 换成真实平台网关地址，逐连接器配 base 亦可。

约定：探测失败一律抛 ConnectorError / 返回 ok=False，内核按 T08「显示读不到、不用默认值」处理。
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request

HOST = os.environ.get('OPCTL_SIM_HOST', '127.0.0.1')
TOKEN = os.environ.get('OPCTL_SIM_TOKEN', '')
PORT_BASE = int(os.environ.get('OPCTL_SIM_PORT_BASE', '9101'))
KEYS = ['gpuworks', 'gpustack', 'cubestudio', 'gateway', 'k8s']
NAMES = {'gpuworks': 'GPUWorks', 'gpustack': 'GPUStack', 'cubestudio': 'CubeStudio',
         'gateway': '统一对外网关', 'k8s': 'K8s 受限通道'}


class ConnectorError(Exception):
    pass


def _base(key):
    port = PORT_BASE + KEYS.index(key)
    return 'http://%s:%d/v1' % (HOST, port)


def request(method, key, path, body=None, timeout=3.0):
    """返回 (http_code, dict)。网络异常/超时抛 ConnectorError。"""
    url = '%s/%s' % (_base(key), path.lstrip('/'))
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if TOKEN:
        req.add_header('X-Sim-Token', TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            obj = json.loads(e.read().decode())
        except Exception:
            obj = {'error': {'code': str(e.code), 'message': e.reason}}
        return e.code, obj
    except Exception as e:
        raise ConnectorError('%s 读不到：%s' % (NAMES.get(key, key), e.__class__.__name__ if not str(e) else str(e)[:80]))


# ---------- 探测缓存（避免每次 state 都外呼） ----------
_cache_lock = threading.Lock()
_probe_cache = {'at': 0, 'data': {}}


def probe_all(timeout=1.0, ttl=15.0):
    with _cache_lock:
        if ttl > 0 and time.time() - _probe_cache['at'] < ttl and _probe_cache['data']:
            return _probe_cache['data']
    out = {}
    for k in KEYS:
        try:
            code, obj = request('GET', k, 'probe', timeout=timeout)
            out[k] = dict(name=NAMES[k], ok=code == 200, error='',
                          version=obj.get('version', ''), capabilities=obj.get('capabilities') or {}) if code == 200 \
                else dict(name=NAMES[k], ok=False, error=obj.get('error', {}).get('message', 'HTTP %s' % code))
        except ConnectorError as e:
            out[k] = dict(name=NAMES[k], ok=False, error=str(e))
    with _cache_lock:
        _probe_cache['at'] = time.time()
        _probe_cache['data'] = out
    return out


def probe(key):
    return bool(probe_all().get(key, {}).get('ok'))


def invalidate():
    with _cache_lock:
        _probe_cache['at'] = 0


# ---------- 控制面 ----------

def plan(key, action, spec):
    code, obj = request('POST', key, 'plan', dict(action=action, spec=spec))
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def apply(key, action, spec, idem=''):
    code, obj = request('POST', key, 'apply', dict(action=action, spec=spec, idem=idem))
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def task(key, task_id):
    code, obj = request('GET', key, 'deployments/%s' % task_id)
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def rollback(key, task_id):
    code, obj = request('POST', key, 'deployments/%s/rollback' % task_id)
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def action(key, task_id, op):
    code, obj = request('POST', key, 'deployments/%s/action' % task_id, dict(op=op))
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def events(key, cursor=0):
    code, obj = request('GET', key, 'events?cursor=%s' % cursor)
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj


def capacity(key):
    code, obj = request('GET', key, 'capacity')
    if code != 200:
        raise ConnectorError(obj.get('error', {}).get('message', 'HTTP %s' % code))
    return obj
