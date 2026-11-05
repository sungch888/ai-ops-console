import React, { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export const CHART_COLORS = ['#22d3ee', '#3d8bfd', '#2fd6a3', '#f5b83d', '#a78bfa', '#ff6b6b', '#5eead4', '#818cf8']
export const AXIS_COLOR = '#7f9cc7'
export const SPLIT_COLOR = 'rgba(64, 130, 220, 0.12)'
export const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(8, 18, 36, 0.96)',
  borderColor: 'rgba(90, 160, 255, 0.4)',
  borderWidth: 1,
  textStyle: { color: '#d9e8ff', fontSize: 12 },
  extraCssText: 'box-shadow: 0 8px 24px rgba(2,8,20,.5); border-radius: 8px;',
}
export const GRID = { left: 8, right: 14, top: 30, bottom: 6, containLabel: true }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Chart({ option, height = 260 }: { option: any; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const c = echarts.init(ref.current)
    inst.current = c
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      c.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
