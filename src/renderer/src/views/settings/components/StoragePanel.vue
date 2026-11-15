<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheckFilled,
  CopyDocument,
  Delete,
  Download,
  FolderAdd,
  FolderOpened,
  Refresh,
  Upload,
  WarningFilled
} from '@element-plus/icons-vue'
import type { AppSettings, BackupInterval, BackupResult } from '@shared/types'
import { BACKUP_INTERVAL_OPTIONS } from '@shared/constants'
import { formatBytes } from '@renderer/utils/format'
import { useAppStore } from '@renderer/stores/app'
import SettingRow from './SettingRow.vue'
import PanelActions from './PanelActions.vue'

interface StorageDraft {
  autoBackup: boolean
  backupInterval: BackupInterval
  clearCacheOnExit: boolean
}

const emit = defineEmits<{
  reload: []
}>()

const appStore = useAppStore()

/* -------------------------------- 数据目录 -------------------------------- */
const picking = ref(false)

const defaultDataDir = computed(() => {
  const base = appStore.systemInfo?.userDataPath
  if (!base) return ''
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}data`
})

const displayDataDir = computed(
  () => appStore.settings.dataDir || defaultDataDir.value || '默认数据目录（应用数据目录下的 data 文件夹）'
)

const isDefaultDir = computed(
  () => !appStore.settings.dataDir || appStore.settings.dataDir === defaultDataDir.value
)

async function pickDir(): Promise<void> {
  if (picking.value) return
  picking.value = true
  try {
    const dir = await window.api.system.pickDirectory()
    if (!dir) return
    // pickDirectory 已在主进程落盘，这里通过 store 再同步一次，确保界面与主题立即刷新
    await appStore.save({ dataDir: dir })
    ElMessage.success('数据目录已更新')
  } catch (error) {
    ElMessage.error(`选择目录失败：${(error as Error).message}`)
  } finally {
    picking.value = false
  }
}

async function openDataDir(): Promise<void> {
  try {
    await window.api.system.openPath('data')
  } catch (error) {
    ElMessage.error(`打开目录失败：${(error as Error).message}`)
  }
}

/* --------------------------------- 缓存管理 -------------------------------- */
const cacheBytes = ref(0)
const loadingCache = ref(false)
const clearingCache = ref(false)
const cacheCleared = ref<number | null>(null)

async function refreshCache(): Promise<void> {
  loadingCache.value = true
  try {
    cacheBytes.value = await window.api.system.cacheSize()
  } catch (error) {
    ElMessage.error(`读取缓存大小失败：${(error as Error).message}`)
  } finally {
    loadingCache.value = false
  }
}

async function clearCache(): Promise<void> {
  if (clearingCache.value) return
  try {
    await ElMessageBox.confirm(
      '清理缓存会删除页面资源缓存、GPU 缓存与临时文件，不会影响数字人数据与系统设置。确认立即清理？',
      '清理缓存',
      {
        confirmButtonText: '立即清理',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  clearingCache.value = true
  try {
    const released = await window.api.system.clearCache()
    cacheCleared.value = released
    cacheBytes.value = await window.api.system.cacheSize()
    ElMessage.success(released > 0 ? `缓存已清理，释放 ${formatBytes(released)} 空间` : '缓存已清理')
  } catch (error) {
    ElMessage.error(`清理缓存失败：${(error as Error).message}`)
  } finally {
    clearingCache.value = false
  }
}

/* -------------------------------- 备份与恢复 ------------------------------- */
const backingUp = ref(false)
const lastBackup = ref<BackupResult | null>(null)

function pickBackup(source: AppSettings): StorageDraft {
  return {
    autoBackup: source.autoBackup,
    backupInterval: source.backupInterval,
    clearCacheOnExit: source.clearCacheOnExit
  }
}

const backupDraft = reactive<StorageDraft>(pickBackup(appStore.settings))

const backupDirty = computed(() => {
  const saved = pickBackup(appStore.settings)
  return (Object.keys(backupDraft) as Array<keyof StorageDraft>).some(
    (key) => backupDraft[key] !== saved[key]
  )
})

watch(
  () => appStore.settings,
  (next) => {
    if (!backupDirty.value) Object.assign(backupDraft, pickBackup(next))
  },
  { deep: true }
)

const savingBackup = ref(false)

function discardBackup(): void {
  Object.assign(backupDraft, pickBackup(appStore.settings))
  ElMessage.info('已还原为当前已保存的备份设置')
}

async function saveBackup(): Promise<void> {
  if (!backupDirty.value || savingBackup.value) return
  savingBackup.value = true
  try {
    await appStore.save({ ...backupDraft })
    ElMessage.success('备份与清理策略已保存')
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    savingBackup.value = false
  }
}

async function backupNow(): Promise<void> {
  if (backingUp.value) return
  backingUp.value = true
  try {
    const result = await window.api.system.backupNow()
    lastBackup.value = result
    if (result.ok) ElMessage.success(`备份完成（${formatBytes(result.size)}）`)
    else ElMessage.error('备份未完成，请检查数据目录是否可写')
  } catch (error) {
    ElMessage.error(`备份失败：${(error as Error).message}`)
  } finally {
    backingUp.value = false
  }
}

async function copyPath(path: string, label: string): Promise<void> {
  if (!path) return
  try {
    await navigator.clipboard.writeText(path)
    ElMessage.success(`${label}已复制到剪贴板`)
  } catch {
    ElMessage.error('复制失败，请手动选择路径文本')
  }
}

/* -------------------------------- 配置迁移 -------------------------------- */
const exporting = ref(false)
const importing = ref(false)
const resetting = ref(false)

async function exportSettings(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await window.api.settings.export()
    if (!result.ok && !result.canceled) ElMessage.error('配置导出失败')
    else if (result.ok) ElMessage.success('配置文件已导出')
  } catch (error) {
    ElMessage.error(`导出失败：${(error as Error).message}`)
  } finally {
    exporting.value = false
  }
}

async function importSettings(): Promise<void> {
  if (importing.value) return
  importing.value = true
  try {
    const result = await window.api.settings.import()
    if (result.canceled) return
    if (!result.ok) {
      ElMessage.error('配置导入失败')
      return
    }
    // 主进程已保存导入的设置，这里重新初始化 store 让设置与主题同步
    await appStore.init()
    await refreshCache()
    emit('reload')
    ElMessage.success('配置导入成功，设置已重新加载')
  } catch (error) {
    ElMessage.error(`导入失败：${(error as Error).message}`)
  } finally {
    importing.value = false
  }
}

async function resetSettings(): Promise<void> {
  if (resetting.value) return
  try {
    await ElMessageBox.confirm(
      '将把基础、外观与存储相关设置恢复为默认值，数字人数据不会被删除。该操作不可撤销，确认恢复？',
      '恢复默认设置',
      {
        confirmButtonText: '恢复默认',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  resetting.value = true
  try {
    await appStore.reset()
    await refreshCache()
    emit('reload')
    ElMessage.success('已恢复默认设置')
  } catch (error) {
    ElMessage.error(`恢复默认失败：${(error as Error).message}`)
  } finally {
    resetting.value = false
  }
}

onMounted(() => {
  void refreshCache()
})
</script>

<template>
  <div class="storage">
    <!-- 数据目录 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">数据目录</h2>
          <p class="panel__subtitle">数字人数据、备份文件与导出配置均读写自该目录。</p>
        </div>
        <span class="chip">{{ isDefaultDir ? '默认目录' : '自定义目录' }}</span>
      </header>
      <div class="panel__body">
        <div class="path-box">
          <el-icon class="path-box__icon"><FolderOpened /></el-icon>
          <span class="path-box__path mono" :title="displayDataDir">{{ displayDataDir }}</span>
          <el-button
            link
            :icon="CopyDocument"
            class="path-box__copy"
            @click="copyPath(displayDataDir, '数据目录')"
          />
        </div>
        <div class="path-actions">
          <el-button :icon="FolderAdd" :loading="picking" @click="pickDir">选择目录</el-button>
          <el-button :icon="FolderOpened" @click="openDataDir">打开目录</el-button>
          <span class="path-tip text-muted">切换后新的备份与导出文件将写入新路径。</span>
        </div>
      </div>
    </article>

    <!-- 缓存管理 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">缓存管理</h2>
          <p class="panel__subtitle">缓存包含页面资源、GPU 数据与临时文件，长期使用后会占用磁盘空间。</p>
        </div>
      </header>
      <div class="panel__body">
        <div class="cache">
          <div class="cache__value">
            <span class="cache__num num">{{ formatBytes(cacheBytes) }}</span>
            <span class="cache__label">当前缓存占用</span>
          </div>
          <div class="cache__actions">
            <el-button
              size="small"
              :icon="Refresh"
              :loading="loadingCache"
              @click="refreshCache"
            >
              重新统计
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              :loading="clearingCache"
              @click="clearCache"
            >
              清理缓存
            </el-button>
          </div>
        </div>
        <p v-if="cacheCleared !== null" class="cache__hint">
          <el-icon><CircleCheckFilled /></el-icon>
          上次清理已释放 {{ formatBytes(cacheCleared) }} 空间
        </p>
      </div>
    </article>

    <!-- 备份与恢复 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">备份与恢复</h2>
          <p class="panel__subtitle">备份文件写入数据目录下的 backups 文件夹，最多保留最近 20 份。</p>
        </div>
        <el-button size="small" type="primary" :icon="Upload" :loading="backingUp" @click="backupNow">
          立即备份
        </el-button>
      </header>
      <div class="panel__body">
        <SettingRow title="自动备份" desc="按周期为数字人数据与系统设置生成完整快照，防止误操作导致数据丢失。">
          <el-switch
            :model-value="backupDraft.autoBackup"
            @change="backupDraft.autoBackup = !backupDraft.autoBackup"
          />
        </SettingRow>
        <SettingRow title="备份周期" desc="自动备份的执行频率，关闭自动备份后该项不生效。">
          <el-select
            v-model="backupDraft.backupInterval"
            :disabled="!backupDraft.autoBackup"
            placeholder="选择备份周期"
          >
            <el-option
              v-for="item in BACKUP_INTERVAL_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </SettingRow>
        <SettingRow
          title="退出时自动清理缓存"
          desc="每次退出应用时清理缓存，可释放磁盘空间，但下次启动需要重新生成缓存资源。"
        >
          <el-switch
            :model-value="backupDraft.clearCacheOnExit"
            @change="backupDraft.clearCacheOnExit = !backupDraft.clearCacheOnExit"
          />
        </SettingRow>

        <div v-if="lastBackup" class="backup-result">
          <div class="backup-result__head">
            <el-icon><CircleCheckFilled /></el-icon>
            <span class="backup-result__title">最近一次手动备份</span>
            <span class="backup-result__size num">{{ formatBytes(lastBackup.size) }}</span>
          </div>
          <div class="backup-result__path mono">{{ lastBackup.filePath }}</div>
        </div>
      </div>
    </article>

    <!-- 配置迁移 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">配置迁移</h2>
          <p class="panel__subtitle">导出当前设置用于备份，或从 JSON 配置文件快速恢复。</p>
        </div>
      </header>
      <div class="panel__body">
        <SettingRow title="导出配置" desc="将当前系统设置导出为 JSON 文件，可用于迁移到其他设备。">
          <el-button :icon="Upload" :loading="exporting" @click="exportSettings">导出配置</el-button>
        </SettingRow>
        <SettingRow title="导入配置" desc="从 JSON 文件恢复设置，导入后界面外观与偏好会立即刷新。">
          <el-button :icon="Download" :loading="importing" @click="importSettings">导入配置</el-button>
        </SettingRow>
        <SettingRow
          title="恢复默认设置"
          desc="将基础、外观与存储设置恢复为出厂默认值，数字人数据不会被删除。"
        >
          <el-button type="danger" plain :icon="WarningFilled" :loading="resetting" @click="resetSettings">
            恢复默认
          </el-button>
        </SettingRow>
      </div>
    </article>

    <PanelActions
      :dirty="backupDirty"
      :saving="savingBackup"
      @save="saveBackup"
      @discard="discardBackup"
    />
  </div>
</template>

<style scoped>
.storage {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* -------------------------------- 数据目录 -------------------------------- */
.path-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-subtle);
}

.path-box__icon {
  flex: none;
  font-size: 16px;
  color: var(--accent);
}

.path-box__path {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.55;
}

.path-box__copy {
  flex: none;
  color: var(--text-tertiary);
}

.path-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.path-tip {
  font-size: 11.5px;
}

/* -------------------------------- 缓存管理 -------------------------------- */
.cache {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.cache__value {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cache__num {
  font-size: 24px;
  font-weight: 680;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.cache__label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.cache__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cache__hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
  font-size: 12px;
  color: var(--success);
}

/* -------------------------------- 备份结果 -------------------------------- */
.backup-result {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--success) 32%, transparent);
  background: var(--success-soft);
}

.backup-result__head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--success);
}

.backup-result__title {
  font-weight: 550;
}

.backup-result__size {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.backup-result__path {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.55;
}
</style>
