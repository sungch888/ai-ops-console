#!/usr/bin/env python3
# md -> PDF converter (Chinese-safe: embeds a TrueType CJK font so the PDF renders
# Chinese everywhere, without relying on the viewer having Chinese fonts).
#
# Usage: python3 tools/md2pdf.py <in.md> <out.pdf> [--landscape]
import argparse
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

# ---------------------------------------------------------------- font selection
# The PDF is only portable if a Chinese TrueType (glyf) font is embedded.
# Normal weight: WenQuanYi Micro Hei (thinner strokes).  Bold: WenQuanYi Zen Hei
# (heavier strokes).  Mono: Zen Hei Mono so code blocks keep CJK glyphs.
SEARCH_DIRS = [os.environ.get('CJK_FONT_DIR', ''), '/root/workspace/.fonts',
               '/usr/share/fonts/truetype/wqy', '/usr/share/fonts', '/system/fonts']
NAMES = {'normal': ('wqy-microhei.ttc', 0), 'bold': ('wqy-zenhei.ttc', 0), 'mono': ('wqy-zenhei.ttc', 1)}


def find_font(name):
    fname, index = NAMES[name]
    for d in SEARCH_DIRS:
        if not d:
            continue
        for dirpath, _dirs, files in os.walk(d):
            if fname in files:
                return os.path.join(dirpath, fname), index
    for d in SEARCH_DIRS:
        if not d:
            continue
        for dirpath, _dirs, files in os.walk(d):
            for f in files:
                if f.endswith(('.ttc', '.ttf')) and re.search(r'zenhei|microhei|fallback', f, re.I):
                    return os.path.join(dirpath, f), 0
    return None, 0


def register_font(role, alias):
    path, index = find_font(role)
    if not path:
        sys.exit('未找到可嵌入的中文字体（TrueType）。请先执行：apt-get install -y fonts-wqy-zenhei fonts-wqy-microhei')
    kw = {'subfontIndex': index} if path.endswith('.ttc') else {}
    try:
        pdfmetrics.registerFont(TTFont(alias, path, **kw))
    except Exception as e:
        sys.exit('字体 %s 无法嵌入 PDF（%s）。该字体可能是 PostScript 轮廓，换用文泉驿字体。' % (path, e))
    return path


FONT_PATHS = {}
FONT_PATHS['normal'] = register_font('normal', 'CJK')
try:
    FONT_PATHS['bold'] = register_font('bold', 'CJKb')
except SystemExit:
    FONT_PATHS['bold'] = FONT_PATHS['normal']
try:
    FONT_PATHS['mono'] = register_font('mono', 'CJKm')
except SystemExit:
    FONT_PATHS['mono'] = FONT_PATHS['normal']
pdfmetrics.registerFontFamily('CJK', normal='CJK', bold='CJKb', italic='CJK', boldItalic='CJKb')
FONT_LABEL = 'WenQuanYi Micro Hei + Zen Hei'
MONO = 'CJKm'

INK = colors.HexColor('#1B2733')
HEAD = colors.HexColor('#0B3C6E')
SUBHEAD = colors.HexColor('#124F8C')
FAINT = colors.HexColor('#5A6B7C')
LINE = colors.HexColor('#C3D2E2')
ROWBG = colors.HexColor('#F2F6FB')
HEADBG = colors.HexColor('#1F4E79')

def styles():
    s = getSampleStyleSheet()
    def add(name, size, color, bold_space, leading=None, left=0):
        s.add(ParagraphStyle(
            name=name, fontName='CJK', fontSize=size, textColor=color, leading=leading or size * 1.55,
            spaceBefore=bold_space[0], spaceAfter=bold_space[1], wordWrap='CJK', alignment=TA_LEFT,
            leftIndent=left, bulletIndent=0))
    add('CnTitle', 18, HEAD, (0, 10))
    add('CnH2', 13.5, HEAD, (14, 6))
    add('CnH3', 11.5, SUBHEAD, (11, 5))
    add('CnH4', 10.5, SUBHEAD, (9, 4))
    add('CnBody', 9.5, INK, (0, 4))
    for _h in ('CnTitle', 'CnH2', 'CnH3', 'CnH4'):
        s[_h].fontName = 'CJKb'
    add('CnQuote', 9.5, colors.HexColor('#33485F'), (3, 5), left=10)
    add('CnBullet', 9.5, INK, (0, 3), left=12)
    add('CnNum', 9.5, INK, (0, 3), left=14)
    add('CnCell', 8.4, INK, (0, 0), leading=11.2)
    add('CnCellHead', 8.6, colors.white, (0, 0), leading=11.4)
    add('CnCode', 8.2, colors.HexColor('#1A3B66'), (2, 6), leading=10.6)
    add('CnFooter', 7.6, FAINT, (0, 0))
    return s


ST = styles()

ESCAPE = {'&': '&amp;', '<': '&lt;', '>': '&gt;'}


def inline(text):
    """markdown inline -> reportlab mini-HTML (escape first, then mark up)."""
    out = []
    for tok in re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', text):
        if not tok:
            continue
        esc = ''.join(ESCAPE.get(c, c) for c in tok)
        if tok.startswith('**') and tok.endswith('**'):
            body = ''.join(ESCAPE.get(c, c) for c in tok[2:-2])
            out.append('<b color="#0B3C6E">%s</b>' % body)
        elif tok.startswith('`') and tok.endswith('`'):
            body = ''.join(ESCAPE.get(c, c) for c in tok[1:-1])
            out.append('<font face="%s" color="#1A3B66">%s</font>' % (MONO, body))
        else:
            out.append(esc)
    return ''.join(out)


def width_of(text):
    """Approximate rendered width in "character units" (CJK counts double)."""
    plain = re.sub(r'\*\*|`', '', text)
    return sum(2 if ord(c) > 0x2E7F else 1 for c in plain)


def make_table(rows, avail):
    cols = max(len(r) for r in rows)
    rows = [r + [''] * (cols - len(r)) for r in rows]
    # column widths: proportional to the widest cell in each column, clamped
    weights = []
    for c in range(cols):
        longest = max(width_of(r[c]) for r in rows)
        weights.append(max(6.0, min(longest, 34.0)))
    total = sum(weights)
    col_w = [avail * w / total for w in weights]
    data = [[Paragraph(inline(cell), ST['CnCellHead']) for cell in rows[0]]]
    for r in rows[1:]:
        data.append([Paragraph(inline(cell), ST['CnCell']) for cell in r])
    t = Table(data, colWidths=col_w, repeatRows=1, splitByRow=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), HEADBG),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.4, LINE),
        ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#9FB4C9')),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(('BACKGROUND', (0, i), (-1, i), ROWBG))
    t.setStyle(TableStyle(style))
    return t


class Doc(BaseDocTemplate):
    def afterPage(self):
        c, doc = self.canv, self
        c.saveState()
        c.setFont('CJK', 7.6)
        c.setFillColor(FAINT)
        c.drawString(doc.leftMargin, doc.bottomMargin - 0.75 * cm, self.title_line)
        c.drawRightString(doc.leftMargin + self.avail, doc.bottomMargin - 0.75 * cm,
                          '第 %d 页' % c.getPageNumber())
        c.setStrokeColor(LINE)
        c.line(doc.leftMargin, doc.bottomMargin - 0.55 * cm, doc.leftMargin + self.avail, doc.bottomMargin - 0.55 * cm)
        c.restoreState()


def convert(src, out, landscape_mode=False):
    title_src = ''
    for line in open(src, encoding='utf-8'):
        if line.startswith('# '):
            title_src = line[2:].strip()
            break
    page = landscape(A4) if landscape_mode else A4
    doc = Doc(out, pagesize=page, leftMargin=1.7 * cm, rightMargin=1.7 * cm,
              topMargin=1.6 * cm, bottomMargin=1.9 * cm, title=title_src or src)
    doc.title_line = (title_src or os.path.basename(src))[:60]
    doc.avail = page[0] - doc.leftMargin - doc.rightMargin
    doc.addPageTemplates([PageTemplate(id='main', frames=[Frame(
        doc.leftMargin, doc.bottomMargin, doc.avail, page[1] - doc.topMargin - doc.bottomMargin, id='f')])])

    story = []
    tbl, code_buf, in_code = [], [], False
    lines = open(src, encoding='utf-8').read().split('\n')
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        if ln.startswith('```'):
            if in_code:
                body = ''.join(ESCAPE.get(c, c) for c in code_buf)
                st = ParagraphStyle('code', parent=ST['CnCode'], fontName=MONO)
                story.append(Paragraph(body or ' ', st))
                code_buf = []
            in_code = not in_code
            i += 1
            continue
        if in_code:
            code_buf.append(ln)
            i += 1
            continue
        if ln.startswith('|') and ln.endswith('|'):
            cells = [c.strip() for c in ln.strip('|').split('|')]
            if all(re.fullmatch(r':?-{2,}:?', c) for c in cells):
                i += 1
                continue
            tbl.append(cells)
            i += 1
            continue
        if tbl:
            story.append(make_table(tbl, doc.avail))
            story.append(Spacer(1, 8))
            tbl = []
        if not ln.strip():
            i += 1
            continue
        if set(ln.strip()) == {'-'} and len(ln.strip()) >= 3:
            story.append(Spacer(1, 4))
            i += 1
            continue
        if ln.startswith('#### '):
            story.append(Paragraph(inline(ln[5:]), ST['CnH4']))
        elif ln.startswith('### '):
            story.append(Paragraph(inline(ln[4:]), ST['CnH3']))
        elif ln.startswith('## '):
            story.append(Paragraph(inline(ln[3:]), ST['CnH2']))
        elif ln.startswith('# '):
            story.append(Paragraph(inline(ln[2:]), ST['CnTitle']))
        elif ln.startswith('> '):
            story.append(Paragraph(inline(ln[2:]), ST['CnQuote']))
        elif re.match(r'^\s*\d+\.\s', ln):
            story.append(Paragraph('• ' + inline(re.sub(r'^\s*\d+\.\s', '', ln)), ST['CnNum']))
        elif re.match(r'^\s*[-*]\s', ln):
            depth = (len(ln) - len(ln.lstrip())) // 2
            st = ParagraphStyle('b2', parent=ST['CnBullet'], leftIndent=12 + 12 * depth)
            story.append(Paragraph('• ' + inline(re.sub(r'^\s*[-*]\s', '', ln)), st))
        else:
            story.append(Paragraph(inline(ln), ST['CnBody']))
        i += 1
    if tbl:
        story.append(make_table(tbl, doc.avail))

    doc.build(story)
    size = os.path.getsize(out)
    data = open(out, 'rb').read()
    embedded = b'/FontFile2' in data or b'/FontFile3' in data
    pages = data.count(b'/Type /Page') or data.count(b'/Type/Page')
    print('PDF 已生成: %s | %s 字节 | 约 %s 页 | 字体已内嵌: %s | 中文字体: %s (%s)'
          % (out, format(size, ','), pages, '是' if embedded else '否', FONT_LABEL, FONT_PATHS['normal']))
    if not embedded:
        print('警告：字体未内嵌，换设备查看可能仍缺中文')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--landscape', action='store_true', help='横向页面，适合超宽表格')
    a = ap.parse_args()
    convert(a.src, a.out, a.landscape)
