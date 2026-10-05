import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db } from '@/utils/db'
import type { SyncChange, SyncConflict } from '@/types/sync'
import {
  ensureClientId,
  fieldLabel,
  isCoordinationOnline,
  readOfflineQueue,
  reconcileClient,
  resolveConflict as resolveConflictEngine
} from '@/utils/sync'
/**
 * 多标签页协同 store：
 * - 订阅 changes 改动流水（liveQuery 天然跨标签页实时推送）；
 * - 汇总本标签页待逐项确认的冲突，提供解决入口；
 * - 监听浏览器在线 / 离线，重连后自动合并不重叠的离线改动，重叠项保持待处理。
 */
export const useSyncStore = defineStore('sync', () => {
  const clientId = ensureClientId()
  const online = ref<boolean>(isCoordinationOnline())
  const centerVisible = ref(false)
  /** 保存动作当场发现的冲突（内存态，按本地流水 id 去重） */
  const raisedConflicts = ref<SyncConflict[]>([])
  /** 最近一次合并提示（合并条数 / 冲突条数 / 时间），供状态栏展示 */
  const lastReport = ref<{ merged: number; conflicts: number; at: number } | null>(null)

  const changeTable = useIdbTable<SyncChange>((database) => database.changes, {
    sortByUpdatedAt: false
  })

  const changes = computed<SyncChange[]>(() => changeTable.rows.value)
  const ready = computed(() => changeTable.ready.value)

  /** 本标签页尚未逐项确认的冲突流水 */
  const myConflictChanges = computed<SyncChange[]>(() =>
    changes.value
      .filter((change) => change.clientId === clientId && change.status === 'conflict')
      .sort((a, b) => a.createdAt - b.createdAt)
  )

  /** 离线暂存队列条数（localStorage 中按本标签页保存） */
  const offlineQueueCount = ref(readOfflineQueue(clientId).length)

  function refreshOfflineCount(): void {
    offlineQueueCount.value = readOfflineQueue(clientId).length
  }

  /**
   * 由一条 conflict 流水还原冲突对象：
   * 对方字段从当前共享库记录读取（即对方已入库的值），本地字段来自流水草稿。
   */
  async function hydrateConflict(change: SyncChange): Promise<SyncConflict | null> {
    const current = (await db.table(change.table).get(change.recordId)) as Record<string, unknown> | undefined
    const diffs: SyncConflict['diffs'] = []
    if (change.kind === 'delete') {
      if (current !== undefined) {
        diffs.push({ field: '__record__', label: '整条记录', local: '删除该记录', remote: '对方保留并已改动' })
      }
    } else {
      Object.keys(change.nextFields).forEach((field) => {
        if (field === 'updatedAt') return
        const localValue = change.nextFields[field]
        const remoteValue = current?.[field]
        const sameAsRemote =
          localValue === remoteValue ||
          (typeof localValue === 'object' &&
            typeof remoteValue === 'object' &&
            localValue !== null &&
            remoteValue !== null &&
            JSON.stringify(localValue) === JSON.stringify(remoteValue))
        if (!sameAsRemote) {
          diffs.push({ field, label: fieldLabel(change.table, field), local: localValue, remote: remoteValue })
        }
      })
      if (current === undefined) {
        diffs.push({ field: '__record__', label: '整条记录', local: '保留修改', remote: '对方已删除' })
      }
    }
    if (diffs.length === 0) {
      // 对方又改回了与本地一致的值：自动闭环
      await db.changes.update(change.id, { status: 'merged' })
      return null
    }
    const remoteRows = changes.value
      .filter((item) => item.clientId !== clientId && item.table === change.table && item.recordId === change.recordId)
      .sort((a, b) => b.createdAt - a.createdAt)
    const remoteChange = remoteRows[0] ?? null
    return {
      key: `${change.table}:${change.recordId}`,
      table: change.table,
      recordId: change.recordId,
      recordLabel: change.recordLabel,
      remoteClientId: remoteChange?.clientId ?? '另一标签页',
      localChangeId: change.id,
      remoteChangeId: remoteChange?.id ?? '',
      diffs,
      resolutions: {},
      localKind: change.kind,
      remoteKind: current === undefined ? 'delete' : remoteChange?.kind ?? 'update',
      localFields: { ...change.nextFields },
      remoteFields: current ? { ...current } : {},
      baseFields: { ...change.baseFields },
      formulaId: change.formulaId,
      detectedAt: change.updatedAt
    }
  }

  /** 冲突中心数据（按待处理流水实时还原，按记录归组） */
  const pendingConflictKeys = computed<string[]>(() => myConflictChanges.value.map((change) => change.id))

  /** 冲突中心当前展示的条目：保存动作当场挂起的 + 由流水还原的 */
  const centerConflicts = ref<SyncConflict[]>([])

  /** 登记一条保存动作当场发现的冲突（按本地流水 id 去重） */
  function raiseConflict(conflict: SyncConflict): void {
    if (!raisedConflicts.value.some((item) => item.localChangeId === conflict.localChangeId)) {
      raisedConflicts.value = [...raisedConflicts.value, conflict]
    }
    centerConflicts.value = raisedConflicts.value
    centerVisible.value = true
  }

  /** 从流水还原全部待处理冲突，打开中心时调用 */
  async function loadCenterConflicts(): Promise<SyncConflict[]> {
    const hydrated: SyncConflict[] = []
    for (const change of myConflictChanges.value) {
      const conflict = await hydrateConflict(change)
      if (conflict) hydrated.push(conflict)
    }
    const seen = new Set(raisedConflicts.value.map((item) => item.localChangeId))
    centerConflicts.value = [...raisedConflicts.value, ...hydrated.filter((item) => !seen.has(item.localChangeId))]
    return centerConflicts.value
  }

  /** 冲突处理完 / 放弃后从内存队列移除 */
  function dismissConflict(localChangeId: string): void {
    raisedConflicts.value = raisedConflicts.value.filter((item) => item.localChangeId !== localChangeId)
    centerConflicts.value = centerConflicts.value.filter((item) => item.localChangeId !== localChangeId)
  }

  /** 冲突总条数（含内存与流水），用于状态栏红点 */
  const pendingConflictCount = computed(
    () => new Set([...raisedConflicts.value.map((c) => c.localChangeId), ...pendingConflictKeys.value]).size
  )

  function openCenter(): void {
    void loadCenterConflicts()
    centerVisible.value = true
  }

  function closeCenter(): void {
    centerVisible.value = false
  }

  async function setResolution(conflict: SyncConflict, field: string, resolution: SyncConflict['resolutions'][string]): Promise<void> {
    conflict.resolutions[field] = resolution
  }

  /** 逐项确认后入库；未逐项确认会抛错，调用方提示并保留草稿 */
  async function resolve(conflict: SyncConflict, formulaId?: string | null): Promise<{ applied: boolean }> {
    const result = await resolveConflictEngine(clientId, conflict, formulaId)
    dismissConflict(conflict.localChangeId)
    refreshOfflineCount()
    return { applied: result.applied }
  }

  /** 放弃本地草稿：仅关闭本地流水，对方改动原样保留 */
  async function discardLocal(conflict: SyncConflict): Promise<void> {
    const now = Date.now()
    await db.changes.update(conflict.localChangeId, { status: 'merged', updatedAt: now })
    dismissConflict(conflict.localChangeId)
  }

  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  async function reconcile(showReport = false): Promise<void> {
    const collected: SyncConflict[] = []
    const report = await reconcileClient(clientId, (conflict) => {
      collected.push(conflict)
    })
    refreshOfflineCount()
    if (showReport || report.merged > 0 || report.conflicts > 0) {
      lastReport.value = { merged: report.merged, conflicts: report.conflicts, at: Date.now() }
    }
    if (collected.length > 0) {
      collected.forEach((conflict) => raiseConflict(conflict))
    } else if (report.conflicts > 0) {
      centerVisible.value = true
    }
  }

  function scheduleReconcile(delay = 600): void {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      void reconcile()
    }, delay)
  }

  /** 浏览器在线 / 离线事件绑定（App.vue 挂载时调用一次） */
  function bindConnectivity(): void {
    window.addEventListener('online', () => {
      online.value = true
      void reconcile(true)
    })
    window.addEventListener('offline', () => {
      online.value = false
    })
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshOfflineCount()
        scheduleReconcile()
      }
    })
    // 任一标签页写入 changes（liveQuery 跨标签页实时推送）后，延迟对账一次：
    // 把对方已被本方知晓、且不与未决冲突重叠的流水标记 merged
    watch(
      () => changeTable.rows.value.length,
      () => scheduleReconcile(1200)
    )
    // 兜底：每 60 秒对账一次（长时间开着的标签页也能合入对方旧改动）
    setInterval(() => {
      if (isCoordinationOnline() && !document.hidden) void reconcile()
    }, 60_000)
  }

  /** 手动触发对账（状态栏按钮） */
  async function reconcileNow(): Promise<{ merged: number; conflicts: number } | null> {
    await reconcile(true)
    return lastReport.value
  }

  return {
    clientId,
    online,
    centerVisible,
    centerConflicts,
    raisedConflicts,
    lastReport,
    changes,
    ready,
    myConflictChanges,
    pendingConflictKeys,
    pendingConflictCount,
    offlineQueueCount,
    hydrateConflict,
    raiseConflict,
    loadCenterConflicts,
    dismissConflict,
    openCenter,
    closeCenter,
    setResolution,
    resolve,
    discardLocal,
    reconcile,
    reconcileNow,
    scheduleReconcile,
    bindConnectivity,
    refreshOfflineCount
  }
})
