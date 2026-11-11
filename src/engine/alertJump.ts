/* =====================================================================
 * 告警直达（alertJump）
 *
 * 口径：界面上任何红 / 黄告警提示都不是「只给你看一眼」——点它就落到
 *      能动手的那个地方（哪个页 + 选中哪一行）。
 *
 * 实现：跳转带 ?pick=<行标识>，目标页读到就把那一行选出来、高亮、滚过去。
 *      行标识沿用各页自己的主键（例外 key / 工单号 / 通知编号 / 监控目标 id / 卡号 / 凭证 id）。
 * ===================================================================== */
import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export interface AlertJump {
  /** 操作点所在页面（路由 path） */
  page: string
  /** 到页后要选中 / 高亮的那一行（缺省就落在页面本身） */
  pick?: string
  /** 悬停提示：点过去能做什么 */
  label?: string
}

/** 例外 key（与 exceptions.ts 的 key(kind, target) 同一口径） */
export const excKey = (kind: string, target: string) => `${kind}|${target}`

/** 拼出带定位参数的地址 */
export function alertHref(j: AlertJump): string {
  return j.pick ? `${j.page}?pick=${encodeURIComponent(j.pick)}` : j.page
}

/** 拿到一个「点告警就跳过去」的函数 */
export function useAlertJump() {
  const nav = useNavigate()
  return (j: AlertJump) => nav(alertHref(j))
}

/** 目标页用：读 ?pick= ，有值就要把对应那一行摆到眼前 */
export function useAlertPick(): string {
  const loc = useLocation()
  return useMemo(() => {
    try { return new URLSearchParams(loc.search).get('pick') ?? '' } catch { return '' }
  }, [loc.search])
}

/** 目标页用：跳转落地后把高亮行滚进视野（同一页内换 pick 也会重新滚） */
export function usePickFlash(pick: string) {
  useEffect(() => {
    if (!pick) return
    const t = setTimeout(() => {
      const el = document.querySelector('.row-pick')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 90)
    return () => clearTimeout(t)
  }, [pick])
}

/* ---- 常用操作点（各页主键口径写在一处，避免同一告警跳到两个不同地方）---- */
export const Jump = {
  /** 例外监控：切接入来源 / 资源侧缓解 / 整改引导都在这里 */
  exception: (kind: string, target: string, label = '去例外监控分析并处置'): AlertJump =>
    ({ page: '/compute/exceptions', pick: excKey(kind, target), label }),
  /** 例外监控：按整条例外的 key 跳（已经拼好 key 的场景） */
  exceptionKey: (key: string, label = '去例外监控分析并处置'): AlertJump =>
    ({ page: '/compute/exceptions', pick: key, label }),
  /** 通知中心：那一告警的「我处置了」 */
  notification: (id: string, label = '去通知中心处置这条告警'): AlertJump =>
    ({ page: '/ops/notifications', pick: id, label }),
  /** 资源调配工作台：那张工单（审批 / 执行 / 回滚 / 闭环） */
  order: (id: string, label = '去工作台看这张工单'): AlertJump =>
    ({ page: '/ops/workflow', pick: id, label }),
  /** 申请与审批台：待审批的工单 */
  approval: (id: string, label = '去审批台处理这张工单'): AlertJump =>
    ({ page: '/ops/apply', pick: id, label }),
  /** 部署与发布：待回执工单的「回填回执」 */
  deployOrder: (id: string, label = '去部署页回填执行回执'): AlertJump =>
    ({ page: '/model/deploy', pick: id, label }),
  /** 推理服务监控：那个采不到 / 异常的服务 */
  monitorTarget: (id: string, label = '去推理服务监控看这个服务'): AlertJump =>
    ({ page: '/model/monitor', pick: id, label }),
  /** 算力卡监控：那张触阈值的卡 */
  card: (id: string, label = '去算力卡监控看这张卡'): AlertJump =>
    ({ page: '/compute/cards', pick: id, label }),
  /** 凭证与配额：这条凭证 */
  credential: (id: string, label = '去凭证与配额处理这条凭证'): AlertJump =>
    ({ page: '/model/credentials', pick: id, label }),
  /** 应用中心 · 安全事件：那起事件 */
  securityEvent: (id: string, label = '去安全事件处置这起事件'): AlertJump =>
    ({ page: '/app/security', pick: id, label }),
  /** 应用中心 · 智能体纳管：那个应用 */
  agent: (name: string, label = '去智能体纳管看这个应用'): AlertJump =>
    ({ page: '/app/agents', pick: name, label }),
  /** 应用中心 · 知识库纳管：那个知识库 */
  kb: (name: string, label = '去知识库纳管看这个库'): AlertJump =>
    ({ page: '/app/kb', pick: name, label }),
  /** 模型中心 · 安全检测 */
  modelSecurity: (label = '去模型安全检测看详情'): AlertJump =>
    ({ page: '/model/security', label }),
  /** 配置中心：告警口径 / 派单映射 */
  settings: (key: string, label = '去配置中心改这个口径'): AlertJump =>
    ({ page: '/ops/settings', pick: key, label }),
  /** 告警规则管理：那条规则 */
  alertRule: (id: string, label = '去告警规则改这条规则'): AlertJump =>
    ({ page: '/ops/alert-rules', pick: id, label }),
  /** 处置指令台 */
  commands: (label = '去处置指令台下发处置'): AlertJump =>
    ({ page: '/ops/commands', label }),
  /** 外部对接清单：这条接入 */
  connector: (id: string, label = '去外部对接清单看这条接入'): AlertJump =>
    ({ page: '/ops/integrations', pick: id, label }),
  /** 微调训练：那个训练任务 */
  trainJob: (id: string, label = '去微调训练看这个任务'): AlertJump =>
    ({ page: '/model/fineTune', pick: id, label }),
  /** 工具生态：那个工具 / 插件 */
  tool: (name: string, label = '去工具生态看这个工具'): AlertJump =>
    ({ page: '/app/tools', pick: name, label }),
}
