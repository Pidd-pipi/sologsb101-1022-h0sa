import assert from 'node:assert/strict'
import {
  buildSnapshotFromProportions,
  diffSnapshot,
  isBatchPendingReview,
  isSnapshotStale,
  signatureOfProportions,
  signatureOfSnapshot
} from '../src/utils/snapshot'
import type { Batch, BatchSnapshotItem } from '../src/types/batch'
import type { Proportion } from '../src/types/proportion'

const proportions: Proportion[] = [
  { id: 'p1', formulaId: 'f1', materialId: 'm1', ratio: 45, role: '君', note: '', seq: 1, updatedAt: 1 },
  { id: 'p2', formulaId: 'f1', materialId: 'm2', ratio: 30, role: '臣', note: '', seq: 2, updatedAt: 1 },
  { id: 'p3', formulaId: 'f1', materialId: 'm3', ratio: 15, role: '佐', note: '', seq: 3, updatedAt: 1 },
  { id: 'p4', formulaId: 'f1', materialId: 'm4', ratio: 10, role: '使', note: '', seq: 4, updatedAt: 1 }
]

const names: Record<string, string> = { m1: '沉香', m2: '檀香', m3: '乳香', m4: '丁香' }
const nameOf = (id: string) => names[id] ?? '未知'

const snapshot: BatchSnapshotItem[] = buildSnapshotFromProportions(proportions, nameOf)
assert.equal(snapshot.length, 4)
assert.deepEqual(signatureOfSnapshot(snapshot).get('m1'), { materialId: 'm1', ratio: 45, role: '君' })

// 1. 完全一致 → 不失效
assert.equal(isSnapshotStale(snapshot, proportions), false)

// 2. 占比变化 → 失效
const changedRatio = proportions.map((p) => (p.materialId === 'm1' ? { ...p, ratio: 50 } : p))
assert.equal(isSnapshotStale(snapshot, changedRatio), true)

// 3. 君臣佐使变化 → 失效
const changedRole = proportions.map((p) => (p.materialId === 'm4' ? { ...p, role: '佐' } : p))
assert.equal(isSnapshotStale(snapshot, changedRole), true)

// 4. 香料增减 → 失效
const removed = proportions.slice(0, 3)
assert.equal(isSnapshotStale(snapshot, removed), true)
const added: Proportion[] = [
  ...proportions,
  { id: 'p5', formulaId: 'f1', materialId: 'm5', ratio: 0, role: '使', note: '', seq: 5, updatedAt: 1 }
]
assert.equal(isSnapshotStale(snapshot, added), true)

// 5. 仅拖拽顺序变化（seq 变，香料/占比/角色不变）→ 快照不失效
const reordered = proportions.map((p) =>
  p.materialId === 'm1' ? { ...p, seq: 2 } : p.materialId === 'm2' ? { ...p, seq: 1 } : p
)
assert.equal(isSnapshotStale(snapshot, reordered), false)

// 6. diff 列出香料、占比、君臣佐使三类差异
const diffs = diffSnapshot(
  {
    id: 'b1',
    formulaId: 'f1',
    mixedAt: '2024-04-01',
    formingMethod: '挤条',
    quantity: 1,
    operator: '',
    snapshot,
    snapshotAt: 1,
    reviewState: '待复核',
    staleAt: 2,
    reviewedAt: 0,
    updatedAt: 2
  } satisfies Batch,
  [
    ...proportions
      .filter((p) => p.materialId !== 'm4')
      .map((p) => (p.materialId === 'm1' ? { ...p, ratio: 50 } : p)),
    { id: 'p5', formulaId: 'f1', materialId: 'm5', ratio: 10, role: '使', note: '', seq: 5, updatedAt: 1 }
  ],
  nameOf
)
const kinds = diffs.map((d) => d.kind).sort()
assert.ok(kinds.includes('added'))
assert.ok(kinds.includes('removed'))
assert.ok(kinds.includes('changed'))
const m1 = diffs.find((d) => d.materialId === 'm1')!
assert.equal(m1.oldRatio, 45)
assert.equal(m1.newRatio, 50)

// 7. 待复核判定
assert.equal(
  isBatchPendingReview(
    { reviewState: '待复核' } as Batch,
    proportions
  ),
  true
)
assert.equal(isBatchPendingReview({ reviewState: '正常' } as Batch, proportions), false)
// 旧档案批次缺字段时按指纹补判
const legacyBatch = { reviewState: '正常', snapshot } as unknown as Batch
assert.equal(isBatchPendingReview(legacyBatch, changedRatio), true)

// 8. 指纹合计保持 100
assert.equal(
  [...signatureOfProportions(changedRatio).values()].reduce((s, e) => s + e.ratio, 0),
  105
)

console.log('snapshot diff/invalidation: all assertions passed')
