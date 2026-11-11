#!/usr/bin/env python3
"""核对 src/panelCatalog.ts 与各页源码里的 <Panel title=…> 是否漂移；
   并核对默认白名单（FOCUS_PANELS）里的关键词都能在目录里找到。"""
import re, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
cat = (ROOT / 'src' / 'panelCatalog.ts').read_text(encoding='utf-8')
CAT = {}
for m in re.finditer(r"^\s*'(/[^']*)': \[([^\]]*)\]", cat, re.M):
    CAT[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))

view = (ROOT / 'src' / 'engine' / 'view.ts').read_text(encoding='utf-8')
i = view.index('export const FOCUS_PANELS'); j = view.index('const KEY =', i)
FOCUS = {}
for m in re.finditer(r"'(/[^']*)': \[([^\]]*)\]", view[i:j]):
    FOCUS[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))

PAT = re.compile(r"<Panel(?:(?!<Panel).){0,420}?title=(?:\"([^\"]{2,60})\"|'([^']{2,60})'|\{\s*'([^']{2,60})')", re.S)
# S4 起侧栏菜单由 routeTable 派生，navCatalog 里已没有字面 to: —— 菜单入口改为读路由表
rt = (ROOT / 'src' / 'routeTable.ts').read_text(encoding='utf-8')
pages = dict.fromkeys(re.findall(r"\{ path: '([^']+)'", rt))
pages['/more'] = True

bad = 0
for path in pages:
    src_files = list((ROOT / 'src' / 'pages').rglob('*.tsx'))
    # 目录里有的页，找出对应源码文件：按 NAV 里 to 的层级猜文件名不可靠，改为扫描所有页面文件比对标题集合
pass

def titles_of(text):
    out = []
    for m in PAT.finditer(text):
        t = (m.group(1) or m.group(2) or m.group(3)).strip()
        for cut in ('（', ' · ', '，'):
            if cut in t and len(t) > 12:
                t = t.split(cut)[0]
                break
        if t and t not in out:
            out.append(t)
    return out

by_file = {}
for f in (ROOT / 'src' / 'pages').rglob('*.tsx'):
    by_file[str(f.relative_to(ROOT))] = titles_of(f.read_text(encoding='utf-8'))

gen = (ROOT / 'tools' / 'gen_panel_catalog.py').read_text(encoding='utf-8')
mapping = dict(re.findall(r"'(/[^']+)':\s*'([^']+)'", gen))
for path, rel in mapping.items():
    want = CAT.get(path)
    got_all = by_file.get(rel, [])
    if want is None:
        if got_all:
            print('缺目录:', path, '（页面有 %d 块面板却没生成目录，重跑 tools/gen_panel_catalog.py）' % len(got_all)); bad += 1
        continue  # 这一页没有可配的面板（标题是动态变量），不算漂移
    got = by_file.get(rel, [])
    if set(want) != set(got):
        miss = [x for x in got if x not in want]
        extra = [x for x in want if x not in got]
        print('漂移 %s (%s)' % (path, rel))
        if miss: print('    页面新增、目录没有:', miss)
        if extra: print('    目录有、页面没有:', extra)
        bad += 1

for path, keys in FOCUS.items():
    if path not in CAT:
        print('白名单页不在目录里:', path); bad += 1; continue
    for k in keys:
        if not any(k in t or t in k for t in CAT[path]):
            print('白名单关键词找不到对应面板: %s → %s' % (path, k)); bad += 1

for path in FOCUS:
    if path not in pages:
        print('白名单里的页不在菜单里:', path); bad += 1

print('面板目录核对:', '通过（%d 页 / 白名单关键词 %d 条）' % (len(mapping), sum(len(v) for v in FOCUS.values())) if bad == 0 else '发现 %d 处漂移' % bad)
sys.exit(1 if bad else 0)
