<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppSettings, LanguageCode, LogLevel } from '@shared/types'
import {
  LOG_LEVEL_OPTIONS,
  TIMEZONE_OPTIONS,
  UI_LANGUAGE_OPTIONS
} from '@shared/constants'
import { useAppStore } from '@renderer/stores/app'
import SettingRow from './SettingRow.vue'
import PanelActions from './PanelActions.vue'

/** 基础设置中可编辑的字段子集（外观 / 存储字段由各自的面板负责） */
interface GeneralDraft {
  systemName: string
  company: string
  language: LanguageCode
  timezone: string
  logLevel: LogLevel
  maxConcurrent: number
  autoLaunch: boolean
  minimizeToTray: boolean
  closeToTray: boolean
}

const appStore = useAppStore()

const saving = ref(false)

function pick(source: AppSettings): GeneralDraft {
  return {
    systemName: source.systemName,
    company: source.company,
    language: source.language,
    timezone: source.timezone,
    logLevel: source.logLevel,
    maxConcurrent: source.maxConcurrent,
    autoLaunch: source.autoLaunch,
    minimizeToTray: source.minimizeToTray,
    closeToTray: source.closeToTray
  }
}

const draft = reactive<GeneralDraft>(pick(appStore.settings))

const dirty = computed(() => {
  const saved = pick(appStore.settings)
  return (Object.keys(draft) as Array<keyof GeneralDraft>).some(
    (key) => draft[key] !== saved[key]
  )
})

// 设置被其他面板修改（导入 / 恢复默认）后，若本地没有未保存修改则自动同步
watch(
  () => appStore.settings,
  (next) => {
    if (!dirty.value) Object.assign(draft, pick(next))
  },
  { deep: true }
)

function discard(): void {
  Object.assign(draft, pick(appStore.settings))
  ElMessage.info('已还原为当前已保存的设置')
}

function onConcurrentChange(value: number | undefined): void {
  if (typeof value === 'number') draft.maxConcurrent = value
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return
  saving.value = true
  try {
    await appStore.save({ ...draft })
    ElMessage.success('基础设置已保存并生效')
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="panel-stack">
    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">基础信息</h2>
          <p class="panel__subtitle">用于标识当前系统，会显示在窗口标题、侧边栏与导出文件中。</p>
        </div>
      </header>
      <div class="panel__body">
        <SettingRow title="系统名称" desc="显示在标题栏、侧边栏与关于页，建议不超过 20 个字符。">
          <el-input v-model="draft.systemName" maxlength="20" show-word-limit placeholder="请输入系统名称" />
        </SettingRow>
        <SettingRow title="企业名称" desc="用于报表页脚、导出配置与企业信息展示。">
          <el-input v-model="draft.company" maxlength="32" placeholder="请输入企业名称" />
        </SettingRow>
      </div>
    </article>

    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">区域与运行</h2>
          <p class="panel__subtitle">界面语言、时间基准与后台任务的运行参数。</p>
        </div>
      </header>
      <div class="panel__body">
        <SettingRow
          title="界面语言"
          desc="切换内置组件（表格、弹窗、日期等）的文案，界面自有文案当前为中文。"
        >
          <el-select v-model="draft.language" placeholder="选择语言">
            <el-option
              v-for="item in UI_LANGUAGE_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </SettingRow>
        <SettingRow title="时区" desc="影响任务时间、运行日志与备份文件的时间戳。">
          <el-select v-model="draft.timezone" filterable placeholder="选择时区">
            <el-option v-for="item in TIMEZONE_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </SettingRow>
        <SettingRow
          title="日志级别"
          desc="调试级别会记录更详细的运行信息，长期开启会占用更多磁盘空间。"
        >
          <el-select v-model="draft.logLevel" placeholder="选择日志级别">
            <el-option
              v-for="item in LOG_LEVEL_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </SettingRow>
        <SettingRow
          title="最大并发任务数"
          desc="同时执行的合成与训练任务上限，数值越高占用的 CPU / 内存越多。"
        >
          <el-input-number
            :model-value="draft.maxConcurrent"
            :min="1"
            :max="32"
            :step="1"
            step-strictly
            controls-position="right"
            @change="onConcurrentChange"
          />
        </SettingRow>
      </div>
    </article>

    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">启动与托盘</h2>
          <p class="panel__subtitle">控制应用随系统启动以及窗口最小化、关闭时的行为。</p>
        </div>
      </header>
      <div class="panel__body">
        <SettingRow title="开机自启动" desc="登录系统后自动在后台启动应用，适合长期值守场景。">
          <el-switch
            :model-value="draft.autoLaunch"
            @change="draft.autoLaunch = !draft.autoLaunch"
          />
        </SettingRow>
        <SettingRow title="最小化到托盘" desc="点击最小化时隐藏到系统托盘，而不是留在任务栏。">
          <el-switch
            :model-value="draft.minimizeToTray"
            @change="draft.minimizeToTray = !draft.minimizeToTray"
          />
        </SettingRow>
        <SettingRow
          title="关闭时最小化到托盘"
          desc="点击关闭按钮时仅隐藏窗口，需要从托盘菜单选择「退出」才会真正结束应用。"
        >
          <el-switch
            :model-value="draft.closeToTray"
            @change="draft.closeToTray = !draft.closeToTray"
          />
        </SettingRow>
      </div>
    </article>

    <PanelActions :dirty="dirty" :saving="saving" @save="save" @discard="discard" />
  </div>
</template>

<style scoped>
.panel-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
</style>
