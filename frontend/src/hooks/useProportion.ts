import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { createId, db } from '@/utils/db'
import { useProportionStore } from '@/stores/proportionStore'
import { useFormulaStore } from '@/stores/formulaStore'
import { useMaterialStore } from '@/stores/materialStore'
import { useSyncGuard } from '@/hooks/useSyncGuard'
import type { Proportion, ProportionRole } from '@/types/proportion'
import type { Material, MaterialGrade, ProcessMethod } from '@/types/material'
import type { LocalEditInput } from '@/types/sync'
import {
  applyManualOrder,
  checkRatioTotal,
  diffFromHundred,
  nextSeqMap,
  normalizeRatios,
  round,
  scaleRatios,
  sortByRoleWeight
} from '@/utils/ratio'

export interface UseProportionOptions {
  /** 仅在该香方下操作；不传则使用 formulaStore 的当前香方 */
  formulaId?: Ref<string | null>
}

export interface ProportionFormPayload {
  materialId: string
  ratio: number
  role: ProportionRole
  note: string
}

/** 配比页一行：配比 + 香料快照 */
export interface ProportionRow {
  /** 配比主键，便于统一按 id 排序 / 拖拽 */
  id: string
  proportion: Proportion
  material: Material | null
  materialName: string
  origin: string
  grade: MaterialGrade | '未知'
  processMethod: ProcessMethod | '未知'
  ratio: number
  role: ProportionRole
}

export interface UseProportionResult {
  formulaId: ComputedRef<string | null>
  rows: ComputedRef<ProportionRow[]>
  /** 按君臣佐使权重预览排序结果（不改动数据库） */
  rolePreview: ComputedRef<ProportionRow[]>
  total: ComputedRef<number>
  gap: ComputedRef<number>
  balanced: ComputedRef<boolean>
  checkLevel: ComputedRef<'ok' | 'warn' | 'error'>
  checkMessage: ComputedRef<string>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** 最近一次保存被冲突拦截的条数（>0 时数据未写入，冲突中心等待逐项确认） */
  blockedByConflict: Ref<boolean>
  /** 最近一次保存是否因离线进入暂存队列 */
  queuedOffline: Ref<boolean>
  add: (payload: ProportionFormPayload) => Promise<Proportion | null>
  update: (id: string, patch: Partial<ProportionFormPayload>) => Promise<boolean>
  remove: (id: string) => Promise<void>
  /** 一键等比缩放到合计 100（可指定缩放因子） */
  rescale: (factor?: number) => Promise<number>
  /** 一键等比放大 / 缩小 */
  multiply: (factor: number) => Promise<number>
  /** 按君臣佐使权重重排并回写 seq */
  sortByRole: () => Promise<void>
  /** 拖拽后按新顺序回写 seq */
  reorder: (orderedIds: string[]) => Promise<void>
  /** 归一化到 100 并写回 */
  normalize: () => Promise<void>
  clearFormula: () => Promise<number>
}

/**
 * useProportion：管理某香方配比的增删改、合计校验与等比缩放。
 * 结果写回 Dexie，并通过 proportionStore 的 liveQuery 自动刷新页面。
 */
export function useProportion(options: UseProportionOptions = {}): UseProportionResult {
  const proportionStore = useProportionStore()
  const formulaStore = useFormulaStore()
  const materialStore = useMaterialStore()
  const guard = useSyncGuard()

  const loading = ref(false)
  const error = ref<string | null>(null)
  const blockedByConflict = ref(false)
  const queuedOffline = ref(false)

  const formulaId = computed<string | null>(() =>
    options.formulaId ? options.formulaId.value : formulaStore.currentFormulaId
  )

  const rows = computed<ProportionRow[]>(() => {
    const id = formulaId.value
    if (!id) return []
    const materialMap = new Map<string, Material>()
    materialStore.materials.forEach((material) => materialMap.set(material.id, material))
    const list = proportionStore.proportionsByFormula(id).map<ProportionRow>((proportion) => {
      const material = materialMap.get(proportion.materialId) ?? null
      return {
        id: proportion.id,
        proportion,
        material,
        materialName: material?.name ?? '香料已删除',
        origin: material?.origin ?? '—',
        grade: material?.grade ?? '未知',
        processMethod: material?.processMethod ?? '未知',
        ratio: proportion.ratio,
        role: proportion.role
      }
    })
    const orderedIds = [...list]
      .sort((a, b) => a.proportion.seq - b.proportion.seq)
      .map((row) => row.proportion.id)
    return applyManualOrder(list, orderedIds)
  })

  const rolePreview = computed<ProportionRow[]>(() => sortByRoleWeight(rows.value))

  const totals = computed(() => checkRatioTotal(rows.value.map((row) => row.ratio)))
  const total = computed(() => totals.value.total)
  const gap = computed(() => diffFromHundred(total.value))
  const balanced = computed(() => totals.value.balanced)
  const checkLevel = computed(() => totals.value.level)
  const checkMessage = computed(() => totals.value.message)

  /** 配比变化后把合计回写到香方，供香方台账与批次页读取（同样走协同守卫） */
  async function syncFormulaTotal(): Promise<void> {
    const id = formulaId.value
    if (!id) return
    const current = await db.formulas.get(id)
    if (!current || current.totalRatio === total.value) return
    await guard.save({
      table: 'formulas',
      recordId: id,
      kind: 'update',
      baseFields: { totalRatio: current.totalRatio },
      nextFields: { totalRatio: total.value },
      recordLabel: current.name,
      formulaId: id
    })
  }

  watch(total, () => {
    void syncFormulaTotal()
  })

  function nextSeq(id: string): number {
    const list = proportionStore.proportionsByFormula(id)
    return list.length === 0 ? 1 : Math.max(...list.map((item) => item.seq)) + 1
  }

  async function add(payload: ProportionFormPayload): Promise<Proportion | null> {
    const id = formulaId.value
    if (!id) throw new Error('请先选择香方')
    loading.value = true
    blockedByConflict.value = false
    queuedOffline.value = false
    try {
      const seq = nextSeq(id)
      const newId = createId('prop')
      const record: Proportion = {
        id: newId,
        formulaId: id,
        materialId: payload.materialId,
        ratio: round(payload.ratio, 2),
        role: payload.role,
        note: payload.note.trim(),
        seq,
        updatedAt: Date.now()
      }
      const formula = formulaStore.formulaById(id)
      const materialName = materialStore.materialName(payload.materialId)
      const result = await guard.save({
        table: 'proportions',
        recordId: newId,
        kind: 'create',
        nextFields: {
          formulaId: id,
          materialId: payload.materialId,
          ratio: record.ratio,
          role: payload.role,
          note: record.note,
          seq
        },
        recordLabel: `${formula?.name ?? '当前香方'} · ${materialName}`,
        formulaId: id
      })
      blockedByConflict.value = result.conflicts.length > 0
      queuedOffline.value = result.queued
      await syncFormulaTotal()
      if (blockedByConflict.value || result.queued) return null
      return record
    } catch (err) {
      error.value = err instanceof Error ? err.message : '新增配比失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function update(id: string, patch: Partial<ProportionFormPayload>): Promise<boolean> {
    loading.value = true
    blockedByConflict.value = false
    queuedOffline.value = false
    try {
      const existing = proportionStore.proportions.find((item) => item.id === id)
      if (!existing) throw new Error('配比记录不存在或已被另一标签页删除')
      const nextFields: Record<string, unknown> = {}
      const baseFields: Record<string, unknown> = {}
      if (patch.materialId !== undefined) {
        nextFields.materialId = patch.materialId
        baseFields.materialId = existing.materialId
      }
      if (patch.ratio !== undefined) {
        nextFields.ratio = round(patch.ratio, 2)
        baseFields.ratio = existing.ratio
      }
      if (patch.role !== undefined) {
        nextFields.role = patch.role
        baseFields.role = existing.role
      }
      if (patch.note !== undefined) {
        nextFields.note = patch.note.trim()
        baseFields.note = existing.note
      }
      const formula = formulaStore.formulaById(existing.formulaId)
      const result = await guard.save({
        table: 'proportions',
        recordId: id,
        kind: 'update',
        baseFields,
        nextFields,
        recordLabel: `${formula?.name ?? '香方'} · ${materialStore.materialName(existing.materialId)}`,
        formulaId: existing.formulaId
      })
      blockedByConflict.value = result.conflicts.length > 0
      queuedOffline.value = result.queued
      await syncFormulaTotal()
      return !blockedByConflict.value && !result.queued
    } catch (err) {
      error.value = err instanceof Error ? err.message : '更新配比失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function remove(id: string): Promise<void> {
    const existing = proportionStore.proportions.find((item) => item.id === id)
    if (!existing) return
    blockedByConflict.value = false
    queuedOffline.value = false
    const formula = formulaStore.formulaById(existing.formulaId)
    const result = await guard.save({
      table: 'proportions',
      recordId: id,
      kind: 'delete',
      baseFields: {
        materialId: existing.materialId,
        ratio: existing.ratio,
        role: existing.role,
        note: existing.note
      },
      nextFields: {},
      recordLabel: `${formula?.name ?? '香方'} · ${materialStore.materialName(existing.materialId)}`,
      formulaId: existing.formulaId
    })
    blockedByConflict.value = result.conflicts.length > 0
    queuedOffline.value = result.queued
    await syncFormulaTotal()
  }

  /** 批量守卫的统一结果处理：任一行冲突则整组未入库 */
  function applyGuardOutcome(inputs: LocalEditInput[]): Promise<{ ok: boolean; queued: boolean }> {
    return guard.run(inputs).then((result) => {
      blockedByConflict.value = result.conflicts.length > 0
      queuedOffline.value = result.queued
      return { ok: !blockedByConflict.value && !result.queued, queued: result.queued }
    })
  }

  /** 等比缩放：按 factor 缩放全部占比后归一化到 100 并写回（整组守卫） */
  async function rescale(factor = 1): Promise<number> {
    const list = rows.value
    if (list.length === 0) return 0
    const scaled =
      factor === 1
        ? normalizeRatios(list.map((row) => row.ratio))
        : scaleRatios(list.map((row) => row.ratio), factor)
    const formulaIdValue = formulaId.value ?? ''
    const formula = formulaStore.formulaById(formulaIdValue)
    const inputs: LocalEditInput[] = list.map((row, index) => ({
      table: 'proportions',
      recordId: row.proportion.id,
      kind: 'update',
      baseFields: { ratio: round(row.ratio, 2) },
      nextFields: { ratio: round(scaled[index] ?? 0, 2) },
      recordLabel: `${formula?.name ?? '香方'} · ${row.materialName}`,
      formulaId: formulaIdValue
    }))
    await applyGuardOutcome(inputs)
    await syncFormulaTotal()
    return scaled.length
  }

  async function multiply(factor: number): Promise<number> {
    return rescale(factor)
  }

  /** 按君臣佐使权重重排：写回 seq 并切换排序方式（整组守卫） */
  async function sortByRole(): Promise<void> {
    const sorted = sortByRoleWeight(rows.value.map((row) => row.proportion))
    await reorder(sorted.map((item) => item.id))
    proportionStore.setSortMode('role')
  }

  /** 拖拽排序：按传入的 id 顺序回写 seq（整组守卫；与另一标签页排序重叠时挂冲突） */
  async function reorder(orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return
    const seqMap = nextSeqMap(orderedIds)
    const formulaIdValue = formulaId.value ?? ''
    const formula = formulaStore.formulaById(formulaIdValue)
    const inputs: LocalEditInput[] = orderedIds
      .map((id) => proportionStore.proportions.find((item) => item.id === id))
      .filter((item): item is Proportion => Boolean(item))
      .map((item) => ({
        table: 'proportions',
        recordId: item.id,
        kind: 'update',
        baseFields: { seq: item.seq },
        nextFields: { seq: seqMap[item.id] },
        recordLabel: `${formula?.name ?? '香方'} · ${materialStore.materialName(item.materialId)} 编排`,
        formulaId: formulaIdValue
      }))
    if (inputs.length > 0) await applyGuardOutcome(inputs)
    proportionStore.setSortMode('manual')
  }

  async function normalize(): Promise<void> {
    await rescale(1)
  }

  async function clearFormula(): Promise<number> {
    const id = formulaId.value
    if (!id) return 0
    const list = proportionStore.proportionsByFormula(id)
    if (list.length === 0) return 0
    const formula = formulaStore.formulaById(id)
    const inputs: LocalEditInput[] = list.map((item) => ({
      table: 'proportions',
      recordId: item.id,
      kind: 'delete',
      baseFields: { ratio: item.ratio, role: item.role, materialId: item.materialId },
      nextFields: {},
      recordLabel: `${formula?.name ?? '香方'} · ${materialStore.materialName(item.materialId)}`,
      formulaId: id
    }))
    const { ok } = await applyGuardOutcome(inputs)
    await syncFormulaTotal()
    return ok ? inputs.length : 0
  }

  return {
    formulaId,
    rows,
    rolePreview,
    total,
    gap,
    balanced,
    checkLevel,
    checkMessage,
    loading,
    error,
    blockedByConflict,
    queuedOffline,
    add,
    update,
    remove,
    rescale,
    multiply,
    sortByRole,
    reorder,
    normalize,
    clearFormula
  }
}
