<script setup lang="ts">
import { computed } from 'vue'
import { Connection, Refresh, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useSyncStore } from '@/stores/syncStore'

const syncStore = useSyncStore()

const statusText = computed(() => (syncStore.online ? '多标签页在线协同中' : '当前离线：改动只暂存本页，重连后自动合并'))
const statusTone = computed(() => (syncStore.online ? 'ok' : 'off'))

async function reconcileNow(): Promise<void> {
  const report = await syncStore.reconcileNow()
  if (!report) return
  if (report.merged === 0 && report.conflicts === 0) {
    ElMessage.success('已对账：没有待合并的改动')
    return
  }
  ElMessage.success(`对账完成：自动合并 ${report.merged} 条，待处理冲突 ${report.conflicts} 条`)
}
</script>

<template>
  <div class="sync-bar">
    <span class="sync-bar__status" :class="`is-${statusTone}`">
      <el-icon><Connection /></el-icon>
      {{ statusText }}
    </span>
    <span v-if="syncStore.offlineQueueCount > 0" class="sync-bar__chip is-offline">
      离线暂存 {{ syncStore.offlineQueueCount }} 条
    </span>
    <button
      type="button"
      class="sync-bar__conflict"
      :class="{ 'has-conflict': syncStore.pendingConflictCount > 0 }"
      @click="syncStore.openCenter()"
    >
      <el-icon><WarningFilled /></el-icon>
      待确认冲突 <em>{{ syncStore.pendingConflictCount }}</em>
    </button>
    <button type="button" class="sync-bar__reconcile" @click="reconcileNow">
      <el-icon><Refresh /></el-icon>
      立即对账合并
    </button>
  </div>
</template>

<style scoped>
.sync-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fdfbf7;
  font-size: 12px;
}

.sync-bar__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #1e8449;
}

.sync-bar__status.is-off {
  color: #a9741a;
}

.sync-bar__chip {
  padding: 2px 10px;
  border-radius: 999px;
}

.sync-bar__chip.is-offline {
  background: #fdf3e0;
  color: #a9741a;
}

.sync-bar__conflict,
.sync-bar__reconcile {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #fff;
  color: #6b5e4f;
  font-size: 12px;
  cursor: pointer;
}

.sync-bar__conflict.has-conflict {
  border-color: #e6b3a8;
  background: #fdecea;
  color: #c0392b;
  font-weight: 600;
}

.sync-bar__conflict em {
  font-style: normal;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.08);
}
</style>
