#!/usr/bin/env python3
"""从各页源码里抓出真实面板标题，生成 src/panelCatalog.ts（配置中心据此出勾选框）。
   动态标题（title={'时延趋势（' + x + '）'}）只取前缀，匹配时按"包含"判断。"""
import re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = {
 '/': 'src/pages/overview.tsx', '/govern': 'src/pages/govern.tsx', '/more': 'src/pages/more.tsx',
 '/account': 'src/pages/account.tsx', '/briefing': 'src/pages/briefing.tsx', '/network': 'src/pages/network.tsx',
 '/compute/overview': 'src/pages/compute/overview.tsx', '/compute/schedule': 'src/pages/compute/schedule.tsx',
 '/compute/storage': 'src/pages/compute/storage.tsx', '/compute/exceptions': 'src/pages/compute/exceptions.tsx',
 '/compute/cards': 'src/pages/compute/cards.tsx',
 '/model/deploy': 'src/pages/model/deploy.tsx', '/model/assets': 'src/pages/model/assets.tsx',
 '/model/monitor': 'src/pages/model/monitor.tsx', '/model/gateway': 'src/pages/model/gateway.tsx',
 '/model/litellm': 'src/pages/model/litellm.tsx', '/model/engine': 'src/pages/model/engine.tsx',
 '/model/credentials': 'src/pages/model/credentials.tsx', '/model/personal': 'src/pages/model/personal.tsx',
 '/model/fineTune': 'src/pages/model/fineTune.tsx', '/model/trace': 'src/pages/model/trace.tsx',
 '/model/audit': 'src/pages/model/audit.tsx', '/model/security': 'src/pages/model/security.tsx',
 '/model/safety-flow': 'src/pages/model/safetyFlow.tsx',
 '/app/market': 'src/pages/app/market.tsx', '/app/agents': 'src/pages/app/agents.tsx', '/app/kb': 'src/pages/app/kb.tsx',
 '/app/tools': 'src/pages/app/tools.tsx', '/app/templates': 'src/pages/app/templates.tsx',
 '/app/security': 'src/pages/app/security.tsx', '/app/dify': 'src/pages/app/dify.tsx', '/app/accounts': 'src/pages/app/accounts.tsx',
 '/ops/workflow': 'src/pages/ops/workflow.tsx', '/ops/alert-rules': 'src/pages/ops/alertRules.tsx',
 '/ops/analytics': 'src/pages/ops/analytics.tsx', '/ops/records': 'src/pages/ops/records.tsx',
 '/ops/notifications': 'src/pages/ops/notifications.tsx', '/ops/integrations': 'src/pages/ops/integrations.tsx',
 '/ops/apply': 'src/pages/ops/apply.tsx', '/ops/settings': 'src/pages/ops/settings.tsx', '/ops/commands': 'src/pages/ops/commands.tsx',
}
PAT = re.compile(r"<Panel(?:(?!<Panel).){0,420}?title=(?:\"([^\"]{2,60})\"|'([^']{2,60})'|\{\s*'([^']{2,60})')", re.S)

def clean(s):
    s = s.strip()
    for cut in ('（', ' · ', '，'):
        if cut in s and len(s) > 12:
            s = s.split(cut)[0]
            break
    return s.strip()

out = ['/* 由 tools/gen_panel_catalog.py 从各页源码生成：配置中心「演示视图」据此出勾选框。',
       '   动态标题只存前缀，判断保留时按「标题包含该前缀」。跑 tools/check_focus_panels.py 会核对这里与源码是否漂移。 */',
       'export const PANEL_CATALOG: Record<string, string[]> = {']
n = 0
for path, f in PAGES.items():
    p = ROOT / f
    if not p.exists():
        continue
    src = p.read_text(encoding='utf-8')
    titles = []
    for m in PAT.finditer(src):
        t = clean(m.group(1) or m.group(2) or m.group(3))
        if t and t not in titles:
            titles.append(t)
    if not titles:
        continue
    n += len(titles)
    out.append("  '%s': [%s]," % (path, ', '.join("'%s'" % t for t in titles)))
out.append('}')
out.append('')
(ROOT / 'src' / 'panelCatalog.ts').write_text('\n'.join(out), encoding='utf-8')
print('已生成 src/panelCatalog.ts：%d 个面板标题 / %d 个页面' % (n, len([1 for l in out if l.startswith("  '")])))
