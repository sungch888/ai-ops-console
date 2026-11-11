/**
 * 通用 Store 基类（消除 6 个引擎模块的样板代码）
 *
 * 每个模块都实现：new Set<() => void>() + emit() + subscribe()
 * 此处抽象为基类，子类只需提供 getSnapshot() 和 notify()。
 *
 * 适用于 useSyncExternalStore 模式：
 *   subscribe → store.subscribe
 *   getSnapshot → store.getSnapshot
 */
export class Store<S> {
  private listeners = new Set<() => void>()
  protected state: S

  constructor(initial: S) {
    this.state = initial
  }

  getSnapshot = (): S => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 通知所有监听器（子类在状态变更后调用） */
  protected emit() {
    for (const l of this.listeners) l()
  }

  /** 安全替换整个 state */
  protected setState(next: S) {
    this.state = next
    this.emit()
  }

  /** 部分更新 state（浅合并） */
  protected patch(patch: Partial<S>) {
    this.state = { ...this.state, ...patch }
    this.emit()
  }
}
