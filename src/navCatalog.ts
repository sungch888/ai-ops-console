/* 菜单与权限点目录：外壳与「正式实施再启用」页共用一份，避免两处菜单长歪
 *
 * S4：本文件不再手写菜单，而是从 routeTable.ts 派生——
 * 路由表是唯一事实，加页面只改一处。 */
import type { PermKey } from './engine/auth'
import { ROUTE_TABLE } from './routeTable'

/** 侧栏菜单（按 routeTable 的分组顺序，隐藏页不进菜单） */
export const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = (() => {
  const groups: { group: string; items: { to: string; label: string; icon: string }[] }[] = []
  for (const r of ROUTE_TABLE) {
    if (r.hidden) continue
    let g = groups.find((x) => x.group === r.group)
    if (!g) { g = { group: r.group, items: [] }; groups.push(g) }
    g.items.push({ to: r.path, label: r.label, icon: r.icon })
  }
  return groups
})()

/** 路由 → 权限点（权限矩阵编辑后立即生效） */
export const ROUTE_PERM: Record<string, PermKey> = Object.fromEntries(
  ROUTE_TABLE.filter((r) => r.perm).map((r) => [r.path, r.perm as PermKey])
)

/** 全部入口的展平表（配置中心与「正式实施再启用」页找名字用） */
export const NAV_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ to: i.to, label: i.label, group: g.group })))
