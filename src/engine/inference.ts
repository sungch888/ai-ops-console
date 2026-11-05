/* =====================================================================
 * 推理引擎运行指标（演示版按引擎状态推导，不接真实引擎）
 * 指标来源：副本数、每副本卡位、池利用率、渠道配额、处置状态 + 引擎配置开关
 * 配置开关真实生效：改前缀缓存 / 量化方式 / 最大并发序列 / 批处理窗口，指标立即变化
 * ===================================================================== */
import { useSyncExternalStore } from 'react'
import { engine, poolUtil, type EngineState } from './engine'
import { ledgerOf } from './ledger'
import { dbRead, dbWrite } from './db'


export type Quantization = 'FP16' | 'W8A8' | 'INT8'
export interface EngineConfig { prefixCache: boolean; kvResident: boolean; quantization: Quantization; maxNumSeqs: number; batchWindowMs: number }
export interface ModelMetrics {
  short: string; name: string; instances: number; cards: number; gpuUtil: number
  kvUsedGB: number; kvTotalGB: number; cacheHit: number; ttftMs: number
  tokensPerSec: number; avgBatch: number; queueDepth: number; restarts: number
  rpm: number; health: 'ok' | 'warn' | 'bad'; note: string
}
export interface ContainerRow { model: string; instance: string; cpu: number; memGB: number; vramGB: number; vramTotal: number; restarts: number; uptimeMin: number; state: '运行中' | '冷启动' | '已摘除' }

const KEY = 'dsh-demo-inference-v1'
export const DEFAULT_CONFIG: EngineConfig = { prefixCache: true, kvResident: true, quantization: 'W8A8', maxNumSeqs: 256, batchWindowMs: 8 }
const QUANT_FACTOR: Record<Quantization, number> = { FP16: 1, W8A8: 0.62, INT8: 0.5 }
const CARD_KV_GB = 22 // 每卡 KV 缓存可用容量（演示口径：单卡 22GB 显存中约 14GB 给 KV）

const listeners = new Set<() => void>()
let config: EngineConfig = load()
let restarts: Record<string, number> = {}

function load(): EngineConfig {
  try {
    const raw = dbRead(KEY)
    if (raw) { const p = JSON.parse(raw) as EngineConfig; if (p && typeof p.prefixCache === 'boolean' && p.quantization in QUANT_FACTOR) return { ...DEFAULT_CONFIG, ...p } }
  } catch { /* 演示环境忽略损坏配置 */ }
  return { ...DEFAULT_CONFIG }
}
function persist() { try { dbWrite(KEY, JSON.stringify(config)) } catch { /* 落库失败已在数据层记录 */ } }
function emit() { listeners.forEach((f) => f()) }

export const inferenceStore = {
  get: () => config,
  getRestarts: () => ({ ...restarts }),
  set(patch: Partial<EngineConfig>) { config = { ...config, ...patch }; persist(); emit() },
  reset() { config = { ...DEFAULT_CONFIG }; restarts = {}; persist(); emit() },
  restart(model: string) { restarts[model] = (restarts[model] ?? 0) + 1; emit() },
  subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f) } },
}

export function useInference() {
  return useSyncExternalStore(inferenceStore.subscribe, () => config, () => config)
}

/** 按引擎状态与配置推导每个模型的运行指标 */
export function metricsOf(st: EngineState): ModelMetrics[] {
  const L = ledgerOf(st)
  const cfg = config
  return st.models.filter((m) => m.state === '运行中' && m.replicas > 0).map((m) => {
    const cards = m.replicas * m.perReplica
    const util = poolUtil(st, m.pool)
    const row = L.perModel.find((x) => x.name === m.short)
    const rpm = Math.max(1, Math.round((row?.calls ?? 0) / 1440))
    const kvTotal = cards * CARD_KV_GB
    const kvUsed = Math.round(kvTotal * (util / 100) * QUANT_FACTOR[cfg.quantization] * (cfg.kvResident ? 1.05 : 0.9) * 10) / 10
    const throttledPenalty = L.throttled.length * 0.02
    const restartPenalty = Math.min(0.12, (restarts[m.short] ?? 0) * 0.04)
    let cacheHit = 0.56 + (cfg.prefixCache ? 0.2 : -0.3) + (cfg.batchWindowMs >= 12 ? 0.05 : 0) + (cfg.maxNumSeqs >= 256 ? 0.04 : -0.02) - m.replicas * 0.014 - throttledPenalty - restartPenalty
    if (cfg.quantization === 'INT8') cacheHit -= 0.03
    cacheHit = Math.max(0.05, Math.min(0.92, cacheHit))
    const ttftMs = Math.round(46 + util * 1.7 + (cards < 4 ? 24 : 0) - (cfg.prefixCache ? cacheHit * 78 : 0) + (cfg.maxNumSeqs < 128 ? 18 : 0) + restartPenalty * 260)
    const tokensPerSec = Math.round((rpm * 820) / 60)
    const avgBatch = Math.max(1, Math.round(cfg.maxNumSeqs * (util / 100) * (cfg.kvResident ? 1.05 : 0.85)))
    const queueDepth = Math.max(0, Math.round(rpm * (util / 100) * 0.035))
    const health: ModelMetrics['health'] = util > 92 || kvUsed / kvTotal > 0.92 ? 'bad' : util > 78 || m.replicas <= 1 ? 'warn' : 'ok'
    const note = health === 'bad' ? '利用率或显存接近上限，建议扩副本或降权重' : health === 'warn' ? (m.replicas <= 1 ? '单副本运行，无冗余' : '负载偏高，可关注队列深度') : '运行平稳'
    return { short: m.short, name: m.name, instances: m.replicas, cards, gpuUtil: util, kvUsedGB: kvUsed, kvTotalGB: kvTotal, cacheHit: Math.round(cacheHit * 1000) / 10, ttftMs, tokensPerSec, avgBatch, queueDepth, restarts: restarts[m.short] ?? 0, rpm, health, note }
  }).sort((a, b) => b.cards - a.cards)
}

export function containersOf(st: EngineState): ContainerRow[] {
  const cfg = config
  const rows: ContainerRow[] = []
  metricsOf(st).forEach((m) => {
    for (let i = 1; i <= m.instances; i++) {
      const cold = m.restarts > 0 && i === m.instances
      const share = m.cards > 0 ? 1 / m.instances : 0
      rows.push({
        model: m.short,
        instance: `${m.short.toLowerCase().replace(/\s+/g, '-')}-replica-${i}`,
        cpu: Math.min(99, Math.round(m.gpuUtil * (cfg.batchWindowMs / 8) * 0.9)),
        memGB: Math.round(m.kvUsedGB * share * 1.35 * 10) / 10,
        vramGB: Math.round(m.kvUsedGB * share * 10) / 10,
        vramTotal: CARD_KV_GB,
        restarts: m.restarts,
        uptimeMin: cold ? 2 : 60 + i * 37 + m.cards * 11,
        state: cold ? '冷启动' : '运行中',
      })
    }
  })
  st.models.filter((m) => m.state === '已下线' || m.replicas === 0).forEach((m) => rows.push({
    model: m.short, instance: `${m.short.toLowerCase().replace(/\s+/g, '-')}-replica-1`, cpu: 0, memGB: 0, vramGB: 0, vramTotal: CARD_KV_GB, restarts: restarts[m.short] ?? 0, uptimeMin: 0, state: '已摘除',
  }))
  return rows
}

export function clusterSummary(st: EngineState) {
  const ms = metricsOf(st)
  const instances = ms.reduce((s, m) => s + m.instances, 0)
  const cards = ms.reduce((s, m) => s + m.cards, 0)
  const cacheHit = ms.length ? Math.round((ms.reduce((s, m) => s + m.cacheHit, 0) / ms.length) * 10) / 10 : 0
  const ttft = ms.length ? Math.round(ms.reduce((s, m) => s + m.ttftMs, 0) / ms.length) : 0
  const kvUsed = Math.round(ms.reduce((s, m) => s + m.kvUsedGB, 0) * 10) / 10
  const kvTotal = ms.reduce((s, m) => s + m.kvTotalGB, 0)
  const tokensPerSec = ms.reduce((s, m) => s + m.tokensPerSec, 0)
  const L = ledgerOf(st)
  const savedTokensWan = Math.round((L.tokensToday * (cacheHit / 100) * 0.35 * 10) / 10)
  const savedCost = Math.round(savedTokensWan * 0.9)
  return { instances, cards, cacheHit, ttft, kvUsed, kvTotal, tokensPerSec, savedTokensWan, savedCost, models: ms.length }
}
