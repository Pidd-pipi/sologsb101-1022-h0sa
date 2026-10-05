import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

const lsStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (lsStore.has(key) ? lsStore.get(key)! : null),
  setItem: (key: string, value: string) => void lsStore.set(key, value),
  removeItem: (key: string) => void lsStore.delete(key),
  clear: () => lsStore.clear()
}

// 先以 v2 结构打开库并写入「旧档案」：批次没有 reviewState/staleAt/reviewedAt，
// 且旧快照与当前配比不一致（模拟改方后、升级前的档案）
const Dexie = (await import('dexie')).default

class LegacyDb extends Dexie {
  formulas!: import('dexie').Table<any, string>
  materials!: import('dexie').Table<any, string>
  proportions!: import('dexie').Table<any, string>
  batches!: import('dexie').Table<any, string>
  cellars!: import('dexie').Table<any, string>
  tastings!: import('dexie').Table<any, string>
  constructor() {
    super('gbincense')
    this.version(2).stores({
      formulas: 'id, name, scentType, usage, state, createdAt, totalRatio, updatedAt',
      materials: 'id, name, origin, grade, processMethod, updatedAt',
      proportions: 'id, formulaId, materialId, role, seq, updatedAt',
      batches: 'id, formulaId, mixedAt, formingMethod, updatedAt',
      cellars: 'id, batchId, startDate, endDate, state, updatedAt',
      tastings: 'id, batchId, tastedAt, smokeScore, updatedAt'
    })
  }
}

const legacy = new LegacyDb()
const now = Date.now()
await legacy.formulas.put({
  id: 'f1',
  name: '旧档案香方',
  scentType: '线香',
  usage: '静室',
  createdAt: '2024-01-01',
  totalRatio: 100,
  state: '在用',
  updatedAt: now
})
await legacy.proportions.bulkPut([
  { id: 'p1', formulaId: 'f1', materialId: 'm1', ratio: 50, role: '君', note: '', seq: 1, updatedAt: now },
  { id: 'p2', formulaId: 'f1', materialId: 'm2', ratio: 50, role: '臣', note: '', seq: 2, updatedAt: now }
])
// 旧批次：快照是 45/55，与当前 50/50 不一致 → 升级后必须待复核
await legacy.batches.put({
  id: 'b_stale',
  formulaId: 'f1',
  mixedAt: '2024-02-01',
  formingMethod: '挤条',
  quantity: 100,
  operator: '甲',
  snapshot: [
    { materialId: 'm1', materialName: '沉香', ratio: 45, role: '君' },
    { materialId: 'm2', materialName: '檀香', ratio: 55, role: '臣' }
  ],
  snapshotAt: now,
  updatedAt: now
})
// 旧批次：快照与当前一致 → 升级后保持正常
await legacy.batches.put({
  id: 'b_fresh',
  formulaId: 'f1',
  mixedAt: '2024-03-01',
  formingMethod: '手搓',
  quantity: 10,
  operator: '乙',
  snapshot: [
    { materialId: 'm1', materialName: '沉香', ratio: 50, role: '君' },
    { materialId: 'm2', materialName: '檀香', ratio: 50, role: '臣' }
  ],
  snapshotAt: now,
  updatedAt: now
})
await legacy.close()

// 用新版 db 重新打开，触发 v2 → v3 升级
const { db } = await import('@/utils/db')
await db.open()

const stale = await db.batches.get('b_stale')
assert.equal(stale!.reviewState, '待复核', '旧快照与当前配比不一致的批次必须升级为待复核')
assert.ok(stale!.staleAt! > 0)
assert.equal(stale!.reviewedAt, 0)
assert.equal(stale!.snapshot.length, 2, '旧快照本身保留不被覆盖')
assert.equal(stale!.snapshot[0].ratio, 45)

const fresh = await db.batches.get('b_fresh')
assert.equal(fresh!.reviewState, '正常')
assert.equal(fresh!.staleAt, 0)

// changes 表已建立可写
await db.changes.put({
  id: 'c1',
  clientId: 'tabX',
  table: 'formulas',
  recordId: 'f1',
  kind: 'update',
  baseFields: {},
  nextFields: { state: '停用' },
  recordLabel: '旧档案香方',
  formulaId: 'f1',
  status: 'pending',
  offline: false,
  createdAt: now,
  updatedAt: now
})
assert.equal(await db.changes.count(), 1)

// 版本号已递增到 3
const { DB_VERSION } = await import('@/utils/db')
assert.equal(DB_VERSION, 3)

console.log('db v2→v3 upgrade (version + stale snapshot marking): all assertions passed')
process.exit(0)
