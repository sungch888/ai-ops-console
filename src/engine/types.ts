/**
 * 共享类型定义（消除 R3-Knowledge Duplication）
 *
 * 原本分散在 engine.ts、exceptions.ts 等模块中的统一类型，
 * 现在集中在此，各模块按需导入。
 * 本文件不依赖 engine.ts，避免循环引用。
 */

/* ---- 接入阻断 ---- */
export type ContainKind = '知识库' | '智能体应用' | 'MCP工具' | '插件' | 'Skill'
export const DIRECTORY_KINDS: ContainKind[] = ['MCP工具', '插件', 'Skill']

export type ContainAction = '暂停入库' | '恢复入库' | '限流保护' | '暂停应用' | '恢复应用' | '隔离出目录' | '重新纳入' | '禁用' | '启用'
export const ACTION_STATUS: Record<ContainAction, string> = {
  '暂停入库': '暂停', '恢复入库': '正常', '限流保护': '限流',
  '暂停应用': '暂停', '恢复应用': '正常', '隔离出目录': '隔离',
  '重新纳入': '正常', '禁用': '禁用', '启用': '正常',
}

/* ---- 管理对象状态 ---- */
export type ManagedStatus = '正常' | '限流' | '暂停' | '隔离' | '禁用'
export type Level = '高保' | '共享' | '灰度'

/* ---- 凭证类型 ---- */
export type CredKind = '个人密钥' | '平台代理'
export interface Cred {
  id: string; kind: CredKind; holder: string; app: string; model: string
  channel: string; rpm: number; tpm: string; ip: string
  expDays: number; lastUsedDays: number; status: 'ok' | 'warn' | 'off'
}

/* ---- 池 ---- */
export type PoolId = 'hp' | 'shared' | 'train'
export interface Pool { id: PoolId; name: string; cards: number; policy: string; sla: string }
