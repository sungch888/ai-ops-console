/* =====================================================================
 * engine-utils.ts — Engine 纯函数工具（无类、无副作用）
 * 从 engine.ts 拆分：admission / applyEffect / reverseEffect 等
 * ===================================================================== */

import type { EngineState, Order, OrderType, Level, ContainKind, ContainAction, ManagedStatus, ScenarioId, PoolId, Cred, Channel, ModelDef, WindowSlot } from './engine'
import { ACTION_STATUS, ContainKind as CK, DIRECTORY_KINDS } from './types'
import { connectorStore, rentConfig } from './connectors'

function governDependents(connectorName: string): string[] {
  return connectorStore.dependentsOf(connectorName)
}

// ── 常量 / 类型别名（从 engine.ts 复制，供纯函数使用）─────────────
export const EXTERNAL_TYPES: OrderType[] = ['model_deploy']
export const URGENT_TYPES: OrderType[] = ['containment', 'access_block', 'access_restore', 'credential_revoke', 'quota_adjust']
export const TYPE_LABEL: Record<OrderType, string> = {
  pool_expand: '算力池扩容', pool_release: '算力池释放', preempt: '高保优先抢占',
  replica_scale: '模型副本调整', weight_adjust: '渠道权重调整', credential_issue: '凭证发放',
  credential_revoke: '凭证吊销', quota_adjust: '配额调整', containment: '纳管对象处置',
  model_rollback: '模型版本回退', model_retire: '模型下线', access_block: '接入阻断',
  access_restore: '接入恢复', model_deploy: '模型部署', train_reserve: '训练卡位预留',
  train_release: '训练卡位归还', weight_register: '训练产物权重登记', model_admission: '模型准入审核',
}
export const ORDER_STATUS_LABEL: Record<string, string> = {
  to_biz: '待业务管理审批', submitted: '待审批', approved: '已审批', queued: '已排队', rejected: '已驳回',
  running: '执行中', rolled_back: '已回滚', closed: '已闭环', external: '待回执',
}
export const BASIS_OPTS = ['告警触发', '合规抽查', '客户方指令', '容量规划', '自动调度']

// ── 内部工具 ────────────────────────────────────────────────────────
export function trace(o: Order, actor: string, action: string, detail: string, tone: 'good' | 'warn' | 'bad' | 'info') {
  o.trace.push({ time: new Date().toISOString(), actor, action, detail, tone })
}

export function nowStr() { return new Date().toISOString() }

export function pushHistory(st: EngineState) {
  st.history = (st.history || []).concat(
    st.orders.slice(-5).map(o => ({
      time: nowStr(), util: { [o.type]: 1 },
    }))
  ).slice(-20)
}

export function freeCards(st: EngineState) {
  const total = (st as any)._totalCards || 88
  let allocated = 0
  st.pools.forEach(p => { if (p.id !== 'train') allocated += p.cards })
  return Math.max(0, total - allocated + (st.rented || 0))
}

export function demandOf(st: EngineState, poolId: PoolId) {
  return st.models.filter(m => m.pool === poolId).reduce((sum, m) => sum + m.replicas * m.perReplica, 0)
}

export function poolUtil(st: EngineState, poolId: PoolId) {
  const p = st.pools.find(x => x.id === poolId)!
  if (!p || p.cards === 0) return 100
  return Math.round((demandOf(st, poolId) / p.cards) * 100)
}

export function totalAllocated(st: EngineState) {
  return st.pools.filter(p => p.id !== 'train').reduce((s, p) => s + p.cards, 0)
}

export function appsOfModel(st: EngineState, short: string): string[] {
  const MODEL_APPS: Record<string, string[]> = {} as any
  const creds = st.creds.filter(c => c.model.includes(short) && c.status !== 'off').map(c => c.app)
  return Array.from(new Set([...creds, ...(MODEL_APPS[short] ?? [])]))
}

export function affectedModels(st: EngineState, poolId: PoolId, cards: number) {
  const demand = demandOf(st, poolId)
  return st.models.filter(m => m.pool === poolId && m.replicas > 0).sort((a, b) => a.replicas * a.perReplica - b.replicas * b.perReplica)
}

export function syncChannelRpm(st: EngineState) {
  st.channels.forEach(c => {
    c.allocatedRpm = Math.round(c.capacityRpm * (c.health === 'ok' ? 0.9 : 0.5))
  })
}

export function describeTarget(st: EngineState, type: OrderType, spec: Record<string, number | string | boolean>) {
  if (type === 'pool_expand' || type === 'pool_release') return st.pools.find(p => p.id === spec.pool)?.name ?? String(spec.pool)
  if (type === 'replica_scale') return String(spec.model)
  if (type === 'weight_adjust') return '全渠道权重'
  if (type === 'preempt') {
    const from = st.pools.find(p => p.id === spec.from)?.name ?? String(spec.from)
    const to = st.pools.find(p => p.id === spec.to)?.name ?? String(spec.to)
    return `${from} → ${to}`
  }
  if (type === 'credential_issue') return String(spec.app)
  if (type === 'credential_revoke') return String(spec.credId)
  if (type === 'quota_adjust') return String(spec.credId)
  if (type === 'containment') return `${String(spec.kind)} · ${String(spec.name)}`
  if (type === 'access_block' || type === 'access_restore') return connectorStore.find(String(spec.connectorId))?.name ?? String(spec.connectorId)
  if (type === 'model_rollback') return `${String(spec.model)} 版本`
  if (type === 'model_retire') return String(spec.model)
  if (type === 'model_deploy') return `${String(spec.model)} → ${st.pools.find(p => p.id === String(spec.pool))?.name ?? String(spec.pool)}`
  if (type === 'train_reserve') return String(spec.name)
  if (type === 'train_release') return String(spec.jobId)
  return ''
}

export function describeAmount(type: OrderType, spec: Record<string, number | string | boolean>) {
  if (type === 'pool_expand') return `+${spec.cards} 卡`
  if (type === 'pool_release') return `-${spec.cards} 卡`
  if (type === 'preempt') return `抢占 ${spec.cards} 卡`
  if (type === 'replica_scale') return `${Number(spec.delta) > 0 ? '+' : ''}${spec.delta} 副本`
  if (type === 'weight_adjust') return `权重 ${String(spec.weights).replace(/,/g, '/')}`
  if (type === 'credential_issue') return `RPM ${spec.rpm}`
  if (type === 'credential_revoke') return '吊销'
  if (type === 'quota_adjust') return `RPM → ${spec.rpm}`
  if (type === 'containment') return String(spec.action)
  if (type === 'access_block') {
    const scope = String(spec.scope ?? '全通道')
    return scope === '全通道' ? '阻断接入并停止采集' : `部分阻断（${scope}）：${String(spec.value ?? '')}`
  }
  if (type === 'access_restore') return '恢复接入与采集'
  if (type === 'model_rollback') return `→ ${spec.toVersion}`
  if (type === 'model_retire') return '下线变更'
  if (type === 'model_deploy') return `${spec.replicas} 副本 × ${Number(spec.perReplica) || 1} 卡 · 灰度 ${Number(spec.gray ?? 100)}%`
  if (type === 'train_reserve') return `${spec.cards} 卡 × ${spec.hours} 小时`
  if (type === 'train_release') return '归还卡位'
  return ''
}

// ── 准入计算 ────────────────────────────────────────────────────────
export function admission(st: EngineState, o: Order): { ok: boolean; reason?: string; suggest?: string } {
  switch (o.type) {
    case 'pool_expand': {
      const pool = o.spec.pool as PoolId
      const cards = Number(o.spec.cards)
      const free = freeCards(st)
      if (cards <= 0) return { ok: false, reason: '扩容卡位必须为正整数' }
      const rent = (st as any)._rentInfo ?? { enabled: false, quota: 0, available: 0, price: 0, blocked: '' }
      if (cards > free) {
        const needRent = cards - free
        if (rent.enabled && !rent.blocked && rent.available >= needRent) {
          return { ok: true, reason: undefined, suggest: `本地空闲 ${free} 卡 + 外部扩租 ${needRent} 卡（额度剩 ${rent.available} 卡 · ${rent.price} 元/卡/日）· 执行后「${st.pools.find(x => x.id === pool)!.name}」${cards} 卡到位` }
        }
        const donor = st.pools.find(p => p.id !== pool && poolUtil(st, p.id) < 70)
        const rentNote = rent.enabled
          ? (typeof rent.blocked === 'string' ? (rent.blocked || `扩租额度剩 ${rent.available} 卡，不足 ${needRent} 卡`) : `扩租额度剩 ${rent.available} 卡，不足 ${needRent} 卡`)
          : `${rent.blocked ?? '未开通扩租'}；开通后本地不足时可扩租最多 ${rent.quota} 卡`
        return { ok: false, reason: `全局空闲卡位不足（空闲 ${free} 卡，申请 ${cards} 卡）`, suggest: `${rentNote}${donor ? `；也可先从「${donor.name}」回收 ${Math.min(Number(donor.cards - demandOf(st, donor.id)), free + Number(donor.cards - demandOf(st, donor.id)))} 卡或错峰降载` : ''}` }
      }
      const p = st.pools.find(p => p.id === pool)!
      const after = p.cards + cards
      const utilAfter = Math.round((demandOf(st, pool) / after) * 100)
      return { ok: true, reason: undefined, suggest: `执行后「${p.name}」利用率 ${poolUtil(st, pool)}% → ${utilAfter}%` }
    }
    case 'pool_release': {
      const pool = o.spec.pool as PoolId
      const cards = Number(o.spec.cards)
      const p = st.pools.find(x => x.id === pool)!
      const idle = p.cards - demandOf(st, pool)
      if (cards > idle) return { ok: false, reason: `回收将侵占在用资源：${p.name} 空闲仅 ${idle} 卡，申请回收 ${cards} 卡` }
      return { ok: true, suggest: `回收后 ${p.name} 利用率将升至 ${Math.round((demandOf(st, pool) / (p.cards - cards)) * 100)}%（阈值 85%）` }
    }
    case 'preempt': {
      const fromId = o.spec.from as PoolId
      const toId = o.spec.to as PoolId
      const cards = Number(o.spec.cards)
      const from = st.pools.find(p => p.id === fromId)!
      const to = st.pools.find(p => p.id === toId)!
      if (cards <= 0) return { ok: false, reason: '抢占卡位必须为正整数' }
      if (fromId === toId) return { ok: false, reason: '源池与目标池不能相同' }
      if (o.level !== '高保') return { ok: false, reason: '抢占仅限高保业务（调度等级须为「高保」），共享 / 灰度业务须走常规扩容' }
      const utilTo = poolUtil(st, toId)
      if (utilTo <= 90) return { ok: false, reason: `${to.name} 当前利用率 ${utilTo}%，未达抢占触发线（>90%）`, suggest: `先提交「${to.name} 扩容」；若全局空闲不足再申请抢占` }
      const canGive = from.cards - demandOf(st, fromId)
      if (cards > canGive) return { ok: false, reason: `${from.name} 可让出上限 ${canGive} 卡（在用 ${demandOf(st, fromId)} 卡不可侵占），本次申请抢占 ${cards} 卡`, suggest: `可分批执行：先抢占 ${Math.max(1, canGive)} 卡，剩余走扩租或错峰降载` }
      const affected = affectedModels(st, fromId, cards)
      const utilToAfter = Math.round((demandOf(st, toId) / (to.cards + cards)) * 100)
      const utilFromAfter = Math.round((demandOf(st, fromId) / (from.cards - cards)) * 100)
      return { ok: true, suggest: `抢占后 ${to.name} ${utilTo}% → ${utilToAfter}% · ${from.name} ${poolUtil(st, fromId)}% → ≤${utilFromAfter}%（被抢占副本降级后实际更低）· 受影响业务 ${affected.map(m => m.short).join('、')}` }
    }
    case 'replica_scale': {
      const short = String(o.spec.model)
      const delta = Number(o.spec.delta)
      const m = st.models.find(x => x.short === short)
      if (!m) return { ok: false, reason: `未找到模型 ${short}` }
      const pool = st.pools.find(p => p.id === m.pool)!
      if (delta > 0) {
        const need = delta * m.perReplica
        const free = freeCards(st)
        if (need > free) return { ok: false, reason: `副本增加需要 ${need} 卡，全局空闲仅 ${free} 卡` }
        const utilAfter = Math.round((demandOf(st, m.pool) + need) / (pool.cards + need) * 100)
        return { ok: true, suggest: `执行后 ${m.short} 副本 ${m.replicas} → ${m.replicas + delta}，「${pool.name}」利用率 ${poolUtil(st, m.pool)}% → ${utilAfter}%` }
      }
      if (delta < 0 && m.replicas + delta < 1) return { ok: false, reason: `${short} 最少保留 1 个副本` }
      return { ok: true, suggest: `副本 ${m.replicas} → ${m.replicas + delta}，释放 ${Math.abs(delta) * m.perReplica} 卡` }
    }
    case 'weight_adjust': {
      const ws = String(o.spec.weights).split(',').map(Number)
      if (ws.some(x => x < 0 || x > 100)) return { ok: false, reason: '权重须在 0-100 之间' }
      if (ws.reduce((s, x) => s + x, 0) !== 100) return { ok: false, reason: '权重之和须等于 100' }
      const dev = Math.max(...ws) - Math.min(...ws)
      return { ok: true, suggest: `权重方案 ${ws.join('/')}，偏离度 ${dev}%` }
    }
    case 'credential_issue': {
      const rpm = Number(o.spec.rpm)
      if (rpm <= 0) return { ok: false, reason: 'RPM 须为正整数' }
      return { ok: true, suggest: `凭证申请 RPM ${rpm}，审批通过后自动发放` }
    }
    case 'credential_revoke': {
      const c = st.creds.find(x => x.id === o.spec.credId)
      if (!c) return { ok: false, reason: `未找到凭证 ${o.spec.credId}` }
      if (c.status === 'off') return { ok: false, reason: `凭证 ${c.id} 已处于「吊销」状态` }
      if (c.lastUsedDays < 90 && c.expDays > 15) return { ok: false, reason: `凭证 ${c.id} 最近 ${c.lastUsedDays} 天有使用、距到期 ${c.expDays} 天，暂不需吊销` }
      return { ok: true, suggest: `凭证 ${c.id} 吊销后关联路由自动清理` }
    }
    case 'quota_adjust': {
      const c = st.creds.find(x => x.id === o.spec.credId)
      if (!c) return { ok: false, reason: `未找到凭证 ${o.spec.credId}` }
      const rpm = Number(o.spec.rpm)
      if (rpm < c.rpm) return { ok: false, reason: `配额下调须先提交「凭证回收」申请` }
      if (rpm > c.rpm * 3) return { ok: false, reason: `临时提额不得超过原配额的 3 倍（${c.rpm} → ${c.rpm * 3} RPM）` }
      return { ok: true, suggest: `凭证 ${c.id} 配额 ${c.rpm} → ${rpm} RPM，审批通过后生效` }
    }
    case 'containment': {
      const m = st.managed.find(x => x.kind === o.spec.kind && x.name === o.spec.name)
      if (!m) return { ok: false, reason: `未找到纳管对象 ${String(o.spec.name)}` }
      const action = String(o.spec.action) as ContainAction
      if (!Object.keys(ACTION_STATUS).includes(action)) return { ok: false, reason: `未知处置动作 ${action}` }
      if (m.status === ACTION_STATUS[action]) return { ok: false, reason: `${m.name} 当前已是「${m.status}」状态，处置动作无变化` }
      const basis = String(o.spec.basis ?? '')
      if (!BASIS_OPTS.includes(basis)) return { ok: false, reason: `处置须注明依据（${BASIS_OPTS.join(' / ')}）` }
      const want = ACTION_STATUS[action]
      const suspending = want === '暂停' || want === '隔离' || want === '禁用'
      if (suspending && m.level === '高保' && basis !== '告警触发' && basis !== '客户方指令') return { ok: false, reason: `${m.name} 属高保业务对象，暂停 / 隔离须有「告警触发」或「客户方指令」依据` }
      if (suspending && o.reason.trim().length < 12) return { ok: false, reason: '暂停 / 隔离 / 禁用 须在理由中写明业务影响与影响范围（不少于 12 字）' }
      const queue = m.kind === '知识库' && want === '暂停' ? Math.max(30, m.queue + 40) : m.queue
      return { ok: true, suggest: `${m.name} 状态 ${m.status} → ${want}${m.kind === '知识库' && want === '暂停' ? ` · 在库队列 ${queue} 项滞留，恢复后自动解除` : ''} · 归口 ${m.owner} 须通知` }
    }
    case 'model_rollback': {
      const m = st.models.find(x => x.short === o.spec.model)
      if (!m) return { ok: false, reason: `未找到模型 ${String(o.spec.model)}` }
      if (m.state !== '运行中') return { ok: false, reason: `${m.short} 已下线，不可执行版本回退` }
      const to = String(o.spec.toVersion)
      if (!m.versions.includes(to)) return { ok: false, reason: `${m.short} 无历史版本 ${to}（可用：${m.versions.join(' / ')}）` }
      if (to === m.ver) return { ok: false, reason: `${m.short} 当前即为 ${to}，无需回退` }
      const apps = appsOfModel(st, m.short)
      return { ok: true, suggest: `${m.short} 版本 ${m.ver} → ${to} · 回退后须验证调用链路可用性 · 受影响应用 ${apps.length} 项须通知` }
    }
    case 'model_retire': {
      const m = st.models.find(x => x.short === o.spec.model)
      if (!m) return { ok: false, reason: `未找到模型 ${String(o.spec.model)}` }
      if (m.state !== '运行中') return { ok: false, reason: `${m.short} 已下线` }
      const basis = String(o.spec.basis ?? '')
      if (!BASIS_OPTS.includes(basis)) return { ok: false, reason: `模型下线须注明依据（${BASIS_OPTS.join(' / ')}）并经下线审批` }
      const cards = m.replicas * m.perReplica
      const pool = st.pools.find(p => p.id === m.pool)!
      if (m.pool === 'hp' && m.replicas <= 1) return { ok: false, reason: `${m.short} 在高保集群仅 ${m.replicas} 个副本，须先扩容或迁移承载后再下线` }
      const creds = st.creds.filter(c => c.model.includes(m.short) && c.status !== 'off')
      const apps = appsOfModel(st, m.short)
      return { ok: true, suggest: `${m.short} 下线释放 ${cards} 卡归还「${pool.name}」· 活跃凭证 ${creds.length} 个须先吊销或迁移 · 受影响应用 ${apps.length} 项须通知 · 保留配置快照可恢复` }
    }
  }
  return { ok: false, reason: '未知申请类型' }
}

// ── 效果应用 ────────────────────────────────────────────────────────
export function applyEffect(st: EngineState, o: Order) {
  switch (o.type) {
    case 'pool_expand': {
      const p = st.pools.find(x => x.id === o.spec.pool)!
      const cards = Number(o.spec.cards)
      const localFree = (st as any)._totalCards || 88
      const rentPart = Math.max(0, Math.min(cards - localFree, (st as any)._rentInfo?.available ?? 0))
      o.spec.rentedPart = rentPart
      p.cards += cards
      st.rented = (st.rented || 0) + rentPart
      break
    }
    case 'pool_release': {
      const p = st.pools.find(x => x.id === o.spec.pool)!
      const cards = Number(o.spec.cards)
      const backRent = Math.min(cards, st.rented || 0)
      o.spec.releasedRented = backRent
      p.cards -= cards
      st.rented = (st.rented || 0) - backRent
      break
    }
    case 'model_deploy': {
      const pool = st.pools.find(x => x.id === String(o.spec.pool))!
      const short = String(o.spec.model)
      const replicas = Number(o.spec.replicas)
      const per = Number(o.spec.perReplica) || 1
      const m = st.models.find(x => x.short === short)
      const version = String(o.spec.version ?? '').trim() || m?.ver || 'v1.0'
      o.spec.prevDeployed = m ? '1' : '0'
      o.spec.prevReplicas = m?.replicas ?? 0
      o.spec.prevVersion = m?.ver ?? ''
      if (m) {
        m.replicas = m.replicas + replicas
        m.ver = version
        if (!m.versions.includes(version)) m.versions = [...m.versions, version]
        m.state = '运行中'
      } else {
        st.models.push({ name: `${short} · 内网部署`, short, pool: pool.id, replicas, perReplica: per, ver: version, versions: [version], state: '运行中' })
      }
      o.spec.prevPoolCards = pool.cards
      break
    }
    case 'train_reserve': {
      const seq = (st.jobs || []).length + 1
      const due = new Date(Date.now() + Number(o.spec.hours) * 3600000)
      st.jobs = [...(st.jobs || []), {
        id: `FT-${130 + seq}`, name: String(o.spec.name), pool: 'train', cards: Number(o.spec.cards),
        applicant: o.applicant, dept: o.dept, framework: String(o.spec.framework), dataLevel: String(o.spec.dataLevel),
        hours: Number(o.spec.hours), dueAt: `${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')} ${due.toTimeString().slice(0, 5)}`, state: '运行中',
      }]
      break
    }
    case 'train_release': {
      const j = (st.jobs || []).find((x: any) => x.id === String(o.spec.jobId))
      if (j) { o.spec.prevJobState = j.state; o.spec.prevJobCards = j.cards; j.state = '已完成' }
      break
    }
    case 'replica_scale': { const m = st.models.find(x => x.short === o.spec.model)!; m.replicas += Number(o.spec.delta); break }
    case 'weight_adjust': {
      const ws = String(o.spec.weights).split(',').map((x: string) => parseInt(x))
      o.spec.prevWeights = st.channels.map((c: any) => c.weight).join(',')
      st.channels.forEach((c: any, i: number) => { c.weight = ws[i] })
      break
    }
    case 'preempt': {
      const from = st.pools.find(p => p.id === o.spec.from)!
      const to = st.pools.find(p => p.id === o.spec.to)!
      const cards = Number(o.spec.cards)
      const affected = affectedModels(st, from.id as PoolId, cards)
      o.spec.prevFromCards = from.cards
      o.spec.prevToCards = to.cards
      o.spec.prevReplicas = affected.map((m: any) => `${m.short}:${m.replicas}`).join(',')
      from.cards -= cards
      to.cards += cards
      let left = cards
      affected.forEach((m: any) => {
        const can = Math.max(0, m.replicas - 1)
        const cut = Math.min(can, Math.floor(left / m.perReplica))
        if (cut > 0) { m.replicas -= cut; left -= cut * m.perReplica }
      })
      break
    }
    case 'credential_issue': {
      st.creds.unshift({ id: String(o.spec.credId ?? `SA-${1000 + st.seq}`), kind: '平台代理' as const, holder: String(o.spec.holder), app: String(o.spec.app), model: String(o.spec.model), channel: String(o.spec.channel), rpm: Number(o.spec.rpm), tpm: String(o.spec.tpm), ip: String(o.spec.ip ?? '10.20.0.0/24'), expDays: 90, lastUsedDays: 0, status: 'ok' as const })
      break
    }
    case 'access_block': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      const scope = String(o.spec.scope ?? '全通道')
      const value = String(o.spec.value ?? '').trim()
      o.spec.prevEnabled = c.enabled
      o.spec.prevHealth = c.health
      o.spec.prevScope = c.blockedScope ?? ''
      o.spec.prevValue = c.blockedValue ?? ''
      if (scope === '全通道') {
        connectorStore.setEnabled(c.id, false)
        connectorStore.setHealth(c.id, 'fault')
        connectorStore.update(c.id, { blocking: `已阻断：${String(o.spec.note ?? o.reason).slice(0, 40)}`, blockedScope: '', blockedValue: '' })
      } else {
        connectorStore.setHealth(c.id, 'warn')
        connectorStore.update(c.id, { blockedScope: scope, blockedValue: value, blocking: `部分阻断（${scope}）：${value}` })
      }
      break
    }
    case 'access_restore': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      const partial = Boolean(c.blockedScope)
      o.spec.prevEnabled = c.enabled
      o.spec.prevHealth = c.health
      o.spec.prevScope = c.blockedScope ?? ''
      o.spec.prevValue = c.blockedValue ?? ''
      connectorStore.setEnabled(c.id, true)
      connectorStore.setHealth(c.id, 'ok')
      connectorStore.update(c.id, { blockedScope: '', blockedValue: '', blocking: partial ? `部分阻断已解除（原 ${c.blockedScope}：${c.blockedValue}）` : '整改完成，接入已恢复' })
      break
    }
    case 'credential_revoke': { const c = st.creds.find((x: any) => x.id === o.spec.credId)!; c.status = 'off' as const; break }
    case 'quota_adjust': { const c = st.creds.find((x: any) => x.id === o.spec.credId)!; o.spec.prevRpm = c.rpm; c.rpm = Number(o.spec.rpm); break }
    case 'containment': {
      const m = st.managed.find(x => x.kind === o.spec.kind && x.name === o.spec.name)!
      o.spec.prevStatus = m.status
      o.spec.prevTech = m.tech
      o.spec.prevBiz = m.biz
      const want = ACTION_STATUS[String(o.spec.action) as ContainAction]
      m.status = want as ManagedStatus
      if (m.kind === 'MCP工具' || m.kind === '插件') {
        if (want === '隔离' || want === '禁用') { m.tech = false; m.biz = false }
        if (want === '正常') { m.tech = true; m.biz = true }
      }
      if (m.kind === '知识库' && want === '暂停') { o.spec.prevQueue = m.queue; m.queue = Math.max(30, m.queue + 40) }
      if (m.kind === '知识库' && want === '正常') { m.queue = Math.max(0, Math.round(m.queue * 0.4)) }
      break
    }
    case 'model_rollback': {
      const m = st.models.find(x => x.short === o.spec.model)!
      o.spec.prevVer = m.ver
      m.ver = String(o.spec.toVersion)
      m.name = m.name.replace(/v\d+\.\d+(-\d+)?/, m.ver)
      break
    }
    case 'model_retire': {
      const m = st.models.find(x => x.short === o.spec.model)!
      const pool = st.pools.find(p => p.id === m.pool)!
      o.spec.prevReplicas = m.replicas
      o.spec.prevPool = m.pool
      o.spec.freedCards = m.replicas * m.perReplica
      pool.cards += m.replicas * m.perReplica
      m.replicas = 0
      m.state = '已下线'
      break
    }
  }
}

export function reverseEffect(st: EngineState, o: Order) {
  switch (o.type) {
    case 'pool_expand': { const p = st.pools.find(x => x.id === o.spec.pool)!; p.cards -= Number(o.spec.cards); st.rented = (st.rented || 0) - Number(o.spec.rentedPart ?? 0); break }
    case 'pool_release': { const p = st.pools.find(x => x.id === o.spec.pool)!; p.cards += Number(o.spec.cards); st.rented = (st.rented || 0) + Number(o.spec.releasedRented ?? 0); break }
    case 'model_deploy': {
      const short = String(o.spec.model)
      if (String(o.spec.prevDeployed) === '0') st.models = st.models.filter(x => x.short !== short)
      else {
        const m = st.models.find(x => x.short === short)
        if (m) { m.replicas = Number(o.spec.prevReplicas); m.ver = String(o.spec.prevVersion || m.ver) }
      }
      break
    }
    case 'train_reserve': { st.jobs = (st.jobs || []).filter((x: any) => !((x.name === String(o.spec.name) && x.cards === Number(o.spec.cards) && x.state === '运行中'))); break }
    case 'train_release': {
      const j = (st.jobs || []).find((x: any) => x.id === String(o.spec.jobId))
      if (j) { j.state = (o.spec.prevJobState as '运行中' | '排队中' | '已完成') || '运行中'; j.cards = Number(o.spec.prevJobCards) || j.cards }
      break
    }
    case 'replica_scale': { const m = st.models.find(x => x.short === o.spec.model)!; m.replicas -= Number(o.spec.delta); break }
    case 'weight_adjust': {
      const prev = String(o.spec.prevWeights ?? '').split(',').map((x: string) => parseInt(x))
      if (prev.length === st.channels.length) st.channels.forEach((c: any, i: number) => { c.weight = prev[i] })
      break
    }
    case 'preempt': {
      const from = st.pools.find(p => p.id === o.spec.from)!
      const to = st.pools.find(p => p.id === o.spec.to)!
      if (o.spec.prevFromCards !== undefined) from.cards = Number(o.spec.prevFromCards)
      if (o.spec.prevToCards !== undefined) to.cards = Number(o.spec.prevToCards)
      String(o.spec.prevReplicas ?? '').split(',').forEach((pair: string) => {
        const [short, n] = pair.split(':')
        const m = st.models.find(x => x.short === short)
        if (m && n) m.replicas = Number(n)
      })
      break
    }
    case 'credential_issue': { st.creds = st.creds.filter((c: any) => c.app !== String(o.spec.app)); break }
    case 'access_block': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      if (o.spec.prevEnabled !== undefined) connectorStore.setEnabled(c.id, Boolean(o.spec.prevEnabled))
      if (o.spec.prevHealth) connectorStore.setHealth(c.id, o.spec.prevHealth as any)
      connectorStore.update(c.id, { blockedScope: String(o.spec.prevScope ?? ''), blockedValue: String(o.spec.prevValue ?? ''), blocking: o.spec.prevScope ? `部分阻断（${o.spec.prevScope}）：${o.spec.prevValue}` : c.blocking })
      break
    }
    case 'access_restore': {
      const c = connectorStore.find(String(o.spec.connectorId))!
      if (o.spec.prevEnabled !== undefined) connectorStore.setEnabled(c.id, Boolean(o.spec.prevEnabled))
      if (o.spec.prevHealth) connectorStore.setHealth(c.id, o.spec.prevHealth as any)
      if (o.spec.prevScope) connectorStore.update(c.id, { blockedScope: String(o.spec.prevScope), blockedValue: String(o.spec.prevValue ?? ''), blocking: `部分阻断（${o.spec.prevScope}）：${o.spec.prevValue}` })
      break
    }
    case 'credential_revoke': { const c = st.creds.find((x: any) => x.id === o.spec.credId)!; c.status = 'ok' as const; break }
    case 'quota_adjust': { const c = st.creds.find((x: any) => x.id === o.spec.credId)!; if (o.spec.prevRpm !== undefined) c.rpm = Number(o.spec.prevRpm); break }
    case 'containment': {
      const m = st.managed.find(x => x.kind === o.spec.kind && x.name === o.spec.name)!
      if (o.spec.prevStatus) m.status = o.spec.prevStatus as ManagedStatus
      if (o.spec.prevQueue !== undefined) m.queue = Number(o.spec.prevQueue)
      if (o.spec.prevTech !== undefined) m.tech = Boolean(o.spec.prevTech)
      if (o.spec.prevBiz !== undefined) m.biz = Boolean(o.spec.prevBiz)
      break
    }
    case 'model_rollback': {
      const m = st.models.find(x => x.short === o.spec.model)!
      if (o.spec.prevVer) { m.name = m.name.replace(/v\d+\.\d+(-\d+)?/, String(o.spec.prevVer)); m.ver = String(o.spec.prevVer) }
      break
    }
    case 'model_retire': {
      const m = st.models.find(x => x.short === o.spec.model)!
      const pool = st.pools.find(p => p.id === (o.spec.prevPool ?? m.pool))!
      m.replicas = Number(o.spec.prevReplicas ?? 1)
      m.state = '运行中'
      pool.cards -= m.replicas * m.perReplica
      break
    }
  }
}

export function verifyResult(st: EngineState, o: Order) {
  if (o.type === 'pool_expand' || o.type === 'pool_release') {
    const p = st.pools.find(x => x.id === o.spec.pool)!
    return `${p.name} 卡位 ${p.cards} · 当前利用率 ${poolUtil(st, p.id)}%`
  }
  if (o.type === 'preempt') {
    const from = st.pools.find(p => p.id === o.spec.from)!
    const to = st.pools.find(p => p.id === o.spec.to)!
    return `${to.name} ${to.cards} 卡（利用率 ${poolUtil(st, to.id)}%）· ${from.name} ${from.cards} 卡（利用率 ${poolUtil(st, from.id)}%）· 被抢占方通知已发出`
  }
  if (o.type === 'replica_scale') { const m = st.models.find(x => x.short === o.spec.model)!; return `${m.short} 副本 ${m.replicas} 存活 · 健康探针通过` }
  if (o.type === 'weight_adjust') return st.channels.map((c: any) => `${c.name.split('（')[0]} ${c.weight}%`).join(' · ')
  if (o.type === 'credential_issue') return '凭证已发放 · 配额与审批单一致 · IP 白名单生效'
  if (o.type === 'credential_revoke') return '凭证已吊销 · 关联授权与路由已清理'
  if (o.type === 'access_block' || o.type === 'access_restore') {
    const c = connectorStore.find(String(o.spec.connectorId))!
    const depends = governDependents(c.name)
    return `${c.name} 通道${c.enabled ? '已启用（采集中）' : '已阻断（停止采集与调用）'} · 健康 ${c.health} · 关联登记对象 ${depends.length} 项 · 配置版本 v${c.version}`
  }
  if (o.type === 'containment') {
    const m = st.managed.find(x => x.kind === o.spec.kind && x.name === o.spec.name)!
    return `${m.name} 状态 ${String(o.spec.prevStatus ?? '—')} → ${m.status}${m.kind === '知识库' && m.status === '暂停' ? ` · 在库队列 ${m.queue} 项滞留（恢复后自动解除）` : ''}${(m.kind === 'MCP工具' || m.kind === '插件') ? ` · 目录同步：技术注册目录${m.tech ? '保留' : '已摘除'} / 业务使用目录${m.biz ? '保留' : '已摘除'}` : ''} · 归口 ${m.owner} 通知已发出`
  }
  if (o.type === 'model_rollback') {
    const m = st.models.find(x => x.short === o.spec.model)!
    return `${m.short} 已运行于 ${m.ver} · 副本 ${m.replicas} 存活 · 调用链路可用性验证通过（Chat / Embed / Rerank / ASR 探测正常）`
  }
  if (o.type === 'model_retire') {
    const m = st.models.find(x => x.short === o.spec.model)!
    const pool = st.pools.find(p => p.id === m.pool)!
    return `${m.short} 已下线并从能力目录摘除 · 释放 ${String(o.spec.freedCards ?? 0)} 卡归还「${pool.name}」（利用率 ${poolUtil(st, pool.id)}%）· 受影响应用通知已发出 · 配置快照保留可恢复`
  }
  return '变更已生效'
}
