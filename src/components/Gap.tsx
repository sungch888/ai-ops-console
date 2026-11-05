import { useIntegrations } from '../engine/ops'

/** 对接通道异常时的数据缺口提示（在「外部对接清单」页模拟中断后即可看到） */
export function GapBanner({ name }: { name: string }) {
  const ints = useIntegrations()
  const it = ints.find((i) => i.name === name)
  if (!it || it.health === 'ok') return null
  return (
    <div className="callout warn" style={{ marginBottom: 12 }}>
      <svg className="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 16H3l9-16z" /><path d="M12 10v4M12 17v.5" /></svg>
      <div>
        <b>纳管数据缺口：{it.name} 通道{it.health === 'fault' ? '中断' : '异常'}</b>
        <div className="small" style={{ marginTop: 4 }}>
          停止采集：{it.dataItems}（每 {it.intervalSec} 秒）。下方数值为通道异常前最后一次汇总（降级策略：{it.fallback}）；接入配置可在「运营分析 · 外部接入配置」探活、恢复或切换真实通道。
        </div>
      </div>
    </div>
  )
}
