# -*- coding: utf-8 -*-
"""连接器模拟环境 + opctl 内核接线 端到端测试（隔离库 /tmp/opctl_sim.db，端口 9201-9205 / 3953）"""
import json, os, subprocess, time, urllib.request, urllib.error
from http.cookiejar import CookieJar

ROOT = '/root/workspace/ai-ops-demo'
SIM_BASE = 9201
PORTS = {'gpuworks': 9201, 'gpustack': 9202, 'cubestudio': 9203, 'gateway': 9204, 'k8s': 9205}
OK = [0]

def ck(name, cond, extra=''):
    OK[0] += 1 if cond else 0
    print(('PASS ' if cond else 'FAIL ') + name + (('  ' + extra) if extra else ''))

def http(method, url, body=None, timeout=4):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method); r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')
    except Exception as e:
        return 0, {'error': {'message': str(e)}}

# ---------- 起模拟环境 ----------
env = dict(os.environ, SIM_PORT_BASE=str(SIM_BASE), SIM_STEP='1.2')
sim = subprocess.Popen(['python3', '-u', 'sim/connectors.py', '--host', '127.0.0.1'],
                       cwd=ROOT, env=env, stdout=open('/tmp/sim.log', 'w'), stderr=subprocess.STDOUT)
for p in PORTS.values():
    for _ in range(40):
        st, _b = http('GET', 'http://127.0.0.1:%d/healthz' % p)
        if st == 200:
            break
        time.sleep(0.2)
print('== A. 模拟环境 10 接口 ==')
for k, p in PORTS.items():
    st, b = http('GET', 'http://127.0.0.1:%d/v1/probe' % p)
    ck('probe %s' % k, st == 200 and b.get('connector') == k and b.get('capabilities'))

st, cap = http('GET', 'http://127.0.0.1:9201/v1/capacity')
ck('gpuworks capacity 有余量', st == 200 and cap['free_cards'] >= 8)
st, pl = http('POST', 'http://127.0.0.1:9201/v1/plan', {'action': 'deploy', 'spec': {'cards': 2}})
ck('gpuworks plan ok', st == 200 and pl['ok'])
st, a1 = http('POST', 'http://127.0.0.1:9201/v1/apply', {'action': 'deploy', 'spec': {'cards': 2}, 'idem': 'T-CONN-1'})
st, a2 = http('POST', 'http://127.0.0.1:9201/v1/apply', {'action': 'deploy', 'spec': {'cards': 2}, 'idem': 'T-CONN-1'})
ck('apply 幂等（T12）', a1.get('ext_txn_id') == a2.get('ext_txn_id') and a2.get('replayed'),
   a1.get('ext_txn_id', ''))
tid = a1['task_id']
time.sleep(5.0)
st, t = http('GET', 'http://127.0.0.1:9201/v1/deployments/' + tid)
ck('任务 4 分段全部完成', st == 200 and t['status'] == '运行中' and all(s['state'] == '完成' for s in t['stages']))
http('POST', 'http://127.0.0.1:9201/v1/sim/fail', {'scenario': 'stuck', 'index': 1})
st, b = http('POST', 'http://127.0.0.1:9201/v1/apply', {'action': 'deploy', 'spec': {'cards': 2}, 'idem': 'T-CONN-2'})
time.sleep(2.6)
st, t2 = http('GET', 'http://127.0.0.1:9201/v1/deployments/' + b['task_id'])
ck('注入卡段：第 2 段不完成', t2['stages'][1]['state'] != '完成' and '卡住' in t2.get('last_error', ''))
http('POST', 'http://127.0.0.1:9201/v1/sim/fail', {'scenario': 'node_down', 'node': 'N-2'})
st, inv = http('GET', 'http://127.0.0.1:9201/v1/inventory')
ck('注入节点故障 + 事件', any(n['health'] == '故障' for n in inv['nodes']))
st, ev = http('GET', 'http://127.0.0.1:9201/v1/events?cursor=0')
ck('events 游标', ev.get('next_cursor', 0) >= 3 and bool(ev.get('events')), json.dumps(ev, ensure_ascii=False)[:90])
http('POST', 'http://127.0.0.1:9201/v1/sim/fail', {'scenario': 'clear'})

st, g1 = http('POST', 'http://127.0.0.1:9204/v1/gateway/keys', {'app': '测试应用', 'rpm': 300, 'idem': 'G-1'})
st, gt = http('GET', 'http://127.0.0.1:9204/v1/deployments/' + g1['task_id'])
time.sleep(3.8)
st, gt = http('GET', 'http://127.0.0.1:9204/v1/deployments/' + g1['task_id'])
kid = gt['result']['key_id']
st, ks = http('GET', 'http://127.0.0.1:9204/v1/gateway/keys')
ck('网关发 Key → 3 段生效 → 状态有效', gt['status'] == '运行中' and
   any(k['key_id'] == kid and k['status'] == '有效' for k in ks['keys']))
st, up = http('PUT', 'http://127.0.0.1:9204/v1/gateway/keys/' + kid, {'rpm': 500})
ck('PUT 改配额', st == 200 and up['key']['rpm'] == 500)

st, a501 = http('POST', 'http://127.0.0.1:9202/v1/deployments/x/action', {'op': 'sleep'})
ck('GPUStack 无休眠（501）', st == 501)
st, pl2 = http('POST', 'http://127.0.0.1:9203/v1/plan', {'action': 'train', 'spec': {'cards': 9}})
ck('CubeStudio 训练单 >8 卡拒绝', st == 200 and not pl2['ok'])
st, a501b = http('POST', 'http://127.0.0.1:9205/v1/apply', {'action': 'quota', 'spec': {}})
ck('K8s 写默认关闭（501）', st == 501)

# ---------- 起演示服务端 ----------
env2 = dict(os.environ, OPCTL_SIM_PORT_BASE=str(SIM_BASE))
srv = subprocess.Popen(['python3', '-u', 'server.py', '--port', '3953', '--host', '127.0.0.1',
                        '--db', '/tmp/opctl_sim.db'],
                       cwd=ROOT + '/server', env=env2, stdout=open('/tmp/sim_srv.log', 'w'), stderr=subprocess.STDOUT)
for _ in range(40):
    st, _b = http('GET', 'http://127.0.0.1:3953/api/health')
    if st == 200:
        break
    time.sleep(0.2)

BASE = 'http://127.0.0.1:3953'
def mk(): return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
def call(op, method, path, body=None, csrf=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method); r.add_header('Content-Type', 'application/json')
    if csrf: r.add_header('X-CSRF-Token', csrf)
    try:
        with op.open(r, timeout=10) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read().decode() or '{}')
def signin(u, p, newpw):
    o = mk(); call(o, 'POST', '/api/login', {'username': u, 'password': p})
    st, s = call(o, 'GET', '/api/session'); csrf = s.get('csrf', '')
    call(o, 'POST', '/api/password/change', {'old_password': p, 'new_password': newpw}, csrf)
    o = mk(); call(o, 'POST', '/api/login', {'username': u, 'password': newpw})
    st, s = call(o, 'GET', '/api/session'); csrf = s.get('csrf', '')
    return o, csrf

print('== B. opctl 内核接线（OC-D-03 走网关连接器） ==')
admin, csa = signin('admin', 'admin123', 'Admin@2026x')
ops, cs2 = signin('ops', 'ops123', 'Ops@2026x')
ops2, cs3 = signin('ops2', 'ops123', 'Ops2@2026x')
st, pc = call(ops, 'POST', '/api/opctl/precheck', {'code': 'OC-D-03', 'target': 'SK-连接器-01', 'params': {'rpm': '300'}}, cs2)
st, sub = call(ops, 'POST', '/api/opctl/submit', {'code': 'OC-D-03', 'target': 'SK-连接器-01',
                 'params': {'rpm': '300'}, 'precheckId': pc.get('precheckId')}, cs2)
oid = sub.get('id')
st, ap = call(admin, 'POST', '/api/opctl/approve', {'id': oid, 'note': '核对审批范围与授权值，同意'}, csa)
ck('admin 审批', ap.get('ok'))
st, ex = call(ops, 'POST', '/api/opctl/execute', {'id': oid}, cs2)
ck('execute → 待复核（双人未放行不下发）', ex.get('ok') and ex['state']['ops'][0].get('id') == oid and
   any(x['id'] == oid and x['status'] == '待复核' for x in ex['state']['ops']))
# 复核前先让网关侧第 3 段卡住，验证「执行体没回报不得判过」
http('POST', 'http://127.0.0.1:9204/v1/sim/fail', {'scenario': 'stuck', 'index': 2})
st, rv = call(ops2, 'POST', '/api/opctl/review', {'id': oid}, cs3)
exts = [x for x in rv['state']['ops'] if x['id'] == oid][0]
ck('ops2 复核放行后真实下发', rv.get('ok') and exts.get('externalRef', exts.get('external_ref', '')).startswith('EXT-GATEWAY'),
   exts.get('externalRef', '') or exts.get('external_ref', ''))
time.sleep(1.4)
st, s1 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
ck('分段1 执行体已回报 → 通过', s1.get('ok'))
time.sleep(1.3)
st, s2 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
ck('分段2 通过', s2.get('ok'))
st, s3 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
ck('分段3 执行体卡住 → 拒绝人工判过', not s3.get('ok') and '尚未完成' in (s3.get('reason') or ''),
   (s3.get('reason') or '')[:40])
http('POST', 'http://127.0.0.1:9204/v1/sim/fail', {'scenario': 'clear'})
time.sleep(1.4)
st, s4 = call(ops, 'POST', '/api/opctl/stage', {'id': oid, 'ok': True}, cs2)
ck('执行体回报完成 → 分段3 通过 → 已生效', s4.get('ok') and
   any(x['id'] == oid and x['status'] == '已生效' for x in s4['state']['ops']))
st, rb = call(ops, 'POST', '/api/opctl/rollback', {'id': oid}, cs2)
ck('回退透传到执行体（Key 已吊销）', rb.get('ok'))
st, ks = http('GET', 'http://127.0.0.1:9204/v1/gateway/keys')
ck('网关侧 Key 状态=已吊销', any('已吊销' == k['status'] for k in ks['keys']))
st, cn = call(admin, 'GET', '/api/opctl/connectors')
ck('connectors 探测 5 个全绿', cn.get('ok') and sum(1 for v in cn['connectors'].values() if v['ok']) == 5)

sim.kill()
time.sleep(0.4)
st, cn2 = call(admin, 'GET', '/api/opctl/connectors')
bad = [k for k, v in cn2.get('connectors', {}).items() if not v['ok']]
ck('停掉模拟环境 → connectors 显示读不到', len(bad) == 5, json.dumps({k: (v.get('ok'), (v.get('error') or '')[:18]) for k, v in cn2.get('connectors', {}).items()}, ensure_ascii=False))

sim.kill(); srv.kill()
print('\n%d PASS' % OK[0])
