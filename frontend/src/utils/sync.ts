import type { Transaction } from 'dexie'
import { db, createId } from '@/utils/db'
import { invalidateBatchesOfFormula } from '@/utils/snapshot'
import type {
  ChangeKind,
  CoordinateResult,
  LocalEditInput,
  ReconcileReport,
  SyncChange,
  SyncConflict,
  SyncFieldDiff,
  SyncTableName
} from '@/types/sync'

/* ---------------------------------- 标签页身份 ---------------------------------- */

const CLIENT_ID_KEY = 'gbincense:sync:client-id'

/** 本标签页身份：sessionStorage 随标签页隔离，刷新同一标签页仍保持同一身份 */
export function ensureClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY)
  if (existing) return existing
  const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  sessionStorage.setItem(CLIENT_ID_KEY, id)
  return id
}

/* ---------------------------------- 字段文案 ---------------------------------- */

/** 各表字段中文名，冲突中心逐项列出「香料 / 占比 / 君臣佐使」差异时使用 */
export const SYNC_FIELD_LABELS: Record<SyncTableName, Record<string, string>> = {
  formulas: {
    name: '香方名',
    scentType: '香型',
    usage: '用途',
    state: '状态',
    totalRatio: '配比合计',
    createdAt: '创方日期'
  },
  materials: {
    name: '香料名',
    origin: '产地',
    grade: '等级',
    processMethod: '炮制方式',
    aromaNote: '香气特征'
  },
  proportions: {
    formulaId: '所属香方',
    materialId: '香料',
    ratio: '占比%',
    role: '君臣佐使',
    note: '备注',
    seq: '编排序号'
  },
  batches: {
    formulaId: '所属香方',
    mixedAt: '和香日期',
    formingMethod: '成型方式',
    quantity: '数量',
    operator: '制香人',
    snapshot: '配比快照',
    reviewState: '复核状态',
    snapshotAt: '快照时间'
  },
  cellars: {
    batchId: '关联批次',
    startDate: '入窖日期',
    endDate: '出窖日期',
    temperatureC: '温度℃',
    humidityPct: '湿度%',
    container: '容器',
    state: '窖藏状态'
  },
  tastings: {
    batchId: '关联批次',
    tastedAt: '品鉴日期',
    aroma: '香韵',
    lastingMin: '留香分钟',
    smokeScore: '烟气评分',
    comment: '评语'
  }
}

export function fieldLabel(table: SyncTableName, field: string): string {
  return SYNC_FIELD_LABELS[table]?.[field] ?? field
}

/* ---------------------------------- 离线队列 ---------------------------------- */

const offlineQueueKey = (clientId: string): string => `gbincense:sync:offline-queue:${clientId}`

/** 标签页协同是否在线：浏览器离线时改动只进本地暂存队列，重连后再合并 */
export function isCoordinationOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

interface QueuedEdit extends LocalEditInput {
  queuedAt: number
}

export function readOfflineQueue(clientId: string): QueuedEdit[] {
  try {
    const raw = localStorage.getItem(offlineQueueKey(clientId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as QueuedEdit[]) : []
  } catch {
    return []
  }
}

function writeOfflineQueue(clientId: string, queue: QueuedEdit[]): void {
  if (queue.length === 0) localStorage.removeItem(offlineQueueKey(clientId))
  else localStorage.setItem(offlineQueueKey(clientId), JSON.stringify(queue))
}

/** 离线期间把改动暂存在本标签页：绝不写共享库，绝不覆盖对方改动 */
export function enqueueOfflineEdit(clientId: string, input: LocalEditInput): void {
  const queue = readOfflineQueue(clientId)
  queue.push({ ...input, queuedAt: Date.now() })
  writeOfflineQueue(clientId, queue)
}

function dropQueuedEdit(clientId: string, index: number): void {
  const queue = readOfflineQueue(clientId)
  queue.splice(index, 1)
  writeOfflineQueue(clientId, queue)
}

/* ---------------------------------- 通用表访问 ---------------------------------- */

/** 删除业务记录时的级联清理，冲突解决选择「本地删除」时同样执行 */
async function cascadeDelete(tx: Transaction, table: SyncTableName, recordId: string): Promise<void> {
  if (table === 'proportions' || table === 'materials' || table === 'formulas') {
    if (table === 'materials') {
      const ids = await tx.table('proportions').where('materialId').equals(recordId).primaryKeys()
      await tx.table('proportions').bulkDelete(ids as string[])
    }
    if (table === 'formulas') {
      const batchIds = (await tx.table('batches').where('formulaId').equals(recordId).primaryKeys()) as string[]
      if (batchIds.length > 0) {
        await tx.table('cellars').where('batchId').anyOf(batchIds).delete()
        await tx.table('tastings').where('batchId').anyOf(batchIds).delete()
      }
      await tx.table('batches').where('formulaId').equals(recordId).delete()
      await tx.table('proportions').where('formulaId').equals(recordId).delete()
    }
    await tx.table(table).delete(recordId)
    return
  }
  if (table === 'batches') {
    await tx.table('cellars').where('batchId').equals(recordId).delete()
    await tx.table('tastings').where('batchId').equals(recordId).delete()
    await tx.table('batches').delete(recordId)
    return
  }
  await tx.table(table).delete(recordId)
}

async function applyEdit(
  tx: Transaction,
  input: LocalEditInput,
  current: Record<string, unknown> | undefined,
  now: number
): Promise<void> {
  const tbl = tx.table(input.table)
  const kind = input.kind ?? 'update'
  if (kind === 'delete') {
    await cascadeDelete(tx, input.table, input.recordId)
    return
  }
  if (kind === 'create') {
    await tbl.put({ id: input.recordId, ...input.nextFields, updatedAt: now } as Record<string, unknown>)
    return
  }
  if (current === undefined) {
    // 记录已被对方删除：update / review 退化为一次创建，避免更新丢失
    await tbl.put({ id: input.recordId, ...input.nextFields, updatedAt: now } as Record<string, unknown>)
    return
  }
  await tbl.update(input.recordId, { ...input.nextFields, updatedAt: now } as Record<string, unknown>)
}

/* ---------------------------------- 冲突检测 ---------------------------------- */

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // 快照等结构化字段按 JSON 比较
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

/** 取对方标签页最近一条针对该记录的改动流水（用于冲突署名） */
async function latestRemoteChange(
  tx: Transaction,
  clientId: string,
  table: SyncTableName,
  recordId: string
): Promise<SyncChange | null> {
  const rows = await tx
    .table<SyncChange>('changes')
    .where('[table+recordId]')
    .equals([table, recordId])
    .toArray()
  const remote = rows
    .filter((change) => change.clientId !== clientId && change.status !== 'merged')
    .sort((a, b) => b.createdAt - a.createdAt)
  return remote[0] ?? null
}

/**
 * 对比本地草稿与对方已入库的值：只在本地实际触及的字段上找差异，
 * 香料、占比、君臣佐使逐项列出。
 */
function buildFieldDiffs(input: LocalEditInput, current: Record<string, unknown>): SyncFieldDiff[] {
  const diffs: SyncFieldDiff[] = []
  Object.keys(input.nextFields).forEach((field) => {
    if (field === 'updatedAt') return
    const localValue = input.nextFields[field]
    const remoteValue = current[field]
    if (!sameValue(localValue, remoteValue)) {
      diffs.push({ field, label: fieldLabel(input.table, field), local: localValue, remote: remoteValue })
    }
  })
  return diffs
}

function buildConflict(params: {
  input: LocalEditInput
  current: Record<string, unknown> | undefined
  remoteChange: SyncChange | null
  localChangeId: string
  diffs: SyncFieldDiff[]
}): SyncConflict {
  const { input, current, remoteChange, localChangeId, diffs } = params
  const kind = input.kind ?? 'update'
  const localFields = kind === 'delete' ? {} : { ...input.nextFields }
  const remoteFields = current ? { ...current } : {}
  return {
    key: `${input.table}:${input.recordId}`,
    table: input.table,
    recordId: input.recordId,
    recordLabel: input.recordLabel,
    remoteClientId: remoteChange?.clientId ?? '另一标签页',
    localChangeId,
    remoteChangeId: remoteChange?.id ?? '',
    diffs,
    resolutions: {},
    localKind: kind,
    remoteKind: current === undefined ? 'delete' : remoteChange?.kind ?? 'update',
    localFields,
    remoteFields,
    baseFields: { ...(input.baseFields ?? {}) },
    formulaId: input.formulaId ?? null,
    detectedAt: Date.now()
  }
}

/* ---------------------------------- 协调写入 ---------------------------------- */

export interface CoordinateOutcome extends CoordinateResult {
  /** 离线时进入本标签页暂存队列，未写共享库 */
  queued: boolean
  /** 实际失效（标成待复核）的在用批次数 */
  invalidatedBatches: number
}

/**
 * 协调一次本地改动（多条记录的便捷封装，见 coordinateBatch）。
 */
export async function coordinateEdit(clientId: string, input: LocalEditInput): Promise<CoordinateOutcome> {
  const outcome = await coordinateBatch(clientId, [input])
  return {
    conflict: outcome.conflicts[0] ?? null,
    change: null,
    queued: outcome.queued > 0,
    invalidatedBatches: outcome.invalidatedBatches
  }
}

export interface CoordinateBatchOutcome {
  conflicts: SyncConflict[]
  /** 离线进入暂存队列的条数 */
  queued: number
  applied: number
  invalidatedBatches: number
}

/**
 * 协调一组本地改动（同一香方的批量缩放 / 拖拽排序 / 清空使用）：
 * - 任一记录与对方改动冲突，则整组不入库，只挂冲突待逐项确认，避免半批写入破坏合计；
 * - 全部不冲突时在同一事务内提交，并把在用批次旧快照标成待复核。
 */
export async function coordinateBatch(
  clientId: string,
  inputs: LocalEditInput[]
): Promise<CoordinateBatchOutcome> {
  const outcome: CoordinateBatchOutcome = { conflicts: [], queued: 0, applied: 0, invalidatedBatches: 0 }
  if (inputs.length === 0) return outcome

  if (!isCoordinationOnline()) {
    inputs.forEach((input) => enqueueOfflineEdit(clientId, input))
    outcome.queued = inputs.length
    return outcome
  }

  const now = Date.now()
  const tableNames = Array.from(new Set(inputs.map((input) => input.table)))
  // 配比类改动需要在同一事务内把相关香方在用批次的旧快照标成待复核
  const touchesProportions = inputs.some((input) => input.table === 'proportions')
  const extraTables = touchesProportions ? [db.batches] : []

  await db.transaction(
    'rw',
    [db.changes, ...tableNames.map((name) => db.table(name)), ...extraTables, db.formulas, db.materials],
    async (tx) => {
      // 第一遍：为每条改动读取当前值并检测冲突（不写业务表）
      type Planned = {
        input: LocalEditInput
        kind: ChangeKind
        current: Record<string, unknown> | undefined
        diffs: SyncFieldDiff[]
        baseFields: Record<string, unknown>
        changeId: string
      }
      const planned: Planned[] = []
      for (const input of inputs) {
        const kind: ChangeKind = input.kind ?? 'update'
        const tbl = tx.table(input.table)
        const current = (await tbl.get(input.recordId)) as Record<string, unknown> | undefined
        const baseFields = { ...(input.baseFields ?? {}) }
        let diffs: SyncFieldDiff[] = []
        if (kind === 'delete' && current === undefined) {
          // 幂等：已被删除，无冲突
        } else if (kind !== 'create') {
          if (current === undefined) {
            diffs = [{ field: '__record__', label: '整条记录', local: '保留修改', remote: '对方已删除' }]
          } else if (baseFields && Object.keys(baseFields).length > 0) {
            diffs = Object.keys(input.nextFields).reduce<SyncFieldDiff[]>((list, field) => {
              if (field === 'updatedAt') return list
              const base = baseFields[field]
              if (base !== undefined && !sameValue(base, current[field]) && !sameValue(input.nextFields[field], current[field])) {
                list.push({ field, label: fieldLabel(input.table, field), local: input.nextFields[field], remote: current[field] })
              }
              return list
            }, [])
          } else {
            diffs = buildFieldDiffs(input, current)
          }
        }
        planned.push({ input, kind, current, diffs, baseFields, changeId: createId('chg') })
      }

      const conflicts = planned.filter((item) => item.diffs.length > 0)

      // 有任何冲突：整组业务写入放弃，仅登记 conflict 流水，草稿由调用方保留
      if (conflicts.length > 0) {
        for (const item of conflicts) {
          const remoteChange = await latestRemoteChange(tx, clientId, item.input.table, item.input.recordId)
          const conflict = buildConflict({
            input: item.input,
            current: item.current,
            remoteChange,
            localChangeId: item.changeId,
            diffs: item.diffs
          })
          await appendChange(tx, {
            clientId,
            input: item.input,
            kind: item.kind,
            changeId: item.changeId,
            baseFields: item.baseFields,
            now,
            status: 'conflict'
          })
          conflict.localChangeId = item.changeId
          outcome.conflicts.push(conflict)
        }
        return
      }

      // 第二遍：无冲突，整组提交
      for (const item of planned) {
        await applyEdit(tx, item.input, item.current, now)
        await appendChange(tx, {
          clientId,
          input: item.input,
          kind: item.kind,
          changeId: item.changeId,
          baseFields: item.baseFields,
          now,
          status: 'pending'
        })
        outcome.applied += 1
      }
      // 仅配比增删改 / 香料删除级联配比时失效旧快照；香方改名等元数据改动不失效
      const touchedFormulaIds = Array.from(
        new Set(
          planned
            .filter((item) => item.input.table === 'proportions')
            .map((item) => item.input.formulaId)
            .filter((v): v is string => Boolean(v))
        )
      )
      for (const formulaId of touchedFormulaIds) {
        outcome.invalidatedBatches += await invalidateBatchesOfFormula(tx, formulaId, now)
      }
    }
  )

  return outcome
}

async function appendChange(
  tx: Transaction,
  params: {
    clientId: string
    input: LocalEditInput
    kind: ChangeKind
    changeId: string
    baseFields: Record<string, unknown>
    now: number
    status: SyncChange['status']
  }
): Promise<SyncChange> {
  const record: SyncChange = {
    id: params.changeId,
    clientId: params.clientId,
    table: params.input.table,
    recordId: params.input.recordId,
    kind: params.kind,
    baseFields: params.baseFields,
    nextFields: params.input.nextFields,
    recordLabel: params.input.recordLabel,
    formulaId: params.input.formulaId ?? null,
    status: params.status,
    offline: !isCoordinationOnline(),
    createdAt: params.now,
    updatedAt: params.now
  }
  await tx.table('changes').put(record)
  return record
}

/* ---------------------------------- 冲突解决 ---------------------------------- */

/** 逐项确认：未全部选择的冲突抛错，绝不半入库 */
export function assertFullyResolved(conflict: SyncConflict): void {
  const missing = conflict.diffs.filter((diff) => !conflict.resolutions[diff.field])
  if (missing.length > 0) {
    throw new Error(`还有 ${missing.length} 项未确认（${missing.map((item) => item.label).join('、')}）`)
  }
}

export interface ResolveResult {
  applied: boolean
  invalidatedBatches: number
}

/**
 * 按逐项确认结果解决冲突：
 * - 选择「本地」的字段按本地草稿写回；选择「对方」的字段保持对方的值；
 * - 删除类冲突必须整项选择本地（删除）或对方（保留）；
 * - 解决后双方流水都标 merged，冲突中心移除该项。
 */
export async function resolveConflict(
  clientId: string,
  conflict: SyncConflict,
  formulaId?: string | null
): Promise<ResolveResult> {
  assertFullyResolved(conflict)
  const picks = conflict.diffs.map((diff) => conflict.resolutions[diff.field])
  const now = Date.now()
  let invalidatedBatches = 0

  if (conflict.localKind === 'delete') {
    if (!picks.every((pick) => pick === 'local')) {
      // 整项保留对方：仅关闭本地流水
      await closeChangeRows(clientId, conflict, now, false)
      return { applied: false, invalidatedBatches: 0 }
    }
    let invalidated = 0
    const tables = conflict.table === 'proportions' ? [db.table(conflict.table), db.changes, db.batches] : [db.table(conflict.table), db.changes]
    await db.transaction('rw', tables, async (tx) => {
      await cascadeDelete(tx, conflict.table, conflict.recordId)
      if (conflict.table === 'proportions' && conflict.formulaId) {
        invalidated = await invalidateBatchesOfFormula(tx, conflict.formulaId, now)
      }
    })
    await closeChangeRows(clientId, conflict, now, true)
    return { applied: true, invalidatedBatches: invalidated }
  }

  if (conflict.remoteKind === 'delete') {
    if (!picks.every((pick) => pick === 'local')) {
      await closeChangeRows(clientId, conflict, now, false)
      return { applied: false, invalidatedBatches: 0 }
    }
  }

  const localPatch: Record<string, unknown> = {}
  conflict.diffs.forEach((diff) => {
    if (diff.field === '__record__') return
    if (conflict.resolutions[diff.field] === 'local') {
      localPatch[diff.field] = conflict.localFields[diff.field]
    }
  })

  await db.transaction(
    'rw',
    [db.table(conflict.table), db.changes, db.batches],
    async (tx) => {
      const tbl = tx.table(conflict.table)
      const current = await tbl.get(conflict.recordId)
      if (current === undefined) {
        await tbl.put({ id: conflict.recordId, ...conflict.localFields, ...localPatch, updatedAt: now })
      } else if (Object.keys(localPatch).length > 0) {
        await tbl.update(conflict.recordId, { ...localPatch, updatedAt: now })
      }
      if (formulaId && conflict.table === 'proportions') {
        invalidatedBatches = await invalidateBatchesOfFormula(tx, formulaId, now)
      }
    }
  )
  await closeChangeRows(clientId, conflict, now, true)
  return { applied: true, invalidatedBatches }
}

async function closeChangeRows(clientId: string, conflict: SyncConflict, now: number, localApplied: boolean): Promise<void> {
  await db.transaction('rw', db.changes, async (tx) => {
    const rows = await tx.table<SyncChange>('changes').toArray()
    for (const change of rows) {
      const isMine = change.id === conflict.localChangeId
      const isTheirs = conflict.remoteChangeId !== '' && change.id === conflict.remoteChangeId
      if (isMine || isTheirs) {
        await tx.table('changes').update(change.id, {
          status: 'merged',
          updatedAt: now,
          offline: change.clientId === clientId ? false : change.offline
        })
      }
    }
    // 对方没有流水记录（例如旧标签页）时，本地至少闭环
    if (localApplied && conflict.remoteChangeId === '') {
      // no-op，保留显式分支说明语义
    }
  })
}

/* ---------------------------------- 重连合并 ---------------------------------- */

/**
 * 重连 / 定期对账：
 * - 先冲刷本标签页离线暂存队列：互不重叠的改动自动合并入库；
 * - 与对方改动重叠的项保持待处理，返回冲突由冲突中心逐项确认；
 * - 再把对方已被本方知晓、且不与本标签页未决项重叠的流水标 merged。
 */
export async function reconcileClient(
  clientId: string,
  onConflict: (conflict: SyncConflict) => void
): Promise<ReconcileReport> {
  const report: ReconcileReport = { merged: 0, conflicts: 0 }
  if (!isCoordinationOnline()) return report

  // 1. 冲刷离线队列（保持顺序）：成功的自动合并；重叠项已登记 conflict 流水，
  //    同样移出队列交给冲突中心逐项确认（草稿在冲突中心继续保留，不丢、不覆盖对方）。
  while (readOfflineQueue(clientId).length > 0) {
    const edit = readOfflineQueue(clientId)[0]
    const outcome = await coordinateEdit(clientId, edit)
    if (outcome.queued) break
    if (outcome.conflict) {
      report.conflicts += 1
      onConflict(outcome.conflict)
    } else {
      report.merged += 1
    }
    dropQueuedEdit(clientId, 0)
  }

  // 2. 对账对方流水：与本标签页未决冲突不重叠即可标记已知晓
  const pendingMine = await db.changes.where('clientId').equals(clientId).toArray()
  const blockedKeys = new Set(
    pendingMine.filter((change) => change.status === 'conflict').map((change) => `${change.table}:${change.recordId}`)
  )
  await db.transaction('rw', db.changes, async (tx) => {
    const rows = await tx.table<SyncChange>('changes').toArray()
    for (const change of rows) {
      if (change.clientId === clientId) continue
      if (change.status !== 'pending') continue
      if (blockedKeys.has(`${change.table}:${change.recordId}`)) continue
      await tx.table('changes').update(change.id, { status: 'merged', updatedAt: Date.now() })
    }
  })

  return report
}

/** 清理早于保留期的已合并流水（默认 7 天），避免 changes 表无限增长 */
export async function pruneMergedChanges(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs
  return db.changes.where('status').equals('merged').filter((change) => change.updatedAt < cutoff).delete()
}

/** 超过保留数量（默认 500 条）时，只保留最近的已合并流水 */
export async function pruneExtraMergedChanges(keep = 500): Promise<number> {
  const merged = await db.changes.where('status').equals('merged').sortBy('updatedAt')
  const extra = merged.slice(0, Math.max(0, merged.length - keep))
  if (extra.length === 0) return 0
  await db.changes.bulkDelete(extra.map((change) => change.id))
  return extra.length
}
