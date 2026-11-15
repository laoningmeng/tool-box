<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Files,
  InfoFilled,
  Monitor,
  Setting
} from '@element-plus/icons-vue'
import GeneralPanel from './components/GeneralPanel.vue'
import AppearancePanel from './components/AppearancePanel.vue'
import StoragePanel from './components/StoragePanel.vue'
import AboutPanel from './components/AboutPanel.vue'
import { useAppStore } from '@renderer/stores/app'

/**
 * 系统设置：左侧分栏 + 右侧面板。
 * 每个面板自己维护草稿与保存按钮，新增分栏只需在 tabs 里加一项。
 */

type TabKey = 'general' | 'appearance' | 'storage' | 'about'

const appStore = useAppStore()
const active = ref<TabKey>('general')

const tabs = computed(() => [
  { key: 'general' as TabKey, label: '基础设置', caption: '名称 · 语言 · 启动', icon: Setting },
  { key: 'appearance' as TabKey, label: '外观设置', caption: '主题 · 色板 · 布局', icon: Monitor },
  { key: 'storage' as TabKey, label: '存储与数据', caption: '目录 · 备份 · 迁移', icon: Files },
  { key: 'about' as TabKey, label: '关于系统', caption: '版本 · 环境 · 日志', icon: InfoFilled }
])

function handleReload(): void {
  void appStore.load()
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          系统设置
          <span class="chip">本地配置</span>
        </h1>
        <p class="page-desc">
          统一管理应用的偏好、外观与本地数据策略，所有配置保存在本机用户数据目录。
        </p>
      </div>
    </header>

    <div class="settings">
      <aside class="settings__nav">
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          class="settings__tab"
          :class="{ 'is-active': active === item.key }"
          @click="active = item.key"
        >
          <el-icon class="settings__tab-icon"><component :is="item.icon" /></el-icon>
          <span class="settings__tab-text">
            <strong>{{ item.label }}</strong>
            <small>{{ item.caption }}</small>
          </span>
        </button>
      </aside>

      <div class="settings__content">
        <GeneralPanel v-if="active === 'general'" />
        <AppearancePanel v-else-if="active === 'appearance'" />
        <StoragePanel v-else-if="active === 'storage'" @reload="handleReload" />
        <AboutPanel v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.settings__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  position: sticky;
  top: 12px;
}

.settings__tab {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.settings__tab:hover {
  background: var(--bg-hover);
}

.settings__tab.is-active {
  background: var(--accent-softer);
  color: var(--accent);
}

.settings__tab-icon {
  font-size: 16px;
  flex: none;
}

.settings__tab-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.settings__tab-text strong {
  font-size: 13px;
}

.settings__tab-text small {
  font-size: 11px;
  color: var(--text-tertiary);
}

.settings__content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

@media (max-width: 1100px) {
  .settings {
    grid-template-columns: 1fr;
  }

  .settings__nav {
    position: static;
    flex-direction: row;
    overflow-x: auto;
  }
}
</style>
