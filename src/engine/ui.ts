/* =====================================================================
 * 配色方案：5 套，右上角切换，选完立刻生效
 * 选择存在数据服务的 kv_store（key: dsh-demo-ui-v1）——换台电脑登录还是这套；
 * 同时记一份在浏览器本地，用于打开页面时先上色、避免闪一下白。
 * ===================================================================== */
import React from 'react'
import { dbRead, dbSeed, dbWrite } from './db'

export type ThemeId = 'deep' | 'ink' | 'paper' | 'govty' | 'contrast'

export const THEMES: { id: ThemeId; name: string; note: string }[] = [
  { id: 'deep', name: '深空蓝', note: '默认 · 大屏值守那种' },
  { id: 'ink', name: '墨青', note: '暗色低饱和，长时间盯屏不刺眼' },
  { id: 'paper', name: '纸白', note: '浅色 · 投屏 / 打印给业务部门看' },
  { id: 'govty', name: '公文灰', note: '素净浅色 · 最不像“AI 做的”' },
  { id: 'contrast', name: '高对比', note: '会议室投影 / 看不清时用' },
]

const KEY = 'dsh-demo-ui-v1'
const LS = 'aiops.theme'

/** 图表（canvas）读不到 CSS 变量，这里给每套配色一份对应的图表用色 */
interface Ink { axis: string; label: string; split: string; tipBg: string; tipBorder: string; series: string[] }
const INK: Record<ThemeId, Ink> = {
  deep: { axis: '#55708f', label: '#7f9cc7', split: 'rgba(64, 130, 220, 0.18)',tipBg: 'rgba(8, 18, 36, 0.96)', tipBorder: 'rgba(90, 160, 255, 0.4)',  series: ['#22d3ee', '#3d8bfd', '#2fd6a3', '#f5b83d', '#ff6b6b', '#a78bfa'] },
  ink: { axis: '#64797a', label: '#8ea6a6', split: 'rgba(70, 110, 118, 0.22)',tipBg: 'rgba(12, 20, 22, 0.96)', tipBorder: 'rgba(100, 150, 160, 0.4)',  series: ['#56c7c7', '#6096be', '#2fd6a3', '#f5b83d', '#ff6b6b', '#9f8fd0'] },
  paper: { axis: '#77869a', label: '#4d5b6c', split: 'rgba(150, 165, 190, 0.35)',tipBg: '#ffffff', tipBorder: 'rgba(150, 165, 190, 0.7)',  series: ['#0e748c', '#1e5ebe', '#148464', '#b2740a', '#be2d2d', '#6d4bb0'] },
  govty: { axis: '#7b8593', label: '#525c69', split: 'rgba(168, 176, 188, 0.4)',tipBg: '#ffffff', tipBorder: 'rgba(168, 176, 188, 0.8)',  series: ['#2f6f7a', '#33597f', '#2f7355', '#9a6c14', '#a43b3b', '#5c5480'] },
  contrast: { axis: '#8fa8c8', label: '#b8cdea', split: 'rgba(110, 160, 230, 0.35)',tipBg: 'rgba(4, 8, 14, 0.97)', tipBorder: 'rgba(140, 190, 255, 0.55)',  series: ['#4ee2ff', '#66a8ff', '#45e8b4', '#ffc851', '#ff8080', '#c4a8ff'] },
}

function valid(v: unknown): ThemeId {
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : 'deep'
}

let theme: ThemeId = 'deep'
try { theme = valid(localStorage.getItem(LS) || 'deep') } catch { /* 隐私模式读不到就算了 */ }
if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', theme)

const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

export function getTheme(): ThemeId { return theme }
export function themeInk() { return INK[theme] }

/** 页面加载完（已取回库里状态）后调用：库里的选择优先 */
export function initTheme(): ThemeId {
  let fromDb: unknown = null
  try {
    const raw = dbRead(KEY)
    if (raw) fromDb = (JSON.parse(raw) || {}).theme
  } catch { /* 忽略 */ }
  theme = valid(fromDb !== null ? fromDb : theme)
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem(LS, theme) } catch { /* 忽略 */ }
  dbSeed(KEY, { theme })
  emit()
  return theme
}

export function setTheme(id: unknown): ThemeId {
  theme = valid(id)
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem(LS, theme) } catch { /* 忽略 */ }
  dbWrite(KEY, JSON.stringify({ theme }))
  emit()
  return theme
}

export function useTheme(): ThemeId {
  return React.useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, getTheme, getTheme)
}
