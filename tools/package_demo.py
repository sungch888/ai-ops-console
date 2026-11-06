#!/usr/bin/env python3
"""Build a portable demo zip: dist + server + collector + docs + start scripts.

    python3 tools/package_demo.py [output.zip]

Rules enforced here: zip entry names are ASCII, and .bat/.ps1/.sh bodies are ASCII
(so Windows / cmd / PowerShell never hit encoding problems). Python sources may keep
Chinese comments; console output of the data service is English.
"""
import os, shutil, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'ai-ops-demo.zip')
STAGE = os.path.join('/tmp', 'aiops-demo-stage')

# Documents kept outside the repository (owner-facing working notes). Included when present.
DL = os.environ.get('DSH_DL', '/sdcard/Download')
# Working notes kept outside the repository. Mapping lives in a JSON file so the
# public repository never references private document names:
#   DSH_DOC_MAP=/path/ext_docs.json python3 tools/package_demo.py out.zip
EXTERNAL_DOCS = {}
_map_path = os.environ.get('DSH_DOC_MAP', '')
if _map_path and os.path.exists(_map_path):
    import json
    EXTERNAL_DOCS = json.load(open(_map_path, encoding='utf-8'))
# Markdown -> Word / PDF, so the package ships formats that survive font differences.
DOC_FORMATS = ('operation-manual', 'iteration-plan', 'confirmation-list')


def build_doc_formats(stage_dir):
    made = []
    for base in DOC_FORMATS:
        src = os.path.join(stage_dir, 'docs', base + '.md')
        if not os.path.exists(src):
            continue
        for tool, suffix in (('md2docx.py', '.docx'), ('md2pdf.py', '.pdf')):
            out = os.path.join(stage_dir, 'docs', base + suffix)
            try:
                subprocess.run(['python3', os.path.join(ROOT, 'tools', tool), src, out],
                               check=True, capture_output=True)
                made.append('docs/' + base + suffix)
            except Exception as exc:
                print('skip docs/%s%s: %s' % (base, suffix, str(exc)[:100]))
    return made


DOC_MAP = {
    'docs-src/operation-manual.md': 'docs/operation-manual.md',
    'docs-src/architecture.md': 'docs/architecture.md',
    'docs-src/api-contract.md': 'docs/api-contract.md',
    'docs-src/intranet-api-checklist.md': 'docs/intranet-api-checklist.md',
}

def tracked():
    out = subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True).stdout
    return [f for f in out.split('\n') if f]

def main():
    shutil.rmtree(STAGE, ignore_errors=True)
    os.makedirs(STAGE)
    n = 0
    for f in tracked():
        if f.startswith('server/data/') or f.startswith('docs-src/'):
            continue
        dst = os.path.join(STAGE, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(ROOT, f), dst)
        if f.endswith('.sh'):
            os.chmod(dst, 0o755)
        n += 1
    dist = os.path.join(ROOT, 'dist')
    if not os.path.isfile(os.path.join(dist, 'index.html')):
        print('dist/index.html missing - run: npm run build')
        return 1
    for root, dirs, fs in os.walk(dist):
        if '.vite' in root:
            continue
        for f in fs:
            src = os.path.join(root, f)
            dst = os.path.join(STAGE, os.path.relpath(src, ROOT))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            n += 1
    for src, dst in DOC_MAP.items():
        p = os.path.join(ROOT, src)
        if not os.path.exists(p):
            continue
        dst = os.path.join(STAGE, dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(p, dst)
        n += 1
    for src, dst in EXTERNAL_DOCS.items():
        p = os.path.join(DL, src)
        if not os.path.exists(p):
            continue
        dst = os.path.join(STAGE, dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(p, dst)
        n += 1
    for extra in build_doc_formats(STAGE):
        print('built', extra)
    for d in ('server/data', 'dist/data'):
        os.makedirs(os.path.join(STAGE, d), exist_ok=True)

    entries = []
    for root, dirs, fs in os.walk(STAGE):
        if '__pycache__' in root:
            continue
        for f in fs:
            entries.append(os.path.relpath(os.path.join(root, f), STAGE).replace(os.sep, '/'))
    for e in entries:
        if any(ord(c) > 127 for c in e):
            print('non-ascii entry name:', e)
            return 1
        if e.endswith(('.bat', '.ps1', '.sh')):
            data = open(os.path.join(STAGE, e), 'rb').read()
            if any(c > 127 for c in data):
                print('non-ascii script body:', e)
                return 1
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for e in sorted(entries):
            z.write(os.path.join(STAGE, e), 'ai-ops-demo/' + e)
    check = zipfile.ZipFile(OUT)
    if check.testzip() is not None:
        print('zip CRC check failed')
        return 1
    print('packed %d files -> %s (%d bytes)' % (len(entries), OUT, os.path.getsize(OUT)))
    return 0

if __name__ == '__main__':
    sys.exit(main())
