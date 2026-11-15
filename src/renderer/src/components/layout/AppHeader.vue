<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowRight, Bell, Expand, Fold, Moon, Sunny } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@renderer/stores/app'

/**
 * 顶栏：折叠侧栏 / 面包屑 / 主题切换 / 通知。
 * 没有登录体系：本地单用户应用，不展示用户菜单。
 */

const appStore = useAppStore()
const route = useRoute()

const title = computed(() => (route.meta?.title as string) ?? '')
const group = computed(() => (route.meta?.group as string) ?? '')
const collapsed = computed(() => appStore.sidebarCollapsed)

async function toggleTheme(): Promise<void> {
  const next = appStore.isDark ? 'light' : 'dark'
  try {
    await appStore.save({ themeMode: next })
  } catch (error) {
    ElMessage.error(`主题切换失败：${(error as Error).message}`)
  }
}
</script>

<template>
  <header class="header">
    <div class="header__left">
      <el-tooltip
        :content="collapsed ? '展开侧栏' : '收起侧栏'"
        placement="bottom"
        :show-after="120"
      >
        <button class="icon-btn" type="button" @click="appStore.toggleSidebar()">
          <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
        </button>
      </el-tooltip>
      <span class="header__divider" />
      <div v-if="appStore.settings.showBreadcrumb" class="breadcrumb">
        <span v-if="group" class="breadcrumb__item">{{ group }}</span>
        <el-icon v-if="group" class="breadcrumb__sep"><ArrowRight /></el-icon>
        <span class="breadcrumb__item is-current">{{ title }}</span>
      </div>
    </div>

    <div class="header__right">
      <el-tooltip :content="appStore.isDark ? '切换为亮色' : '切换为暗色'" placement="bottom">
        <button class="icon-btn" type="button" @click="toggleTheme">
          <el-icon><component :is="appStore.isDark ? Sunny : Moon" /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="暂无新通知" placement="bottom">
        <button class="icon-btn is-badge" type="button">
          <el-icon><Bell /></el-icon>
        </button>
      </el-tooltip>
    </div>
  </header>
</template>

<style scoped>
.header {
  height: var(--header-height);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 24px 0 16px;
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-color);
  position: relative;
  z-index: 9;
}

.header__left,
.header__right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header__divider {
  width: 1px;
  height: 18px;
  background: var(--border-color);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.breadcrumb__item.is-current {
  color: var(--text-primary);
  font-weight: 600;
}

.breadcrumb__sep {
  font-size: 11px;
}

.icon-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.icon-btn.is-badge {
  position: relative;
}

.icon-btn.is-badge::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}
</style>
