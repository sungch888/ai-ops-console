# -*- coding: utf-8 -*-
"""池借还两条新动作冒烟（隔离库 /tmp/opctl_pool.db，端口 9201-9205 / 3954）"""
import json, os, subprocess, time, urllib.request, urllib.error
from http.cookiejar import CookieJar

ROOT = '/root/workspace/ai-ops-demo'
OKN = [0]
def ck(n, c, e=''):
    OKN[0] += 1 if c else 0
    print(('PASS ' if c else 'FAIL ') + n + (('  ' + e) if e else ''))

def http(method, url, body=None, timeout=4):
    d = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(url, data=d, method=method); r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')
    except Exception as e:
        return 0, {'error': {'message': str(e)}}

env = dict(os.environ, SIM_PORT_BASE='9201', SIM_STEP='1.2', SIM_K8S_WRITE='1')
sim = subprocess.Popen(['python3', '-u', 'sim/connectors.py', '--host', '127.0.0.1'], cwd=ROOT, env=env,
                       stdout=open('/tmp/simp.log', 'w'), stderr=subprocess.STDOUT)
for _ in range(40):
    st, _b = http('GET', 'http://127.0.0.1:9205/healthz')
    if st == 200:
        break
    time.sleep(0.2)
time.sleep(0.4)
st, pr = http('GET', 'http://127.0.0.1:9205/v1/probe')
ck('K8s 通道写权限开启（SIM_K8S_WRITE）', '已有' in str(pr['capabilities'].get('k8s_write', {})))

env2 = dict(os.environ, OPCTL_SIM_PORT_BASE='9201')
srv = subprocess.Popen(['python3', '-u', 'server.py', '--port', '3954', '--host', '127.0.0.1',
                        '--db', '/tmp/opctl_pool.db'], cwd=ROOT + '/server', env=env2,
                       stdout=open('/tmp/poolsrv.log', 'w'), stderr=subprocess.STDOUT)
for _ in range(40):
    st, _b = http('GET', 'http://127.0.0.1:3954/api/health')
    if st == 200:
        break
    time.sleep(0.2)

BASE = 'http://127.0.0.1:3954'
def mk(): return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
def call(op, method, path, body=None, csrf=None):
    d = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=d, method=method); r.add_header('Content-Type', 'application/json')
    if csrf: r.add_header('X-CSRF-Token', csrf)
    try:
        with op.open(r, timeout=10) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read().decode() or '{}')
def signin(u, p, np):
    o = mk(); call(o, 'POST', '/api/login', {'username': u, 'password': p})
    st, s = call(o, 'GET', '/api/session'); c = s.get('csrf', '')
    call(o, 'POST', '/api/password/change', {'old_password': p, 'new_password': np}, c)
    o = mk(); call(o, 'POST', '/api/login', {'username': u, 'password': np})
    st, s = call(o, 'GET', '/api/session')
    return o, s.get('csrf', '')

admin, csa = signin('admin', 'admin123', 'Admin@2026x')
ops, cs2 = signin('ops', 'ops123', 'Ops@2026x')
ops2, cs3 = signin('ops2', 'ops123', 'Ops2@2026x')

print('== OC-E-11 可回收额度（双人 → K8s 配额写） ==')
st, pc = call(ops, 'POST', '/api/opctl/precheck', {'code': 'OC-E-11', 'target': '夜间可借额度 ×2卡', 'params': {'reclaim_cards': '2'}}, cs2)
st, sub = call(ops, 'POST', '/api/opctl/submit', {'code': 'OC-E-11', 'target': '夜间可借额度 ×2卡',
                 'params': {'reclaim_cards': '2'}, 'precheckId': pc.get('precheckId')}, cs2)
oid = sub.get('id'); ck('E-11 提交', bool(oid), str(oid))
st, ap = call(admin, 'POST', '/api/opctl/approve', {'id': oid, 'note': '三属性齐全，同意发放'}, csa)
ck('E-11 审批', ap.get('ok'), (ap.get('reason') or '')[:50])
st, ex = call(ops, 'POST', '/api/opctl/execute', {'id': oid}, cs2)
ck('E-11 执行→待复核（不下发）', ex.get('ok') and any(x['id'] == oid and x['status'] == '待复核' for x in ex['state']['ops']))
st, rv = call(ops2, 'POST', '/api/opctl/review', {'id': oid}, cs3)
row = [x for x in rv['state']['ops'] if x['id'] == oid][0]
ck('E-11 复核后写 K8s 配额（真实回执）', rv.get('ok') and row.get('externalRef', '').startswith('EXT-K8S'), row.get('externalRef', ''))
time.sleep(2.5)
st, s1 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
st, s2 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
ck('E-11 两段过 → 已生效', s2.get('ok') and any(x['id'] == oid and x['status'] == '已生效' for x in s2['state']['ops']))

print('== OC-F-08 弹性借还（策略自动 → CubeStudio lend 5 段） ==')
st, pc = call(ops, 'POST', '/api/opctl/precheck', {'code': 'OC-F-08', 'target': 'Qwen 高保池借用 2 卡（夜间）', 'params': {'cards': '2', 'grace': '600'}}, cs2)
st, sub = call(ops, 'POST', '/api/opctl/submit', {'code': 'OC-F-08', 'target': 'Qwen 高保池借用 2 卡（夜间）',
                 'params': {'cards': '2', 'grace': '600'}, 'precheckId': pc.get('precheckId')}, cs2)
oid2 = sub.get('id')
st, ap2 = call(admin, 'POST', '/api/opctl/approve', {'id': oid2, 'note': '策略 AP-01 边界内，排队执行'}, csa)
st, ex = call(ops, 'POST', '/api/opctl/execute', {'id': oid2}, cs2)
ck('F-08 免审批直发（运营任务单+预约号）', ex.get('ok') and any(x['id'] == oid2 and x['status'] == '执行中' for x in ex['state']['ops']))
okall = True
for i in range(5):
    for _try in range(8):
        st, s = call(ops, 'POST', '/api/opctl/stage', {'id': oid2, 'ok': True}, cs2)
        if s.get('ok'):
            break
        time.sleep(0.8)
    okall = okall and bool(s.get('ok'))
ck('F-08 五段以执行体回报逐段放行 → 已生效',
   okall and any(x['id'] == oid2 and x['status'] == '已生效' for x in s['state']['ops']))
st, stt = call(admin, 'GET', '/api/opctl/state')
row2 = [x for x in stt.get('ops', []) if x['id'] == oid2][0]
ck('F-08 分段名已对齐执行体', row2['stages'][0]['name'] == '预约', json.dumps([x['name'] for x in row2['stages']], ensure_ascii=False))

print('== OC-F-09 换池禁紧急通道 ==')
st, g6 = call(ops, 'POST', '/api/opctl/submit', {'code': 'OC-F-09', 'target': '节点 sim-cubestudio-03', 'params': {}, 'precheckId': 'X', 'urgent': True}, cs2)
ck('F-09 紧急通道被拒', not g6.get('ok') and '紧急' in (g6.get('reason') or ''), (g6.get('reason') or '')[:50])

sim.kill(); srv.kill()
print('\n%d PASS' % OKN[0])
