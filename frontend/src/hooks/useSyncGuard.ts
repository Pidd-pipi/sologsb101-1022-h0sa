import { useSyncStore } from '@/stores/syncStore'
import {
  coordinateBatch,
  type CoordinateBatchOutcome
} from '@/utils/sync'
import type { LocalEditInput, SyncConflict } from '@/types/sync'

export interface GuardResult {
  /** 是否有冲突：为 true 时业务数据一条都未写入，草稿保留 */
  conflicts: SyncConflict[]
  /** 是否离线暂存（未写共享库，重连后自动合并） */
  queued: boolean
  applied: number
  invalidatedBatches: number
}

/**
 * useSyncGuard：页面保存动作统一通过它写入共享 IndexedDB。
 * - 在线且不冲突 → 落库，配比类改动同时把在用批次旧快照标成待复核；
 * - 在线但与另一标签页改动重叠 → 不写入，冲突挂到冲突中心逐项确认；
 * - 离线 → 只进本标签页暂存队列，绝不覆盖对方改动。
 */
export function useSyncGuard() {
  const syncStore = useSyncStore()

  async function run(inputs: LocalEditInput[]): Promise<GuardResult> {
    const outcome: CoordinateBatchOutcome = await coordinateBatch(syncStore.clientId, inputs)
    outcome.conflicts.forEach((conflict) => syncStore.raiseConflict(conflict))
    if (outcome.applied > 0 || outcome.conflicts.length > 0) syncStore.refreshOfflineCount()
    return {
      conflicts: outcome.conflicts,
      queued: outcome.queued > 0,
      applied: outcome.applied,
      invalidatedBatches: outcome.invalidatedBatches
    }
  }

  /** 单条保存的便捷封装 */
  function save(input: LocalEditInput): Promise<GuardResult> {
    return run([input])
  }

  return { run, save, clientId: syncStore.clientId }
}
