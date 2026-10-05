<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, WarningFilled } from '@element-plus/icons-vue'
import { useCollabStore } from '@/stores/collabStore'
import type { ConflictChoice, PendingConflict, RowConflict } from '@/types/collab'
import { formatPercent } from '@/utils/ratio'

const collabStore = useCollabStore()
const dialogVisible = ref(false)
const activeConflictId = ref<string | null>(null)

const pending = computed<PendingConflict[]>(() => collabStore.pendingConflicts)
const active = computed<PendingConflict | null>(
  () => pending.value.find((item) => item.id === activeConflictId.value) ?? pending.value[0] ?? null
)

// 本次会话中一旦出现新的待处理冲突，自动打开冲突中心逐项确认
watch(
  () => collabStore.pendingConflictCount,
  (count, previous) => {
    if (count > 0 && (previous ?? 0) === 0) {
      activeConflictId.value = null
      dialogVisible.value = true
    }
  }
)

function openCenter(): void {
  activeConflictId.value = null
  dialogVisible.value = true
}

function selectConflict(id: string): void {
  activeConflictId.value = id
}

async function choose(row: RowConflict, choice: ConflictChoice): Promise<void> {
  if (!active.value) return
  await collabStore.setConflictChoice(active.value.id, row.materialId, choice)
}

async function chooseAll(choice: ConflictChoice): Promise<void> {
  if (!active.value) return
  await collabStore.setAllChoices(active.value.id, choice)
  ElMessage.success(choice === 'ours' ? '已全部采用本方草稿' : '已全部采用对方版本')
}

async function resolve(): Promise<void> {
  if (!active.value) return
  const count = await collabStore.resolveConflict(active.value.id)
  ElMessage.success(`已逐项确认并入库 ${count} 味配比，对方改动已保留`)
  if (pending.value.length === 0) dialogVisible.value = false
}

async function defer(): Promise<void> {
  if (!active.value) return
  await collabStore.deferConflict(active.value.id)
  ElMessage.info('草稿已保留，可稍后在冲突中心继续处理')
  if (pending.value.length <= 1) dialogVisible.value = false
}

async function dismiss(): Promise<void> {
  if (!active.value) return
  const confirmed = await ElMessageBox.confirm(
    '放弃本方草稿后，未入库的修改将丢失，对方已提交版本不受影响。是否继续？',
    '放弃本方草稿',
    { type: 'warning', confirmButtonText: '放弃草稿', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await collabStore.dismissConflict(active.value.id)
  ElMessage.success('已放弃本方草稿')
  if (pending.value.length === 0) dialogVisible.value = false
}

function ratioText(row: RowConflict, side: 'ours' | 'theirs'): string {
  const snapshot = side === 'ours' ? row.ours : row.theirs
  return snapshot ? formatPercent(snapshot.ratio, 2) : '—'
}

function roleText(row: RowConflict, side: 'ours' | 'theirs'): string {
  const snapshot = side === 'ours' ? row.ours : row.theirs
  return snapshot?.role ?? '—'
}

function kindLabel(kind: RowConflict['kind']): string {
  if (kind === 'add') return '双方新增'
  if (kind === 'remove') return '一方删除'
  return '双方修改'
}

function changedLabel(row: RowConflict): string {
  return row.changedFields
    .map((field) => (field === 'ratio' ? '占比' : field === 'role' ? '君臣佐使' : '备注'))
    .join(' · ')
}
</script>

<template>
  <div class="conflict-center">
    <el-badge :value="collabStore.pendingConflictCount" :hidden="collabStore.pendingConflictCount === 0" :max="99">
      <el-button :icon="Bell" :type="collabStore.pendingConflictCount > 0 ? 'danger' : 'default'" plain @click="openCenter">
        协同冲突
      </el-button>
    </el-badge>

    <el-dialog v-model="dialogVisible" title="协同冲突 · 逐项确认后入库" width="860px" append-to-body>
      <div v-if="pending.length === 0" class="conflict-empty">
        <el-icon class="conflict-empty__icon"><WarningFilled /></el-icon>
        <p>当前没有待处理的协同冲突。</p>
        <p class="muted">两个标签页同时修改同一香方配比时，未确认的草稿会保留在这里，不会覆盖对方改动。</p>
      </div>

      <template v-else>
        <div class="conflict-list">
          <button
            v-for="item in pending"
            :key="item.id"
            class="conflict-list__item"
            :class="{ 'is-active': active?.id === item.id }"
            type="button"
            @click="selectConflict(item.id)"
          >
            <strong>{{ item.formulaName }}</strong>
            <span class="muted mono">{{ new Date(item.createdAt).toLocaleTimeString('zh-CN') }}</span>
            <el-tag size="small" type="danger" effect="plain" round>{{ item.conflicts.length }} 项分歧</el-tag>
          </button>
        </div>

        <div v-if="active" class="conflict-detail">
          <div class="conflict-detail__head">
            <h3>{{ active.formulaName }}</h3>
            <p class="muted">
              共同祖先 {{ active.base.length }} 味 · 本方草稿 {{ active.ours.length }} 味 · 对方已提交
              {{ active.theirs.length }} 味 · {{ active.autoMerged.length }} 项无分歧自动合并
            </p>
          </div>

          <div class="conflict-actions">
            <el-button size="small" @click="chooseAll('ours')">全部采用本方草稿</el-button>
            <el-button size="small" @click="chooseAll('theirs')">全部采用对方版本</el-button>
          </div>

          <el-table :data="active.conflicts" size="small" row-key="materialId" stripe>
            <el-table-column label="香料" min-width="140">
              <template #default="{ row }: { row: RowConflict }">
                <strong>{{ row.materialName }}</strong>
                <el-tag size="small" effect="plain" round class="conflict-kind">{{ kindLabel(row.kind) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="分歧字段" width="150">
              <template #default="{ row }: { row: RowConflict }">
                <span class="ratio-error">{{ changedLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="本方草稿" min-width="150">
              <template #default="{ row }: { row: RowConflict }">
                <div>占比 <span class="mono">{{ ratioText(row, 'ours') }}</span></div>
                <div>君臣佐使 <el-tag size="small" round>{{ roleText(row, 'ours') }}</el-tag></div>
              </template>
            </el-table-column>
            <el-table-column label="对方已提交" min-width="150">
              <template #default="{ row }: { row: RowConflict }">
                <div>占比 <span class="mono">{{ ratioText(row, 'theirs') }}</span></div>
                <div>君臣佐使 <el-tag size="small" type="warning" round>{{ roleText(row, 'theirs') }}</el-tag></div>
              </template>
            </el-table-column>
            <el-table-column label="逐项确认" width="200">
              <template #default="{ row }: { row: RowConflict }">
                <el-radio-group :model-value="row.choice ?? 'ours'" size="small" @update:model-value="(value: ConflictChoice) => choose(row, value)">
                  <el-radio value="ours">本方</el-radio>
                  <el-radio value="theirs">对方</el-radio>
                </el-radio-group>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>

      <template #footer>
        <template v-if="active">
          <el-button @click="dismiss">放弃本方草稿</el-button>
          <el-button @click="defer">保留草稿，稍后处理</el-button>
          <el-button type="primary" @click="resolve">逐项确认并入库</el-button>
        </template>
        <el-button v-else @click="dialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.conflict-center {
  display: inline-flex;
  align-items: center;
}

.conflict-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 0;
  color: #8c8479;
}

.conflict-empty__icon {
  font-size: 36px;
  color: #d68910;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.conflict-list__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fbf9f5;
  cursor: pointer;
  text-align: left;
}

.conflict-list__item.is-active {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.conflict-detail__head h3 {
  margin: 0 0 4px;
}

.conflict-detail__head p {
  margin: 0 0 10px;
  font-size: 12px;
}

.conflict-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.conflict-kind {
  margin-left: 6px;
}
</style>
