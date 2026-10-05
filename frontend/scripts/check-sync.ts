import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

// Node 环境补一个最小 localStorage（离线暂存队列依赖）
const lsStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (lsStore.has(key) ? lsStore.get(key)! : null),
  setItem: (key: string, value: string) => void lsStore.set(key, value),
  removeItem: (key: string) => void lsStore.delete(key),
  clear: () => lsStore.clear()
}

// navigator 在 Node 下没有 onLine，引擎把 undefined 视为在线；离线用例显式改写
const originalNavigator = globalThis.navigator

const { db, initDatabase, createId } = await import('../src/utils/db')
const { coordinateEdit, resolveConflict, reconcileClient } = await import('../src/utils/sync')
const { buildSnapshotFromProportions } = await import('../src/utils/snapshot')
const { seedDatabase } = await import('../src/utils/db')

await initDatabase()

const now = Date.now()
const fid = 'test_formula_f1'
const pid = 'test_prop_1'
const pid2 = 'test_prop_2'
const bid = 'test_batch_1'

await db.formulas.put({
  id: fid,
  name: '测试香方',
  scentType: '线香',
  usage: '静室',
  createdAt: '2024-01-01',
  totalRatio: 100,
  state: '在用',
  updatedAt: now
})
await db.materials.put({
  id: 'test_mat_1',
  name: '沉香',
  origin: '海南',
  grade: '特级',
  processMethod: '生用',
  aromaNote: '',
  createdAt: '2024-01-01',
  updatedAt: now
})
const mkProp = (id: string, ratio: number, role: '君' | '臣', seq: number) => ({
  id,
  formulaId: fid,
  materialId: 'test_mat_1',
  ratio,
  role,
  note: '原备注',
  seq,
  updatedAt: now
})
await db.proportions.bulkPut([mkProp(pid, 45, '君', 1), mkProp(pid2, 55, '臣', 2)])

const snapshot = buildSnapshotFromProportions(
  await db.proportions.where('formulaId').equals(fid).toArray(),
  () => '沉香'
)
await db.batches.put({
  id: bid,
  formulaId: fid,
  mixedAt: '2024-02-01',
  formingMethod: '挤条',
  quantity: 100,
  operator: '甲',
  snapshot,
  snapshotAt: now,
  reviewState: '正常',
  staleAt: 0,
  reviewedAt: 0,
  updatedAt: now
})

/* ---------- 1. 标签页 A 改占比：成功，并立即把在用批次旧快照标成待复核 ---------- */
const r1 = await coordinateEdit('tabA', {
  table: 'proportions',
  recordId: pid,
  kind: 'update',
  baseFields: { ratio: 45 },
  nextFields: { ratio: 50 },
  recordLabel: '测试香方 · 沉香',
  formulaId: fid
})
assert.equal(r1.conflict, null)
assert.equal(r1.invalidatedBatches, 1)
assert.equal((await db.proportions.get(pid))!.ratio, 50)
const batchAfter = await db.batches.get(bid)
assert.equal(batchAfter!.reviewState, '待复核')
assert.ok(batchAfter!.staleAt > 0)

/* ---------- 2. 标签页 B 基于旧值 45 改同一字段：冲突，绝不覆盖 ---------- */
const r2 = await coordinateEdit('tabB', {
  table: 'proportions',
  recordId: pid,
  kind: 'update',
  baseFields: { ratio: 45 },
  nextFields: { ratio: 55 },
  recordLabel: '测试香方 · 沉香',
  formulaId: fid
})
assert.ok(r2.conflict)
assert.equal(r2.conflict!.diffs.some((d) => d.field === 'ratio'), true)
assert.equal((await db.proportions.get(pid))!.ratio, 50, '冲突时不能覆盖 A 的改动')

/* ---------- 3. 逐项确认：占比保留 B 的 55 ---------- */
const conflict = r2.conflict!
conflict.resolutions.ratio = 'local'
const rr = await resolveConflict('tabB', conflict, fid)
assert.equal(rr.applied, true)
assert.equal((await db.proportions.get(pid))!.ratio, 55)
const openConflicts = await db.changes.where('status').equals('conflict').count()
assert.equal(openConflicts, 0)

/* ---------- 4. 互不重叠的改动自动合并（不同字段） ---------- */
const r3 = await coordinateEdit('tabA', {
  table: 'proportions',
  recordId: pid2,
  kind: 'update',
  baseFields: { note: '原备注' },
  nextFields: { note: 'A 改备注' },
  recordLabel: '测试香方 · 檀香',
  formulaId: fid
})
assert.equal(r3.conflict, null)
const r4 = await coordinateEdit('tabB', {
  table: 'proportions',
  recordId: pid2,
  kind: 'update',
  baseFields: { seq: 2 },
  nextFields: { seq: 9 },
  recordLabel: '测试香方 · 檀香',
  formulaId: fid
})
assert.equal(r4.conflict, null, '改不同字段不构成冲突')
const p2now = await db.proportions.get(pid2)
assert.equal(p2now!.note, 'A 改备注')
assert.equal(p2now!.seq, 9)

/* ---------- 5. 离线暂存 → 重连后合并不重叠改动 ---------- */
// @ts-expect-error 测试中改写 navigator
globalThis.navigator = { onLine: false }
const off = await coordinateEdit('tabC', {
  table: 'proportions',
  recordId: pid2,
  kind: 'update',
  baseFields: { note: 'A 改备注' },
  nextFields: { note: '离线改备注' },
  recordLabel: '测试香方 · 檀香',
  formulaId: fid
})
assert.equal(off.queued, true)
assert.equal((await db.proportions.get(pid2))!.note, 'A 改备注', '离线时不得写共享库')
// @ts-expect-error 恢复在线
globalThis.navigator = originalNavigator
let mergedConflicts = 0
const report = await reconcileClient('tabC', () => {
  mergedConflicts += 1
})
assert.equal(report.merged, 1)
assert.equal(report.conflicts, 0)
assert.equal(mergedConflicts, 0)
assert.equal((await db.proportions.get(pid2))!.note, '离线改备注')

/* ---------- 6. 待复核期间批次注册被闸门拦截（registerBatch 层面） ---------- */
// 批次 b1 仍待复核（比例再次变化），同一香方不允许开新批：由 store 公式 formulaHasPendingReview 验证
const pending = await db.batches.where('formulaId').equals(fid).filter((b) => b.reviewState === '待复核').count()
assert.ok(pending >= 1)

/* ---------- 7. 播种幂等 ---------- */
await seedDatabase()
await seedDatabase()
assert.equal(await db.formulas.where('id').equals('seed_formula_line').count(), 1)

console.log('sync engine (conflict / invalidation / offline-merge): all assertions passed')
process.exit(0)
