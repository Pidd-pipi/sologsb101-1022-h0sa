/**
 * 多标签页协同 store：
 * - 在线标签页心跳与数量
 * - 配比冲突的排队、逐项确认与落库（未确认草稿原样保留在 conflicts 表，不覆盖对方改动）
 * - 配方配比的三方合并提交入口（guardProportionWrite）
 * - 批次快照待复核拦截（出窖 / 品香前必须先复核）
 * - 离线 / 重连后的合并：互不重叠的改动自动合并，重叠项保留待处理
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowReactive } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { tabBus, tabId } from '@/utils/tabBus'
import {
  buildSnapshotItems,
  fingerprint,
  mergeProportionSets,
  resolveConflictRows
} from '@/utils/merge'
import { useProportionStore } from '@/stores/proportionStore'
import { useMaterialStore } from '@/stores/materialStore'
import type { Proportion } from '@/types/proportion'
import type { Batch } from '@/types/batch'
import type { ConflictChoice, PendingConflict, TabPresence } from '@/types/collab'

/** 标签页心跳超时阈值：超过该时长未上报视为离线 */
const TAB_STALE_MS = 15000

export const useCollabStore = defineStore('collab', () => {
  const conflictTable = useIdbTable<PendingConflict>((database) => database.conflicts, {
    sortByUpdatedAt: false
  })

  /** 其它在线标签页（不含本标签页） */
  const tabs = ref<TabPresence[]>([])
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
  const initialized = ref(false)

  /** 各香方在本标签页的「已观察一致」基线（共同祖先），不持久化；浅响应式避免结构化克隆带入 Vue 代理 */
  const baseByFormula = shallowReactive<Record<string, { at: number; rows: Proportion[] }>>({})

  /** 全局快照复核对话框 */
  const reviewOpen = ref(false)
  const reviewBatchId = ref<string | null>(null)

  /** 待处理冲突（按更新时间倒序） */
  const pendingConflicts = computed<PendingConflict[]>(() =>
    conflictTable.rows.value
      .filter((conflict) => conflict.status === 'pending')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )
  const pendingConflictCount = computed(() => pendingConflicts.value.length)
  const activeTabCount = computed(() => tabs.value.length + 1)

  function hasPendingConflict(formulaId: string): boolean {
    return pendingConflicts.value.some((conflict) => conflict.formulaId === formulaId)
  }

  function upsertTab(tab: TabPresence): void {
    if (tab.tabId === tabId) return
    const index = tabs.value.findIndex((item) => item.tabId === tab.tabId)
    if (index >= 0) tabs.value[index] = tab
    else tabs.value.push(tab)
    const cutoff = Date.now() - TAB_STALE_MS
    tabs.value = tabs.value.filter((item) => item.lastSeenAt >= cutoff)
  }

  async function refreshBaseIfIdle(formulaId: string): Promise<void> {
    if (hasPendingConflict(formulaId)) return
    const current = await db.proportions.where('formulaId').equals(formulaId).toArray()
    baseByFormula[formulaId] = { at: Date.now(), rows: current }
  }

  /** 订阅跨页消息与在线状态（应用启动时调用一次） */
  function init(): void {
    if (initialized.value) return
    initialized.value = true

    tabBus.on((message) => {
      switch (message.type) {
        case 'hello':
        case 'presence':
          upsertTab(message.tab)
          break
        case 'bye':
          tabs.value = tabs.value.filter((tab) => tab.tabId !== message.tabId)
          break
        case 'proportion-changed':
          if (message.writerTabId === tabId) break
          // 其它标签页改了配比：无待处理冲突时同步基线，避免下次提交误判
          void refreshBaseIfIdle(message.formulaId)
          break
        default:
          break
      }
    })

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        online.value = true
        void reconcile()
      })
      window.addEventListener('offline', () => {
        online.value = false
      })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reconcile()
      })
    }

    tabBus.hello()
  }

  /**
   * 配比内容整组提交的协同守卫：
   * 以本标签页基线为共同祖先，与「对方已提交版本」做 3-way 合并。
   * 无分歧 → 直接落库；有分歧 → 保留本方草稿并排队待逐项确认，绝不覆盖对方改动。
   */
  async function guardProportionWrite(
    formulaId: string,
    oursRows: Proportion[]
  ): Promise<{ held: boolean; conflictId?: string; count?: number }> {
    const materialStore = useMaterialStore()
    const proportionStore = useProportionStore()
    const nameOf = (id: string): string => materialStore.materialName(id)

    const base =
      baseByFormula[formulaId]?.rows ??
      (await db.proportions.where('formulaId').equals(formulaId).toArray())
    const theirs = await db.proportions.where('formulaId').equals(formulaId).toArray()

    const { rows: autoMerged, conflicts: rowConflicts } = mergeProportionSets(
      base,
      oursRows,
      theirs,
      nameOf
    )

    if (rowConflicts.length === 0) {
      const written = await proportionStore.replaceProportionSet(formulaId, autoMerged)
      baseByFormula[formulaId] = { at: Date.now(), rows: written }
      return { held: false, count: written.length }
    }

    const formula = await db.formulas.get(formulaId)
    const now = Date.now()
    const conflict: PendingConflict = {
      id: createId('conflict'),
      kind: 'proportion',
      formulaId,
      formulaName: formula?.name ?? '未知香方',
      status: 'pending',
      base,
      ours: oursRows,
      theirs,
      autoMerged,
      conflicts: rowConflicts.map((row) => ({ ...row, choice: 'ours' as ConflictChoice })),
      createdAt: now,
      updatedAt: now,
      sourceTabId: tabId
    }
    await db.conflicts.put(conflict)
    tabBus.broadcast({ type: 'conflict-held', conflictId: conflict.id, formulaId })
    return { held: true, conflictId: conflict.id }
  }

  /** 页面观察到配比变化时同步基线（有待处理冲突时保留共同祖先，不覆盖） */
  function noteObservation(formulaId: string, rows: Proportion[]): void {
    if (hasPendingConflict(formulaId)) return
    baseByFormula[formulaId] = { at: Date.now(), rows: rows.map((row) => ({ ...row })) }
  }

  /** 逐项确认后落库：按用户选择组装最终配比并写入 */
  async function resolveConflict(conflictId: string): Promise<number> {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict || conflict.status !== 'pending') return 0
    const proportionStore = useProportionStore()
    const finalRows = resolveConflictRows(conflict.autoMerged, conflict.conflicts, conflict.theirs)
    const written = await proportionStore.replaceProportionSet(conflict.formulaId, finalRows)
    await db.conflicts.update(conflictId, { status: 'resolved', updatedAt: Date.now() })
    baseByFormula[conflict.formulaId] = { at: Date.now(), rows: written }
    tabBus.broadcast({ type: 'conflict-resolved', conflictId, formulaId: conflict.formulaId })
    return written.length
  }

  /** 修改某一行的逐项选择并持久化 */
  async function setConflictChoice(
    conflictId: string,
    materialId: string,
    choice: ConflictChoice
  ): Promise<void> {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict) return
    const conflicts = conflict.conflicts.map((row) =>
      row.materialId === materialId ? { ...row, choice } : row
    )
    await db.conflicts.update(conflictId, { conflicts, updatedAt: Date.now() })
  }

  /** 全部采用某一方 */
  async function setAllChoices(conflictId: string, choice: ConflictChoice): Promise<void> {
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict) return
    const conflicts = conflict.conflicts.map((row) => ({ ...row, choice }))
    await db.conflicts.update(conflictId, { conflicts, updatedAt: Date.now() })
  }

  /** 保留草稿稍后处理（不写库） */
  async function deferConflict(conflictId: string): Promise<void> {
    await db.conflicts.update(conflictId, { updatedAt: Date.now() })
  }

  /** 放弃本方草稿 */
  async function dismissConflict(conflictId: string): Promise<void> {
    await db.conflicts.update(conflictId, { status: 'dismissed', updatedAt: Date.now() })
  }

  /**
   * 离线 / 重连后合并：
   * - 无冲突香方：基线刷新为数据库最新状态（互不重叠的改动已在提交时自动合并）
   * - 待处理冲突：用对方最新版本重算自动合并项，重叠项继续保留待处理
   */
  async function reconcile(): Promise<void> {
    const materialStore = useMaterialStore()
    const formulaIds = new Set<string>([
      ...Object.keys(baseByFormula),
      ...pendingConflicts.value.map((conflict) => conflict.formulaId)
    ])
    for (const formulaId of formulaIds) {
      const current = await db.proportions.where('formulaId').equals(formulaId).toArray()
      const pending = pendingConflicts.value.find((conflict) => conflict.formulaId === formulaId)
      if (pending) {
        const nameOf = (id: string): string => materialStore.materialName(id)
        const { rows: autoMerged, conflicts: rowConflicts } = mergeProportionSets(
          pending.base,
          pending.ours,
          current,
          nameOf
        )
        const choices = new Map<string, ConflictChoice>()
        pending.conflicts.forEach((row) => choices.set(row.materialId, row.choice ?? 'ours'))
        const merged = rowConflicts.map((row) => ({
          ...row,
          choice: choices.get(row.materialId) ?? 'ours'
        }))
        await db.conflicts.update(pending.id, {
          theirs: current,
          autoMerged,
          conflicts: merged,
          updatedAt: Date.now()
        })
      } else {
        baseByFormula[formulaId] = { at: Date.now(), rows: current }
      }
    }
    tabBus.hello()
  }

  /**
   * 批次快照复核拦截：快照已漂移且未复核 → 打开复核对话框并返回 false（不放行）；
   * 已复核或快照一致 → 返回 true，允许出窖 / 品香。
   */
  function requireReviewed(batch: Batch): boolean {
    if (batch.snapshotStatus !== 'stale' || batch.reviewedAt) return true
    reviewBatchId.value = batch.id
    reviewOpen.value = true
    return false
  }

  function openReview(batchId: string): void {
    reviewBatchId.value = batchId
    reviewOpen.value = true
  }

  /** 复核处理：keep=保留旧方快照（解除拦截，仍按原批次追溯）；refresh=按当前配比刷新快照 */
  async function submitReview(batchId: string, choice: 'keep' | 'refresh'): Promise<void> {
    const batch = await db.batches.get(batchId)
    if (!batch) return
    const now = Date.now()
    if (choice === 'refresh') {
      const materialStore = useMaterialStore()
      const current = await db.proportions.where('formulaId').equals(batch.formulaId).toArray()
      const formula = await db.formulas.get(batch.formulaId)
      await db.batches.update(batchId, {
        snapshot: buildSnapshotItems(current, (id) => materialStore.materialName(id)),
        snapshotAt: now,
        snapshotVersion: formula?.version ?? batch.snapshotVersion,
        snapshotStatus: 'current',
        reviewedAt: now,
        reviewNote: '已按当前配比刷新快照',
        updatedAt: now
      })
    } else {
      await db.batches.update(batchId, {
        reviewedAt: now,
        reviewNote: '保留旧方快照，批次按原配比追溯',
        updatedAt: now
      })
    }
    reviewOpen.value = false
    reviewBatchId.value = null
    tabBus.broadcast({ type: 'snapshot-reviewed', batchId, formulaId: batch.formulaId })
  }

  /** 供外部读取某香方基线指纹（调试 / UI 提示用） */
  function baseFingerprint(formulaId: string): string {
    return fingerprint(baseByFormula[formulaId]?.rows ?? [])
  }

  return {
    initialized,
    tabs,
    online,
    baseByFormula,
    pendingConflicts,
    pendingConflictCount,
    activeTabCount,
    reviewOpen,
    reviewBatchId,
    init,
    guardProportionWrite,
    noteObservation,
    resolveConflict,
    setConflictChoice,
    setAllChoices,
    deferConflict,
    dismissConflict,
    reconcile,
    requireReviewed,
    openReview,
    submitReview,
    hasPendingConflict,
    baseFingerprint
  }
})
