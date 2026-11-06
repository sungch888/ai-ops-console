#!/usr/bin/env python3
# md -> docx converter for the operation manual (subset: headings, tables, lists, code, bold, inline code)
import re, sys
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn

SRC, OUT = sys.argv[1], sys.argv[2]
doc = Document()

normal = doc.styles['Normal']
normal.font.name = 'Microsoft YaHei'
normal.font.size = Pt(10.5)
normal.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
normal.paragraph_format.space_after = Pt(4)
normal.paragraph_format.line_spacing = 1.25

for name, size, color in (('Heading 1', 17, 0x0B3C6E), ('Heading 2', 14, 0x124F8C), ('Heading 3', 12, 0x1B5FA8), ('Heading 4', 11, 0x2B5F8F)):
    st = doc.styles[name]
    st.font.name = 'Microsoft YaHei'
    st.font.size = Pt(size)
    st.font.color.rgb = RGBColor(color >> 16 & 255, color >> 8 & 255, color & 255)
    st.font.bold = True
    st.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')

for s in doc.sections:
    s.left_margin = s.right_margin = Cm(2.0)
    s.top_margin = s.bottom_margin = Cm(1.8)

MONO = ('Consolas', 'Courier New')


def add_runs(p, text):
    """inline **bold** and `code`"""
    for tok in re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', text):
        if not tok:
            continue
        if tok.startswith('**') and tok.endswith('**'):
            r = p.add_run(tok[2:-2]); r.bold = True
        elif tok.startswith('`') and tok.endswith('`'):
            r = p.add_run(tok[1:-1]); r.font.name = MONO[0]
            r.font.color.rgb = RGBColor(0x1A, 0x3B, 0x66)
        else:
            p.add_run(tok)


def flush_table(rows):
    if not rows:
        return
    body = rows
    head, *rest = body
    cols = len(head)
    t = doc.add_table(rows=1, cols=cols)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, cell in enumerate(head):
        p = t.rows[0].cells[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        add_runs(p, cell)
        for r in p.runs:
            r.bold = True
            r.font.size = Pt(9.5)
            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shd = t.rows[0].cells[i]._tc.get_or_add_tcPr()
        el = shd.makeelement(qn('w:shd'), {qn('w:val'): 'clear', qn('w:fill'): '1F4E79'})
        shd.append(el)
    for row in rest:
        cells = t.add_row().cells
        for i in range(cols):
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            add_runs(p, row[i] if i < len(row) else '')
            for r in p.runs:
                r.font.size = Pt(9.5)
    doc.add_paragraph()


lines = open(SRC, encoding='utf-8').read().split('\n')
i = 0
tbl = []
in_code = False
code_buf = []
while i < len(lines):
    ln = lines[i].rstrip()
    if ln.startswith('```'):
        if in_code:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            r = p.add_run('\n'.join(code_buf))
            r.font.name = MONO[0]
            r.font.size = Pt(9)
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
        if all(re.fullmatch(r':?-{2,}:?|', c) for c in cells):
            i += 1
            continue
        tbl.append(cells)
        i += 1
        continue
    if tbl:
        flush_table(tbl); tbl = []
    if not ln.strip():
        i += 1
        continue
    if ln.startswith('---') and set(ln.strip()) == {'-'}:
        i += 1
        continue
    if ln.startswith('#### '):
        doc.add_heading('', level=4).add_run(ln[5:].replace('**', ''))
    elif ln.startswith('### '):
        doc.add_heading('', level=3).add_run(ln[4:].replace('**', ''))
    elif ln.startswith('## '):
        doc.add_heading('', level=2).add_run(ln[3:].replace('**', ''))
    elif ln.startswith('# '):
        h = doc.add_heading('', level=1)
        r = h.add_run(ln[2:].replace('**', ''))
        r.font.size = Pt(20)
    elif ln.startswith('> '):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.5)
        add_runs(p, ln[2:])
        for r in p.runs:
            r.italic = True
            r.font.color.rgb = RGBColor(0x33, 0x4A, 0x66)
    elif re.match(r'^\s*\d+\.\s', ln):
        p = doc.add_paragraph(style='List Number')
        add_runs(p, re.sub(r'^\s*\d+\.\s', '', ln))
    elif re.match(r'^\s*[-*]\s', ln):
        depth = len(ln) - len(ln.lstrip())
        p = doc.add_paragraph(style='List Bullet 2' if depth >= 2 else 'List Bullet')
        add_runs(p, re.sub(r'^\s*[-*]\s', '', ln))
    else:
        p = doc.add_paragraph()
        add_runs(p, ln)
    i += 1
if tbl:
    flush_table(tbl)

doc.save(OUT)
print('已生成 Word:', OUT)
