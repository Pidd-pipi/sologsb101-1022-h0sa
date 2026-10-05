/**
 * 配比三方合并与快照比对（纯函数，不依赖 Vue / Dexie）。
 *
 * 同一浏览器的多个标签页共享同一个 IndexedDB：任一方写入后，
 * 另一方在提交前都能读到「对方已提交版本」。据此做 3-way merge：
 *   base   = 双方上次一致的共同祖先
 *   ours   = 本标签页想写入的草稿
 *   theirs = 对方标签页已提交的版本（提交当刻读库）
 * 互不重叠的改动自动合并；同一字段双方都改且结果不一致 → 保留待逐项确认。
 */
import type { Proportion, ProportionRole } from '@/types/proportion'
import type { BatchSnapshotItem } from '@/types/batch'
import type { RowConflict, RowFieldSnapshot } from '@/types/collab'
import { round } from '@/utils/ratio'

export interface MergeResult {
  /** 无分歧、可直接落库的行（已含自动合并项） */
  rows: Proportion[]
  /** 需要逐项确认的分歧行 */
  conflicts: RowConflict[]
}

export type ContentField = 'ratio' | 'role' | 'note'

const normRatio = (value: number): number => round(value, 2)
const normNote = (value: string): string => (value ?? '').trim()

function snapshotOf(row: Proportion, nameOf: (materialId: string) => string): RowFieldSnapshot {
  return {
    materialId: row.materialId,
    materialName: nameOf(row.materialId),
    ratio: normRatio(row.ratio),
    role: row.role,
    note: normNote(row.note)
  }
}

/** 两行之间产生变化的内容字段（香料身份以 materialId 对齐，不在此字段范围内） */
export function changedFields(a: Proportion | undefined, b: Proportion | undefined): ContentField[] {
  if (!a || !b) return ['ratio', 'role', 'note']
  const fields: ContentField[] = []
  if (normRatio(a.ratio) !== normRatio(b.ratio)) fields.push('ratio')
  if (a.role !== b.role) fields.push('role')
  if (normNote(a.note) !== normNote(b.note)) fields.push('note')
  return fields
}

function fieldValue(row: Proportion, field: ContentField): number | ProportionRole | string {
  if (field === 'ratio') return normRatio(row.ratio)
  if (field === 'role') return row.role
  return normNote(row.note)
}

function sameContent(a: Proportion, b: Proportion): boolean {
  return changedFields(a, b).length === 0
}

/**
 * 合并双方都修改过的同一行：取本方改的字段 + 对方改的字段。
 * 仅当双方改动互不重叠时调用（重叠且不一致会进入 conflicts）。
 */
function mergeRowFields(ours: Proportion, theirs: Proportion, base: Proportion): Proportion {
  const oCh = changedFields(base, ours)
  const tCh = changedFields(base, theirs)
  const merged: Proportion = { ...base }
  oCh.forEach((field) => {
    if (field === 'ratio') merged.ratio = ours.ratio
    else if (field === 'role') merged.role = ours.role
    else merged.note = ours.note
  })
  tCh.forEach((field) => {
    if (field === 'ratio') merged.ratio = theirs.ratio
    else if (field === 'role') merged.role = theirs.role
    else merged.note = theirs.note
  })
  merged.ratio = normRatio(merged.ratio)
  merged.note = normNote(merged.note)
  return merged
}

/**
 * 配比三方合并。seq（拖拽编排顺序）不纳入内容冲突：
 * 顺序以对方已提交版本为主线，本方新增行追加到末尾。
 */
export function mergeProportionSets(
  base: Proportion[],
  ours: Proportion[],
  theirs: Proportion[],
  nameOf: (materialId: string) => string
): MergeResult {
  const baseM = new Map(base.map((row) => [row.materialId, row]))
  const oursM = new Map(ours.map((row) => [row.materialId, row]))
  const theirsM = new Map(theirs.map((row) => [row.materialId, row]))
  const keys = new Set<string>([...baseM.keys(), ...oursM.keys(), ...theirsM.keys()])

  const auto: Proportion[] = []
  const conflicts: RowConflict[] = []
  const pushAuto = (row: Proportion | undefined): void => {
    if (row) auto.push(row)
  }

  keys.forEach((key) => {
    const b = baseM.get(key)
    const o = oursM.get(key)
    const t = theirsM.get(key)
    const inBase = Boolean(b)
    const inOurs = Boolean(o)
    const inTheirs = Boolean(t)
    const name = nameOf(key)

    if (inBase && inOurs && inTheirs) {
      const oCh = changedFields(b, o)
      const tCh = changedFields(b, t)
      if (oCh.length === 0 && tCh.length === 0) {
        pushAuto(t)
        return
      }
      if (oCh.length === 0) {
        pushAuto(t)
        return // 仅对方改动
      }
      if (tCh.length === 0) {
        pushAuto(o)
        return // 仅本方改动
      }
      // 双方都改：找出取值不一致的分歧字段
      const oursRow = o as Proportion
      const theirsRow = t as Proportion
      const clash = oCh.filter(
        (field) => tCh.includes(field) && fieldValue(oursRow, field) !== fieldValue(theirsRow, field)
      )
      if (clash.length === 0) {
        pushAuto(mergeRowFields(oursRow, theirsRow, b as Proportion))
        return // 改动互不重叠（或结果一致）→ 字段级自动合并
      }
      conflicts.push({
        key,
        materialId: key,
        materialName: name,
        kind: 'field',
        base: snapshotOf(b as Proportion, nameOf),
        ours: snapshotOf(o as Proportion, nameOf),
        theirs: snapshotOf(t as Proportion, nameOf),
        changedFields: clash,
        oursRow: o,
        theirsRow: t
      })
      return
    }

    if (!inBase && inOurs && inTheirs) {
      // 双方都新增同一香料
      if (sameContent(o as Proportion, t as Proportion)) {
        pushAuto(t)
        return
      }
      conflicts.push({
        key,
        materialId: key,
        materialName: name,
        kind: 'add',
        ours: snapshotOf(o as Proportion, nameOf),
        theirs: snapshotOf(t as Proportion, nameOf),
        changedFields: changedFields(o, t),
        oursRow: o,
        theirsRow: t
      })
      return
    }

    if (!inBase && inOurs && !inTheirs) {
      pushAuto(o)
      return // 本方新增，对方未碰
    }
    if (!inBase && !inOurs && inTheirs) {
      pushAuto(t)
      return // 对方新增，本方未碰
    }

    if (inBase && inOurs && !inTheirs) {
      // 对方删除，本方保留 / 修改
      const oCh = changedFields(b, o)
      if (oCh.length === 0) return // 本方未改 → 接受删除
      conflicts.push({
        key,
        materialId: key,
        materialName: name,
        kind: 'remove',
        base: snapshotOf(b as Proportion, nameOf),
        ours: snapshotOf(o as Proportion, nameOf),
        changedFields: oCh,
        oursRow: o
      })
      return
    }
    if (inBase && !inOurs && inTheirs) {
      // 本方删除，对方保留 / 修改
      const tCh = changedFields(b, t)
      if (tCh.length === 0) return
      conflicts.push({
        key,
        materialId: key,
        materialName: name,
        kind: 'remove',
        base: snapshotOf(b as Proportion, nameOf),
        theirs: snapshotOf(t as Proportion, nameOf),
        changedFields: tCh,
        theirsRow: t
      })
      return
    }
    // inBase && !inOurs && !inTheirs：双方都删除，跳过
  })

  // 以对方已提交顺序为主线，本方新增行追加到末尾
  auto.sort((a, b) => {
    const seqA = theirsM.get(a.materialId)?.seq ?? Number.MAX_SAFE_INTEGER
    const seqB = theirsM.get(b.materialId)?.seq ?? Number.MAX_SAFE_INTEGER
    return seqA - seqB
  })

  return { rows: auto, conflicts }
}

/** 由自动合并行 + 逐项选择结果组装最终配比，并重排 seq */
export function resolveConflictRows(
  autoMerged: Proportion[],
  conflicts: RowConflict[],
  theirs: Proportion[]
): Proportion[] {
  const choiceOf = new Map(conflicts.map((c) => [c.materialId, c.choice ?? 'ours']))
  const autoByKey = new Map(autoMerged.map((row) => [row.materialId, row]))
  const finalRows: Proportion[] = []

  // 以对方已提交顺序为主线
  theirs.forEach((t) => {
    const choice = choiceOf.get(t.materialId)
    if (choice) {
      const conflict = conflicts.find((c) => c.materialId === t.materialId)
      const row = choice === 'ours' ? conflict?.oursRow : conflict?.theirsRow
      if (row) finalRows.push({ ...row })
    } else if (autoByKey.has(t.materialId)) {
      finalRows.push({ ...(autoByKey.get(t.materialId) as Proportion) })
    }
  })

  // 本方新增（对方没有）的行追加到末尾
  autoMerged.forEach((row) => {
    if (!theirs.some((t) => t.materialId === row.materialId)) {
      finalRows.push({ ...row })
    }
  })

  return finalRows.map((row, index) => ({ ...row, seq: index + 1 }))
}

/** 内容指纹：用于判断配比自上次观察后是否被改写（不含 seq 编排顺序） */
export function fingerprint(rows: Proportion[]): string {
  const normalized = rows
    .map((row) => `${row.materialId}|${normRatio(row.ratio)}|${row.role}|${normNote(row.note)}`)
    .sort()
    .join(';;')
  return normalized
}

/** 批次快照是否与当前配比一致（按 materialId 比对占比与君臣佐使） */
export function snapshotMatches(snapshot: BatchSnapshotItem[], current: Proportion[]): boolean {
  if (snapshot.length !== current.length) return false
  const currentM = new Map(current.map((row) => [row.materialId, row]))
  return snapshot.every((item) => {
    const row = currentM.get(item.materialId)
    if (!row) return false
    return normRatio(item.ratio) === normRatio(row.ratio) && item.role === row.role
  })
}

/** 由当前配比构建快照条目 */
export function buildSnapshotItems(
  rows: Proportion[],
  nameOf: (materialId: string) => string
): BatchSnapshotItem[] {
  return [...rows]
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      materialId: row.materialId,
      materialName: nameOf(row.materialId),
      ratio: normRatio(row.ratio),
      role: row.role
    }))
}
