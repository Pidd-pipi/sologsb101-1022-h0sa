/** 多标签页协同：在线状态、冲突排队与跨页消息 */
import type { Proportion, ProportionRole } from '@/types/proportion'

/** 冲突处理状态：待处理 / 已入库 / 已放弃本方草稿 */
export type ConflictStatus = 'pending' | 'resolved' | 'dismissed'

/** 逐项确认时的选择：采用本方草稿 / 采用对方已提交版本 */
export type ConflictChoice = 'ours' | 'theirs'

/** 某一行（某味香料）在某一方手里的字段快照 */
export interface RowFieldSnapshot {
  materialId: string
  materialName: string
  ratio: number
  role: ProportionRole
  note: string
}

/** 行冲突类型：双方都改同一行 / 双方都新增同一香料 / 一方删除一方修改 */
export type RowConflictKind = 'field' | 'add' | 'remove'

/** 一味香料的三方（本方草稿 / 对方已提交 / 共同祖先）对照 */
export interface RowConflict {
  /** 统一用 materialId 作为同一味香料的对齐键 */
  key: string
  materialId: string
  materialName: string
  kind: RowConflictKind
  base?: RowFieldSnapshot
  ours?: RowFieldSnapshot
  theirs?: RowFieldSnapshot
  /** 产生分歧的字段（香料身份固定为 materialId，故仅占比 / 君臣佐使 / 备注） */
  changedFields: Array<'ratio' | 'role' | 'note'>
  /** 本方完整行（field / add / remove 中保留方），用于入库 */
  oursRow?: Proportion
  /** 对方完整行 */
  theirsRow?: Proportion
  /** 用户的逐项选择 */
  choice?: ConflictChoice
}

/** 一次排队待处理的配比冲突（未确认草稿原样保留在此，不落库） */
export interface PendingConflict {
  id: string
  kind: 'proportion'
  formulaId: string
  formulaName: string
  status: ConflictStatus
  /** 共同祖先：双方上次一致的配比 */
  base: Proportion[]
  /** 本方草稿：本标签页想写入的结果 */
  ours: Proportion[]
  /** 对方版本：检测时数据库里已提交的结果 */
  theirs: Proportion[]
  /** 无分歧、可直接落库的自动合并行 */
  autoMerged: Proportion[]
  /** 逐项确认的分歧行 */
  conflicts: RowConflict[]
  createdAt: number
  updatedAt: number
  sourceTabId: string
}

/** 在线标签页身份 */
export interface TabPresence {
  tabId: string
  label: string
  lastSeenAt: number
  online: boolean
}

/** 跨标签页广播消息（BroadcastChannel） */
export type TabMessage =
  | { type: 'hello'; tab: TabPresence }
  | { type: 'bye'; tabId: string }
  | { type: 'presence'; tab: TabPresence }
  | { type: 'proportion-changed'; formulaId: string; version: number; writerTabId: string; at: number }
  | { type: 'conflict-held'; conflictId: string; formulaId: string }
  | { type: 'conflict-resolved'; conflictId: string; formulaId: string }
  | { type: 'snapshot-reviewed'; batchId: string; formulaId: string }
