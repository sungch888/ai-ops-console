#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
连接器局域网模拟环境：一个进程起 5 个端口，按统一 10 接口模拟
GPUWorks(9101) / GPUStack(9102) / CubeStudio(9103) / 统一对外网关(9104) / K8s(9105)。

- 接口与 docs-src/operation-connectors.md 第 1 节一一对应：
  probe / plan / apply / 任务(verify) / action / rollback / inventory / capacity / workload / gateway / events
- apply 支持幂等键（同 idem 重放返回同一回执，演示 T12「回执重复只生效一次」）
- 任务分段随时间推进（SIM_STEP 秒一段），可注入故障（卡段 / 拒单 / 节点故障 / 端口抖动）
- 仅供局域网联调演示，不是任何真实平台。

启动：python3 sim/connectors.py [--host 0.0.0.0]
自检：GET http://<host>:9101/healthz
"""
import argparse
import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STEP = float(os.environ.get('SIM_STEP', '4'))          # 每个分段耗时（秒）
TOKEN = os.environ.get('SIM_TOKEN', '')                 # 非空则校验 X-Sim-Token
PORT_BASE = int(os.environ.get('SIM_PORT_BASE', '9101'))

def now():
    return time.time()

def iso(ts):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(ts))


class Store:
    """单个连接器的全部模拟状态。"""

    def __init__(self, spec):
        self.spec = spec
        self.key = spec['key']
        self.lock = threading.RLock()
        self.tasks = {}          # task_id -> task
        self.idem = {}           # idem_key -> (task_id, ext)
        self.events = []         # 顺序数组，cursor 即下标
        self.ev_seq = 0
        self.seq = 0
        self.faults = {}         # scenario -> {until, index, note}
        self.keys = {}           # gateway: key_id -> key
        self.routes = {'chat-main': {'weight_b': 0, 'state': '生效中'}}
        self.quota = {'default': {'cpu': '200', 'mem': '800Gi', 'gpu': '16'}}
        self.nodes = [dict(
            id='N-%d' % (i + 1), host='sim-%s-%02d' % (self.key, i + 1),
            chip=spec['chips'][i % len(spec['chips'])], cards=8,
            total_gib=8 * spec['card_gib'], sn='SN-%s-%04d' % (self.key.upper(), i + 1),
            health='正常') for i in range(4)]

    # ---------- 事件 ----------
    def emit(self, kind, severity, subject, detail):
        self.ev_seq += 1
        self.events.append(dict(event_id='EV-%06d' % self.ev_seq, ts=iso(now()), source=self.key,
                                severity=severity, kind=kind, subject=subject, detail=detail))
        return self.events[-1]

    # ---------- 能力与只读 ----------
    def probe(self):
        return dict(connector=self.key, name=self.spec['name'], version=self.spec['version'],
                    base='port %d' % (PORT_BASE + self.spec['idx']),
                    capabilities=self.spec['caps'], simulated=True)

    def capacity(self):
        healthy = [n for n in self.nodes if n['health'] == '正常']
        used = 0
        for t in self.tasks.values():
            if t['kind'] in ('deploy', 'train') and t['status'] not in ('已回退',):
                used += int(t['spec'].get('cards', 0) or 0)
        total = sum(n['cards'] for n in healthy)
        return dict(schedulable=bool(healthy), total_cards=total, used_cards=used,
                    free_cards=max(total - used, 0),
                    by_chip=[{'chip': n['chip'], 'cards': n['cards'], 'health': n['health']} for n in self.nodes])

    def inventory(self):
        return dict(nodes=self.nodes)

    def workload(self):
        items = []
        for t in self.tasks.values():
            if t['kind'] in ('deploy', 'train') and t['status'] not in ('已回退',):
                items.append(dict(kind='model_instance' if t['kind'] == 'deploy' else 'train_job',
                                  id=t['id'], node='N-%s' % (abs(hash(t['id'])) % 4 + 1),
                                  cards=t['spec'].get('cards', 1), owner=t['spec'].get('owner', '未知'),
                                  status=t['status']))
        return dict(items=items)

    def ev_range(self, cursor):
        cursor = max(int(cursor or 0), 0)
        return dict(events=self.events[cursor:], next_cursor=len(self.events))

    # ---------- 控制面 ----------
    def plan(self, body):
        action = str(body.get('action') or '')
        if action not in self.spec['actions']:
            return 501, dict(error=dict(code='not_supported', message='%s 暂不能提供 %s' % (self.spec['name'], action)))
        if self.faults.get('reject_next'):
            del self.faults['reject_next']
            return 200, dict(plan_id='PLAN-rejected', ok=False,
                            checks=[dict(item='资源余量', ok=False, note='（注入故障）余量不足，放置失败')])
        cards = int(body.get('spec', {}).get('cards', 0) or 0)
        cap = self.capacity()
        ok = cards <= cap['free_cards']
        checks = [dict(item='资源余量', ok=ok, note='空闲 %s 卡 / 需求 %s 卡' % (cap['free_cards'], cards))]
        if 'train' in action and cards > 8:
            ok, _ = False, checks.append(dict(item='单申请上限', ok=False, note='训练单申请不得超过 8 卡'))
        self.seq += 1
        return 200, dict(plan_id='PLAN-%s-%04d' % (self.key, self.seq), ok=ok, checks=checks,
                         placement=[dict(node='N-%d' % (i + 1), cards=1) for i in range(min(cards, 8))])

    def apply(self, body, headers):
        idem = str(body.get('idem') or '')
        if idem and idem in self.idem:
            tid, ext = self.idem[idem]
            t = self.tasks.get(tid) or {}
            return 200, dict(ext_txn_id=ext, task_id=tid, replayed=True, stage_names=t.get('stage_names', []))
        action = str(body.get('action') or '')
        if action not in self.spec['actions']:
            return 501, dict(error=dict(code='not_supported', message='%s 暂不能提供 %s' % (self.spec['name'], action)))
        if self.faults.get('flaky_until', 0) > now():
            return 503, dict(error=dict(code='flaky', message='（注入故障）连接器暂时不可用'))
        self.seq += 1
        stages = self.spec['task_stages'].get(action) or self.spec['task_stages']['_']
        tid = 'T-%s-%04d' % (self.key, self.seq)
        ext = 'EXT-%s-%04d' % (self.key.upper(), self.seq)
        t = dict(id=tid, ext=ext, action=action, kind=self.spec['action_kind'].get(action, '_'),
                 spec=body.get('spec') or {}, created_at=now(),
                 stage_names=list(stages), status='进行中', last_error='', stuck_reason='',
                 result={}, rolled_back=False)
        self.tasks[tid] = t
        if idem:
            self.idem[idem] = (tid, ext)
        if action in ('issue_key', 'quota_key'):
            kid = body.get('key_id') or ('sk-sim-%s-%04d' % (self.key, self.seq))
            self.keys[kid] = dict(key_id=kid, app=t['spec'].get('app', '未标注'),
                                  rpm=t['spec'].get('rpm', 0), status='下发中', created_at=iso(now()))
            t['result'] = dict(key_id=kid, url='https://gw.sim/v1')
        self.emit('task_state', 'info', tid, '已受理 %s，外部回执 %s' % (action, ext))
        return 200, dict(ext_txn_id=ext, task_id=tid, replayed=False, stage_names=list(stages))

    def _advance(self, t):
        """按时间推进分段；stuck 注入会让指定段永远不完成。"""
        if t['status'] in ('运行中', '失败', '已回退'):
            return
        stuck = self.faults.get('stuck')
        done = 0
        for i in range(len(t['stage_names'])):
            if stuck and stuck.get('index') == i and (not stuck.get('for_task') or stuck.get('for_task') == t['id']):
                t['status'] = '进行中'
                t['last_error'] = '（注入故障）分段「%s」卡住：模拟 %s 侧步骤未回报' % (t['stage_names'][i], self.spec['name'])
                return
            if now() - t['created_at'] >= (i + 1) * STEP:
                done += 1
        if done >= len(t['stage_names']):
            t['status'] = '运行中'
            if t['kind'] == 'deploy':
                pass
            if 'key_id' in t['result']:
                self.keys[t['result']['key_id']]['status'] = '有效'
            self.emit('task_state', 'info', t['id'], '全部分段完成 → %s' % t['status'])

    def task(self, tid):
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return 404, dict(error=dict(code='not_found', message='找不到任务 %s' % tid))
            self._advance(t)
            stages = []
            stuck = self.faults.get('stuck')
            stuck_applies = bool(stuck) and (not stuck.get('for_task') or stuck.get('for_task') == t['id'])
            for i, name in enumerate(t['stage_names']):
                if t['status'] == '运行中':
                    st = '完成'
                elif stuck_applies and i == stuck.get('index'):
                    st = '卡住'
                elif stuck_applies and i > stuck.get('index'):
                    st = '待执行'
                else:
                    st = '完成' if now() - t['created_at'] >= (i + 1) * STEP else '进行中'
                stages.append(dict(name=name, state=st))
            return 200, dict(id=t['id'], ext_txn_id=t['ext'], action=t['action'], status=t['status'],
                             stages=stages, last_error=t['last_error'], result=t['result'],
                             rolled_back=t['rolled_back'])

    def action(self, tid, body):
        op = str(body.get('op') or '')
        if op not in self.spec['ops']:
            return 501, dict(error=dict(code='not_supported', message='%s 暂不能提供动作 %s' % (self.spec['name'], op)))
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return 404, dict(error=dict(code='not_found', message='找不到任务 %s' % tid))
            self.seq += 1
            ext = 'EXT-%s-%04d' % (self.key.upper(), self.seq)
            self.emit('task_state', 'info', tid, '动作 %s 已执行，回执 %s' % (op, ext))
            return 200, dict(ext_txn_id=ext, applied=True)

    def rollback(self, tid):
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return 404, dict(error=dict(code='not_found', message='找不到任务 %s' % tid))
            t['status'] = '已回退'
            t['rolled_back'] = True
            if 'key_id' in t['result']:
                self.keys[t['result']['key_id']]['status'] = '已吊销'
            self.seq += 1
            ext = 'EXT-%s-%04d' % (self.key.upper(), self.seq)
            self.emit('task_state', 'warn', tid, '已按变更前快照回退，回执 %s' % ext)
            return 200, dict(ext_txn_id=ext, rolled_back=True)

    def gateway_keys(self):
        return dict(keys=list(self.keys.values()))

    def sim_fault(self, body):
        sc = str(body.get('scenario') or '')
        if sc == 'reject_next':
            self.faults['reject_next'] = True
        elif sc == 'stuck':
            self.faults['stuck'] = dict(index=int(body.get('index', 1)), for_task=str(body.get('task_id') or ''))
            if body.get('task_id'):
                self.faults['stuck']['for_task'] = body['task_id']
        elif sc == 'node_down':
            nid = str(body.get('node') or 'N-1')
            for n in self.nodes:
                if n['id'] == nid:
                    n['health'] = '故障'
                    self.emit('node_health', 'critical', n['sn'], '（注入故障）节点 %s GPU 掉卡，已停止新分配' % nid)
        elif sc == 'flaky':
            self.faults['flaky_until'] = now() + float(body.get('ttl', 30))
        elif sc == 'clear':
            self.faults.clear()
            for n in self.nodes:
                n['health'] = '正常'
        else:
            return 400, dict(error=dict(code='bad_scenario', message='未知 scenario: %s' % sc))
        return 200, dict(ok=True, faults=dict(stuck=bool(self.faults.get('stuck')),
                                              flaky=self.faults.get('flaky_until', 0) > now()))


def _caps(dep='已有', sleep='已有', key='已有', traffic='已有', train='暂不能提供', k8swrite='暂不能提供'):
    def st(s, n):
        return dict(state=s, note=n)
    return dict(
        inventory=st('已有', ''), capacity=st('已有', ''), workload=st('已有', ''),
        plan=st('已有', ''), apply=st('已有', ''), verify=st('已有', ''),
        rollback=st('已有', ''), sleep_wake=st(sleep, ''), key_gateway=st(key, ''),
        traffic=st(traffic, ''), train=train if isinstance(train, str) else '已有',
        k8s_write=st(k8swrite, ''), events=st('需补采', '模拟为轮询，真实需确认 webhook'))

SPECS = [
    dict(key='gpuworks', idx=0, name='GPUWorks 模拟池', version='v0.1.0-sim',
         chips=['A100-80G', '910B4-64G'], card_gib=80,
         actions=['deploy', 'retire'], ops=['scale', 'stop', 'sleep', 'wake', 'drain', 'cordon'],
         action_kind=dict(deploy='deploy', retire='deploy'),
         task_stages=dict(deploy=['实例健康检查', '网关注册', '路由生效', '经网关试调用'],
                          retire=['入口停止', '路由清理', '关联授权清理', '台账更新'],
                          _=['执行动作', '生效校验']),
         caps=_caps()),
    dict(key='gpustack', idx=1, name='GPUStack 模拟池', version='v2.3-sim',
         chips=['A800-80G', 'L20-48G'], card_gib=80,
         actions=['deploy', 'retire'], ops=['scale', 'stop', 'drain', 'cordon'],  # 无 sleep
         action_kind=dict(deploy='deploy', retire='deploy'),
         task_stages=dict(deploy=['实例健康检查', '路由生效', '经网关试调用'],
                          retire=['入口停止', '路由清理', '台账更新'], _=['执行动作', '生效校验']),
         caps=_caps(sleep='暂不能提供', key='需计算', traffic='暂不能提供')),
    dict(key='cubestudio', idx=2, name='CubeStudio 模拟（训练）', version='v2026-sim',
         chips=['A800-80G', '910B-32G'], card_gib=80,
         actions=['train', 'lend'], ops=['stop'], action_kind=dict(train='train'),
         task_stages=dict(train=['排队', '资源就绪', '任务运行'],
                          lend=['预约', '挂起与checkpoint', '排空', '入推理池', '台账回写'], _=['执行动作']),
         caps=_caps(dep='暂不能提供', sleep='暂不能提供', key='暂不能提供', traffic='暂不能提供',
                    train='已有')),
    dict(key='gateway', idx=3, name='统一对外网关模拟', version='v1.5-sim',
         chips=['x86-vcpu'], card_gib=0,
         actions=['issue_key', 'quota_key', 'revoke_key', 'traffic'], ops=[],
         action_kind=dict(issue_key='key', quota_key='key', revoke_key='key', traffic='traffic'),
         task_stages=dict(issue_key=['生成凭证', '配额下发', '生效探测'],
                          quota_key=['网关配置下发', '复核生效'], revoke_key=['吊销凭证', '验证旧凭证失效'],
                          traffic=['策略下发', '分流验证'], _=['下发', '生效']),
         caps=_caps(dep='暂不能提供', sleep='暂不能提供', key='已有', traffic='已有')),
    dict(key='k8s', idx=4, name='K8s 受限通道模拟', version='v1.30-sim',
         chips=['节点CPU'], card_gib=0,
         actions=(['quota'] if os.environ.get('SIM_K8S_WRITE') == '1' else []), ops=[],
         action_kind=dict(quota='quota'),
         task_stages=dict(quota=['配额写入', '生效读取'], _=['下发']),
         caps=_caps(dep='暂不能提供', sleep='暂不能提供', key='暂不能提供', traffic='暂不能提供',
                    train='需计算', k8swrite='已有' if os.environ.get('SIM_K8S_WRITE') == '1' else '暂不能提供')),
]

STORES = {s['key']: Store(s) for s in SPECS}


class H(BaseHTTPRequestHandler):
    store = None  # 由子类注入

    def log_message(self, *a):  # 安静
        pass

    def _send(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}

    def _auth_ok(self):
        return (not TOKEN) or self.headers.get('X-Sim-Token') == TOKEN

    def _route(self, method):
        if not self._auth_ok():
            return self._send(401, dict(error=dict(code='unauthorized', message='缺少或错误的 X-Sim-Token')))
        u = urllib.parse.urlparse(self.path)
        parts = [p for p in u.path.split('/') if p]
        q = urllib.parse.parse_qs(u.query)
        s = self.store
        if parts == ['healthz']:
            return self._send(200, dict(status='ok', connector=s.key))
        if not parts or parts[0] != 'v1':
            return self._send(404, dict(error=dict(code='no_route', message='未知路径')))
        head = parts[1] if len(parts) > 1 else ''
        with s.lock:
            if method == 'GET':
                if head == 'probe':
                    return self._send(200, s.probe())
                if head == 'capacity':
                    return self._send(200, s.capacity())
                if head == 'inventory':
                    return self._send(200, s.inventory())
                if head == 'workload':
                    return self._send(200, s.workload())
                if head == 'events':
                    return self._send(200, s.ev_range((q.get('cursor') or ['0'])[0]))
                if head == 'gateway' and len(parts) > 2 and parts[2] == 'keys':
                    return self._send(200, s.gateway_keys())
                if head == 'deployments' and len(parts) >= 3:
                    return self._send(*s.task(parts[2]))
                if head == 'sim':
                    return self._send(200, dict(key=s.key, tasks=len(s.tasks), events=len(s.events), faults=len(s.faults)))
                return self._send(404, dict(error=dict(code='no_route', message='未知 GET')))
            if method == 'POST':
                body = self._read_body()
                if head == 'plan':
                    return self._send(*s.plan(body))
                if head == 'apply':
                    return self._send(*s.apply(body, self.headers))
                if head == 'sim' and len(parts) > 2 and parts[2] == 'fail':
                    return self._send(*s.sim_fault(body))
                if head == 'deployments' and len(parts) >= 4 and parts[3] == 'action':
                    return self._send(*s.action(parts[2], body))
                if head == 'deployments' and len(parts) >= 4 and parts[3] == 'rollback':
                    return self._send(*s.rollback(parts[2]))
                if head == 'gateway' and len(parts) > 2 and parts[2] == 'keys':
                    return self._send(*s.apply(dict(action='issue_key', spec=body, idem=body.get('idem')), self.headers))
                return self._send(404, dict(error=dict(code='no_route', message='未知 POST')))
            if method == 'PUT':
                if head == 'gateway' and len(parts) >= 4 and parts[2] == 'keys':
                    body = self._read_body()
                    kid = parts[3]
                    if kid not in s.keys:
                        return self._send(404, dict(error=dict(code='not_found', message='找不到 Key')))
                    s.keys[kid].update({k: v for k, v in body.items() if k in ('rpm', 'app')})
                    s.emit('quota_change', 'info', kid, '配额调整 rpm=%s' % s.keys[kid]['rpm'])
                    return self._send(200, dict(ok=True, key=s.keys[kid]))
                return self._send(404, dict(error=dict(code='no_route', message='未知 PUT')))
            if method == 'DELETE':
                if head == 'gateway' and len(parts) >= 4 and parts[2] == 'keys':
                    kid = parts[3]
                    if kid not in s.keys:
                        return self._send(404, dict(error=dict(code='not_found', message='找不到 Key')))
                    s.keys[kid]['status'] = '已吊销'
                    s.emit('quota_change', 'warn', kid, '凭证已吊销')
                    return self._send(200, dict(ok=True))
                return self._send(404, dict(error=dict(code='no_route', message='未知 DELETE')))
        return self._send(405, dict(error=dict(code='method', message='方法不支持')))

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def do_PUT(self):
        self._route('PUT')

    def do_DELETE(self):
        self._route('DELETE')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='0.0.0.0')
    args = ap.parse_args()
    threads = []
    for spec in SPECS:
        port = PORT_BASE + spec['idx']
        handler = type('H_%s' % spec['key'], (H,), {'store': STORES[spec['key']]})
        srv = ThreadingHTTPServer((args.host, port), handler)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        threads.append(th)
        print('  %-10s http://%s:%d  （%s）' % (spec['key'], args.host, port, spec['name']))
    print('模拟环境就绪：分段推进速度 SIM_STEP=%ss，token=%s。Ctrl-C 退出。' % (STEP, '开' if TOKEN else '关'))
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
