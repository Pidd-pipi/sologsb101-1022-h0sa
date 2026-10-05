import { db } from '@/utils/db'
import type { Batch, BatchSnapshotItem } from '@/types/batch'
import type { Proportion } from '@/types/proportion'
import { round } from '@/utils/ratio'

/** 配比快照的「指纹」：按香料 id 汇总占比与君臣佐使 */
export interface SnapshotSignatureEntry {
  materialId: string
  ratio: number
  role: string
}

/** 把一组当前配比转成快照指纹（seq 升序） */
export function signatureOfProportions(proportions: Proportion[]): Map<string, SnapshotSignatureEntry> {
  const map = new Map<string, SnapshotSignatureEntry>()
  proportions
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .forEach((proportion) => {
      map.set(proportion.materialId, {
        materialId: proportion.materialId,
        ratio: round(proportion.ratio, 2),
        role: proportion.role
      })
    })
  return map
}

/** 把批次固化的旧快照转成指纹 */
export function signatureOfSnapshot(snapshot: BatchSnapshotItem[]): Map<string, SnapshotSignatureEntry> {
  const map = new Map<string, SnapshotSignatureEntry>()
  snapshot.forEach((item) => {
    map.set(item.materialId, {
      materialId: item.materialId,
      ratio: round(item.ratio, 2),
      role: item.role
    })
  })
  return map
}

/**
 * 旧快照与当前配比是否不一致：
 * 香料增减、占比变化、君臣佐使调整任一发生即判失效。
 */
export function isSnapshotStale(snapshot: BatchSnapshotItem[], current: Proportion[]): boolean {
  const oldMap = signatureOfSnapshot(snapshot)
  const newMap = signatureOfProportions(current)
  if (oldMap.size !== newMap.size) return true
  for (const [materialId, entry] of newMap) {
    const old = oldMap.get(materialId)
    if (!old) return true
    if (Math.abs(old.ratio - entry.ratio) > 0.01) return true
    if (old.role !== entry.role) return true
  }
  return false
}

/** 批次是否处于待复核（显式标记优先；旧数据缺失字段时按快照指纹补判） */
export function isBatchPendingReview(batch: Batch, current: Proportion[] | null): boolean {
  if (batch.reviewState === '待复核') return true
  if (!current) return false
  if (!Array.isArray(batch.snapshot) || batch.snapshot.length === 0) return false
  return isSnapshotStale(batch.snapshot, current)
}

/** 列出旧快照与当前配比的逐项差异，供批次页与复核入口展示 */
export interface SnapshotDiffItem {
  materialId: string
  materialName: string
  /** added=新方新增 / removed=已从方中移除 / ratio=占比变化 / role=君臣佐使变化 / same=一致 */
  kind: 'added' | 'removed' | 'changed' | 'same'
  oldRatio: number | null
  newRatio: number | null
  oldRole: string | null
  newRole: string | null
}

export function diffSnapshot(batch: Batch, current: Proportion[], nameOf: (id: string) => string): SnapshotDiffItem[] {
  const oldMap = signatureOfSnapshot(batch.snapshot)
  const newMap = signatureOfProportions(current)
  const ids = Array.from(new Set([...oldMap.keys(), ...newMap.keys()]))
  return ids.map((materialId) => {
    const old = oldMap.get(materialId) ?? null
    const now = newMap.get(materialId) ?? null
    const name = nameOf(materialId)
    if (!old && now) {
      return {
        materialId,
        materialName: name,
        kind: 'added',
        oldRatio: null,
        newRatio: now.ratio,
        oldRole: null,
        newRole: now.role
      }
    }
    if (old && !now) {
      return {
        materialId,
        materialName: old ? pickSnapshotName(batch, materialId) ?? name : name,
        kind: 'removed',
        oldRatio: old.ratio,
        newRatio: null,
        oldRole: old.role,
        newRole: null
      }
    }
    const ratioChanged = old && now ? Math.abs(old.ratio - now.ratio) > 0.01 : false
    const roleChanged = old && now ? old.role !== now.role : false
    return {
      materialId,
      materialName: pickSnapshotName(batch, materialId) ?? name,
      kind: ratioChanged || roleChanged ? 'changed' : 'same',
      oldRatio: old?.ratio ?? null,
      newRatio: now?.ratio ?? null,
      oldRole: old?.role ?? null,
      newRole: now?.role ?? null
    }
  })
}

function pickSnapshotName(batch: Batch, materialId: string): string | null {
  return batch.snapshot.find((item) => item.materialId === materialId)?.materialName ?? null
}

/** 支持批次写入的最小结构：Dexie 事务与数据库实例都满足 */
export interface BatchWriter {
  table<T>(name: string): import('dexie').Table<T, string>
}

/**
 * 香方配比改动后：把该香方名下「在用」（已有非空快照）的批次旧快照立即标成待复核。
 * 在 Dexie 事务内调用，随配比写入一起提交。
 */
export async function invalidateBatchesOfFormula(
  target: BatchWriter,
  formulaId: string,
  now: number
): Promise<number> {
  const batchesTable = target.table<Batch>('batches')
  const batches = await batchesTable.where('formulaId').equals(formulaId).toArray()
  let count = 0
  for (const batch of batches) {
    if (!Array.isArray(batch.snapshot) || batch.snapshot.length === 0) continue
    if (batch.reviewState === '待复核') continue
    await batchesTable.update(batch.id, {
      reviewState: '待复核',
      staleAt: batch.staleAt || now,
      reviewedAt: 0,
      updatedAt: now
    })
    count += 1
  }
  return count
}

/** 由当前配比生成批次快照条目 */
export function buildSnapshotFromProportions(
  proportions: Proportion[],
  nameOf: (id: string) => string
): BatchSnapshotItem[] {
  return proportions
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((proportion) => ({
      materialId: proportion.materialId,
      materialName: nameOf(proportion.materialId),
      ratio: round(proportion.ratio, 2),
      role: proportion.role
    }))
}

/**
 * 导入 / 升级旧档案后按指纹补版本：
 * 快照与当前配比不一致且尚未复核的批次统一标成待复核，避免导入后错按新配比出窖。
 */
export async function reconcileImportedReviewStates(
  proportionsByFormula: Map<string, Proportion[]>,
  now: number
): Promise<number> {
  const batches = await db.batches.toArray()
  let count = 0
  for (const batch of batches) {
    const wantPending =
      batch.reviewState === '待复核' ||
      (Array.isArray(batch.snapshot) &&
        batch.snapshot.length > 0 &&
        isSnapshotStale(batch.snapshot, proportionsByFormula.get(batch.formulaId) ?? []))
    if (wantPending && batch.reviewState !== '待复核') {
      await db.batches.update(batch.id, { reviewState: '待复核', staleAt: batch.staleAt || now, updatedAt: now })
      count += 1
    }
    if (!wantPending && (batch as Partial<Batch>).reviewState === undefined) {
      await db.batches.update(batch.id, { reviewState: '正常', staleAt: 0, reviewedAt: 0 })
    }
  }
  return count
}
