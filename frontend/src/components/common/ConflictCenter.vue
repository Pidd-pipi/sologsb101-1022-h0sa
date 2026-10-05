<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleCheck, RefreshLeft, WarningFilled } from '@element-plus/icons-vue'
import { useSyncStore } from '@/stores/syncStore'
import { fieldLabel } from '@/utils/sync'
import type { SyncConflict, SyncTableName } from '@/types/sync'

const syncStore = useSyncStore()

const TABLE_LABEL: Record<SyncTableName, string> = {
  formulas: '香方',
  materials: '香料',
  proportions: '配比',
  batches: '批次',
  cellars: '窖藏',
  tastings: '品香'
}

/** 当前展示的冲突列表（打开时从流水实时还原） */
const conflicts = ref<SyncConflict[]>([])
const resolving = ref(false)

watch(
  () => syncStore.centerVisible,
  async (visible) => {
    if (visible) conflicts.value = await syncStore.loadCenterConflicts()
  },
  { immediate: true }
)

watch(
  () => syncStore.pendingConflictKeys.join(','),
  async () => {
    if (syncStore.centerVisible) conflicts.value = await syncStore.loadCenterConflicts()
  }
)

function tableLabel(table: SyncTableName): string {
  return TABLE_LABEL[table] ?? table
}

function formatValue(value: unknown): string {
  if (value === undefined) return '（无）'
  if (value === null) return '（空）'
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `结构化数据 ${value.length} 项`
    return JSON.stringify(value)
  }
  return String(value)
}

/** 一项冲突是否已逐项确认（删除类只有一个整项） */
function isFullyDecided(conflict: SyncConflict): boolean {
  return conflict.diffs.every((diff) => Boolean(conflict.resolutions[diff.field]))
}

function pendingCount(conflict: SyncConflict): number {
  return conflict.diffs.filter((diff) => !conflict.resolutions[diff.field]).length
}

function pickAll(conflict: SyncConflict, resolution: 'local' | 'remote'): void {
  conflict.diffs.forEach((diff) => {
    conflict.resolutions[diff.field] = resolution
  })
}

async function submit(conflict: SyncConflict): Promise<void> {
  if (!isFullyDecided(conflict)) {
    ElMessage.warning(`还有 ${pendingCount(conflict)} 项未确认，请逐项选择保留哪一方后再入库`)
    return
  }
  resolving.value = true
  try {
    const { applied } = await syncStore.resolve(conflict, conflict.formulaId)
    conflicts.value = await syncStore.loadCenterConflicts()
    ElMessage.success(applied ? '已按逐项确认结果入库，未选项保持对方原值' : '已保留对方改动，本地草稿未入库')
    if (conflicts.value.length === 0) syncStore.closeCenter()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '冲突处理失败')
  } finally {
    resolving.value = false
  }
}

async function discard(conflict: SyncConflict): Promise<void> {
  await syncStore.discardLocal(conflict)
  conflicts.value = await syncStore.loadCenterConflicts()
  ElMessage.info('已放弃本地草稿，对方改动原样保留')
  if (conflicts.value.length === 0) syncStore.closeCenter()
}

function handleClose(): void {
  // 关闭不代表确认：未确认草稿继续保留，绝不覆盖对方改动
  syncStore.closeCenter()
}

const totalDiffs = computed(() => conflicts.value.reduce((sum, conflict) => sum + conflict.diffs.length, 0))
</script>

<template>
  <el-drawer
    :model-value="syncStore.centerVisible"
    title="多标签页保存冲突 · 逐项确认"
    size="640px"
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="(value: boolean) => !value && handleClose()"
  >
    <el-alert
      type="warning"
      show-icon
      :closable="false"
      title="检测到另一标签页同时改动了同一记录"
      description="请逐项核对香料、占比、君臣佐使的双方差异并选择保留方；未逐项确认前本地草稿继续保留，不会覆盖对方改动。关闭本面板不会丢草稿。"
    />

    <div v-if="conflicts.length === 0" class="conflict-empty">
      <el-icon :size="28"><CircleCheck /></el-icon>
      <p>当前没有待处理冲突。离线标签页重连后，互不重叠的改动会自动合并，重叠项才会出现在这里。</p>
    </div>

    <div v-for="conflict in conflicts" :key="conflict.localChangeId" class="conflict-card">
      <div class="conflict-card__head">
        <el-tag type="warning" effect="dark" round>
          <el-icon><WarningFilled /></el-icon>
          {{ tableLabel(conflict.table) }}冲突
        </el-tag>
        <strong>{{ conflict.recordLabel }}</strong>
      </div>
      <p class="conflict-card__meta muted">
        对方标签页 {{ conflict.remoteClientId }} ·
        本地动作 {{ conflict.localKind === 'delete' ? '删除' : conflict.localKind === 'create' ? '新增' : '保存' }} ·
        对方动作 {{ conflict.remoteKind === 'delete' ? '删除' : '保存' }}
      </p>

      <el-table :data="conflict.diffs" size="small" class="conflict-table">
        <el-table-column label="项目" min-width="110">
          <template #default="{ row }">
            <strong>{{ row.field === '__record__' ? row.label : fieldLabel(conflict.table, row.field) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="本标签页草稿" min-width="150">
          <template #default="{ row }">
            <span class="value-local">{{ formatValue(row.local) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对方已保存" min-width="150">
          <template #default="{ row }">
            <span class="value-remote">{{ formatValue(row.remote) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="确认保留" width="180">
          <template #default="{ row }">
            <el-radio-group
              :model-value="conflict.resolutions[row.field]"
              size="small"
              @update:model-value="(value: 'local' | 'remote') => syncStore.setResolution(conflict, row.field, value)"
            >
              <el-radio-button value="local">本页</el-radio-button>
              <el-radio-button value="remote">对方</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
      </el-table>

      <div class="conflict-card__quick">
        <el-button size="small" text type="primary" @click="pickAll(conflict, 'local')">全部保留本页草稿</el-button>
        <el-button size="small" text type="info" @click="pickAll(conflict, 'remote')">全部采用对方</el-button>
        <span v-if="pendingCount(conflict) > 0" class="muted">还差 {{ pendingCount(conflict) }} 项未确认</span>
      </div>

      <div class="conflict-card__actions">
        <el-button type="primary" :icon="CircleCheck" :disabled="!isFullyDecided(conflict)" :loading="resolving" @click="submit(conflict)">
          逐项确认后入库
        </el-button>
        <el-button :icon="RefreshLeft" @click="discard(conflict)">放弃本页草稿</el-button>
      </div>
    </div>

    <p class="conflict-foot muted" v-if="totalDiffs > 0">共 {{ conflicts.length }} 条待处理记录、{{ totalDiffs }} 个差异项。</p>
  </el-drawer>
</template>

<style scoped>
.conflict-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px 12px;
  color: #8c8479;
  text-align: center;
}

.conflict-card {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}

.conflict-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.conflict-card__meta {
  margin: 6px 0 10px;
  font-size: 12px;
}

.conflict-table {
  width: 100%;
}

.value-local {
  color: #8a5a2b;
  font-weight: 600;
}

.value-remote {
  color: #5b7fa6;
}

.conflict-card__quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 12px;
}

.conflict-card__actions {
  display: flex;
  gap: 8px;
}

.conflict-foot {
  margin-top: 14px;
  font-size: 12px;
}
</style>
