/** 和香批次：一次实际的配料与成型作业 */
export type FormingMethod = '挤条' | '手搓' | '压模' | '炼蜜成丸'

/** 批次生成时固化的配比快照条目，用于追溯改方前后的差异 */
export interface BatchSnapshotItem {
  materialId: string
  materialName: string
  ratio: number
  role: string
}

export interface Batch {
  id: string
  /** 所属香方 */
  formulaId: string
  /** 和香日期（ISO 日期串 yyyy-MM-dd） */
  mixedAt: string
  /** 成型方式：挤条/手搓/压模/炼蜜成丸 */
  formingMethod: FormingMethod
  /** 数量（支 / 丸 / 饼） */
  quantity: number
  /** 制香人 */
  operator: string
  /** 和香当刻固化的配比快照 */
  snapshot: BatchSnapshotItem[]
  /** 快照固化时间戳 */
  snapshotAt: number
  /** 快照对应的配方版本号（Formula.version） */
  snapshotVersion: number
  /** 快照状态：current=与当前配比一致；stale=改方后旧快照已失效，待复核 */
  snapshotStatus: 'current' | 'stale'
  /** 复核时间戳：复核通过（保留旧快照或已刷新）后写入，解除出窖 / 品香拦截 */
  reviewedAt?: number
  /** 复核备注：如「保留旧方」「已按新配比刷新」 */
  reviewNote?: string
  updatedAt: number
}

export const FORMING_METHODS: FormingMethod[] = ['挤条', '手搓', '压模', '炼蜜成丸']

/** 批次列表行：批次 + 香方 + 窖藏状态 */
export interface BatchRow {
  batch: Batch
  formulaName: string
  /** 快照条目数 */
  snapshotCount: number
  /** 当前配比合计，用于对照快照差异 */
  currentRatioTotal: number
  /** 快照配比合计 */
  snapshotRatioTotal: number
  /** 是否已进入窖藏 */
  cellared: boolean
  cellarState: string
}

/** 批次筛选条件 */
export interface BatchFilterState {
  keyword: string
  formulas: string[]
  formingMethods: FormingMethod[]
}

export function createEmptyBatchFilter(): BatchFilterState {
  return { keyword: '', formulas: [], formingMethods: [] }
}
