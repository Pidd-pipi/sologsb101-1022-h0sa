/**
 * 多标签页协同：改动流水（changelog）与待处理冲突。
 *
 * 每个标签页（clientId）把本地改动追加到 changes 表；各标签页监听该表后：
 * - 互不重叠的改动自动合并；
 * - 同一条记录被两个标签页同时改动时，后保存方拿到冲突，必须逐项确认后才入库，
 *   未确认的本地草稿继续保留，绝不覆盖对方改动。
 */

/** 参与协同的表 */
export type SyncTableName = 'formulas' | 'materials' | 'proportions' | 'batches' | 'cellars' | 'tastings'

export const SYNC_TABLE_NAMES: SyncTableName[] = [
  'formulas',
  'materials',
  'proportions',
  'batches',
  'cellars',
  'tastings'
]

/** 改动流水状态：待合并 / 已被各处合并 / 挂起为冲突 */
export type ChangeStatus = 'pending' | 'merged' | 'conflict'

/** 改动动作 */
export type ChangeKind = 'create' | 'update' | 'delete' | 'review'

/** 一条改动流水：谁在何时改了哪张表的哪条记录 */
export interface SyncChange {
  id: string
  /** 发起改动的标签页 id */
  clientId: string
  table: SyncTableName
  /** 被改动记录的主键 */
  recordId: string
  kind: ChangeKind
  /** update / delete 时记录改动前的字段，供冲突时列出双方差异 */
  baseFields: Record<string, unknown>
  /** 本地要写入的新值（delete 时为空） */
  nextFields: Record<string, unknown>
  /** 人类可读的记录名（香方名 / 香料名 / 批次号等），供冲突中心展示 */
  recordLabel: string
  /** 受影响的香方：配比 / 批次 / 窖藏 / 品香改动都会回填，用于失效旧快照 */
  formulaId: string | null
  status: ChangeStatus
  /** 发起改动的标签页是否处于离线状态（离线改动重连后再合并） */
  offline: boolean
  createdAt: number
  updatedAt: number
}

/** 字段差异的双方取值 */
export interface SyncFieldDiff {
  field: string
  label: string
  /** 冲突发起方本地草稿的值 */
  local: unknown
  /** 对方标签页已入库的值 */
  remote: unknown
}

/** 冲突中每一项（按记录归组）的解决方式：逐项确认，未确认不入库 */
export type ConflictResolution = 'local' | 'remote'

/** 一条待处理冲突：本标签页的改动 vs 对方已入库的改动 */
export interface SyncConflict {
  /** 冲突归组键：table:recordId */
  key: string
  table: SyncTableName
  recordId: string
  recordLabel: string
  /** 对方标签页 id */
  remoteClientId: string
  /** 双方改动流水 id，便于逐项处理后回写 */
  localChangeId: string
  remoteChangeId: string
  /** 有差异的字段（香料、占比、君臣佐使等逐项列出） */
  diffs: SyncFieldDiff[]
  /** 每项字段的确认结果；未逐项确认前整体不可入库 */
  resolutions: Record<string, ConflictResolution>
  localKind: ChangeKind
  remoteKind: ChangeKind
  localFields: Record<string, unknown>
  remoteFields: Record<string, unknown>
  baseFields: Record<string, unknown>
  /** 关联香方（配比等改动带来的旧快照失效范围） */
  formulaId: string | null
  detectedAt: number
}

/** 协调一次改动时的入参 */
export interface LocalEditInput {
  table: SyncTableName
  recordId: string
  kind?: ChangeKind
  baseFields?: Record<string, unknown>
  nextFields: Record<string, unknown>
  recordLabel: string
  formulaId?: string | null
}

/** 协调结果：无冲突直接落库；有冲突时抛出/返回 conflict，由调用方打开确认中心 */
export interface CoordinateResult {
  conflict: SyncConflict | null
  change: SyncChange | null
}

/** 重连合并的统计结果 */
export interface ReconcileReport {
  /** 互不重叠、已自动合并的改动条数 */
  merged: number
  /** 重叠且仍待逐项处理的冲突条数 */
  conflicts: number
}
