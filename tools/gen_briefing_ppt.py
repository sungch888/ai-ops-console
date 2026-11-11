#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成领导汇报用 PPT（逻辑架构一页纸 → 10 页幻灯片）。

用法：python3 tools/gen_briefing_ppt.py docs-src/briefing-logic-architecture.pptx
依赖：python-pptx（pip install python-pptx）
口径来源：docs-src/briefing-logic-architecture.md（数字不要在这里另写，改那份 md 后重跑本脚本）
"""
import sys
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.oxml import parse_xml

OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs-src/briefing-logic-architecture.pptx'

NAVY = RGBColor(0x0B, 0x3C, 0x6E)
BLUE = RGBColor(0x12, 0x4F, 0x8C)
ACC = RGBColor(0x1B, 0x5F, 0xA8)
LIGHT = RGBColor(0xF2, 0xF6, 0xFB)
LINE = RGBColor(0xD5, 0xDF, 0xEB)
TEXT = RGBColor(0x1A, 0x27, 0x33)
GRAY = RGBColor(0x5A, 0x6B, 0x7B)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RED = RGBColor(0xC0, 0x39, 0x2B)
AMBER = RGBColor(0xB8, 0x6E, 0x00)
GREEN = RGBColor(0x1E, 0x7A, 0x54)

FONT = '微软雅黑'
W, H = Inches(13.333), Inches(7.5)

prs = Presentation()
prs.slide_width, prs.slide_height = W, H
BLANK = prs.slide_layouts[6]


def set_font(run, size=14, bold=False, color=TEXT, name=FONT):
    f = run.font
    f.name = name
    f.size = Pt(size)
    f.bold = bold
    f.color.rgb = color
    rPr = run._r.get_or_add_rPr()
    for tag in ('a:ea', 'a:cs'):
        el = rPr.find(qn(tag))
        if el is None:
            el = parse_xml('<a:%s xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>' % tag.split(':')[1])
            rPr.append(el)
        el.set('typeface', name)


def box(slide, x, y, w, h, fill=None, line=None, shape=MSO_SHAPE.RECTANGLE, radius=None):
    sh = slide.shapes.add_shape(shape, x, y, w, h)
    if fill is None:
        sh.fill.background()
    else:
        sh.fill.solid()
        sh.fill.fore_color.rgb = fill
    if line is None:
        sh.line.fill.background()
    else:
        sh.line.color.rgb = line
        sh.line.width = Pt(1)
    sh.shadow.inherit = False
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        sh.adjustments[0] = radius
    return sh


def text(slide, x, y, w, h, items, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, space=6):
    """items: [(text, size, bold, color)] 或 [[(..),(..)]] 多段"""
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Pt(2)
    tf.margin_top = tf.margin_bottom = Pt(1)
    groups = items if items and isinstance(items[0], list) else [items]
    first = True
    for g in groups:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.alignment = align
        p.space_after = Pt(space)
        for (t, size, bold, color) in g:
            r = p.add_run()
            r.text = t
            set_font(r, size, bold, color)
    return tb


def head(slide, title, sub=None, page=None):
    box(slide, 0, 0, W, Inches(0.92), fill=NAVY)
    box(slide, 0, Inches(0.92), W, Inches(0.045), fill=ACC)
    text(slide, Inches(0.55), Inches(0.16), Inches(9.5), Inches(0.6),
         [(title, 25, True, WHITE)])
    if sub:
        text(slide, Inches(0.55), Inches(0.62), Inches(9.5), Inches(0.3),
             [(sub, 12, False, RGBColor(0xC8, 0xDA, 0xEE))])
    if page:
        text(slide, Inches(11.9), Inches(0.3), Inches(1.0), Inches(0.35),
             [(page, 12, False, RGBColor(0xC8, 0xDA, 0xEE))], align=PP_ALIGN.RIGHT)
    return slide


def foot(slide, txt='AI 算力与模型运营平台 · 逻辑架构（汇报稿）'):
    text(slide, Inches(0.55), Inches(7.02), Inches(12.2), Inches(0.3),
         [(txt, 10, False, GRAY)])


def kpi(slide, x, y, w, h, num, unit, label):
    box(slide, x, y, w, h, fill=LIGHT, line=LINE, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
    text(slide, x, y + Inches(0.14), w, Inches(0.5),
         [[(num, 26, True, ACC), ('  ' + unit, 12, False, GRAY)]], align=PP_ALIGN.CENTER)
    text(slide, x, y + h - Inches(0.44), w, Inches(0.36),
         [(label, 11.5, False, TEXT)], align=PP_ALIGN.CENTER)


def bullet_rows(slide, x, y, w, rows, size=13, gap=0.44, dot=ACC):
    for i, (t, c) in enumerate(rows):
        yy = y + Inches(gap * i)
        box(slide, x, yy + Inches(0.09), Inches(0.09), Inches(0.09), fill=dot, shape=MSO_SHAPE.OVAL)
        text(slide, x + Inches(0.22), yy, w - Inches(0.22), Inches(gap), [(t, size, False, c)])


def table(slide, x, y, w, h, data, col_w=None, head_size=12, body_size=11.5, head_fill=BLUE):
    rows, cols = len(data), len(data[0])
    gt = slide.shapes.add_table(rows, cols, x, y, w, h).table
    if col_w:
        total = sum(col_w)
        for i, cw in enumerate(col_w):
            gt.columns[i].width = Emu(int(w * cw / total))
    for ri, row in enumerate(data):
        gt.rows[ri].height = Emu(int(h / rows))
        for ci, val in enumerate(row):
            cell = gt.cell(ri, ci)
            cell.text = ''
            cell.margin_left = Pt(7)
            cell.margin_right = Pt(7)
            cell.margin_top = Pt(3)
            cell.margin_bottom = Pt(3)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            if ri == 0:
                cell.fill.fore_color.rgb = head_fill
            else:
                cell.fill.fore_color.rgb = WHITE if ri % 2 else LIGHT
            p = cell.text_frame.paragraphs[0]
            r = p.add_run()
            r.text = str(val)
            if ri == 0:
                set_font(r, head_size, True, WHITE)
            else:
                set_font(r, body_size, False, TEXT)
    return gt


def flow(slide, x, y, w, steps, box_h=0.62, size=11.5):
    n = len(steps)
    gap = Inches(0.16)
    bw = (w - gap * (n - 1)) / n
    for i, (t, sub) in enumerate(steps):
        bx = x + (bw + gap) * i
        box(slide, bx, y, bw, Inches(box_h), fill=BLUE if i % 2 == 0 else ACC,
            shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.14)
        text(slide, bx, y + Inches(0.06), bw, Inches(0.3), [(t, size, True, WHITE)], align=PP_ALIGN.CENTER)
        text(slide, bx, y + Inches(0.32), bw, Inches(0.26), [(sub, 9.5, False, RGBColor(0xD8, 0xE6, 0xF5))], align=PP_ALIGN.CENTER)
        if i < n - 1:
            text(slide, bx + bw, y + Inches(0.16), gap, Inches(0.3),
                 [('›', 16, True, GRAY)], align=PP_ALIGN.CENTER)


# ── 1 封面 ────────────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
box(s, 0, 0, W, H, fill=NAVY)
box(s, 0, Inches(4.05), W, Inches(0.05), fill=ACC)
text(s, Inches(0.9), Inches(2.0), Inches(11.5), Inches(1.0),
     [('AI 算力与模型运营平台', 40, True, WHITE)])
text(s, Inches(0.9), Inches(3.05), Inches(11.5), Inches(0.7),
     [('逻辑架构汇报', 26, False, RGBColor(0x9E, 0xC5, 0xEC))])
text(s, Inches(0.9), Inches(4.35), Inches(11.5), Inches(1.0),
     [[('三类资产统一纳管 · 运营动作闭环 · 异常处置闭环 · 平台不擅自改动外部系统', 15, False, RGBColor(0xC8, 0xDA, 0xEE))]])
text(s, Inches(0.9), Inches(6.5), Inches(11.5), Inches(0.4),
     [('演示版 v3.10　|　口径以演示版实测数据为准', 11.5, False, RGBColor(0x8F, 0xA9, 0xC6))])

# ── 2 定位与规模 ──────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '一、系统定位与规模', '面向示例单位信息网的 AI 算力与模型运营管理平台', '2')
text(s, Inches(0.55), Inches(1.15), Inches(12.2), Inches(0.6),
     [('把算力资源、模型服务、智能体应用三类资产统一纳管，用「工单 → 审批 → 执行 → 回执 → 验证 → 审计」把日常运营动作闭环，'
       '并把异常检测与处置也闭环；需要外部执行的动作一律走工单与回执，平台不擅自改动外部系统。', 14, False, TEXT)])
cards = [('5', '大业务区', '总览/算力/模型/应用/运营'), ('41', '个功能入口', '按角色权限过滤显示'),
         ('26', '张业务表', '工单·通知·审计·指标'), ('18', '个权限点', '服务端判定，前端改不动'),
         ('16', '类工单', '审批·窗口·回执·回滚'), ('6', '类例外', '旁路·缺口·异常·越界·不一致')]
for i, (n, u, l) in enumerate(cards):
    kpi(s, Inches(0.55) + (Inches(2.03) * i), Inches(2.1), Inches(1.85), Inches(1.15), n, u, l)
text(s, Inches(0.55), Inches(3.55), Inches(12.2), Inches(0.4),
     [('四条角色线', 15, True, NAVY)])
table(s, Inches(0.55), Inches(4.0), Inches(12.2), Inches(2.5), [
    ['角色', '定位', '能看到', '能操作'],
    ['平台管理员', '平台运维与授权', '全部 18 个权限点', '全部 18 个权限点（含配置与授权）'],
    ['运营值班', '日常运营与工单流转', '16 个权限点', '9 个权限点（工单、接入、告警处置）'],
    ['模型技术', '模型与凭证配置', '8 个权限点', '2 个权限点（自己的模型与凭证）'],
    ['业务用户', '业务使用与提单', '2 个权限点', '无（只提单与查看）'],
], col_w=[1.2, 2.0, 2.2, 3.4])
foot(s)

# ── 3 逻辑五层 ───────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '二、逻辑五层', '自上而下：谁能用 → 在哪用 → 怎么干 → 出事怎么办 → 数据与外部在哪', '3')
table(s, Inches(0.55), Inches(1.3), Inches(12.2), Inches(4.5), [
    ['层', '管什么', '现在有多少'],
    ['1 使用者与角色', '管理员 / 运营值班 / 模型技术 / 业务用户，按权限点决定能看什么、能改什么；权限在数据服务侧判定', '4 类角色 · 18 个权限点'],
    ['2 业务功能区', '总览、算力中心、模型中心、应用中心、运营分析', '5 大区 · 41 个功能入口'],
    ['3 运营闭环引擎', '资源池扩缩、副本与路由权重、凭证发放与吊销、配额调整、接入阻断与恢复、模型回滚与下线、部署与训练排队', '16 类工单 · 8 种状态'],
    ['4 监测与处置', '六类例外检测、四级接管深度、告警规则、整改单派单与复核', '6 类例外 · 4 级接管深度'],
    ['5 数据与外部对接', '工单、审批、事件、通知、指令、兜底工单、排班、凭证、指标采样、审计；外部系统按接入配置接入，改配置不改程序', '26 张业务表 · 28 项接入配置 · 11 个可改口径'],
], col_w=[1.7, 7.4, 2.9], body_size=11)
text(s, Inches(0.55), Inches(6.0), Inches(12.2), Inches(0.8),
     [[('贯穿全局的两条线：', 13, True, NAVY), ('一条是「工单」——所有运营动作走同一条流水线；'
       '另一条是「例外」——所有异常都汇到分析、切断、整改、复核的同一条处置链。', 13, False, TEXT)]])
foot(s)

# ── 4 三条闭环主线 ───────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '三、三条闭环主线', '汇报就讲这三条：资源怎么调、异常怎么处置、告警怎么闭环', '4')
cols = [
    ('① 资源调配闭环', BLUE, ['申请 → 审批（可驳回并留理由）', '变更窗口排队 → 执行', '外部执行回执回填 → 效果验证', '台账与审计留痕']),
    ('② 例外处置闭环', ACC, ['检出例外 → 切断「例外接入来源」', '自动开整改单派当班角色', '接单 → 整改 → 复核通过', '才允许提交恢复接入']),
    ('③ 监控告警闭环', RGBColor(0x2C, 0x7A, 0x9E), ['只读探活连续取不到数', '事件 + 通知 + 兜底工单派值班', '超时无人接管自动升级带班', '处置或取数恢复后自动闭环']),
]
for i, (t, c, items) in enumerate(cols):
    x = Inches(0.55) + Inches(4.14) * i
    box(s, x, Inches(1.25), Inches(3.9), Inches(3.4), fill=LIGHT, line=LINE, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
    box(s, x, Inches(1.25), Inches(3.9), Inches(0.62), fill=c, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
    text(s, x, Inches(1.38), Inches(3.9), Inches(0.4), [(t, 15, True, WHITE)], align=PP_ALIGN.CENTER)
    bullet_rows(s, x + Inches(0.25), Inches(2.1), Inches(3.4), [(it, TEXT) for it in items], size=12, gap=0.62, dot=c)
box(s, Inches(0.55), Inches(4.9), Inches(12.2), Inches(1.55), fill=RGBColor(0xFD, 0xF4, 0xE8), line=RGBColor(0xE8, 0xC9, 0x9B), shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
text(s, Inches(0.85), Inches(5.05), Inches(11.6), Inches(1.3),
     [[('两条关键口径（领导最容易追问的点）', 13.5, True, AMBER)],
      [('· 阻断只切「例外接入来源」（通道 / 凭证 / 调用入口 / 目录入口），算力池、卡位、模型副本、业务都不停不回收；要动资源走资源侧缓解，那是变更工单、进变更窗口。', 12.5, False, TEXT)],
      [('· 同一原因重复报警只留最新一条要处置，之前的自动完成处置（处置人记「系统自动并入」，审计里看得见并了几条），值班不必逐条点。', 12.5, False, TEXT)]])
foot(s)

# ── 5 闭环一细节 ─────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '四、闭环一：资源调配（算力与模型怎么动）', '所有动作走同一条流水线：谁申请、谁批、何时执行、结果是否回填', '5')
flow(s, Inches(0.55), Inches(1.3), Inches(12.2), [
    ('申请', '填用途与量'), ('审批', '可驳回留理由'), ('变更窗口', '按排期排队'),
    ('执行', '紧急处置可即时'), ('回执回填', '外部执行才生效'), ('效果验证', '对比前后读数'), ('台账审计', '全程可追责')])
text(s, Inches(0.55), Inches(2.3), Inches(6.0), Inches(0.4), [('工单类型（16 类）', 15, True, NAVY)])
table(s, Inches(0.55), Inches(2.72), Inches(6.0), Inches(3.5), [
    ['线', '工单'],
    ['算力', '资源池扩容 / 回收 / 高保抢占'],
    ['模型', '副本扩缩 / 路由权重 / 模型回滚 / 下线'],
    ['凭证', '发放申请 / 吊销 / 配额调整'],
    ['接入', '接入阻断 / 恢复接入'],
    ['发布', '模型部署（外部执行，回执到位才生效）'],
    ['训练', '训练卡位预留 / 释放'],
], col_w=[1.1, 5.4])
text(s, Inches(7.0), Inches(2.3), Inches(5.8), Inches(0.4), [('执行边界', 15, True, NAVY)])
bullet_rows(s, Inches(7.0), Inches(2.75), Inches(5.75), [
    ('需要外部动手的（部署、扩缩容）：平台只发单，回执到位才登记生效', TEXT),
    ('紧急处置类（阻断、吊销、限流）：不受变更窗口限制，可即时生效', TEXT),
    ('平台不替外部系统做决定：改单、驳回、改参数重发、撤回都在工单里留痕', TEXT),
    ('凭证与配额调整先过就绪校验，准入不通过会明确写原因，不静默生效', TEXT),
    ('排期：变更窗口按平台 / 高保集群 / 共享集群三个范围预约', TEXT),
], size=12.5, gap=0.72)
foot(s)

# ── 6 闭环二细节 ─────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '五、闭环二：例外处置（出事怎么收场）', '止损与整改分开：先切来源，再走整改与复核', '6')
table(s, Inches(0.55), Inches(1.25), Inches(5.4), Inches(2.5), [
    ['六类例外', '说的是什么'],
    ['旁路接入', '没登记就直连的外部算力或通道'],
    ['旁路调用', '应用绕开平台直接调模型'],
    ['接管缺口', '登记了但接不到（深度不足）'],
    ['资源异常', '池水位吃紧、节点故障、卡异常'],
    ['配额越界', '凭证配额超过上限'],
    ['目录不一致', '技术目录与业务目录对不上'],
], col_w=[1.5, 3.9])
text(s, Inches(0.55), Inches(3.95), Inches(5.4), Inches(0.4), [('四级接管深度', 15, True, NAVY)])
depth = [('L1 看得见', '只登记，看不到明细'), ('L2 可度量', '能看到指标'), ('L3 可处置不可调度', '能限流不能调度'), ('L4 可调度', '完全纳管')]
for i, (t, d) in enumerate(depth):
    x = Inches(0.55) + Inches(1.38) * i
    box(s, x, Inches(4.4), Inches(1.26), Inches(1.35), fill=LIGHT, line=LINE, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.1)
    text(s, x, Inches(4.55), Inches(1.26), Inches(0.5), [(t, 12, True, ACC)], align=PP_ALIGN.CENTER)
    text(s, x, Inches(5.08), Inches(1.26), Inches(0.6), [(d, 10, False, GRAY)], align=PP_ALIGN.CENTER)
flow(s, Inches(6.5), Inches(1.35), Inches(6.3), [
    ('检出', '按证据判定'), ('切断', '只切接入来源'), ('开整改单', '派当班角色'),
    ('接单/整改', '有期限有记录'), ('复核', '通过才可恢复'), ('恢复接入', '留恢复前提')], box_h=0.72, size=11)
text(s, Inches(6.5), Inches(2.35), Inches(6.3), Inches(0.4), [('处置为什么这样设计', 15, True, NAVY)])
bullet_rows(s, Inches(6.5), Inches(2.8), Inches(6.25), [
    ('切来源不停业务：阻断的是接入通道 / 凭证 / 调用入口 / 目录入口，资源本身不回收、不下线', TEXT),
    ('整改与止损分开：阻断只是止血，真正的整改由归口部门在整改单里完成并签字', TEXT),
    ('没有签字不许恢复：整改未闭环时，恢复接入的动作会被系统挡下并说明原因', TEXT),
    ('超时自动升级：整改超期、接单超时自动升级给带班角色，值班不靠人催', TEXT),
    ('全过程留痕：谁切断的、谁接的、谁复核的、依据是什么，都进审计台账', TEXT),
], size=12.5, gap=0.72)
foot(s)

# ── 7 闭环三细节 ─────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '六、闭环三：监控告警（值班怎么盯、怎么交班）', '只读探活 + 同因归并：人只看真正要处理的那一条', '7')
flow(s, Inches(0.55), Inches(1.3), Inches(12.2), [
    ('只读探活', '平台自己拉指标'), ('连续失败', '默认 2 轮判定中断'), ('发告警', '事件+通知+兜底工单'),
    ('派值班', '按派单映射到岗位'), ('超时升级', '默认 15 分钟无人接管'), ('处置/恢复', '自动闭环')], box_h=0.72, size=11.5)
text(s, Inches(0.55), Inches(2.35), Inches(6.0), Inches(0.4), [('同因重复报警：只处理最后一条', 15, True, NAVY)])
table(s, Inches(0.55), Inches(2.8), Inches(6.0), Inches(2.6), [
    ['场景', '系统的动作'],
    ['同一个目标又报了一次', '旧的未处置自动完成处置，只留最新一条'],
    ['取数恢复了', '该目标未处置的中断告警一并闭环'],
    ['人处置最新一条', '同因旧告警一起闭环，接口返回并了几条'],
    ['要看过程', '审计里能查到每一次并了几条、谁并的'],
], col_w=[2.4, 3.6])
text(s, Inches(7.0), Inches(2.35), Inches(5.8), Inches(0.4), [('告警点得进去', 15, True, NAVY)])
bullet_rows(s, Inches(7.0), Inches(2.8), Inches(5.75), [
    ('界面上每一个红色 / 黄色提示都可点，点进去直接落到能动手的那一行', TEXT),
    ('落地那一行会高亮并滚到中间，不用在一堆表里自己找', TEXT),
    ('归并口径可配置：alert-merge-same-cause 设为 off 就恢复成每条都要处理', TEXT),
    ('关掉的口径不藏：告警来源、等级、处置人、处置时间都写在通知与审计里', TEXT),
    ('外部取数失败显示缺口，不用旧读数冒充实时', TEXT),
], size=12.5, gap=0.72)
foot(s)

# ── 8 数据口径 ───────────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '七、数据口径与可信度', '领导常问的两点：数据存在哪、真假怎么分', '8')
text(s, Inches(0.55), Inches(1.2), Inches(6.0), Inches(0.4), [('谁写谁读', 15, True, NAVY)])
table(s, Inches(0.55), Inches(1.62), Inches(6.0), Inches(3.3), [
    ['归属', '内容', '方向'],
    ['前端写', '业务状态快照与投影（工单、例外、告警规则、通知、模板）', '→ 数据服务落库'],
    ['服务端写', '指标采样、告警通知、兜底工单、指令、审批、审计、登录记录', '→ 前端只读'],
    ['权限判定', '每次写操作在服务端判权限点，越权直接拒绝并留审计', '服务端为准'],
    ['失败可见', '写失败在界面上明确显示，不假装已保存', '不静默丢弃'],
], col_w=[1.3, 3.4, 1.6])
text(s, Inches(7.0), Inches(1.2), Inches(5.8), Inches(0.4), [('真实数据 vs 演示数据', 15, True, NAVY)])
box(s, Inches(7.0), Inches(1.62), Inches(5.8), Inches(1.55), fill=RGBColor(0xEC, 0xF6, 0xF1), line=RGBColor(0xB9, 0xDC, 0xC9), shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
text(s, Inches(7.25), Inches(1.78), Inches(5.3), Inches(1.3),
     [[('真实采集', 13, True, GREEN)],
      [('来自平台自己的只读探针：推理服务指标、算力卡、数据源采集结果，落在采样与告警表。', 12, False, TEXT)]])
box(s, Inches(7.0), Inches(3.32), Inches(5.8), Inches(1.55), fill=RGBColor(0xFD, 0xF4, 0xE8), line=RGBColor(0xE8, 0xC9, 0x9B), shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
text(s, Inches(7.25), Inches(3.48), Inches(5.3), Inches(1.3),
     [[('演示推导', 13, True, AMBER)],
      [('引擎事件推导出来的通知与读数，页面上明确标注「演示推导 · 不是真实采集」，与真实数据不混用。', 12, False, TEXT)]])
text(s, Inches(0.55), Inches(5.15), Inches(12.2), Inches(1.4),
     [[('给领导的一句实话：', 13.5, True, NAVY), ('今天演示里能真跑的是平台内部的闭环——工单、审批、例外、告警、整改、审计全链路留痕；', 13, False, TEXT)],
      [('需要外部系统配合的部分，平台已经把接口位置和字段留好，等客户方与厂商给条件就能切真实数据，程序与流程不用重做。', 13, False, TEXT)]])
foot(s)

# ── 9 已跑通 vs 留位 ─────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '八、已跑通 vs 接口留位（谈判口径）', '左边是现在就能用的，右边是等客户方或厂商给条件的', '9')
box(s, Inches(0.55), Inches(1.25), Inches(6.0), Inches(0.5), fill=GREEN)
text(s, Inches(0.55), Inches(1.33), Inches(6.0), Inches(0.35), [('平台内已闭环，现在就能用', 14, True, WHITE)], align=PP_ALIGN.CENTER)
box(s, Inches(6.75), Inches(1.25), Inches(6.0), Inches(0.5), fill=AMBER)
text(s, Inches(6.75), Inches(1.33), Inches(6.0), Inches(0.35), [('接口与位置已留，待外部条件', 14, True, WHITE)], align=PP_ALIGN.CENTER)
left = ['资源调配与审批，驳回留理由', '例外检出与切断，处置记录到人',
        '整改单派单闭环（接单 / 整改 / 复核 / 恢复接入）', '监控告警与兜底接管（同因归并、超时升级）',
        '台账、审计、报表与 CSV 导出', '权限矩阵、口令策略与登录留痕']
right = ['统一身份认证：CAS / OIDC / LDAP 待客户方定协议与签发方',
         '外部审批系统对接：回调位已留，可切外部审批来源',
         '处置指令真实下发：预检、下发、确认、超时回滚已闭环，执行接口待厂商开放',
         '模型安全检测引擎：流程与展示已通，检测引擎待接',
         '第二期对接：调用日志、配额下发、知识库条目、用户与权限映射待厂商开放',
         '短信 / 值班电话等通知通道：开关已留，需客户方给通道与凭证']
for col, x in ((left, Inches(0.55)), (right, Inches(6.75))):
    for i, t in enumerate(col):
        y = Inches(1.95) + Inches(0.78) * i
        box(s, x, y, Inches(6.0), Inches(0.68), fill=LIGHT, line=LINE, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
        box(s, x + Inches(0.16), y + Inches(0.27), Inches(0.14), Inches(0.14),
            fill=GREEN if x < Inches(1) else AMBER, shape=MSO_SHAPE.OVAL)
        text(s, x + Inches(0.42), y + Inches(0.06), Inches(5.4), Inches(0.58), [(t, 12, False, TEXT)], anchor=MSO_ANCHOR.MIDDLE)
foot(s)

# ── 10 边界与三句话 ───────────────────────────────────────────────────────
s = prs.slides.add_slide(BLANK)
head(s, '九、责任边界与结论', '平台负责看得见、管得住、追得到、兜得了', '10')
table(s, Inches(0.55), Inches(1.25), Inches(12.2), Inches(2.15), [
    ['谁负责', '负责什么'],
    ['平台', '统一台账与指标看得见；审批与变更窗口管得住；审计与归口追得到；外部不可用时能兜底接管与降级'],
    ['客户方', '认证源与协议、通知通道与凭证、外部审批与执行系统接口、归口部门与值班岗位指定'],
    ['厂商', '真实执行（扩缩容、部署、阻断落地）与执行回执；回执不到位记「待回执」并开兜底工单，不静默当作已完成'],
], col_w=[1.3, 10.9], body_size=12)
text(s, Inches(0.55), Inches(3.6), Inches(12.2), Inches(0.4), [('给领导的三句话', 16, True, NAVY)])
sayings = [
    ('1', '一套工单口径管所有运营动作：谁申请、谁批、什么时候执行、结果是否回填、效果有没有验证，全程可查、可追责。'),
    ('2', '异常不是弹提示，而是有处置链：红黄告警点进去就是能动手的那一条；同一原因重复报警只留最新一条要处置，旧的自动闭环。'),
    ('3', '平台不擅自改外部系统：需要外部动手的动作一律走工单 + 回执 + 兜底接管，超时自动升级带班，边界清楚、留痕完整。'),
]
for i, (n, t) in enumerate(sayings):
    y = Inches(4.05) + Inches(0.78) * i
    box(s, Inches(0.55), y, Inches(0.5), Inches(0.5), fill=ACC, shape=MSO_SHAPE.OVAL)
    text(s, Inches(0.55), y + Inches(0.08), Inches(0.5), Inches(0.35), [(n, 16, True, WHITE)], align=PP_ALIGN.CENTER)
    text(s, Inches(1.25), y - Inches(0.02), Inches(11.5), Inches(0.62), [(t, 13.5, False, TEXT)])
box(s, Inches(0.55), Inches(6.4), Inches(12.2), Inches(0.55), fill=LIGHT, line=LINE, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.12)
text(s, Inches(0.8), Inches(6.5), Inches(11.8), Inches(0.4),
     [[('现在需要客户方拍板的三件事：', 12.5, True, NAVY), ('① 统一身份认证用哪种协议、谁签发　② 通知通道（短信 / 值班电话）由谁提供　③ 各类对象的归口部门与值班岗位怎么定', 12.5, False, TEXT)]])
foot(s)

prs.save(OUT)
print('已生成 PPT：%s（%d 页）' % (OUT, len(prs.slides.__iter__.__self__._sldIdLst)))
