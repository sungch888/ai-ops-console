import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme.css'
import { hydrate } from './engine/db'
import { ErrorBoundary } from './components/ErrorBoundary'

/**
 * 启动顺序（v2.2 起）：
 *   1) 先向数据服务取回全部业务状态（hydrate）
 *   2) 再加载界面模块 —— 引擎模块在取数完成后才被 import，避免读到空状态
 *   3) 取数失败也照常渲染，但界面上明确显示「未连接，本次改动不会保存」，
 *      并且不会退回浏览器本地存储。
 *
 * v3.11.3：hydrate 加超时上限。数据服务没起或卡住时，fetch 会一直挂着，
 * 界面就停在「正在读取…」那行字上（看起来也像黑屏）。超时后照常往下走，
 * 顶栏会显示「数据服务未连接」，至少还能登录、还能看说明。
 */
const HYDRATE_TIMEOUT_MS = 8000

/** 给任意 Promise 加超时上限：超时按「失败」处理，不无限期挂住启动流程 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + '超时（' + ms + 'ms）')), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function boot() {
  const box = document.getElementById('root')
  if (!box) return
  box.innerHTML = '<div style="padding:40px;color:var(--text-dim);font:14px/1.7 system-ui">正在从数据服务读取业务状态并恢复会话…</div>'
  let res: { ok: boolean; error?: string; keys?: number } = { ok: false, error: '数据服务未连接' }
  try {
    res = await withTimeout(hydrate(), HYDRATE_TIMEOUT_MS, '读取业务状态')
  } catch (e) {
    console.warn('数据服务取数未完成，界面照常渲染（改动不会保存）：', e)
  }
  const ui = await import('./engine/ui')
  const view = await import('./engine/view')
  view.initView()              // 演示档/完整模式按库里的配置生效
  ui.initTheme()               // 配色按库里的选择上色（没有就用默认深空蓝）
  const auth = await import('./engine/auth')
  try {
    await withTimeout(auth.restoreSession(), HYDRATE_TIMEOUT_MS, '恢复会话')
  } catch (e) {
    console.warn('会话恢复未完成，按未登录处理：', e)
  }
  const ops = await import('./engine/ops')
  ops.hookEngineEvents()              // 显式启动引擎事件 → 通知桥接，避免 ops.ts 模块加载时的隐式副作用
  const { default: App } = await import('./App')
  ReactDOM.createRoot(box).render(
    <React.StrictMode>
      {/* 启动阶段再兜一层：万一渲染抛错，也是一块能看懂的错误面板，不是黑屏 */}
      <ErrorBoundary title="界面启动失败">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
  if (!res.ok) console.warn('数据服务未连接，界面可操作但不会保存：', res.error)
}

boot()
