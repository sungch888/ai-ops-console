/* =====================================================================
 * 正式实施再启用的功能（演示档收起的那批入口）
 *   功能一个都没删：这页就是全部入口的清单，点进去照常能用。
 *   留哪些摆在侧栏上，是「配置中心 · 演示视图」里的配置项。
 * ===================================================================== */
import { useNavigate } from 'react-router-dom'
import { Badge, AlertBadge, Callout, PageHead, Panel } from '../components/ui'
import { DEMO_NAV, setView, useView } from '../engine/view'

/** 与外壳同一份菜单定义（App.tsx 导出），保证这里不会跟侧栏长歪 */
import { NAV, ROUTE_PERM } from '../navCatalog'
import { useMatrix, useSession } from '../engine/auth'

export default function MorePage() {
  const nav = useNavigate()
  const view = useView()
  const acc = useSession()
  const mx = useMatrix()
  const canSee = (to: string) => !acc || mx[acc.role].view.includes(ROUTE_PERM[to as keyof typeof ROUTE_PERM] ?? 'overview')

  return (
    <div>
      <PageHead title="正式实施再启用的功能"
        desc="演示档只展示重点页面；下面这些不是没做，是先不摆在台面上。点任意一项照常进入、照常操作。" />
      <Callout text={'现在跑的是「演示档」：侧栏留 ' + view.nav.length + ' 个重点入口，其余收在这页。要看全套就切到「完整模式」；要长期固定哪几页，在配置中心 · 演示视图里勾（存数据服务，换电脑登录也认）。'} />

      <div className="row gap6 wrap" style={{ marginTop: 12 }}>
        <button className={'btn sm' + (view.mode === 'demo' ? ' primary' : '')} onClick={() => setView({ mode: 'demo' })}>演示档（只留重点）</button>
        <button className={'btn sm' + (view.mode === 'full' ? ' primary' : '')} onClick={() => setView({ mode: 'full' })}>完整模式（40 个入口全开）</button>
        <button className="btn sm ghost" onClick={() => setView({ nav: DEMO_NAV })}>入口恢复默认清单</button>
      </div>

      {NAV.map((g) => (
        <Panel key={g.group} title={g.group} className="mt14">
          <div className="row gap6 wrap">
            {g.items.map((it) => {
              const hidden = view.mode === 'demo' && !view.nav.includes(it.to)
              const noPerm = !canSee(it.to)
              return (
                <span key={it.to} className="row gap6" style={{ alignItems: 'center' }}>
                  <button className="btn sm ghost" disabled={noPerm} onClick={() => nav(it.to)}
                    title={noPerm ? '当前角色没有这个页面的查看权' : hidden ? '演示档已收起 · 点这里进入' : '侧栏上也有'}>
                    {it.label}
                  </button>
                  {noPerm ? <Badge tone="muted">无查看权</Badge> : hidden ? <AlertBadge tone="warn" jump={{ page: it.to, label: `「${it.label}」在演示档被收起：点过去直接进入这个页面，功能照常在（要长期摆回侧栏在配置中心 · 演示视图勾）` }}>演示档收起</AlertBadge> : <Badge tone="good">侧栏在列</Badge>}
                </span>
              )
            })}
          </div>
        </Panel>
      ))}
    </div>
  )
}
