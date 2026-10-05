/** 和香批次：一次实际的配料与成型作业 */
export type FormingMethod = '挤条' | '手搓' | '压模' | '炼蜜成丸'

/** 旧快照复核状态：香方配比改动后，在用批次的旧快照立即失效，等待逐批复核 */
export type BatchReviewState = '正常' | '待复核'

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
  /**
   * 旧快照复核状态：
   * - 正常：快照与当前香方配比一致，或已复核通过
   * - 待复核：香方配比改动后旧快照立即失效，未复核前不得按新配比登记出窖 / 品香
   */
  reviewState: BatchReviewState
  /** 快照被判失效（待复核）的时间戳，正常批次为 0 */
  staleAt: number
  /** 复核通过时间戳；复核会按当前配比重新固化快照 */
  reviewedAt: number
  updatedAt: number
}

export const FORMING_METHODS: FormingMethod[] = ['挤条', '手搓', '压模', '炼蜜成丸']
export const BATCH_REVIEW_STATES: BatchReviewState[] = ['正常', '待复核']

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
  /** 旧快照是否待复核（香方已改、未复核不得按新配比出窖 / 品香） */
  pendingReview: boolean
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
