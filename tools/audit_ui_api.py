#!/usr/bin/env python3
"""接线体检：服务端接口清单 × 界面调用清单 × 失败静默点。用法：python3 tools/audit_ui_api.py"""
import re
import pathlib

srv = pathlib.Path('server/server.py').read_text(encoding='utf-8')
METHODS = ('_api_get', '_api_put', '_api_delete', '_api_post')

def segment(name):
    i = srv.index('def %s(self' % name)
    j = len(srv)
    for other in METHODS:
        if other == name:
            continue
        k = srv.find('def %s(self' % other, i + 10)
        if k > 0:
            j = min(j, k)
    k = srv.find('def main(', i + 10)
    if k > 0:
        j = min(j, k)
    return srv[i:j]

def keys_in(block):
    out = set()
    for m in re.finditer(r"\b(?:key|name)\s*==\s*'([a-z_][a-z0-9_/.,-]*)'", block):
        out.add(m.group(1))
    for m in re.finditer(r"\b(?:key|name)\s*(?:not\s+in|\bin)\s*\(([^)]*)\)", block):
        out.update(re.findall(r"'([a-z_][a-z0-9_/.,-]*)'", m.group(1)))
    for m in re.finditer(r"\b(?:key|name)\.startswith\(\s*'([a-z_][a-z0-9_/.,-]*)'", block):
        out.add(m.group(1) + '…')
    return out

ROUTES = {v: keys_in(segment(n)) for v, n in
          (('GET', '_api_get'), ('POST', '_api_post'), ('PUT', '_api_put'), ('DELETE', '_api_delete'))}
# 通用查询层（TABLE_OF）也算 GET 接口
m = re.search(r"TABLE_OF = \{(.*?)\}\n", srv, re.S)
if m:
    ROUTES['GET'] |= set(re.findall(r"'([a-z_]+)'", m.group(1)))
    ROUTES['GET'] |= {k for k in re.findall(r"'([a-z_]+)':", m.group(1))}

client, silent = {}, []
for f in sorted(pathlib.Path('src').rglob('*')):
    if f.suffix not in ('.ts', '.tsx'):
        continue
    lines = f.read_text(encoding='utf-8').split('\n')
    for n, line in enumerate(lines):
        for m in re.finditer(r"api(Get|Send|Delete)\(\s*(?:'([A-Z]+)'\s*,\s*)?'([^']+)'", line):
            verb = m.group(2) or {'Get': 'GET', 'Send': 'POST', 'Delete': 'DELETE'}[m.group(1)]
            path = m.group(3).split('?')[0].strip('/')
            client.setdefault(verb + ' ' + path, []).append('%s:%d' % (f, n + 1))
            ctx = '\n'.join(lines[max(0, n - 25):n + 25])
            if '.catch' not in ctx and 'catch' not in ctx and 'try' not in ctx:
                silent.append('%s:%d → %s %s' % (f, n + 1, verb, path))
        for m in re.finditer(r"fetch\(\s*(?:API_BASE|BASE)\s*\+\s*'([^']+)'", line):
            p = m.group(1).split('?')[0].strip('/')
            verb = 'POST' if p in ('login', 'logout') else 'GET'
            client.setdefault(verb + ' ' + p, []).append('%s:%d(fetch)' % (f, n + 1))

def exists(verb, path):
    seg = ROUTES[verb]
    if path in seg or path.startswith('state/'):
        return True
    return any(p.endswith('…') and path.startswith(p[:-1]) for p in seg)

print('=== 1) 界面调用但服务端没有这个接口（点了没反应）===')
bad = [(k, w) for k, w in sorted(client.items()) if not exists(*k.split(' ', 1))]
for k, w in bad:
    print('  ✗', k, '|', '; '.join(w[:2]))
print('  不匹配 %d 条' % len(bad))

print('\n=== 2) 调用处附近没有错误处理（失败静默）===')
for s in silent:
    print('  ⚠', s)
print('  共 %d 处' % len(silent))

print('\n=== 3) 服务端有写接口但界面没有入口 ===')
used = {k.split(' ', 1)[1] for k in client}
for verb in ('POST', 'PUT', 'DELETE'):
    for key in sorted(ROUTES[verb]):
        if key.endswith('…') or key in ('state/bulk', 'reset', 'seed'):
            continue
        if key not in used:
            print('  ·', verb, key)

print('\n界面调用 %d 类 | 服务端 GET %d / POST %d / PUT %d / DELETE %d' %
      (len(client), len(ROUTES['GET']), len(ROUTES['POST']), len(ROUTES['PUT']), len(ROUTES['DELETE'])))
