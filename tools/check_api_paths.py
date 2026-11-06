#!/usr/bin/env python3
"""防呆检查：前端调用路径不能带 /api 前缀（API_BASE 已经是 /api，多写一层会打到 /api/api/… → 404 且不落审计）。"""
import re, sys, pathlib
bad = []
for f in pathlib.Path('src').rglob('*'):
    if f.suffix not in ('.ts', '.tsx'):
        continue
    src = f.read_text(encoding='utf-8')
    for m in re.finditer(r"api(Get|Send|Delete)\(\s*('POST'|'PUT'|'DELETE'|'GET')?\s*,?\s*'(/api/[^']+)'", src):
        bad.append('%s:%s' % (f, m.group(3)))
    for m in re.finditer(r"fetch\(BASE\s*\+\s*'(/api/[^']+)'", src):
        bad.append('%s:%s' % (f, m.group(1)))
if bad:
    print('发现多写一层 /api 的调用（会 404）：')
    for b in bad: print('  ', b)
    sys.exit(1)
print('前端接口路径检查：无重复 /api 前缀')
