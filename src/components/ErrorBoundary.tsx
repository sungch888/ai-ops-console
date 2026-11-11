import React from 'react'

/**
 * 渲染错误兜底（v3.11.3）
 *
 * 为什么需要它：React 里只要有一个组件在渲染时抛错，且上面没有错误边界，
 * 整棵树会被直接卸载 —— 页面上什么都不剩（深色背景下就是一片黑屏）。
 * 用户看到的只有「黑屏」，既不知道发生了什么，也拿不到任何线索。
 *
 * 这里把错误拦下来：显示可读的错误信息 + 重新加载按钮，
 * 保证「出错」永远表现为「一块能看懂的面板」，而不是「黑屏」。
 *
 * resetKey 变化时自动清空错误状态（比如换路由、换账号后重试一次）。
 */

export interface ErrorBoundaryProps {
  children: React.ReactNode
  /** 变化时清空错误状态并重新渲染子树（换路由 / 换账号后自动重试） */
  resetKey?: string
  /** 面板标题 */
  title?: string
  /** 出错时额外的一行说明 */
  hint?: string
}

interface ErrorBoundaryState {
  error: Error | null
  stack: string
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 留一份组件栈，方便在控制台里定位是哪个页面炸的
    this.setState({ stack: info.componentStack ?? '' })
    console.error('[界面渲染出错] ' + (this.props.title ?? ''), error, info.componentStack)
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, stack: '' })
    }
  }

  private reload = () => { window.location.reload() }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    const title = this.props.title ?? '页面渲染出错'
    return (
      <div style={{
        minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px',
      }}>
        <div className="panel" style={{ width: 720, maxWidth: '100%' }}>
          <div className="panel-head">
            <span className="ph-left">{title}</span>
            <span className="extra">这一屏是错误兜底页，不是数据问题</span>
          </div>
          <div className="panel-body">
            <div className="callout warn">
              <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 4l9 16H3z" /><path d="M12 10v4M12 16.5v.5" />
              </svg>
              <div>
                界面渲染时抛了异常，React 把这一片卸载了（所以本来是一片黑屏）。
                {this.props.hint ? <><br />{this.props.hint}</> : null}
                <br />重新加载通常就能恢复；同样的错误在浏览器控制台（F12）里有完整记录。
              </div>
            </div>

            <div className="small" style={{ color: 'var(--text-dim)', marginTop: 14, lineHeight: 1.9 }}>
              错误信息：
              <div className="mono" style={{
                marginTop: 6, padding: '8px 10px', borderRadius: 9,
                background: 'rgba(var(--red-rgb), .08)', border: '1px solid rgba(var(--red-rgb), .28)',
                color: 'var(--bad-text)', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
              }}>{error.message || String(error)}</div>
              {stack ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="tiny faint" style={{ cursor: 'pointer' }}>组件栈（定位用）</summary>
                  <pre className="mono tiny" style={{
                    marginTop: 6, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap',
                    color: 'var(--text-faint)', wordBreak: 'break-word',
                  }}>{stack}</pre>
                </details>
              ) : null}
            </div>

            <div className="row gap6" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={this.reload}>重新加载</button>
              <span className="tiny faint">也可以直接按 F5 刷新（浏览器会重新拉一遍前端资源）</span>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
