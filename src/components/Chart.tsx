import React, { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { themeInk, useTheme } from '../engine/ui'

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

  const theme = useTheme()

  useEffect(() => {
    // 配色切换时图表跟着换色：文字 / 坐标轴 / 网格 / 提示框 / 系列配色都按当前方案覆盖
    const ink = themeInk()
    const opt: Record<string, unknown> = { ...(option || {}) }
    const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : [])
    for (const key of ['xAxis', 'yAxis']) {
      opt[key] = arr(opt[key]).map((a) => ({
        ...a,
        axisLabel: { ...(a.axisLabel || {}), color: ink.axis },
        axisLine: { ...(a.axisLine || {}), lineStyle: { ...((a.axisLine || {}).lineStyle || {}), color: ink.axis } },
        splitLine: { ...(a.splitLine || {}), lineStyle: { ...(((a.splitLine || {}).lineStyle) || {}), color: ink.split } },
      }))
      if (!arr(opt[key]).length) delete opt[key]
    }
    const tips = arr(opt.tooltip)
    if (tips.length) {
      opt.tooltip = tips.map((t) => ({ ...t, backgroundColor: ink.tipBg, borderColor: ink.tipBorder,
        textStyle: { ...(t.textStyle || {}), color: ink.label } }))
      if (tips.length === 1) opt.tooltip = (opt.tooltip as any[])[0]
    }
    opt.textStyle = { ...((opt.textStyle as object) || {}), color: ink.label }
    const palette = arr(opt.color)
    opt.color = palette.length ? palette : ink.series
    inst.current?.setOption(opt, true)
  }, [option, theme])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
