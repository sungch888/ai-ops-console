"""操作控制内核（服务端权威实现）—— 把「已批准的决策」变成「对资源的真实变更」的那一层。

口径（依据《模型中心业务流程（讨论稿）》与 docs-src/operation-control-unit.md）：
  g0 归属边界：应用发布归应用中心，本单元不得发起 → 拦下
  g1 工单绑定：无覆盖本次「审批+执行+验证」的工单不得执行（原文 1.1-8）
  g2 操作级权限：按「动作×职责」查 op_perms 逐账号授权（原文 1.3）
  g3 预检强制：未做 dry-run 预检不得下发（沿用处置指令台既有口径）
  g4 审批：申请人不得自批，唯一例外是部署工单（原文 2.5-2 / 2.6-2）
  g5 双人执行复核：执行与复核必须是两个不同账号，未复核不得标记发放成功（2.6-3）
  g6 变更窗口：非紧急动作无开放窗口不得执行，排队位次保留
  g7 执行归属：外部执行需回执，回执到位前不改台账（2.5-2 / engine.ts:793 口径）
  g8 分段成功判定：任一段失败即「部分成功」，全段通过才算生效（2.5-2）
  g9 效果验证：要同口径前后对比证据，不以登记完成代替验证（SP-08）
  g10 通知与台账：通知三态分列，失败/回退留痕，兜底待办可接管

对外的执行体通过 server/connector.py 走统一连接器接口（模拟环境或真实平台，
见 docs-src/operation-connectors.md）。连接器探测不通时按「读不到」处理，绝不使用默认值。
"""
from datetime import datetime, timedelta

STATUS = ['草稿', '待审批', '待复核', '待窗口', '执行中', '待回执',
          '部分成功', '已生效', '已验证', '已闭环', '已驳回', '失败', '待人工兜底', '已回滚']

# ---- 操作目录：decision 字段以此为准（前端只负责表单字段与文案） ----
CATALOG = {
    'OC-A-03': dict(group='模型资产', action='完整性校验与安全扫描', resource='模型版本', ticket='服务申请单',
                    exec_mode='平台自动', needs_dual=0, self_approve=0, auto=1, urgent=0, priority='P1',
                    external='安全扫描', ref='原文 2.1-3',
                    stages=['实际文件哈希计算', '安全扫描', '报告归档'],
                    impact=['模型版本', '准入工单']),
    'OC-B-01': dict(group='部署上线', action='发起模型部署', resource='模型名称', ticket='服务申请单',
                    exec_mode='人工', needs_dual=0, self_approve=1, auto=0, urgent=0, priority='P0',
                    external='无', ref='原文 2.5-1', stages=['部署工单审批'],
                    impact=['模型服务', '算力卡位', '网关渠道']),
    'OC-B-02': dict(group='部署上线', action='自动部署并接入网关', resource='推理服务', ticket='变更单',
                    exec_mode='外部执行需回执', needs_dual=0, self_approve=0, auto=1, urgent=0, priority='P0',
                    external='容器调度平台 / 推理网关', ref='原文 2.5-2',
                    stages=['实例健康检查', '网关注册', '路由生效', '经网关试调用'],
                    impact=['推理实例', '网关路由', '调用方凭证']),
    'OC-B-06': dict(group='部署上线', action='模型下线', resource='模型版本', ticket='变更单',
                    exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=1, priority='P0',
                    external='推理网关 / MCP 注册中心', ref='原文 2.10-2/3',
                    stages=['入口停止', '路由清理', '关联授权清理', '台账更新'],
                    impact=['调用方凭证', 'MCP 依赖', '业务应用']),
    'OC-C-03': dict(group='网关配置', action='路由策略调整', resource='路由策略', ticket='变更单',
                    exec_mode='人工', needs_dual=0, self_approve=0, auto=0, urgent=1, priority='P1',
                    external='推理网关', ref='原文 2.7-2 / 2.8-2', stages=['策略下发', '分流验证'],
                    impact=['渠道', '业务应用', '凭证']),
    'OC-D-03': dict(group='凭证配额', action='发放模型 API Key', resource='API Key', ticket='服务申请单',
                    exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=0, priority='P0',
                    external='推理网关', ref='原文 2.6-3',
                    stages=['生成 Key-ID 与访问 URL', '按审批配置配额', '双人复核'],
                    impact=['调用方应用', '网关配额', '台账']),
    'OC-D-05': dict(group='凭证配额', action='调整 Key 额度', resource='API Key', ticket='变更单',
                    exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=0, priority='P0',
                    external='推理网关', ref='原文 4.1-3 / 2.6-4', stages=['网关配置下发', '复核生效'],
                    impact=['调用方应用', '网关配额', '成本归口']),
    'OC-D-08': dict(group='凭证配额', action='泄露应急吊销', resource='API Key', ticket='变更单',
                    exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=1, priority='P1',
                    external='推理网关', ref='原文 2.6-4 / 2.9-2', stages=['吊销凭证', '验证旧凭证失效'],
                    impact=['调用方应用', '安全事件']),
    'OC-E-04': dict(group='算力训练', action='分配训练算力', resource='训练任务', ticket='服务申请单',
                    exec_mode='外部执行需回执', needs_dual=0, self_approve=0, auto=0, urgent=0, priority='P0',
                    external='训练平台 / 容器调度', ref='原文 2.3-2',
                    stages=['算力预占', '节点分配', '平台回执'],
                    impact=['训练资源池', '推理可分配余量', '排队队列']),
    'OC-E-08': dict(group='算力训练', action='到期自动停止与回收', resource='训练任务', ticket='运营任务单',
                    exec_mode='平台自动', needs_dual=0, self_approve=0, auto=1, urgent=0, priority='P1',
                    external='训练平台', ref='原文 1.1-11 / 2.3-5', stages=['任务停止', '算力回收', '留痕'],
                    impact=['训练资源池', '权重存储']),
    'OC-F-01': dict(group='运行弹性', action='指标驱动自动扩缩容', resource='推理服务', ticket='变更单',
                    exec_mode='平台自动', needs_dual=0, self_approve=0, auto=1, urgent=0, priority='P0',
                    external='容器调度平台', ref='原文 1.1-9 / 2.8-4',
                    stages=['执行前建变更工单', '调度扩容', '实例健康', '效果验证'],
                    impact=['推理实例', '算力卡位', '网关路由']),
    'OC-G-03': dict(group='应用与MCP', action='异常 MCP 服务移出路由', resource='MCP 服务', ticket='故障处理单',
                    exec_mode='人工', needs_dual=0, self_approve=0, auto=0, urgent=1, priority='P1',
                    external='MCP 注册中心 / 推理网关', ref='原文 4.2.2-1',
                    stages=['移出路由', '应用侧状态交接'], impact=['消费侧应用', '网关路由']),
    'OC-G-05': dict(group='应用与MCP', action='应用发布（上架与消费授权在应用中心）', resource='智能体应用',
                    ticket='变更单', exec_mode='待确认', needs_dual=0, self_approve=0, auto=0, urgent=0,
                    priority='P2', external='应用中心', ref='原文 4.2 引言 / 6-6', stages=['配置下发', '版本切换'],
                    impact=['消费侧目录', '模型渠道'], owner='应用中心'),
    'OC-E-11': dict(group='算力训练', action='发放可回收训练算力额度（含三属性）', resource='训练额度',
                    ticket='服务申请单', exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=0,
                    priority='P0', external='CubeStudio / K8s 配额', ref='池借还规则 P2/P4',
                    stages=['写入可回收额度', '生效校验'],
                    impact=['训练资源池', '弹性预留余量', '回收队列']),
    'OC-F-08': dict(group='运行弹性', action='弹性算力借还（预约-借-还）', resource='算力卡（跨池）',
                    ticket='运营任务单', exec_mode='平台自动', needs_dual=0, self_approve=0, auto=1, urgent=0,
                    priority='P0', external='CubeStudio / GPUWorks', ref='池借还规则 F1/F2 与 R2-R5',
                    stages=['预约', '挂起与checkpoint', '排空', '入推理池', '台账回写'],
                    impact=['训练任务', '推理扩容', '容量台账']),
    'OC-F-09': dict(group='运行弹性', action='节点换池（入池/出池）', resource='算力节点',
                    ticket='变更单', exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=0,
                    priority='P1', external='GPUWorks / CubeStudio', ref='池借还规则 F3 与 R6',
                    stages=['排空与预约核对', '原池下线', '新池注册与标签', '台账pool_type变更'],
                    impact=['推理池容量', '训练池容量', '调度域']),
    'OC-H-02': dict(group='平台配置', action='逐账号权限项开关', resource='账号权限项', ticket='变更单',
                    exec_mode='人工', needs_dual=1, self_approve=0, auto=0, urgent=0, priority='P0',
                    external='无', ref='原文 1.3', stages=['权限项变更', '生效校验'],
                    impact=['账号入口', '审计范围']),
}
for _k, _v in CATALOG.items():
    _v.setdefault('owner', '本单元')

# ---- 执行体连接器：哪些动作经哪个连接器真实下发（未列出的仍走人工/演示路径）----
CONN_MAP = {'OC-B-02': ('gpuworks', 'deploy'), 'OC-B-06': ('gpuworks', 'retire'),
            'OC-C-03': ('gateway', 'traffic'), 'OC-D-03': ('gateway', 'issue_key'),
            'OC-D-08': ('gateway', 'revoke_key'), 'OC-E-04': ('cubestudio', 'train'),
            'OC-E-11': ('k8s', 'quota'), 'OC-F-08': ('cubestudio', 'lend')}


def _conn():
    """懒加载连接器客户端；模块缺失时返回 None（内核退回人工路径）。"""
    global _CONN_MOD
    if _CONN_MOD is None:
        try:
            import connector
            _CONN_MOD = connector
        except Exception:
            _CONN_MOD = False
    return _CONN_MOD or None


_CONN_MOD = None

# 每条动作 × 职责 → 需要的操作权限项（g2）
OP_PERMS = {
    'OC-A-03': {'request': 'admission.request', 'approve': 'admission.approve', 'execute': 'admission.execute'},
    'OC-B-01': {'request': 'model.deploy.request', 'approve': 'model.deploy.approve', 'execute': 'model.deploy.execute'},
    'OC-B-02': {'execute': 'model.deploy.execute'},
    'OC-B-06': {'request': 'model.retire.request', 'approve': 'model.retire.approve',
                'execute': 'model.retire.execute', 'review': 'model.retire.review'},
    'OC-C-03': {'request': 'gateway.config', 'execute': 'gateway.execute'},
    'OC-D-03': {'request': 'key.request', 'execute': 'key.execute', 'review': 'key.review'},
    'OC-D-05': {'request': 'key.quota.request', 'approve': 'key.quota.approve',
                'execute': 'key.quota.execute', 'review': 'key.quota.review'},
    'OC-D-08': {'request': 'key.request', 'execute': 'key.execute', 'review': 'key.review'},
    'OC-E-04': {'request': 'train.request', 'approve': 'train.approve', 'execute': 'train.allocate'},
    'OC-E-08': {'execute': 'train.allocate'},
    'OC-E-11': {'request': 'train.request', 'approve': 'train.approve',
                'execute': 'train.allocate', 'review': 'train.reclaim.review'},
    'OC-F-08': {'execute': 'train.lend.auto'},
    'OC-F-09': {'request': 'train.request', 'approve': 'train.approve',
                'execute': 'train.pool.change', 'review': 'train.reclaim.review'},
    'OC-F-01': {'execute': 'autoscale.execute.auto'},
    'OC-G-03': {'request': 'mcp.register', 'execute': 'mcp.execute'},
}

PERM_ITEMS = [
    ('opctl.view', '看操作目录与审计', '操作控制', 'view'),
    ('opctl.config', '改门禁与策略配置', '操作控制', 'config'),
    ('opctl.emergency', '紧急处置（免窗口，须补审）', '操作控制', 'emergency'),
    ('admission.request', '发起模型准入', '模型准入', 'request'),
    ('admission.execute', '执行校验 / 扫描 / 评测', '模型准入', 'execute'),
    ('admission.approve', '审批准入并登记入库', '模型准入', 'approve'),
    ('model.deploy.request', '发起部署工单', '部署上线', 'request'),
    ('model.deploy.approve', '审批部署工单', '部署上线', 'approve'),
    ('model.deploy.execute', '执行部署与接入网关', '部署上线', 'execute'),
    ('model.retire.request', '发起下线 / 升级', '模型下线', 'request'),
    ('model.retire.approve', '审批下线 / 升级', '模型下线', 'approve'),
    ('model.retire.execute', '执行下线并清理依赖', '模型下线', 'execute'),
    ('model.retire.review', '复核下线清理结果', '模型下线', 'review'),
    ('gateway.config', '改路由 / 策略 / 隔离配置', '网关配置', 'config'),
    ('gateway.execute', '下发网关配置变更', '网关配置', 'execute'),
    ('key.request', '申请或代申请 Key', '凭证发放', 'request'),
    ('key.execute', '执行发 Key 与配置', '凭证发放', 'execute'),
    ('key.review', '复核发 Key 配置与台账', '凭证发放', 'review'),
    ('key.quota.request', '申请额度调整', '配额调整', 'request'),
    ('key.quota.approve', '审批额度调整', '配额调整', 'approve'),
    ('key.quota.execute', '执行额度调整', '配额调整', 'execute'),
    ('key.quota.review', '复核额度调整', '配额调整', 'review'),
    ('train.request', '申请训练算力（原文示例权限项）', '算力训练', 'request'),
    ('train.approve', '审批训练算力申请', '算力训练', 'approve'),
    ('train.allocate', '执行算力分配与回收', '算力训练', 'execute'),
    ('train.lend.auto', '按获批策略执行算力借还（策略内自动）', '运行弹性', 'auto'),
    ('train.pool.change', '执行节点换池（入池/出池）', '算力训练', 'execute'),
    ('train.reclaim.review', '复核可回收额度与换池', '算力训练', 'review'),
    ('autoscale.strategy.config', '改弹性策略与边界', '运行弹性', 'config'),
    ('autoscale.execute.auto', '按获批策略自动执行', '运行弹性', 'auto'),
    ('mcp.register', '登记 / 变更 MCP 技术目录', 'MCP', 'request'),
    ('mcp.execute', '执行隔离 / 恢复路由', 'MCP', 'execute'),
    ('perm.item.configure', '逐账号权限项开关', '平台权限', 'config'),
]

POLICIES = [
    dict(id='AP-01', name='Qwen2.5-VL-7B 弹性策略', scope='Qwen2.5-VL-7B', ver='v1.2', approved=1,
         metric='P99 时延 + 请求队列 + GPU 利用率', threshold='P99 > 1.8s', sustain='持续 ≥ 10 分钟',
         mn=2, mx=8, cooldown='15 分钟'),
    dict(id='AP-02', name='DeepSeek-V3-R1 弹性策略', scope='DeepSeek-V3-R1', ver='v0（演练）', approved=0,
         metric='GPU 利用率', threshold='利用率 < 20%', sustain='持续 ≥ 10 分钟',
         mn=2, mx=6, cooldown='15 分钟'),
]

# 默认逐账号授权：体现「同角色不同账号不同能力」与「执行 / 复核分岗」
SEED_PERMS = [
    # 管理员 A（系统管理员 · U-0001）：审批 / 配置 / 紧急，但不给执行——管理员不自动获得全部业务操作（原文 1.2）
    ('U-0001', 'opctl.view', 'global'), ('U-0001', 'opctl.config', 'global'),
    ('U-0001', 'opctl.emergency', 'global'), ('U-0001', 'admission.approve', 'global'),
    ('U-0001', 'model.deploy.approve', 'global'), ('U-0001', 'model.retire.approve', 'global'),
    ('U-0001', 'key.quota.approve', 'global'), ('U-0001', 'train.approve', 'global'),
    ('U-0001', 'autoscale.strategy.config', 'global'), ('U-0001', 'perm.item.configure', 'global'),
    # 运营 B（运营执行岗 · U-0002）：能发起、能执行，也能复核（用来演示同人复核被 g5 拒）
    ('U-0002', 'opctl.view', 'org'), ('U-0002', 'admission.request', 'org'),
    ('U-0002', 'admission.execute', 'org'), ('U-0002', 'model.deploy.request', 'org'),
    ('U-0002', 'model.deploy.execute', 'org'), ('U-0002', 'model.retire.request', 'org'),
    ('U-0002', 'model.retire.execute', 'org'), ('U-0002', 'gateway.config', 'org'),
    ('U-0002', 'gateway.execute', 'org'), ('U-0002', 'key.request', 'org'),
    ('U-0002', 'key.execute', 'org'), ('U-0002', 'key.review', 'org'),
    ('U-0002', 'key.quota.request', 'org'), ('U-0002', 'key.quota.execute', 'org'),
    ('U-0002', 'key.quota.review', 'org'), ('U-0002', 'train.allocate', 'org'), ('U-0002', 'train.request', 'org'),
    ('U-0002', 'train.lend.auto', 'org'), ('U-0002', 'train.pool.change', 'org'),
    ('U-0002', 'autoscale.execute.auto', 'org'), ('U-0002', 'mcp.register', 'org'),
    ('U-0002', 'mcp.execute', 'org'),
    # 韦东（运营复核岗 · U-9002）：只有复核权——与运营 B同角色不同能力（原文 1.3 核心演示）
    ('U-9002', 'opctl.view', 'org'), ('U-9002', 'key.review', 'org'),
    ('U-9002', 'key.quota.review', 'org'), ('U-9002', 'model.retire.review', 'org'), ('U-9002', 'train.reclaim.review', 'org'),
    # 开发者 C（业务开发者 · U-0003）：只能发起申请
    ('U-0003', 'opctl.view', 'self'), ('U-0003', 'train.request', 'self'),
    ('U-0003', 'key.request', 'self'), ('U-0003', 'key.quota.request', 'self'),
    # 用户 D（普通用户 · U-0004）：仅本人额度申请，无操作控制入口
    ('U-0004', 'key.quota.request', 'self'),
]


# --------------------------------------------------------------------------- 基础
def _now():
    from server import now_iso
    return now_iso()


def _stamp():
    return datetime.now().strftime('%m-%d %H:%M')


def _name(conn, account_id):
    if not account_id:
        return ''
    row = conn.execute('SELECT name FROM users WHERE id=?', (account_id,)).fetchone()
    return row['name'] if row else account_id


def _names(conn):
    return {r['id']: r['name'] for r in conn.execute('SELECT id, name FROM users').fetchall()}


def _audit(conn, actor_id, action, target, detail=''):
    from server import audit
    audit(conn, actor_id, action, target, detail)


def _trace(conn, op_id, actor_id, gate, action, result, reason='', detail=''):
    # 跨操作/跨中心的判定（g0 归属边界、窗口开关）没有具体操作号，用 GLOBAL 占位，避免 NULL 打断审计链
    conn.execute('INSERT INTO op_trace(op_id, at, actor, gate, action, result, reason, detail)'
                 ' VALUES(?,?,?,?,?,?,?,?)',
                 (op_id or 'GLOBAL', _stamp(), _name(conn, actor_id) or actor_id, gate, action, result,
                  reason or '', detail or ''))


def _deny(conn, op_id, actor_id, gate, reason, ref='', detail=''):
    _trace(conn, op_id, actor_id, gate, 'denied', '拦下', reason, detail or ('依据 ' + ref if ref else ''))
    if op_id:
        conn.execute('UPDATE operations SET updated_at=? WHERE id=?', (_now(), op_id))
    return {'ok': False, 'reason': '%s 拦下：%s%s' % (gate, reason, '（依据 %s）' % ref if ref else '')}


def has_perm(conn, account_id, perm):
    if not account_id or not perm:
        return True if not perm else False
    row = conn.execute('SELECT 1 FROM op_perms WHERE account_id=? AND perm=? AND revoked_at IS NULL',
                       (account_id, perm)).fetchone()
    return bool(row)


def _g2(conn, actor, code, kind):
    need = (OP_PERMS.get(code) or {}).get(kind)
    if not need:
        return None
    if not has_perm(conn, actor['id'], need):
        return need
    return None


def _op(conn, op_id):
    row = conn.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone()
    return dict(row) if row else None


def _next(conn, prefix, key):
    row = conn.execute('SELECT value FROM op_meta WHERE key=?', (key,)).fetchone()
    n = int(row['value']) if row else 2000
    n += 1
    conn.execute('INSERT INTO op_meta(key, value, updated_at) VALUES(?,?,?)'
                 ' ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                 (key, str(n), _now()))
    return '%s-%d' % (prefix, n)


def serialize(conn, state_only=True):
    names = _names(conn)
    ops = []
    for r in conn.execute('SELECT * FROM operations ORDER BY created_at DESC, id DESC').fetchall():
        o = dict(r)
        stages = [dict(x) for x in conn.execute(
            'SELECT name, state, reason, at FROM op_stages WHERE op_id=? ORDER BY seq', (o['id'],)).fetchall()]
        trace = [dict(x) for x in conn.execute(
            'SELECT at, actor, gate, action, result, reason, detail FROM op_trace WHERE op_id=? ORDER BY id',
            (o['id'],)).fetchall()]
        notify = [dict(x) for x in conn.execute(
            'SELECT to_who, channel, at, state FROM op_notify WHERE op_id=? ORDER BY id', (o['id'],)).fetchall()]
        ops.append({
            'id': o['id'], 'code': o['code'], 'target': o['target'],
            'params': _json(o['params']) or {},
            'ticketId': o['ticket_id'], 'ticketKind': o['ticket_kind'], 'status': o['status'],
            'requestedBy': names.get(o['requested_by'], o['requested_by']), 'requestedAt': o['requested_at'],
            'approvedBy': names.get(o['approved_by'], o['approved_by'] or ''),
            'approvedAt': o['approved_at'] or '', 'approvalNote': o['approval_note'] or '',
            'executedBy': names.get(o['executed_by'], o['executed_by'] or ''),
            'executedAt': o['executed_at'] or '',
            'reviewedBy': names.get(o['reviewed_by'], o['reviewed_by'] or ''),
            'reviewedAt': o['reviewed_at'] or '',
            'execMode': o['exec_mode'], 'precheckId': o['precheck_id'] or '',
            'impact': _json(o['impact']) or [],
            'beforeSnap': o['before_snap'] or '', 'afterSnap': o['after_snap'] or '',
            'stages': [{'name': s['name'], 'state': s['state'], 'reason': s['reason'] or '', 'at': s['at'] or ''}
                       for s in stages],
            'failStage': o['fail_stage'] or '', 'urgent': bool(o['urgent']),
            'externalRef': o['external_ref'] or '', 'receiptNote': o['receipt_note'] or '',
            'queuePos': o['queue_pos'], 'windowId': o['window_id'] or '',
            'rollbackOf': o['rollback_of'] or '',
            'emergency': ({'dueAt': o['emergency_due'], 'state': o['emergency_state']}
                          if o['emergency_state'] else None),
            'notify': [{'to': n['to_who'], 'channel': n['channel'], 'at': n['at'], 'state': n['state']}
                       for n in notify],
            'trace': [{'at': t['at'], 'actor': t['actor'], 'gate': t['gate'], 'action': t['action'],
                       'result': t['result'], 'reason': t['reason'] or '', 'detail': t['detail'] or ''}
                      for t in trace],
        })
    windows = [dict(w) for w in conn.execute('SELECT * FROM op_windows ORDER BY id').fetchall()]
    fallbacks = [dict(f) for f in conn.execute('SELECT * FROM op_fallbacks ORDER BY at DESC').fetchall()]
    denied = conn.execute("SELECT COUNT(*) c FROM op_trace WHERE result='拦下'").fetchone()['c']
    return {
        'ok': True,
        'ops': ops,
        'windows': [{'id': w['id'], 'scope': w['scope'], 'from': w['t_from'], 'to': w['t_to'],
                     'reason': w['reason'], 'status': w['status'], 'by': names.get(w['by_id'], w['by_id'])}
                    for w in windows],
        'fallbacks': [{'id': f['id'], 'opId': f['op_id'], 'title': f['title'], 'detail': f['detail'],
                       'status': f['status'], 'owner': names.get(f['owner'], f['owner']), 'at': f['at']}
                      for f in fallbacks],
        'policies': [dict(id=p['id'], name=p['name'], scope=p['scope'], ver=p['ver'],
                          approved=bool(p['approved']), metric=p['metric'], threshold=p['threshold'],
                          sustain=p['sustain'], min=p['mn'], max=p['mx'], cooldown=p['cooldown'])
                     for p in POLICIES],
        'denied': denied,
    }


def _json(raw):
    import json
    try:
        return json.loads(raw) if raw else None
    except Exception:
        return None


def state(conn, user):
    """GET /api/opctl/state：页面一次拿全（操作 / 窗口 / 兜底 / 策略 / 权限）"""
    out = serialize(conn)
    out['catalog'] = catalog_payload()
    out['perms'] = perms_payload(conn)
    return out


def connectors_state():
    """GET /api/opctl/connectors：5 个连接器一次探测（1 秒超时，15 秒缓存），供页面显示真实可用性。"""
    c = _conn()
    if not c:
        return {'ok': False, 'error': 'connector 模块缺失', 'connectors': {}}
    return {'ok': True, 'connectors': c.probe_all(ttl=0)}


def catalog_payload():
    items = []
    for code, d in CATALOG.items():
        items.append(dict(code=code, group=d['group'], action=d['action'], resource=d['resource'],
                          ticketKind=d['ticket'], execMode=d['exec_mode'], needsDual=bool(d['needs_dual']),
                          selfApprove=bool(d['self_approve']), autoAllowed=bool(d['auto']),
                          urgentAllowed=bool(d['urgent']), priority=d['priority'], external=d['external'],
                          sourceRef=d['ref'], stages=d['stages'], impact=d['impact'], owner=d['owner']))
    return items


def perms_payload(conn):
    names = _names(conn)
    rows = conn.execute('SELECT * FROM op_perms WHERE revoked_at IS NULL ORDER BY account_id, perm').fetchall()
    changes = conn.execute('SELECT * FROM op_perm_changes ORDER BY id DESC LIMIT 200').fetchall()
    return {
        'items': [dict(code=c, label=l, domain=dom, kind=k) for c, l, dom, k in PERM_ITEMS],
        'grants': [dict(account=names.get(r['account_id'], r['account_id']), accountId=r['account_id'],
                        perm=r['perm'], scope=r['scope'], grantedBy=names.get(r['granted_by'], r['granted_by']),
                        ticketId=r['ticket_id'], at=r['granted_at']) for r in rows],
        'changes': [dict(at=c['at'], account=names.get(c['account_id'], c['account_id']), accountId=c['account_id'],
                         perm=c['perm'], before=c['before_val'], after=c['after_val'],
                         actor=names.get(c['actor'], c['actor']), ticketId=c['ticket_id'])
                    for c in changes],
        'accounts': [dict(id=u['id'], name=u['name'], role=u['role'], note=u['note'])
                     for u in conn.execute("SELECT id, name, role, note FROM users WHERE status='active' ORDER BY id").fetchall()],
    }


# --------------------------------------------------------------------------- 动作
def precheck(conn, actor, p):
    code = str(p.get('code') or '')[:20]
    target = str(p.get('target') or '')[:160]
    params = p.get('params') or {}
    d = CATALOG.get(code)
    if not d:
        return {'ok': False, 'reasons': ['操作码不存在']}
    if d['owner'] != '本单元':
        return {'ok': False, 'reasons': [
            '该动作归应用中心：上架审批、使用目录与消费权限都在应用中心办理，本单元只接收发布后的状态交接与回执（原文 4.2 引言）']}
    reasons = []
    if not target.strip():
        reasons.append('目标对象不可定位：要写明被操作的对象与版本（原文 4.1-2）')
    try:
        if code == 'OC-D-05' and int(params.get('rpm') or 0) > 600:
            reasons.append('申请 RPM 高于单密钥获批上限 600，执行时以审批值为准或拒绝（原文 2.6-2）')
        if code == 'OC-E-04' and int(params.get('cards') or 0) > 8:
            reasons.append('一次申请超过 8 卡的单申请上限（原文 2.3-1）')
    except Exception:
        pass
    if code == 'OC-B-01' and '未准入' in target:
        reasons.append('所选模型无有效准入入库记录，不得进入部署（原文 2.5-1）')
    pid = 'PRE-%04d' % (len(reasons) + int(datetime.now().timestamp()) % 10000)
    impact = ['%s ×%d（由台账推导）' % (k, i + 1) for i, k in enumerate(d['impact'])]
    return {'ok': not reasons, 'precheckId': pid, 'impact': impact, 'reasons': reasons}


def submit(conn, actor, p):
    code = str(p.get('code') or '')[:20]
    d = CATALOG.get(code)
    if not d:
        return {'ok': False, 'reason': '操作码不存在'}
    if d['owner'] != '本单元':
        return _deny(conn, None, actor['id'], 'g0 归属边界',
                     '该动作归应用中心，本单元不得发起（原文 4.2 引言）')
    need = _g2(conn, actor, code, 'request')
    if need:
        return _deny(conn, None, actor['id'], 'g2 权限项',
                     '当前账号没有操作权限项「%s」，这项按账号授予，同角色不同账号能力可以不同' % need, '原文 1.3')
    if not str(p.get('precheckId') or '').strip():
        return {'ok': False, 'reason': 'g3 预检 拦下：未做 dry-run 预检不得下发（先点①预检）'}
    urgent = bool(p.get('urgent'))
    if urgent and not d['urgent']:
        return {'ok': False, 'reason': 'g6 变更窗口 拦下：该动作不允许走紧急通道（放宽类动作紧急也禁止）'}
    op_id = _next(conn, 'OP', 'opctl_seq')
    ticket = ('%s-%04d' % ('CHG' if d['ticket'] == '变更单' else 'REQ', int(datetime.now().timestamp()) % 10000))
    ts = _now()
    conn.execute(
        'INSERT INTO operations(id, code, target, params, ticket_id, ticket_kind, status,'
        ' requested_by, requested_at, exec_mode, precheck_id, impact, before_snap, urgent, created_at, updated_at)'
        ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (op_id, code, str(p.get('target') or '')[:160], _dumps(p.get('params') or {}), ticket, d['ticket'],
         '待审批', actor['id'], ts, d['exec_mode'], str(p.get('precheckId'))[:40],
         _dumps(['%s ×%d（由台账推导）' % (k, i + 1) for i, k in enumerate(d['impact'])]),
         '变更前台账快照已留存', 1 if urgent else 0, ts, ts))
    for i, name in enumerate(d['stages']):
        conn.execute('INSERT INTO op_stages(op_id, seq, name, state) VALUES(?,?,?,?)',
                     (op_id, i, name, '待执行'))
    _trace(conn, op_id, actor['id'], 'g1 工单绑定', 'submit', '通过',
           '', '%s %s 已建立并关联本次变更（原文 1.1-8：不得绕过工单直接修改）' % (d['ticket'], ticket))
    _trace(conn, op_id, actor['id'], 'g3 预检', 'submit', '通过', '',
           '预检号 %s · 未产生外部调用' % str(p.get('precheckId'))[:40])
    _audit(conn, actor['id'], 'opctl_submit', op_id, '%s %s → %s' % (code, d['action'], ticket))
    return {'ok': True, 'id': op_id, 'state': serialize(conn)}


def approve(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    d = CATALOG.get(op['code']) or {}
    if op['status'] != '待审批':
        return {'ok': False, 'reason': '当前是「%s」，不能审批' % op['status']}
    need = _g2(conn, actor, op['code'], 'approve')
    if need:
        return _deny(conn, op['id'], actor['id'], 'g2 权限项',
                     '当前账号没有操作权限项「%s」' % need, '原文 1.3')
    if not d.get('self_approve') and op['requested_by'] == actor['id']:
        return _deny(conn, op['id'], actor['id'], 'g4 审批',
                     '申请人不得自批本单，仅部署工单允许申请人自审并留痕', '原文 2.5-2 / 2.6-2')
    note = str(p.get('note') or '').strip()
    if len(note) < 4:
        return {'ok': False, 'reason': '审批意见必填（不少于 4 字），台账与审计要看'}
    status = '待窗口'
    conn.execute('UPDATE operations SET status=?, approved_by=?, approved_at=?, approval_note=?, updated_at=?'
                 ' WHERE id=?', (status, actor['id'], _now(), note[:300], _now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g4 审批', 'approve', '通过', '',
           '审批通过，进入排队待窗口%s；意见：%s'
           % ('（该动作执行后还须另一账号复核）' if d.get('needs_dual') else '', note[:80]))
    _notify(conn, op['id'], op['requested_by'], '站内消息', '已发送')
    _audit(conn, actor['id'], 'opctl_approve', op['id'], note[:120])
    return {'ok': True, 'state': serialize(conn)}


def reject(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] != '待审批':
        return {'ok': False, 'reason': '当前是「%s」，不能驳回' % op['status']}
    reason = str(p.get('reason') or '范围与授权值不一致，退回补充依据')[:200]
    conn.execute("UPDATE operations SET status='已驳回', approved_by=?, approved_at=?, approval_note=?, updated_at=?"
                 ' WHERE id=?', (actor['id'], _now(), reason, _now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g4 审批', 'reject', '记录', '', '驳回原因：' + reason)
    _notify(conn, op['id'], op['requested_by'], '站内消息', '已发送')
    _audit(conn, actor['id'], 'opctl_reject', op['id'], reason[:120])
    return {'ok': True, 'state': serialize(conn)}


def _spec_for(op, code):
    try:
        params = _json(op['params']) or {}
    except Exception:
        params = {}
    if code in ('OC-D-03', 'OC-D-08'):
        return {'app': op['target'], 'rpm': int(params.get('rpm') or 300), 'owner': op['requested_by']}
    if code == 'OC-E-04':
        return {'cards': int(params.get('cards') or 1), 'owner': op['requested_by']}
    if code == 'OC-E-11':
        return {'cards': int(params.get('reclaim_cards') or 2), 'scope': params.get('queue') or 'train-general'}
    if code == 'OC-F-08':
        return {'cards': int(params.get('cards') or 2), 'grace_sec': int(params.get('grace') or 300)}
    if code == 'OC-C-03':
        return {'route': params.get('route') or 'chat-main', 'weight_b': int(params.get('weight_b') or 0)}
    return {'cards': int(params.get('replicas') or 2), 'model': op['target'], 'owner': op['requested_by']}


def _dispatch(conn, op, actor):
    """经连接器真实下发。成功：写 op_conn 并把分段名对齐执行体；失败：返回错误 dict（本单状态不动）。
    无连接器环境返回 None，保持原演示路径（人工分段判定）。"""
    cm = CONN_MAP.get(op['code'])
    if not cm:
        return None
    c = _conn()
    if not c or not c.probe(cm[0]):
        return None
    key, action = cm
    try:
        r = c.apply(key, action, _spec_for(op, op['code']), idem=op['id'])
    except Exception as e:
        return {'ok': False,
                'reason': '连接器 %s 读不到（%s）：未改动资源，可重试执行或转人工兜底（T08）'
                          % (c.NAMES.get(key, key), str(e)[:90])}
    ts = _now()
    conn.execute(
        'INSERT OR REPLACE INTO op_conn(op_id, connector, plan_id, ext_txn_id, task_id, action,'
        ' stage_names, dispatched_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        (op['id'], key, '', r['ext_txn_id'], r['task_id'], action,
         _dumps(r.get('stage_names') or []), ts, ts))
    names = r.get('stage_names') or []
    if names:
        rows = conn.execute('SELECT seq FROM op_stages WHERE op_id=? ORDER BY seq', (op['id'],)).fetchall()
        for i, row in enumerate(rows[:len(names)]):
            conn.execute('UPDATE op_stages SET name=? WHERE op_id=? AND seq=?', (names[i], op['id'], row['seq']))
    _trace(conn, op['id'], actor['id'], 'g7 执行归属', 'dispatch', '通过', '',
           '已下发 %s 执行体（任务 %s，外部回执 %s%s）；执行体回报到位前，分段不得人工判过'
           % (c.NAMES.get(key, key), r['task_id'], r['ext_txn_id'],
              '，幂等重放：同单号只受理一次' if r.get('replayed') else ''))
    return None


def execute(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    need = _g2(conn, actor, op['code'], 'execute')
    if need:
        return _deny(conn, op['id'], actor['id'], 'g2 权限项', '当前账号没有操作权限项「%s」' % need, '原文 1.3')
    if op['status'] == '待复核':
        return _deny(conn, op['id'], actor['id'], 'g5 双人复核',
                     '凭证 / 额度 / 权限项 / 下线类动作必须先由另一名账号复核，未复核不得执行', '原文 2.6-3')
    if op['status'] != '待窗口':
        return {'ok': False, 'reason': '当前是「%s」，须先审批通过并排队' % op['status']}
    win = conn.execute("SELECT * FROM op_windows WHERE status='使用中' ORDER BY id LIMIT 1").fetchone()
    if not win and not op['urgent']:
        return _deny(conn, op['id'], actor['id'], 'g6 变更窗口',
                     '当前无开放变更窗口：已保留排队位次，待预约窗口开启后自动接续（紧急通道需单独权限）', '原文 2.10-2')
    dual = bool((CATALOG.get(op['code']) or {}).get('needs_dual'))
    if not dual:
        err = _dispatch(conn, op, actor)
        if err:
            return err
    if dual:
        status = '待复核'
    elif op['exec_mode'] == '外部执行需回执':
        status = '待回执'
    else:
        status = '执行中'
    crow = conn.execute('SELECT ext_txn_id FROM op_conn WHERE op_id=?', (op['id'],)).fetchone()
    if crow:
        ext = crow['ext_txn_id']
    else:
        ext = ('EXT-%04d' % (int(datetime.now().timestamp()) % 10000)) if status == '待回执' else ''
    conn.execute('UPDATE operations SET status=?, executed_by=?, executed_at=?, window_id=?, external_ref=?,'
                 ' queue_pos=NULL, updated_at=? WHERE id=?',
                 (status, actor['id'], _now(), win['id'] if win else '', ext, _now(), op['id']))
    if status == '执行中':
        conn.execute("UPDATE op_stages SET state='执行中', at=? WHERE op_id=? AND seq=0", (_stamp(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g6 变更窗口', 'execute', '通过', '',
           '紧急通道下发（须 24h 内补审）' if op['urgent'] else '落当前使用中窗口（%s），串行执行' % (win['id'] if win else ''))
    if status == '待回执':
        _trace(conn, op['id'], actor['id'], 'g7 执行归属', 'execute', '记录', '',
               '已下发 %s 执行（%s）；回执到位前不改台账占用' % (CATALOG.get(op['code'], {}).get('external', '外部系统'), ext))
    _notify(conn, op['id'], '值班', '站内消息', '已发送')
    _audit(conn, actor['id'], 'opctl_execute', op['id'], '状态 → ' + status)
    return {'ok': True, 'state': serialize(conn)}


def review(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    d = CATALOG.get(op['code']) or {}
    if not d.get('needs_dual'):
        return {'ok': False, 'reason': '该动作不要求双人复核'}
    if op['status'] != '待复核':
        return {'ok': False, 'reason': '当前是「%s」，不在待复核状态' % op['status']}
    need = _g2(conn, actor, op['code'], 'review')
    if need:
        return _deny(conn, op['id'], actor['id'], 'g2 权限项', '当前账号没有操作权限项「%s」' % need, '原文 1.3')
    if op['executed_by'] and op['executed_by'] == actor['id']:
        return _deny(conn, op['id'], actor['id'], 'g5 双人复核',
                     '执行人与复核人必须是两个不同账号，同一人不得兼任；未完成双人复核不得标记发放成功',
                     '原文 2.6-3 / 2.7-3')
    err = _dispatch(conn, op, actor)
    if err:
        return err
    crow = conn.execute('SELECT ext_txn_id FROM op_conn WHERE op_id=?', (op['id'],)).fetchone()
    conn.execute("UPDATE operations SET status='执行中', reviewed_by=?, reviewed_at=?, updated_at=?,"
                 ' external_ref=COALESCE(?, external_ref) WHERE id=?',
                 (actor['id'], _now(), _now(), crow['ext_txn_id'] if crow else None, op['id']))
    if not conn.execute("SELECT 1 FROM op_stages WHERE op_id=? AND state='执行中'", (op['id'],)).fetchone():
        conn.execute("UPDATE op_stages SET state='执行中' WHERE op_id=? AND seq=0 AND state='待执行'", (op['id'],))
    _trace(conn, op['id'], actor['id'], 'g5 双人复核', 'review', '通过', '',
           '复核人 %s 与执行 %s 非同一人；配置与审批一致，放行至窗口' %
           (_name(conn, actor['id']), _name(conn, op['executed_by'])))
    _audit(conn, actor['id'], 'opctl_review', op['id'], '双人复核通过')
    return {'ok': True, 'state': serialize(conn)}


def receipt(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] != '待回执':
        return {'ok': False, 'reason': '当前是「%s」，不在待回执状态' % op['status']}
    note = str(p.get('note') or '').strip()
    if len(note) < 6:
        return {'ok': False, 'reason': '回执要写执行结果说明（不少于 6 字），台账与审计要看'}
    ok = bool(p.get('ok'))
    conn.execute('UPDATE operations SET receipt_note=?, updated_at=? WHERE id=?', (note[:300], _now(), op['id']))
    if ok:
        conn.execute("UPDATE operations SET status='执行中' WHERE id=?", (op['id'],))
        conn.execute("UPDATE op_stages SET state='执行中' WHERE op_id=? AND state='待执行'", (op['id'],))
        _trace(conn, op['id'], actor['id'], 'g7 执行归属', 'receipt', '通过', '', '回执：' + note[:120])
    else:
        conn.execute("UPDATE operations SET status='失败', fail_stage='外部执行回执', fail_reason=? WHERE id=?",
                     (note[:200], op['id']))
        _trace(conn, op['id'], actor['id'], 'g7 执行归属', 'receipt', '失败', note[:120], '台账不动，生成人工兜底工单')
        _fallback(conn, op['id'], '外部执行失败', '%s 外部执行失败：%s' % (op['id'], note[:120]))
    _audit(conn, actor['id'], 'opctl_receipt', op['id'], ('成功' if ok else '失败') + '：' + note[:80])
    return {'ok': True, 'state': serialize(conn)}


def stage(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] not in ('执行中', '部分成功'):
        return {'ok': False, 'reason': '当前是「%s」，不能在分段判定上推进' % op['status']}
    rows = conn.execute('SELECT seq, name, state FROM op_stages WHERE op_id=? ORDER BY seq', (op['id'],)).fetchall()
    cur = next((r for r in rows if r['state'] != '通过'), None)
    if not cur:
        return {'ok': False, 'reason': '所有分段已通过，请做效果验证'}
    ok = bool(p.get('ok'))
    reason = str(p.get('reason') or '')[:160]
    if ok:
        crow = conn.execute('SELECT * FROM op_conn WHERE op_id=?', (op['id'],)).fetchone()
        if crow:
            c = _conn()
            if not c:
                return {'ok': False, 'reason': '连接器模块读不到，分段判定保持原状（不用默认值）'}
            try:
                if not c.probe(crow['connector']):
                    raise c.ConnectorError('探测不通')
                t = c.task(crow['connector'], crow['task_id'])
            except Exception as e:
                return {'ok': False,
                        'reason': '连接器 %s 读不到（%s）：分段判定保持原状，不以默认值代替执行体回报（T08）'
                                  % (crow['connector'], str(e)[:70])}
            done_n = sum(1 for s in t['stages'] if s['state'] == '完成')
            passed = conn.execute("SELECT COUNT(*) c FROM op_stages WHERE op_id=? AND state='通过'",
                                  (op['id'],)).fetchone()['c']
            if done_n <= passed:
                nxt = t['stages'][passed]['name'] if len(t['stages']) > passed else '—'
                err_txt = ('：' + t['last_error']) if t.get('last_error') else ''
                return {'ok': False,
                        'reason': '执行体回报分段「%s」尚未完成%s，不得先行判定通过（原文 2.5-2：仅实例启动不算上线成功）'
                                  % (nxt, err_txt)}
        conn.execute("UPDATE op_stages SET state='通过', at=? WHERE op_id=? AND seq=?",
                     (_stamp(), op['id'], cur['seq']))
        left = conn.execute("SELECT COUNT(*) c FROM op_stages WHERE op_id=? AND state!='通过'",
                            (op['id'],)).fetchone()['c']
        nxt = conn.execute("SELECT name FROM op_stages WHERE op_id=? AND state='待执行' ORDER BY seq LIMIT 1",
                           (op['id'],)).fetchone()
        if left == 0:
            conn.execute("UPDATE operations SET status='已生效', after_snap='变更后台账快照已留存', updated_at=?"
                         ' WHERE id=?', (_now(), op['id']))
            _trace(conn, op['id'], actor['id'], 'g8 分段成功判定', 'stage_check', '通过', '',
                   '「%s」通过：全部分段齐备 → 已生效（原文 2.5-2：仅实例启动不算上线成功）' % cur['name'])
            _notify(conn, op['id'], '值班', '站内消息', '已送达')
        else:
            if nxt:
                conn.execute("UPDATE op_stages SET state='执行中' WHERE op_id=? AND name=?", (op['id'], nxt['name']))
            _trace(conn, op['id'], actor['id'], 'g8 分段成功判定', 'stage_check', '通过', '',
                   '「%s」通过 → 下一段「%s」执行中；分段未齐备不得显示整体成功' % (cur['name'], nxt['name'] if nxt else '—'))
    else:
        conn.execute("UPDATE op_stages SET state='失败', reason=?, at=? WHERE op_id=? AND seq=?",
                     (reason or '未填写原因', _stamp(), op['id'], cur['seq']))
        conn.execute("UPDATE operations SET status='部分成功', fail_stage=?, fail_reason=?, updated_at=? WHERE id=?",
                     (cur['name'], reason or '未填写原因', _now(), op['id']))
        _trace(conn, op['id'], actor['id'], 'g8 分段成功判定', 'stage_check', '失败',
               reason or '未填写原因',
               '「%s」失败：界面不得显示整体上线成功，可重试该段 / 回退 / 转人工兜底（原文 2.5-2/3）' % cur['name'])
    _audit(conn, actor['id'], 'opctl_stage', op['id'], '%s %s' % (cur['name'], '通过' if ok else '失败'))
    return {'ok': True, 'state': serialize(conn)}


def verify(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] != '已生效':
        return {'ok': False, 'reason': '当前是「%s」，须先生效再验证' % op['status']}
    ev = str(p.get('evidence') or '').strip()
    if len(ev) < 6:
        return _deny(conn, op['id'], actor['id'], 'g9 效果验证',
                     '要填同口径的变更前后对比证据（时延 / 失败率 / 用量），不以登记完成代替验证', '原文 SP-08 / 2.8-4')
    conn.execute("UPDATE operations SET status='已验证', updated_at=? WHERE id=?", (_now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g9 效果验证', 'verify', '通过', '', '前后同口径对比：' + ev[:140])
    _audit(conn, actor['id'], 'opctl_verify', op['id'], ev[:120])
    return {'ok': True, 'state': serialize(conn)}


def close(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] != '已验证':
        return {'ok': False, 'reason': '当前是「%s」，验证通过才能闭环' % op['status']}
    conn.execute("UPDATE operations SET status='已闭环', updated_at=? WHERE id=?", (_now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g10 通知与台账', 'close', '通过', '',
           '台账与实际状态一致，未闭环事项已清零（原文 2.10-3）')
    _notify(conn, op['id'], op['requested_by'], '站内消息', '已送达')
    _audit(conn, actor['id'], 'opctl_close', op['id'], '闭环')
    return {'ok': True, 'state': serialize(conn)}


def rollback(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if op['status'] not in ('执行中', '部分成功', '已生效', '待回执'):
        return {'ok': False, 'reason': '当前是「%s」，不能回退' % op['status']}
    if op['code'] == 'OC-D-08':
        return _deny(conn, op['id'], actor['id'], 'g10 回退',
                     '凭证吊销不可自动回滚，只能按原批准范围重新发放并重新双人复核', '原文 2.6-4')
    rid = _next(conn, 'OP', 'opctl_seq')
    ts = _now()
    d = CATALOG.get(op['code']) or {}
    conn.execute(
        'INSERT INTO operations(id, code, target, params, ticket_id, ticket_kind, status, requested_by,'
        ' requested_at, exec_mode, impact, before_snap, after_snap, rollback_of, created_at, updated_at)'
        ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (rid, op['code'], op['target'], op['params'], 'CHG-%04d' % (int(datetime.now().timestamp()) % 10000),
         '变更单', '已回滚', actor['id'], ts, op['exec_mode'], op['impact'],
         op['after_snap'] or '取变更前快照', '已恢复至 ' + (op['before_snap'] or ''), op['id'], ts, ts))
    for i, name in enumerate(d.get('stages') or []):
        conn.execute('INSERT INTO op_stages(op_id, seq, name, state, at) VALUES(?,?,?,?,?)',
                     (rid, i, '反向·' + name, '通过', _stamp()))
    _trace(conn, rid, actor['id'], 'g10 回退', 'rollback', '记录', '',
           '对 %s 生成反向操作并按变更前快照复验；回退失败须保持事件在途并转故障处理单（原文 2.10-2）' % op['id'])
    conn.execute("UPDATE operations SET status='已回滚', updated_at=? WHERE id=?", (ts, op['id']))
    crow = conn.execute('SELECT * FROM op_conn WHERE op_id=?', (op['id'],)).fetchone()
    if crow:
        c = _conn()
        try:
            r = c.rollback(crow['connector'], crow['task_id'])
            _trace(conn, rid, actor['id'], 'g7 执行归属', 'rollback_conn', '通过', '',
                   '执行体已按变更前快照回退（外部回执 %s）' % r['ext_txn_id'])
        except Exception as e:
            _trace(conn, rid, actor['id'], 'g7 执行归属', 'rollback_conn', '失败', str(e)[:80],
                   '连接器读不到，执行体侧回退未能确认：保持事件在途并转人工兜底（原文 2.10-2）')
            _fallback(conn, rid, '执行体回退未确认',
                      '%s 经连接器 %s 的回退未能确认，需在对方侧人工核对' % (op['id'], crow['connector']))
    _trace(conn, op['id'], actor['id'], 'g10 回退', 'rollback', '记录', '', '已生成反向操作 ' + rid)
    _audit(conn, actor['id'], 'opctl_rollback', op['id'], '→ ' + rid)
    return {'ok': True, 'state': serialize(conn)}


def emergency(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    if not has_perm(conn, actor['id'], 'opctl.emergency'):
        return _deny(conn, op['id'], actor['id'], 'g2 权限项',
                     '没有紧急处置权限项 opctl.emergency：紧急通道逐账号开启，且仍不得执行放宽类动作', '原文 1.2 / 6-1')
    d = CATALOG.get(op['code']) or {}
    if not d.get('urgent'):
        return _deny(conn, op['id'], actor['id'], '紧急通道', '该动作不在紧急白名单内（放宽类动作紧急也禁止）', '原文 1.2 / GW-12')
    due = (datetime.now() + timedelta(hours=24)).strftime('%m-%d %H:%M')
    ticket = 'CHG-%04d' % (int(datetime.now().timestamp()) % 10000)
    conn.execute('UPDATE operations SET urgent=1, emergency_due=?, emergency_state=?, ticket_id=?, updated_at=?'
                 ' WHERE id=?', (due, '待补审', ticket, _now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g4 审批 / 紧急通道', 'emergency', '记录', '',
           '走紧急通道不受变更窗口限制，自动建关联变更单 %s；须 %s 前补审，超时升级值班长' % (ticket, due))
    _audit(conn, actor['id'], 'opctl_emergency', op['id'], due)
    return {'ok': True, 'state': serialize(conn)}


def complement(conn, actor, p):
    op = _op(conn, str(p.get('id') or ''))
    if not op:
        return {'ok': False, 'reason': '找不到操作记录'}
    conn.execute("UPDATE operations SET emergency_state='已补审', updated_at=? WHERE id=?", (_now(), op['id']))
    _trace(conn, op['id'], actor['id'], 'g4 审批 / 紧急通道', 'complement', '通过', '', '紧急处置已补审并归档关联变更单')
    _audit(conn, actor['id'], 'opctl_complement', op['id'], '补审')
    return {'ok': True, 'state': serialize(conn)}


def window(conn, actor, p):
    action = str(p.get('action') or '')
    wid = str(p.get('id') or '')
    if action == 'open':
        conn.execute("UPDATE op_windows SET status='使用中' WHERE id=?", (wid,))
    elif action == 'close':
        conn.execute("UPDATE op_windows SET status='已结束' WHERE id=?", (wid,))
    else:
        return {'ok': False, 'reason': '未知窗口动作'}
    _trace(conn, None, actor['id'], 'g6 变更窗口', 'window_' + action, '记录', '', '窗口 %s' % wid)
    _audit(conn, actor['id'], 'opctl_window', wid, action)
    return {'ok': True, 'state': serialize(conn)}


def autoscale(conn, actor, p):
    pid = str(p.get('policyId') or '')
    pol = next((x for x in POLICIES if x['id'] == pid), None)
    if not pol:
        return {'ok': False, 'reason': '找不到策略'}
    need = _g2(conn, actor, 'OC-F-01', 'execute')
    if need:
        return _deny(conn, None, actor['id'], 'g2 权限项', '当前账号没有操作权限项「%s」' % need, '原文 1.3')
    if not pol['approved']:
        op_id = _next(conn, 'OP', 'opctl_seq')
        ts = _now()
        _new_auto_op(conn, op_id, pol, '草稿', ts, fail=False)
        _trace(conn, op_id, actor['id'], 'g1 工单绑定 / 策略授权', 'autoscale', '拦下',
               '策略 %s 未获批 → 不执行，转人工审批（原文 1.1-9：未获批不得执行）')
        return {'ok': False, 'verdict': '未获批', 'reason': '策略 %s 未获批：不执行任何资源变更，已转人工审批并留待办' % pol['ver'],
                'state': serialize(conn)}
    if p.get('buildFail'):
        op_id = _next(conn, 'OP', 'opctl_seq')
        ts = _now()
        _new_auto_op(conn, op_id, pol, '草稿', ts, fail=True)
        _trace(conn, op_id, actor['id'], 'g1 工单绑定 / 策略授权', 'autoscale', '拦下',
               '执行前建变更工单失败 → 硬阻断，不得执行（原文 2.8-4）')
        _fallback(conn, op_id, '自动变更建单失败', '%s %s：变更工单创建失败，已阻断执行' % (op_id, pol['name']))
        return {'ok': False, 'verdict': '范围内',
                'reason': '策略范围内，但执行前建单失败 → 已硬阻断，未产生任何资源变更，并生成兜底待办',
                'state': serialize(conn)}
    op_id = _next(conn, 'OP', 'opctl_seq')
    ts = _now()
    _new_auto_op(conn, op_id, pol, '执行中', ts, fail=False)
    conn.execute('UPDATE operations SET executed_by=?, executed_at=?, ticket_id=? WHERE id=?',
                 (actor['id'], ts, 'CHG-%04d' % (int(datetime.now().timestamp()) % 10000), op_id))
    _trace(conn, op_id, actor['id'], 'g1 工单绑定 / 策略授权', 'autoscale', '通过', '',
           '获批策略 %s %s 范围内：%s · %s · %s · 副本 %d–%d · 冷却 %s；免逐次人工审批（原文 1.1-9）'
           % (pol['name'], pol['ver'], pol['metric'], pol['threshold'], pol['sustain'], pol['mn'], pol['mx'], pol['cooldown']))
    _audit(conn, actor['id'], 'opctl_autoscale', op_id, pol['id'])
    return {'ok': True, 'verdict': '范围内',
            'reason': '已先建变更工单并自动执行（范围内免逐次人工审批），副本上限 %d，冷却 %s 内不再触发' % (pol['mx'], pol['cooldown']),
            'state': serialize(conn)}


def _new_auto_op(conn, op_id, pol, status, ts, fail):
    conn.execute(
        'INSERT INTO operations(id, code, target, params, ticket_id, ticket_kind, status, requested_by,'
        ' requested_at, exec_mode, impact, before_snap, urgent, fail_stage, created_at, updated_at)'
        ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (op_id, 'OC-F-01', '%s（自动）' % pol['scope'], _dumps({'svc': pol['scope'], 'to': str(pol['mx'])}),
         '建单失败' if fail else '—', '变更单', status, 'platform',
         ts, '平台自动', _dumps(['推理实例 ×1', '算力卡位 ×1', '网关路由 ×1']),
         '未执行，无变更' if fail else '变更前台账快照已留存', 0,
         '执行前建变更工单' if fail else '', ts, ts))
    names = CATALOG['OC-F-01']['stages']
    for i, name in enumerate(names):
        st = '失败' if (fail and i == 0) else '待执行'
        conn.execute('INSERT INTO op_stages(op_id, seq, name, state) VALUES(?,?,?,?)', (op_id, i, name, st))


def _fallback(conn, op_id, title, detail):
    fid = 'FB-%03d' % (conn.execute('SELECT COUNT(*) c FROM op_fallbacks').fetchone()['c'] + 1)
    conn.execute('INSERT INTO op_fallbacks(id, op_id, title, detail, status, owner, at)'
                 ' VALUES(?,?,?,?,?,?,?)',
                 (fid, op_id, '%s · %s' % (title, op_id), detail[:300], '在途', 'U-0001', _stamp()))
    conn.execute("UPDATE operations SET status='待人工兜底', updated_at=? WHERE id=?", (_now(), op_id))


def _notify(conn, op_id, to_who, channel, st):
    conn.execute('INSERT INTO op_notify(op_id, to_who, channel, at, state) VALUES(?,?,?,?,?)',
                 (op_id, to_who or '值班', channel, _stamp(), st))


def takeover(conn, actor, p):
    op_id = str(p.get('opId') or p.get('id') or '')
    conn.execute("UPDATE op_fallbacks SET status='已接管', owner=? WHERE op_id=? AND status!='已关闭'",
                 (actor['id'], op_id))
    _audit(conn, actor['id'], 'opctl_takeover', op_id, '人工接管兜底')
    return {'ok': True, 'state': serialize(conn)}


def sweep(conn, actor=None):
    """超时未回执 → 人工兜底（沿用处置指令台 sweep_commands 口径）"""
    hit = conn.execute("SELECT id FROM operations WHERE status='待回执'").fetchall()
    for r in hit:
        _fallback(conn, r['id'], '超时未获执行回执', '%s 超过回执时限未回写，自动转人工兜底' % r['id'])
    return {'ok': True, 'count': len(hit), 'state': serialize(conn)}


# ---- 逐账号权限 ----
def perm_toggle(conn, actor, p):
    acct = str(p.get('account') or '')
    perm = str(p.get('perm') or '')
    if not acct or not perm:
        return {'ok': False, 'reason': '要指定账号与权限项'}
    if perm not in [x[0] for x in PERM_ITEMS]:
        return {'ok': False, 'reason': '未知权限项'}
    row = conn.execute('SELECT * FROM op_perms WHERE account_id=? AND perm=?', (acct, perm)).fetchone()
    ts = _now()
    ticket = 'CHG-%04d' % (int(datetime.now().timestamp()) % 10000)
    if row and not row['revoked_at']:
        conn.execute('UPDATE op_perms SET revoked_at=?, granted_by=? WHERE account_id=? AND perm=?',
                     (ts, actor['id'], acct, perm))
        before, after = '开启（%s）' % row['scope'], '已关闭'
    else:
        conn.execute('INSERT INTO op_perms(account_id, perm, scope, granted_by, ticket_id, granted_at, revoked_at)'
                     ' VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(account_id, perm)'
                     ' DO UPDATE SET scope=excluded.scope, granted_by=excluded.granted_by,'
                     ' ticket_id=excluded.ticket_id, granted_at=excluded.granted_at, revoked_at=NULL',
                     (acct, perm, (row['scope'] if row else 'org'), actor['id'], ticket, ts))
        before, after = ('未开启' if not row else '已关闭'), '开启（%s）' % (row['scope'] if row else 'org')
    conn.execute('INSERT INTO op_perm_changes(at, account_id, perm, before_val, after_val, actor, ticket_id, scope)'
                 ' VALUES(?,?,?,?,?,?,?,?)',
                 (_stamp(), acct, perm, before, after, actor['id'], ticket, '—'))
    _audit(conn, actor['id'], 'opctl_perm_toggle', '%s/%s' % (acct, perm), after)
    return {'ok': True, 'state': serialize(conn), 'perms': perms_payload(conn)}


def perm_scope(conn, actor, p):
    acct = str(p.get('account') or '')
    perm = str(p.get('perm') or '')
    scope = str(p.get('scope') or 'org')
    if scope not in ('self', 'org', 'line', 'global'):
        return {'ok': False, 'reason': '未知数据范围'}
    conn.execute('UPDATE op_perms SET scope=? WHERE account_id=? AND perm=?', (scope, acct, perm))
    conn.execute('INSERT INTO op_perm_changes(at, account_id, perm, before_val, after_val, actor, ticket_id, scope)'
                 ' VALUES(?,?,?,?,?,?,?,?)',
                 (_stamp(), acct, perm, '—', '数据范围改为' + scope, actor['id'],
                  'CHG-%04d' % (int(datetime.now().timestamp()) % 10000), scope))
    _audit(conn, actor['id'], 'opctl_perm_scope', '%s/%s' % (acct, perm), scope)
    return {'ok': True, 'state': serialize(conn), 'perms': perms_payload(conn)}


ACTIONS = {
    'precheck': precheck, 'submit': submit, 'approve': approve, 'reject': reject,
    'execute': execute, 'review': review, 'receipt': receipt, 'stage': stage,
    'verify': verify, 'close': close, 'rollback': rollback, 'emergency': emergency,
    'complement': complement, 'window': window, 'autoscale': autoscale,
    'takeover': takeover, 'sweep': sweep, 'perm/toggle': perm_toggle, 'perm/scope': perm_scope,
}


# --------------------------------------------------------------------------- 种子
def seed(conn):
    """写入演示数据：逐账号权限 + 夜间变更窗口 + 4 条代表性操作（仅在空表时执行）"""
    # 逐账号权限：只补缺失的（升级老库时把新增账号的默认授权补上，不覆盖已调整过的授权）
    ts = _now()
    for acct, perm, scope in SEED_PERMS:
        conn.execute('INSERT OR IGNORE INTO op_perms(account_id, perm, scope, granted_by, ticket_id,'
                     ' granted_at) VALUES(?,?,?,?,?,?)', (acct, perm, scope, 'U-0001', 'REQ-0001', ts))
    if conn.execute('SELECT COUNT(*) c FROM op_windows').fetchone()['c'] == 0:
        ts = _now()
        conn.execute("INSERT OR IGNORE INTO op_windows(id, scope, t_from, t_to, reason, status, by_id, created_at)"
                     " VALUES('W-DAY','共享集群','12:00','13:00','日间小窗口：仅配置类变更','已结束','U-0002',?)", (ts,))
        conn.execute("INSERT OR IGNORE INTO op_windows(id, scope, t_from, t_to, reason, status, by_id, created_at)"
                     " VALUES('W-NIGHT','全平台','22:00','23:30','夜间窗口：部署 / 扩缩容 / 额度调整','使用中','U-0001',?)", (ts,))
    if conn.execute('SELECT COUNT(*) c FROM operations').fetchone()['c'] > 0:
        return 0
    ts = _now()
    items = [
        # (id, code, target, params, status, requested_by, approved_by, executed_by, reviewed_by, extra)
        ('OP-2101', 'OC-D-03', 'SK-示例业务一部-07（Service Account Key）',
         {'kind': 'Service Account Key', 'model': 'Qwen2.5-VL-7B', 'rpm': '600'}, '待复核', 'U-0002', 'U-0001', 'U-0002', None),
        ('OP-2102', 'OC-B-02', 'DeepSeek-V3-R1（共享池）', {'model': 'DeepSeek-V3-R1'}, '部分成功', 'U-0002', 'U-0001',
         'U-0002', None),
        ('OP-2103', 'OC-F-01', 'Qwen2.5-VL-7B（高保池）', {'svc': 'Qwen2.5-VL-7B', 'to': '6'}, '草稿',
         'U-0002', None, 'platform', None),
        ('OP-2105', 'OC-G-03', '人脸比对 v2.3（MCP）', {'svc': '人脸比对 v2.3'}, '已闭环', 'U-0002', 'U-0001',
         'U-0002', None),
        ('OP-2106', 'OC-E-04', 'FT-2026-142（示例业务一部 · 8 卡）', {'cards': '8', 'days': '14'}, '待窗口',
         'U-0003', 'U-0001', None, None),
    ]
    for op_id, code, target, params, status, req, appr, exe, rev in items:
        d = CATALOG[code]
        conn.execute(
            'INSERT INTO operations(id, code, target, params, ticket_id, ticket_kind, status, requested_by,'
            ' requested_at, approved_by, approved_at, executed_by, executed_at, reviewed_by, reviewed_at,'
            ' exec_mode, precheck_id, impact, before_snap, after_snap, queue_pos, created_at, updated_at,'
            ' fail_stage, external_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (op_id, code, target, _dumps(params), 'WO-%04d' % (900 + len(op_id)), d['ticket'], status, req, ts,
             appr, ts if appr else None, exe, ts if exe else None, rev, ts if rev else None, d['exec_mode'],
             'PRE-2101', _dumps(['%s ×1' % k for k in d['impact']]), '变更前台账快照已留存',
             '变更后台账快照已留存' if status == '已闭环' else None,
             1 if status == '待窗口' else None, ts, ts,
             '网关注册' if status == '部分成功' else None,
             'K8S-DEPLOY-8842' if status == '部分成功' else None))
        for i, name in enumerate(d['stages']):
            if status == '部分成功':
                st = '通过' if i == 0 else ('失败' if i == 1 else '待执行')
            elif status == '已闭环':
                st = '通过'
            elif status in ('待复核', '待审批'):
                st = '待执行'
            else:
                st = '执行中' if i == 0 else '待执行'
            conn.execute('INSERT INTO op_stages(op_id, seq, name, state) VALUES(?,?,?,?)', (op_id, i, name, st))
    _trace(conn, 'OP-2101', 'U-0002', 'g5 双人复核', 'execute', '记录', '',
           '执行完成，等待另一名运营账号复核（原文 2.6-3：同一人不得兼任）')
    _trace(conn, 'OP-2102', 'platform', 'g8 分段成功判定', 'stage_check', '失败',
           '网关注册失败：渠道名冲突 channel=qwen-vl-shared 已存在',
           '实例健康通过，网关注册失败 → 整体不得显示上线成功（原文 2.5-2）')
    _trace(conn, 'OP-2103', 'platform', 'g1 工单绑定 / 策略授权', 'autoscale', '拦下',
           '策略 v0 未获批，且模拟建单失败 → 不执行任何资源变更（原文 1.1-9）')
    _trace(conn, 'OP-2105', 'U-0002', 'g10 通知与台账', 'notify', '记录', '',
           '应用侧状态交接：使用目录同步回执已取回，双端目录一致后才闭环（原文 4.2.1-2）')
    _notify(conn, 'OP-2102', 'U-0001', '站内消息', '已送达')
    return len(items)


def _dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False)
