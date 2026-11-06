#!/usr/bin/env python3
"""Download a Chinese TrueType (glyf) font so md2pdf.py can embed it into PDFs.

Why: the PDF is only portable when the Chinese font is embedded inside it. If the
document names 微软雅黑 / Microsoft YaHei and the viewer (phone WPS, an online
converter, a PC without Chinese fonts) cannot find that font, the Chinese text
comes out blank in the converted PDF.

Only WenQuanYi packages are used here: they ship TrueType outlines (glyf), which
PDF writers can subset and embed. Noto CJK on Android ships CFF2 outlines, which
reportlab cannot embed.

Usage: python3 tools/get_cjk_font.py [--dest DIR]     (default: <repo>/.fonts)
"""
import argparse
import os
import re
import subprocess
import sys
import urllib.request

MIRROR = 'https://mirrors.aliyun.com/ubuntu/pool/universe/f/'
PKGS = ('fonts-wqy-zenhei', 'fonts-wqy-microhei')


def list_debs(pkg):
    with urllib.request.urlopen(MIRROR + pkg + '/', timeout=20) as r:
        body = r.read().decode('utf-8', 'ignore')
    names = [h for h in re.findall(r'href="([^"]+\.deb)"', body) if h.endswith('.deb')]
    best = None
    for name in names:                       # skip 2 KB transitional packages
        try:
            req = urllib.request.Request(MIRROR + pkg + '/' + name, method='HEAD')
            with urllib.request.urlopen(req, timeout=25) as r:
                size = int(r.headers.get('Content-Length', '0'))
        except Exception as exc:
            print('  HEAD 失败:', name, exc)
            continue
        if size > 200000 and (best is None or size < best[1]):
            best = (name, size)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dest', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', '.fonts'))
    a = ap.parse_args()
    dest = os.path.abspath(a.dest)
    os.makedirs(dest, exist_ok=True)
    have = [f for f in ('wqy-zenhei.ttc', 'wqy-microhei.ttc') if os.path.exists(os.path.join(dest, f))]
    if len(have) == 2:
        print('中文字体已就绪:', ', '.join(os.path.join(dest, f) for f in have))
        return 0
    tmp = os.path.join(dest, 'deb')
    os.makedirs(tmp, exist_ok=True)
    for pkg in PKGS:
        if os.path.exists(os.path.join(dest, 'wqy-zenhei.ttc' if 'zenhei' in pkg else 'wqy-microhei.ttc')):
            continue
        found = list_debs(pkg)
        if not found:
            sys.exit('镜像上找不到 %s 的真包（只有 2 KB 的转发包）' % pkg)
        name, size = found
        print('下载 %s (%s 字节)' % (name, format(size, ',')))
        with urllib.request.urlopen(MIRROR + pkg + '/' + name, timeout=240) as r, open(os.path.join(tmp, name), 'wb') as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        out = os.path.join(tmp, 'x')
        subprocess.run(['dpkg-deb', '-x', os.path.join(tmp, name), out], check=True)
        for dirpath, _dirs, files in os.walk(out):
            for fn in files:
                if fn.endswith(('.ttc', '.ttf')):
                    src = os.path.join(dirpath, fn)
                    dst = os.path.join(dest, fn)
                    open(dst, 'wb').write(open(src, 'rb').read())
                    print('  取出', fn, format(os.path.getsize(dst), ','), '字节')
    for f in ('wqy-zenhei.ttc', 'wqy-microhei.ttc'):
        if os.path.exists(os.path.join(dest, f)):
            print('可用:', os.path.join(dest, f))
        else:
            print('缺:', f)
    return 0


if __name__ == '__main__':
    sys.exit(main())
