import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme.css'
import { hydrate } from './engine/db'

/**
 * 启动顺序（v2.2 起）：
 *   1) 先向数据服务取回全部业务状态（hydrate）
 *   2) 再加载界面模块 —— 引擎模块在取数完成后才被 import，避免读到空状态
 *   3) 取数失败也照常渲染，但界面上明确显示「未连接，本次改动不会保存」，
 *      并且不会退回浏览器本地存储。
 */
async function boot() {
  const box = document.getElementById('root')
  if (!box) return
  box.innerHTML = '<div style="padding:40px;color:#9fc2ea;font:14px/1.7 system-ui">正在从数据服务读取业务状态并恢复会话…</div>'
  const res = await hydrate()
  const ui = await import('./engine/ui')
  ui.initTheme()               // 配色按库里的选择上色（没有就用默认深空蓝）
  const auth = await import('./engine/auth')
  await auth.restoreSession()          // 服务端会话还在就接着用，不在就显示登录页
  const { default: App } = await import('./App')
  ReactDOM.createRoot(box).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
  if (!res.ok) console.warn('数据服务未连接，界面可操作但不会保存：', res.error)
}

boot()
