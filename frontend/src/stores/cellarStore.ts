import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useSyncGuard } from '@/hooks/useSyncGuard'
import {
  CELLAR_NEAR_DAYS,
  CELLAR_STATE_FLOW,
  createEmptyCellarFilter,
  type Cellar,
  type CellarContainer,
  type CellarFilterState,
  type CellarRow,
  type CellarState,
  type CellarUrgency
} from '@/types/cellar'
import type { Batch } from '@/types/batch'
import type { Formula } from '@/types/formula'
import type { LocalEditInput } from '@/types/sync'
import { round } from '@/utils/ratio'

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 yyyy-MM-dd 解析为当天 0 点的毫秒数，非法日期返回 NaN */
export function parseDate(value: string): number {
  if (!value) return Number.NaN
  const parts = value.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return Number.NaN
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/** 计算两个日期之间的整天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = parseDate(from)
  const end = parseDate(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / DAY_MS)
}

/** 今天（本地时区）的 yyyy-MM-dd */
export function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 窖藏 store：维护窖藏批次、环境读数与排序方式，
 * 派生临近出窖提醒（逾期 / 临近 / 正常 / 已出窖）。
 */
export const useCellarStore = defineStore('cellar', () => {
  const cellarTable = useIdbTable<Cellar>((database) => database.cellars)
  const batchTable = useIdbTable<Batch>((database) => database.batches, { sortByUpdatedAt: false })
  const formulaTable = useIdbTable<Formula>((database) => database.formulas, { sortByUpdatedAt: false })
  const guard = useSyncGuard()

  const prefs = readUiPrefs()
  const sortMode = ref<'remain' | 'start'>(prefs.cellarSort)
  const filter = ref<CellarFilterState>(createEmptyCellarFilter())
  const currentCellarId = ref<string | null>(null)

  const cellars = computed<Cellar[]>(() => cellarTable.rows.value)
  const batches = computed<Batch[]>(() => batchTable.rows.value)
  const formulas = computed<Formula[]>(() => formulaTable.rows.value)
  const loading = computed(() => cellarTable.loading.value)
  const ready = computed(() => cellarTable.ready.value)
  const error = computed(() => cellarTable.error.value)

  const currentCellar = computed<Cellar | null>(
    () => cellars.value.find((cellar) => cellar.id === currentCellarId.value) ?? null
  )

  const batchMap = computed<Record<string, Batch>>(() => {
    const map: Record<string, Batch> = {}
    batches.value.forEach((batch) => {
      map[batch.id] = batch
    })
    return map
  })

  const formulaNameMap = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    formulas.value.forEach((formula) => {
      map[formula.id] = formula.name
    })
    return map
  })

  /** 批次标签：香方名 · 和香日期 · 成型方式 */
  function batchLabel(batchId: string): string {
    const batch = batchMap.value[batchId]
    if (!batch) return '批次已删除'
    const name = formulaNameMap.value[batch.formulaId] ?? '香方已删除'
    return `${name} · ${batch.mixedAt} · ${batch.formingMethod}`
  }

  /** 批次旧快照是否待复核（香方改动后未复核，不得按新配比登记出窖 / 品香） */
  function isBatchPendingReview(batchId: string): boolean {
    return pendingReviewBatchIds.value.has(batchId)
  }

  /** 待复核批次数量（窖藏页 / 批次页 / 品香页统一口径） */
  const pendingReviewBatchIds = computed<Set<string>>(
    () => new Set(batches.value.filter((batch) => batch.reviewState === '待复核').map((batch) => batch.id))
  )

  const pendingReviewCount = computed(() => pendingReviewBatchIds.value.size)

  function urgencyOf(cellar: Cellar): CellarUrgency {
    if (cellar.state === '已出窖') return 'done'
    const remain = daysBetween(todayIso(), cellar.endDate)
    if (remain < 0) return 'overdue'
    if (remain <= CELLAR_NEAR_DAYS) return 'near'
    return 'normal'
  }

  /** 全部窖藏行：附带批次、香方与剩余天数 */
  const rows = computed<CellarRow[]>(() =>
    cellars.value.map((cellar) => {
      const batch = batchMap.value[cellar.batchId]
      return {
        cellar,
        batchLabel: batchLabel(cellar.batchId),
        formulaName: batch ? formulaNameMap.value[batch.formulaId] ?? '香方已删除' : '香方已删除',
        quantity: batch?.quantity ?? 0,
        remainDays: daysBetween(todayIso(), cellar.endDate),
        agedDays: daysBetween(cellar.startDate, todayIso()),
        urgency: urgencyOf(cellar)
      }
    })
  )

  /** 按排序方式排列：临近出窖（剩余天数升序）/ 按入窖日期 */
  const sortedRows = computed<CellarRow[]>(() => {
    const list = [...rows.value]
    if (sortMode.value === 'start') {
      return list.sort((a, b) => b.cellar.startDate.localeCompare(a.cellar.startDate))
    }
    return list.sort((a, b) => {
      const rank = (row: CellarRow): number => (row.urgency === 'done' ? 1 : 0)
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) return rankDiff
      return a.remainDays - b.remainDays
    })
  })

  const filteredRows = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.batchLabel}${row.formulaName}${row.cellar.container}${row.cellar.state}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.states.length > 0 && !filter.value.states.includes(row.cellar.state)) return false
      if (filter.value.containers.length > 0 && !filter.value.containers.includes(row.cellar.container)) return false
      return true
    })
  )

  /** 临近出窖提醒：逾期 + 14 天内到期的在窖批次 */
  const alerts = computed<CellarRow[]>(() =>
    sortedRows.value.filter((row) => row.urgency === 'overdue' || row.urgency === 'near')
  )

  const agingCount = computed(() => cellars.value.filter((cellar) => cellar.state === '窖藏中').length)
  const doneCount = computed(() => cellars.value.filter((cellar) => cellar.state === '已出窖').length)

  const averageTemperature = computed(() => {
    const list = cellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.temperatureC, 0) / list.length, 1)
  })

  const averageHumidity = computed(() => {
    const list = cellars.value.filter((cellar) => cellar.state === '窖藏中')
    if (list.length === 0) return 0
    return round(list.reduce((sum, cellar) => sum + cellar.humidityPct, 0) / list.length, 1)
  })

  /** 温湿度是否在建议区间内（18~26℃ / 50~70%） */
  const environmentWarning = computed(() =>
    cellars.value
      .filter((cellar) => cellar.state === '窖藏中')
      .filter((cellar) => cellar.temperatureC < 18 || cellar.temperatureC > 26 || cellar.humidityPct < 50 || cellar.humidityPct > 70)
      .map((cellar) => ({
        cellarId: cellar.id,
        label: batchLabel(cellar.batchId),
        temperatureC: cellar.temperatureC,
        humidityPct: cellar.humidityPct
      }))
  )

  const hasFilter = computed(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.states.length > 0 ||
      filter.value.containers.length > 0
  )

  function setSortMode(mode: 'remain' | 'start'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), cellarSort: mode })
  }

  function setCurrentCellar(id: string | null): void {
    currentCellarId.value = id
  }

  function patchFilter(patch: Partial<CellarFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCellarFilter()
  }

  function cellarById(id: string): Cellar | undefined {
    return cellars.value.find((cellar) => cellar.id === id)
  }

  function cellarsOfBatch(batchId: string): Cellar[] {
    return cellars.value.filter((cellar) => cellar.batchId === batchId)
  }

  async function createCellar(payload: {
    batchId: string
    startDate: string
    endDate: string
    temperatureC: number
    humidityPct: number
    container: CellarContainer
    state?: CellarState
  }): Promise<{ cellarId: string; blocked: boolean; queued: boolean }> {
    const id = createId('cellar')
    const nextFields = {
      batchId: payload.batchId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      temperatureC: round(payload.temperatureC, 1),
      humidityPct: round(payload.humidityPct, 1),
      container: payload.container,
      state: payload.state ?? '窖藏中'
    }
    const result = await guard.save({
      table: 'cellars',
      recordId: id,
      kind: 'create',
      nextFields,
      recordLabel: batchLabel(payload.batchId),
      formulaId: batchMap.value[payload.batchId]?.formulaId ?? null
    })
    return { cellarId: id, blocked: result.conflicts.length > 0, queued: result.queued }
  }

  async function updateCellar(id: string, patch: Partial<Cellar>): Promise<{ blocked: boolean; queued: boolean }> {
    const cellar = cellarById(id)
    if (!cellar) return { blocked: false, queued: false }
    const next: Partial<Cellar> = { ...patch }
    if (patch.temperatureC !== undefined) next.temperatureC = round(patch.temperatureC, 1)
    if (patch.humidityPct !== undefined) next.humidityPct = round(patch.humidityPct, 1)
    const baseFields: Record<string, unknown> = {}
    Object.keys(next).forEach((field) => {
      baseFields[field] = (cellar as unknown as Record<string, unknown>)[field]
    })
    const result = await guard.save({
      table: 'cellars',
      recordId: id,
      kind: 'update',
      baseFields,
      nextFields: next as Record<string, unknown>,
      recordLabel: batchLabel(cellar.batchId),
      formulaId: batchMap.value[cellar.batchId]?.formulaId ?? null
    })
    return { blocked: result.conflicts.length > 0, queued: result.queued }
  }

  /** 状态流转：窖藏中 → 已出窖（可回退）；旧快照待复核时禁止出窖 */
  async function advanceState(id: string): Promise<{ next: CellarState | null; blocked: boolean; queued: boolean }> {
    const cellar = cellarById(id)
    if (!cellar) return { next: null, blocked: false, queued: false }
    const next = CELLAR_STATE_FLOW[cellar.state]
    const patch: Partial<Cellar> = { state: next }
    if (next === '已出窖' && cellar.endDate > todayIso()) {
      patch.endDate = todayIso()
    }
    if (next === '已出窖' && isBatchPendingReview(cellar.batchId)) {
      return { next: null, blocked: true, queued: false }
    }
    const result = await updateCellar(id, patch)
    return { next, blocked: result.blocked, queued: result.queued }
  }

  async function setState(id: string, state: CellarState): Promise<{ blocked: boolean; queued: boolean }> {
    const cellar = cellarById(id)
    if (!cellar || cellar.state === state) return { blocked: false, queued: false }
    if (state === '已出窖' && isBatchPendingReview(cellar.batchId)) {
      return { blocked: true, queued: false }
    }
    return updateCellar(id, { state })
  }

  /** 一键出窖：跳过旧快照待复核的批次（未复核不许按新配比登记出窖） */
  async function releaseOverdue(): Promise<{ released: number; skippedPending: number }> {
    const targets = rows.value.filter((row) => row.cellar.state === '窖藏中' && row.remainDays < 0)
    const allowed = targets.filter((row) => !isBatchPendingReview(row.cellar.batchId))
    const skipped = targets.length - allowed.length
    if (allowed.length === 0) return { released: 0, skippedPending: skipped }
    const inputs: LocalEditInput[] = allowed.map((row) => ({
      table: 'cellars',
      recordId: row.cellar.id,
      kind: 'update',
      baseFields: { state: row.cellar.state, endDate: row.cellar.endDate },
      nextFields: { state: '已出窖', endDate: todayIso() },
      recordLabel: row.batchLabel,
      formulaId: batchMap.value[row.cellar.batchId]?.formulaId ?? null
    }))
    await guard.run(inputs)
    return { released: allowed.length, skippedPending: skipped }
  }

  async function removeCellar(id: string): Promise<{ blocked: boolean; queued: boolean }> {
    const cellar = cellarById(id)
    if (!cellar) return { blocked: false, queued: false }
    const result = await guard.save({
      table: 'cellars',
      recordId: id,
      kind: 'delete',
      baseFields: { batchId: cellar.batchId, state: cellar.state, endDate: cellar.endDate },
      nextFields: {},
      recordLabel: batchLabel(cellar.batchId),
      formulaId: batchMap.value[cellar.batchId]?.formulaId ?? null
    })
    if (currentCellarId.value === id) currentCellarId.value = null
    return { blocked: result.conflicts.length > 0, queued: result.queued }
  }

  async function removeCellarsOfBatch(batchId: string): Promise<number> {
    const ids = cellarsOfBatch(batchId).map((cellar) => cellar.id)
    if (ids.length === 0) return 0
    await cellarTable.bulkRemove(ids)
    return ids.length
  }

  /** 当前香方是否有待复核批次：配比页登记新批次前读取 */
  function formulaHasPendingReview(formulaId: string): boolean {
    return batches.value.some((batch) => batch.formulaId === formulaId && batch.reviewState === '待复核')
  }

  /**
   * 登记和香批次（自动固化当前配比快照）。
   * 所属香方存在待复核旧批次时拒绝登记：未复核前不许按新配比出窖 / 开新批。
   */
  async function registerBatch(payload: {
    formulaId: string
    mixedAt: string
    formingMethod: Batch['formingMethod']
    quantity: number
    operator: string
    snapshot: Batch['snapshot']
  }): Promise<{ batchId: string | null; blockedByReview: boolean; conflict: boolean; queued: boolean }> {
    if (formulaHasPendingReview(payload.formulaId)) {
      return { batchId: null, blockedByReview: true, conflict: false, queued: false }
    }
    const id = createId('batch')
    const formulaName = formulaNameMap.value[payload.formulaId] ?? '香方'
    const now = Date.now()
    const result = await guard.save({
      table: 'batches',
      recordId: id,
      kind: 'create',
      nextFields: {
        formulaId: payload.formulaId,
        mixedAt: payload.mixedAt,
        formingMethod: payload.formingMethod,
        quantity: payload.quantity,
        operator: payload.operator,
        snapshot: payload.snapshot,
        snapshotAt: now,
        reviewState: '正常',
        staleAt: 0,
        reviewedAt: 0
      },
      recordLabel: `${formulaName} · ${payload.mixedAt} · ${payload.formingMethod}`,
      formulaId: payload.formulaId
    })
    return {
      batchId: id,
      blockedByReview: false,
      conflict: result.conflicts.length > 0,
      queued: result.queued
    }
  }

  /** 编辑批次元信息（不动快照，不改变复核状态） */
  async function updateBatchMeta(
    id: string,
    patch: Partial<Pick<Batch, 'formulaId' | 'mixedAt' | 'formingMethod' | 'quantity' | 'operator'>>
  ): Promise<{ blocked: boolean; queued: boolean }> {
    const batch = batches.value.find((item) => item.id === id)
    if (!batch) return { blocked: false, queued: false }
    const baseFields: Record<string, unknown> = {}
    Object.keys(patch).forEach((field) => {
      baseFields[field] = (batch as unknown as Record<string, unknown>)[field]
    })
    const result = await guard.save({
      table: 'batches',
      recordId: id,
      kind: 'update',
      baseFields,
      nextFields: patch as Record<string, unknown>,
      recordLabel: `${formulaNameMap.value[batch.formulaId] ?? '香方'} · ${batch.mixedAt}`,
      formulaId: batch.formulaId
    })
    return { blocked: result.conflicts.length > 0, queued: result.queued }
  }

  /**
   * 复核通过：按当前配比重新固化快照、清除待复核标记。
   * 这是唯一允许「按新配比」覆盖旧快照的入口。
   */
  async function reviewBatchSnapshot(
    id: string,
    snapshot: Batch['snapshot']
  ): Promise<{ blocked: boolean; queued: boolean }> {
    const batch = batches.value.find((item) => item.id === id)
    if (!batch) return { blocked: false, queued: false }
    const now = Date.now()
    const result = await guard.save({
      table: 'batches',
      recordId: id,
      kind: 'review',
      baseFields: {
        snapshot: batch.snapshot,
        reviewState: batch.reviewState,
        staleAt: batch.staleAt,
        reviewedAt: batch.reviewedAt
      },
      nextFields: {
        snapshot,
        snapshotAt: now,
        reviewState: '正常',
        staleAt: 0,
        reviewedAt: now
      },
      recordLabel: `${formulaNameMap.value[batch.formulaId] ?? '香方'} · ${batch.mixedAt}`,
      formulaId: batch.formulaId
    })
    return { blocked: result.conflicts.length > 0, queued: result.queued }
  }

  return {
    cellars,
    batches,
    formulas,
    loading,
    ready,
    error,
    sortMode,
    filter,
    currentCellarId,
    currentCellar,
    rows,
    sortedRows,
    filteredRows,
    alerts,
    agingCount,
    doneCount,
    averageTemperature,
    averageHumidity,
    environmentWarning,
    hasFilter,
    batchMap,
    batchLabel,
    pendingReviewBatchIds,
    pendingReviewCount,
    isBatchPendingReview,
    formulaHasPendingReview,
    registerBatch,
    updateBatchMeta,
    reviewBatchSnapshot,
    setSortMode,
    setCurrentCellar,
    patchFilter,
    resetFilter,
    cellarById,
    cellarsOfBatch,
    createCellar,
    updateCellar,
    advanceState,
    setState,
    releaseOverdue,
    removeCellar,
    removeCellarsOfBatch
  }
})
