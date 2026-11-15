<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CircleCheckFilled,
  CopyDocument,
  Download,
  FolderOpened,
  Refresh
} from '@element-plus/icons-vue'
import type { UpdateCheckResult } from '@shared/types'
import { formatDateTime } from '@renderer/utils/format'
import { useAppStore } from '@renderer/stores/app'

interface InfoItem {
  label: string
  value: string
  mono?: boolean
}

interface PathItem {
  label: string
  path: string
}

const appStore = useAppStore()

const info = computed(() => appStore.systemInfo)

const appName = computed(
  () => appStore.settings.systemName || info.value?.appName || '穷哥们的工具箱'
)

const version = computed(() => info.value?.appVersion ?? '-')

const runtimeItems = computed<InfoItem[]>(() => {
  const data = info.value
  if (!data) return []
  return [
    { label: 'Electron', value: data.electron, mono: true },
    { label: 'Chromium', value: data.chrome, mono: true },
    { label: 'Node.js', value: data.node, mono: true },
    { label: 'V8 引擎', value: data.v8, mono: true },
    { label: '平台 / 架构', value: `${data.platform} / ${data.arch}`, mono: true },
    { label: '处理器', value: data.cpuModel },
    { label: 'CPU 核心数', value: `${data.cpuCores} 核`, mono: true },
    { label: '可用 / 总内存', value: `${data.freeMemory} / ${data.totalMemory}` },
    { label: '本次运行时长', value: data.uptime },
    { label: '应用标识', value: data.appName, mono: true },
    { label: '打包方式', value: data.packaged ? '安装包版本' : '开发调试模式' }
  ]
})

const pathItems = computed<PathItem[]>(() => {
  const data = info.value
  if (!data) return []
  return [
    { label: '数据文件', path: data.dataPath },
    { label: '应用数据目录', path: data.userDataPath },
    { label: '日志目录', path: data.logsPath }
  ]
})

const checking = ref(false)
const updateResult = ref<UpdateCheckResult | null>(null)

async function checkUpdate(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    const result = await window.api.system.checkUpdate()
    updateResult.value = result
    if (result.hasUpdate) {
      ElMessage.warning(`发现新版本 v${result.latest}，当前版本 v${result.current}`)
    } else {
      ElMessage.success(`已是最新版本 v${result.current}`)
    }
  } catch (error) {
    ElMessage.error(`检查更新失败：${(error as Error).message}`)
  } finally {
    checking.value = false
  }
}

async function openLogs(): Promise<void> {
  try {
    await window.api.system.openPath('logs')
  } catch (error) {
    ElMessage.error(`打开日志目录失败：${(error as Error).message}`)
  }
}

async function copyText(text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('路径已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败，请手动选择路径文本')
  }
}

function refreshInfo(): void {
  void appStore.loadSystemInfo()
}

onMounted(() => {
  if (!info.value) void appStore.loadSystemInfo()
})
</script>

<template>
  <div class="about">
    <!-- 应用信息 -->
    <article class="panel">
      <div class="panel__body about-hero">
        <div class="about-hero__logo">{{ appName.slice(0, 1) }}</div>
        <div class="about-hero__main">
          <div class="about-hero__title-row">
            <h2 class="about-hero__name">{{ appName }}</h2>
            <span class="chip mono">v{{ version }}</span>
            <span class="chip" :class="{ 'is-packaged': info?.packaged }">
              {{ info?.packaged ? '安装包版本' : '开发调试' }}
            </span>
          </div>
          <p class="about-hero__desc">
            基于 Electron + Vue 3 构建的本地优先桌面管理后台，数据、日志与配置全部保存在本机。
          </p>
          <div class="about-hero__meta mono">
            <span>应用标识：{{ info?.appName ?? '-' }}</span>
            <span class="divider-v" />
            <span>运行平台：{{ info?.platform ?? '-' }}</span>
          </div>
        </div>
        <div class="about-hero__actions">
          <el-button type="primary" :icon="Refresh" :loading="checking" @click="checkUpdate">
            检查更新
          </el-button>
          <el-button :icon="FolderOpened" @click="openLogs">打开日志目录</el-button>
        </div>
      </div>

      <div v-if="updateResult" class="update-result" :class="{ 'is-new': updateResult.hasUpdate }">
        <el-icon>
          <component :is="updateResult.hasUpdate ? Download : CircleCheckFilled" />
        </el-icon>
        <span class="update-result__text">
          {{
            updateResult.hasUpdate
              ? `发现新版本 v${updateResult.latest}，当前版本 v${updateResult.current}`
              : `已是最新版本 v${updateResult.current}`
          }}
        </span>
        <span class="update-result__time">检查于 {{ formatDateTime(updateResult.checkedAt, true) }}</span>
      </div>
    </article>

    <!-- 运行环境 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">运行环境</h2>
          <p class="panel__subtitle">应用运行时依赖的底层组件版本与设备信息。</p>
        </div>
        <el-button link type="primary" :icon="Refresh" @click="refreshInfo">刷新</el-button>
      </header>
      <div v-loading="appStore.loadingSystemInfo" class="panel__body">
        <div v-if="runtimeItems.length" class="info-grid">
          <div v-for="item in runtimeItems" :key="item.label" class="info-item">
            <span class="info-item__label">{{ item.label }}</span>
            <span class="info-item__value" :class="{ mono: item.mono }" :title="item.value">
              {{ item.value }}
            </span>
          </div>
        </div>
        <el-empty v-else description="正在读取运行环境信息" :image-size="72" />
      </div>
    </article>

    <!-- 文件路径 -->
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">文件路径</h2>
          <p class="panel__subtitle">数据文件、应用数据与日志的本地位置，可一键复制。</p>
        </div>
      </header>
      <div class="panel__body paths">
        <div v-for="item in pathItems" :key="item.label" class="path-row">
          <span class="path-row__label">{{ item.label }}</span>
          <span class="path-row__path mono" :title="item.path">{{ item.path || '-' }}</span>
          <el-button link :icon="CopyDocument" :disabled="!item.path" @click="copyText(item.path)">
            复制
          </el-button>
        </div>
        <el-empty v-if="!pathItems.length" description="正在读取文件路径" :image-size="64" />
      </div>
    </article>
  </div>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ------------------------------- 应用信息卡 ------------------------------- */
.about-hero {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding: 22px 22px 20px;
}

.about-hero__logo {
  flex: none;
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-lg);
  font-size: 24px;
  font-weight: 700;
  color: var(--accent-ink);
  background: linear-gradient(
    135deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 45%, var(--info))
  );
  box-shadow: var(--shadow-md);
}

.about-hero__main {
  flex: 1;
  min-width: 0;
}

.about-hero__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.about-hero__name {
  margin: 0;
  font-size: 19px;
  font-weight: 680;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

.chip.is-packaged {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 30%, transparent);
  background: var(--success-soft);
}

.about-hero__desc {
  margin: 8px 0 10px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-secondary);
  max-width: 620px;
}

.about-hero__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.about-hero__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* ------------------------------- 更新检查结果 ------------------------------ */
.update-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 22px 18px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
  background: var(--success-soft);
  color: var(--success);
  font-size: 12.5px;
}

.update-result.is-new {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.update-result__text {
  font-weight: 500;
}

.update-result__time {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

/* -------------------------------- 运行环境 -------------------------------- */
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-subtle);
  min-width: 0;
}

.info-item__label {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.info-item__value {
  font-size: 13px;
  font-weight: 550;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* -------------------------------- 文件路径 -------------------------------- */
.paths {
  display: flex;
  flex-direction: column;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px dashed var(--border-color);
}

.path-row:first-child {
  padding-top: 2px;
}

.path-row:last-child {
  padding-bottom: 2px;
  border-bottom: none;
}

.path-row__label {
  flex: none;
  width: 108px;
  font-size: 13px;
  font-weight: 550;
  color: var(--text-primary);
}

.path-row__path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1080px) {
  .about-hero {
    flex-wrap: wrap;
  }

  .about-hero__actions {
    width: 100%;
  }
}
</style>
