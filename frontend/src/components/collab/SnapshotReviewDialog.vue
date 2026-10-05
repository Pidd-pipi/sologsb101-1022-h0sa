<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { WarningFilled } from '@element-plus/icons-vue'
import { useCollabStore } from '@/stores/collabStore'
import { useMaterialStore } from '@/stores/materialStore'
import { db } from '@/utils/db'
import type { Batch } from '@/types/batch'
import type { Formula } from '@/types/formula'
import type { Proportion } from '@/types/proportion'
import { round } from '@/utils/ratio'

const collabStore = useCollabStore()
const materialStore = useMaterialStore()

const batch = ref<Batch | null>(null)
const formula = ref<Formula | null>(null)
const currentRows = ref<Proportion[]>([])
const submitting = ref(false)

const formulaName = computed(() => (batch.value ? materialStore.materialName(batch.value.formulaId) : ''))

interface DiffRow {
  materialId: string
  materialName: string
  snapshotRatio: number | null
  currentRatio: number | null
  snapshotRole: string | null
  currentRole: string | null
  changed: boolean
}

const diffRows = computed<DiffRow[]>(() => {
  if (!batch.value) return []
  const currentM = new Map(currentRows.value.map((row) => [row.materialId, row]))
  const rows: DiffRow[] = batch.value.snapshot.map((item) => {
    const current = currentM.get(item.materialId)
    const changed =
      !current ||
      round(item.ratio, 2) !== round(current.ratio, 2) ||
      item.role !== current.role
    return {
      materialId: item.materialId,
      materialName: item.materialName,
      snapshotRatio: item.ratio,
      currentRatio: current ? round(current.ratio, 2) : null,
      snapshotRole: item.role,
      currentRole: current?.role ?? null,
      changed
    }
  })
  // 当前方子新增、快照里没有的香料
  currentRows.value.forEach((row) => {
    if (batch.value && !batch.value.snapshot.some((item) => item.materialId === row.materialId)) {
      rows.push({
        materialId: row.materialId,
        materialName: materialStore.materialName(row.materialId),
        snapshotRatio: null,
        currentRatio: round(row.ratio, 2),
        snapshotRole: null,
        currentRole: row.role,
        changed: true
      })
    }
  })
  return rows
})

const changedCount = computed(() => diffRows.value.filter((row) => row.changed).length)

watch(
  () => collabStore.reviewBatchId,
  async (batchId) => {
    if (!batchId) {
      batch.value = null
      formula.value = null
      currentRows.value = []
      return
    }
    batch.value = (await db.batches.get(batchId)) ?? null
    if (batch.value) {
      formula.value = (await db.formulas.get(batch.value.formulaId)) ?? null
      currentRows.value = await db.proportions.where('formulaId').equals(batch.value.formulaId).toArray()
    }
  },
  { immediate: true }
)

async function review(choice: 'keep' | 'refresh'): Promise<void> {
  if (!batch.value) return
  submitting.value = true
  try {
    await collabStore.submitReview(batch.value.id, choice)
    ElMessage.success(choice === 'refresh' ? '已按当前配比刷新快照，批次解除待复核' : '已保留旧方快照，可继续出窖 / 品香')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="collabStore.reviewOpen" title="批次快照复核" width="720px" append-to-body>
    <template v-if="batch">
      <el-alert type="warning" :closable="false" show-icon class="review-alert">
        <template #title>
          香方「{{ formulaName }}」配比已改动，本批次旧快照已失效并标记为待复核。
          未复核前不能按新配比登记出窖，品香也会按旧快照归属，避免归错香方。
        </template>
      </el-alert>

      <p class="muted review-meta">
        批次 {{ batch.mixedAt }} · {{ batch.formingMethod }} · 快照固化于
        {{ new Date(batch.snapshotAt || Date.now()).toLocaleString('zh-CN') }} ·
        快照版本 v{{ batch.snapshotVersion }} · 当前配方版本 v{{ formula?.version ?? '—' }}
      </p>

      <el-table :data="diffRows" size="small" row-key="materialId" stripe max-height="360">
        <el-table-column label="香料" min-width="130">
          <template #default="{ row }: { row: DiffRow }">
            <strong>{{ row.materialName }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="君臣佐使（快照 → 当前）" min-width="170">
          <template #default="{ row }: { row: DiffRow }">
            <span class="muted">{{ row.snapshotRole ?? '—' }}</span>
            <el-icon v-if="row.changed" class="review-arrow"><WarningFilled /></el-icon>
            <span :class="row.changed ? 'ratio-error' : ''">{{ row.currentRole ?? '已移除' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="占比 %（快照 → 当前）" min-width="170">
          <template #default="{ row }: { row: DiffRow }">
            <span class="mono muted">{{ row.snapshotRatio ?? '—' }}</span>
            <el-icon v-if="row.changed" class="review-arrow"><WarningFilled /></el-icon>
            <span class="mono" :class="row.changed ? 'ratio-error' : ''">{{ row.currentRatio ?? '已移除' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }: { row: DiffRow }">
            <el-tag v-if="row.changed" size="small" type="warning" effect="plain" round>已变化</el-tag>
            <el-tag v-else size="small" type="success" effect="plain" round>一致</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <p class="muted review-summary">共 {{ diffRows.length }} 味 · {{ changedCount }} 味已变化</p>
    </template>

    <template #footer>
      <el-button @click="collabStore.reviewOpen = false">稍后复核</el-button>
      <el-button type="primary" :loading="submitting" @click="review('keep')">保留旧方快照</el-button>
      <el-button type="success" :loading="submitting" @click="review('refresh')">按当前配比刷新</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.review-alert {
  margin-bottom: 12px;
}

.review-meta {
  margin: 0 0 10px;
  font-size: 12px;
}

.review-arrow {
  margin: 0 6px;
  color: #d68910;
  vertical-align: middle;
}

.review-summary {
  margin: 10px 0 0;
  font-size: 12px;
}
</style>
