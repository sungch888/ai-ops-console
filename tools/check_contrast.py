#!/usr/bin/env python3
"""配色对比度检查（WCAG 2.1 相对亮度与对比度）。
   要求：正文 ≥ 7:1（AAA），次要 / 微弱文字 ≥ 4.5:1，面板标题 / 大数字 ≥ 7:1。
   用法：python3 tools/check_contrast.py"""
import re
import pathlib
import sys

CSS = pathlib.Path('src/theme.css').read_text(encoding='utf-8')

def block(text, start):
    i = text.index(start)
    j = text.index('}', i)
    return text[i:j]

def tokens(chunk):
    out = {}
    for m in re.finditer(r'(--[a-z0-9-]+)\s*:\s*([^;]+);', chunk):
        out[m.group(1)] = ' '.join(m.group(2).split())
    return out

def resolve(name, toks, depth=0):
    v = toks.get(name, '')
    if depth > 6:
        return v
    m = re.search(r'var\((--[a-z0-9-]+)\)', v)
    if m and 'gradient' not in v and len(v.strip()) < 40:
        return resolve(m.group(1), toks, depth + 1)
    return v

def first_color(v):
    m = re.search(r'rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)', v)
    if m:
        r, g, b = (float(m.group(i)) for i in (1, 2, 3))
        a = float(m.group(4) or 1)
        return (r, g, b, a)
    m = re.search(r'#[0-9a-fA-F]{6}', v)
    if m:
        h = m.group(0).lstrip('#')
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    return None

def last_color(v):
    cols = [c for c in re.finditer(r'rgba?\([^)]*\)|#[0-9a-fA-F]{6}', v)]
    return first_color(cols[-1].group(0)) if cols else None

def over(fg, bg):
    r, g, b, a = fg
    br, bg2, bb, _ = bg
    return (r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a), 1.0)

def lum(c):
    def f(x):
        x /= 255.0
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

THEMES = [('deep 深空蓝', tokens(block(CSS, ':root')))]
base = THEMES[0][1]
for name in ('ink', 'paper', 'govty', 'contrast'):
    chunk = block(CSS, "[data-theme='%s']" % name)
    THEMES.append((name + ' ' + {'ink': '墨青', 'paper': '纸白', 'govty': '公文灰', 'contrast': '高对比'}[name], dict(base, **tokens(chunk))))

CHECKS = [('--text', '正文', 7.0), ('--text-dim', '次要文字', 5.0), ('--text-faint', '微弱说明', 5.0),
          ('--panel-title', '面板标题', 7.0), ('--kpi-text', '大数字', 7.0),
          ('--nav-text', '侧栏项', 5.0), ('--ok-text', '绿色徽章', 4.5), ('--warn-text', '琥珀徽章', 4.5),
          ('--bad-text', '红色徽章', 4.5), ('--table-text', '表格正文', 7.0), ('--table-strong', '表格强调', 7.0),
          ('--info-text', '蓝色徽章', 4.5), ('--purple-text', '紫色徽章', 4.5), ('--warn-strong', '警示框文字', 4.5),
          ('--link-text', '标签文字', 4.5)]


# 图表（canvas）用的颜色在 src/engine/ui.ts 里单列一份，这里一并量
import json as _json
ui = pathlib.Path('src/engine/ui.ts').read_text(encoding='utf-8')
INKS = {}
for m in re.finditer(r"\n  (deep|ink|paper|govty|contrast): \{ axis: '([^']+)', label: '([^']+)'", ui):
    INKS[m.group(1)] = (m.group(2), m.group(3))

fails = 0
for label, toks in THEMES:
    page = first_color(resolve('--bg', toks)) or last_color(resolve('--page-bg', toks))
    panel_raw = resolve('--panel-grad', toks)
    panel = first_color(resolve('--bg-panel', toks)) or first_color(panel_raw) or page
    if panel and panel[3] < 1:
        panel = over(panel, page)
    side_raw = resolve('--chrome-rgb', toks)
    side = over((float(side_raw.split(',')[0]), float(side_raw.split(',')[1]), float(side_raw.split(',')[2]), 0.9), page)
    print('\n== %s ==' % label)
    for tok, cn, need in CHECKS:
        c = first_color(resolve(tok, toks))
        if not c:
            print('   ? %-10s 读不到色值' % cn); continue
        bg = side if tok == '--nav-text' else panel
        r = ratio(over(c, bg), bg)
        flag = 'ok' if r >= need else '不足'
        if r < need:
            fails += 1
        print('   %-10s %5.2f:1  (需 ≥ %.1f)  %s' % (cn, r, need, flag))
    key = label.split(' ')[0]
    if key in INKS:
        ax, lb = INKS[key]
        for nm, col, need in (('图表数据标签', lb, 7.0), ('图表坐标轴文字', ax, 4.5)):
            c = first_color(col)
            r = ratio(over(c, panel), panel) if c else 0
            if r < need:
                fails += 1
            print('   %-10s %5.2f:1  (需 ≥ %.1f)  %s' % (nm, r, need, 'ok' if r >= need else '不足'))
    b1 = first_color(resolve('--line', toks)) or (128, 128, 128, 1)
    pr = ratio(panel, page)
    br = ratio(over(b1, page), page)
    print('   面板对页面 %.2f:1（需 ≥ 1.15）%s' % (pr, 'ok' if pr >= 1.15 else '不足'))
    print('   边框对页面 %.2f:1（需 ≥ 1.25）%s' % (br, 'ok' if br >= 1.25 else '不足'))
    if pr < 1.15 or br < 1.25:
        fails += 1

print('\n判定:', '通过' if fails == 0 else '有 %d 项对比度不足' % fails)
sys.exit(1 if fails else 0)
