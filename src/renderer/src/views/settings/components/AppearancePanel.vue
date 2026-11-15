<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { Check, InfoFilled, Monitor, Moon, Sunny } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { AppSettings, ThemeMode } from '@shared/types'
import { ACCENT_PRESETS } from '@shared/constants'
import { useAppStore } from '@renderer/stores/app'
import SettingRow from './SettingRow.vue'

interface ThemeCard {
  value: ThemeMode
  label: string
  desc: string
  icon: Component
}

const appStore = useAppStore()

const applying = ref(false)

const themeModes: ThemeCard[] = [
  { value: 'light', label: '浅色模式', desc: '明亮的界面风格，适合白天与光线充足的环境。', icon: Sunny },
  { value: 'dark', label: '深色模式', desc: '低亮度深色界面，长时间使用更省眼。', icon: Moon },
  { value: 'system', label: '跟随系统', desc: '随操作系统的明暗设置自动切换。', icon: Monitor }
]

const currentThemeLabel = computed(() => {
  const current = appStore.settings.themeMode
  if (current === 'system') return `跟随系统（当前${appStore.isDark ? '深色' : '浅色'}）`
  return current === 'dark' ? '深色模式' : '浅色模式'
})

const customColor = ref<string | null>(appStore.settings.accentColor)

watch(
  () => appStore.settings.accentColor,
  (value) => {
    customColor.value = value
  }
)

function isAccent(color: string): boolean {
  return appStore.settings.accentColor.toLowerCase() === color.toLowerCase()
}

/** 外观类设置即时保存并立即生效 */
async function saveAppearance(patch: Partial<AppSettings>): Promise<void> {
  if (applying.value) return
  applying.value = true
  try {
    await appStore.save(patch)
  } catch (error) {
    ElMessage.error(`外观设置应用失败：${(error as Error).message}`)
  } finally {
    applying.value = false
  }
}

function setThemeMode(mode: ThemeMode): void {
  if (mode === appStore.settings.themeMode) return
  void saveAppearance({ themeMode: mode })
}

function setAccent(color: string): void {
  if (isAccent(color)) return
  void saveAppearance({ accentColor: color })
}

function onCustomColorChange(value: string | null): void {
  if (value) void saveAppearance({ accentColor: value })
}

function toggleCompact(): void {
  void saveAppearance({ compactMode: !appStore.settings.compactMode })
}

function toggleBreadcrumb(): void {
  void saveAppearance({ showBreadcrumb: !appStore.settings.showBreadcrumb })
}

function toggleSidebar(): void {
  appStore.toggleSidebar()
}
</script>

<template>
  <div class="appearance">
    <div class="notice">
      <el-icon><InfoFilled /></el-icon>
      <span>外观设置修改后立即生效并自动保存，无需手动确认。</span>
    </div>

    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">主题模式</h2>
          <p class="panel__subtitle">选择界面明暗风格，跟随系统时会随操作系统外观自动切换。</p>
        </div>
        <span class="chip">{{ currentThemeLabel }}</span>
      </header>
      <div class="panel__body">
        <div class="theme-grid">
          <button
            v-for="mode in themeModes"
            :key="mode.value"
            type="button"
            class="theme-card"
            :class="{ 'is-active': appStore.settings.themeMode === mode.value }"
            :disabled="applying"
            @click="setThemeMode(mode.value)"
          >
            <span class="theme-card__icon" :class="`is-${mode.value}`">
              <el-icon><component :is="mode.icon" /></el-icon>
            </span>
            <span class="theme-card__body">
              <span class="theme-card__title">{{ mode.label }}</span>
              <span class="theme-card__desc">{{ mode.desc }}</span>
            </span>
            <span
              v-if="appStore.settings.themeMode === mode.value"
              class="theme-card__check"
            >
              <el-icon><Check /></el-icon>
            </span>
          </button>
        </div>
      </div>
    </article>

    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">主题色</h2>
          <p class="panel__subtitle">应用于按钮、链接、选中态与图表主色，修改后全局立即生效。</p>
        </div>
        <span class="chip mono">{{ appStore.settings.accentColor }}</span>
      </header>
      <div class="panel__body">
        <div class="accent-grid">
          <button
            v-for="preset in ACCENT_PRESETS"
            :key="preset.value"
            type="button"
            class="accent-item"
            :class="{ 'is-active': isAccent(preset.value) }"
            :disabled="applying"
            @click="setAccent(preset.value)"
          >
            <span class="accent-item__dot" :style="{ background: preset.value }">
              <el-icon v-if="isAccent(preset.value)"><Check /></el-icon>
            </span>
            <span class="accent-item__meta">
              <span class="accent-item__label">{{ preset.label }}</span>
              <span class="accent-item__hex mono">{{ preset.value }}</span>
            </span>
          </button>
        </div>

        <div class="accent-custom">
          <div class="accent-custom__meta">
            <span class="accent-custom__title">自定义主题色</span>
            <span class="accent-custom__desc">
              支持任意色值，建议选择与白色文字对比度足够高的颜色。
            </span>
          </div>
          <div class="accent-custom__picker">
            <el-color-picker
              v-model="customColor"
              :predefine="ACCENT_PRESETS.map((item) => item.value)"
              :disabled="applying"
              @change="onCustomColorChange"
            />
            <span class="chip mono">{{ customColor ?? appStore.settings.accentColor }}</span>
          </div>
        </div>
      </div>
    </article>

    <article class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">界面偏好</h2>
          <p class="panel__subtitle">调整页面密度与导航元素的显示方式，修改后立即生效。</p>
        </div>
      </header>
      <div class="panel__body">
        <SettingRow title="紧凑模式" desc="减少页面留白与行高，适合小屏幕或信息密集的使用场景。">
          <el-switch :model-value="appStore.settings.compactMode" @change="toggleCompact" />
        </SettingRow>
        <SettingRow title="显示面包屑" desc="顶部导航展示「分组 / 页面」路径，关闭后仅显示当前页面标题。">
          <el-switch
            :model-value="appStore.settings.showBreadcrumb"
            @change="toggleBreadcrumb"
          />
        </SettingRow>
        <SettingRow title="折叠侧边栏" desc="折叠后仅显示图标，为内容区域腾出更多横向空间。">
          <el-switch :model-value="appStore.sidebarCollapsed" @change="toggleSidebar" />
          <span class="side-state">{{ appStore.sidebarCollapsed ? '已折叠' : '展开' }}</span>
        </SettingRow>
      </div>
    </article>
  </div>
</template>

<style scoped>
.appearance {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-border);
  background: var(--accent-softer);
  color: var(--text-secondary);
  font-size: 12.5px;
}

.notice .el-icon {
  color: var(--accent);
  font-size: 15px;
  flex: none;
}

/* ------------------------------- 主题模式卡片 ------------------------------ */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1080px) {
  .theme-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.theme-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  transition: border-color var(--dur-fast) linear, background var(--dur-fast) linear,
    box-shadow var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}

.theme-card:hover:not(:disabled) {
  border-color: var(--accent-border);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

.theme-card:disabled {
  cursor: progress;
}

.theme-card.is-active {
  border-color: var(--accent);
  background: var(--accent-softer);
  box-shadow: 0 0 0 1px var(--accent-border) inset;
}

.theme-card__icon {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-size: 17px;
}

.theme-card__icon.is-light {
  color: var(--warning);
  background: var(--warning-soft);
}

.theme-card__icon.is-dark {
  color: var(--info);
  background: var(--info-soft);
}

.theme-card__icon.is-system {
  color: var(--accent);
  background: var(--accent-soft);
}

.theme-card__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-right: 14px;
}

.theme-card__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.theme-card.is-active .theme-card__title {
  color: var(--accent);
}

.theme-card__desc {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-tertiary);
}

.theme-card__check {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 11px;
  color: var(--accent-ink);
  background: var(--accent);
}

/* -------------------------------- 主题色 --------------------------------- */
.accent-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 1080px) {
  .accent-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.accent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  transition: border-color var(--dur-fast) linear, background var(--dur-fast) linear,
    transform var(--dur-base) var(--ease-out);
}

.accent-item:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  transform: translateY(-1px);
}

.accent-item:disabled {
  cursor: progress;
}

.accent-item.is-active {
  border-color: var(--accent-border);
  background: var(--accent-softer);
}

.accent-item__dot {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 11px;
  color: var(--accent-ink);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 8%, transparent) inset;
}

.accent-item__meta {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  min-width: 0;
}

.accent-item__label {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-primary);
}

.accent-item__hex {
  font-size: 11px;
  color: var(--text-tertiary);
}

.accent-custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--border-color);
}

.accent-custom__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.accent-custom__title {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--text-primary);
}

.accent-custom__desc {
  font-size: 12px;
  color: var(--text-tertiary);
}

.accent-custom__picker {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

/* 侧边栏状态 */
.side-state {
  min-width: 46px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: right;
}
</style>
