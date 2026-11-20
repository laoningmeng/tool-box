<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Avatar,
  Box,
  Collection,
  Connection,
  DataBoard,
  Expand,
  FolderOpened,
  Setting
} from '@element-plus/icons-vue'
import { useAppStore } from '@renderer/stores/app'

/**
 * 侧边栏导航：一维菜单 + 可展开的二级菜单。
 * 新增模块只需在 navItems 里加一项，并在 router 中配置同名 path。
 */

interface NavChild {
  path: string
  title: string
}

interface NavItem {
  path: string
  title: string
  icon: unknown
  children?: NavChild[]
}

const navItems: NavItem[] = [
  { path: '/dashboard', title: '工作台', icon: DataBoard },
  { path: '/resources', title: '资源管理', icon: Box },
  {
    path: '/models',
    title: '3D 模型管理',
    icon: Collection,
    children: [
      { path: '/models', title: '模型列表' },
      { path: '/models/config', title: '配置管理' }
    ]
  },
  {
    path: '/paperdoll',
    title: '纸娃娃系统',
    icon: Avatar,
    children: [
      { path: '/paperdoll', title: '角色列表' },
      { path: '/paperdoll/parts', title: '部件库' },
      { path: '/paperdoll/studio', title: '换装台' }
    ]
  },
  {
    path: '/workflow',
    title: '工作流管理',
    icon: Connection,
    children: [
      { path: '/workflow', title: '流程列表' },
      { path: '/workflow/run', title: '执行流程' },
      { path: '/media', title: '媒体库' }
    ]
  },
  { path: '/settings', title: '系统设置', icon: Setting }
]

const appStore = useAppStore()
const route = useRoute()
const router = useRouter()

const collapsed = computed(() => appStore.sidebarCollapsed)
const activePath = computed(() => route.path)
const expanded = ref<string[]>(['/models', '/workflow', '/paperdoll'])

function isActive(path: string): boolean {
  return activePath.value === path || activePath.value.startsWith(`${path}/`)
}

function toggleGroup(item: NavItem): void {
  expanded.value = expanded.value.includes(item.path)
    ? expanded.value.filter((value) => value !== item.path)
    : [...expanded.value, item.path]
}

function groupOpen(item: NavItem): boolean {
  return expanded.value.includes(item.path)
}

function navigate(path: string): void {
  if (activePath.value !== path) void router.push(path)
}

watch(
  activePath,
  (path) => {
    const matched = navItems.find(
      (item) =>
        item.children?.length &&
        (path === item.path || item.children.some((child) => path.startsWith(child.path)))
    )
    if (matched && !expanded.value.includes(matched.path)) {
      expanded.value = [...expanded.value, matched.path]
    }
  },
  { immediate: true }
)
</script>

<template>
  <aside class="sidebar" :class="{ 'is-collapsed': collapsed }">
    <nav class="sidebar__nav">
      <template v-for="item in navItems" :key="item.path">
        <div
          class="nav-item"
          :class="{ 'is-active': isActive(item.path) && !item.children }"
          @click="item.children?.length ? toggleGroup(item) : navigate(item.path)"
        >
          <el-icon class="nav-item__icon"><component :is="item.icon" /></el-icon>
          <span v-if="!collapsed" class="nav-item__title">{{ item.title }}</span>
          <el-icon v-if="!collapsed && item.children?.length" class="nav-item__arrow">
            <component :is="groupOpen(item) ? Expand : Expand" />
          </el-icon>
        </div>
        <template v-if="item.children?.length && !collapsed && groupOpen(item)">
          <div
            v-for="child in item.children"
            :key="child.path"
            class="nav-sub"
            :class="{ 'is-active': activePath === child.path }"
            @click="navigate(child.path)"
          >
            <span class="nav-sub__dot" />
            <span class="nav-sub__title">{{ child.title }}</span>
          </div>
        </template>
      </template>
    </nav>

    <div class="sidebar__meta" :class="{ 'is-collapsed': collapsed }">
      <span class="sidebar__version">v{{ appStore.systemInfo?.appVersion ?? '1.0.0' }}</span>
      <span v-if="!collapsed" class="sidebar__meta-text">
        Python {{ appStore.pythonStatus?.version || '未就绪' }}
      </span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border-color);
  transition: width var(--dur-base) ease;
  overflow: hidden;
}

.sidebar.is-collapsed {
  width: 72px;
}

.sidebar__nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  color: var(--sidebar-text);
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.nav-item:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text-active);
}

.nav-item.is-active {
  background: var(--sidebar-active);
  color: var(--sidebar-text-active);
}

.nav-item__icon {
  font-size: 16px;
  flex: none;
}

.nav-item__title {
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
}

.nav-item__arrow {
  font-size: 11px;
  opacity: 0.6;
}

.nav-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  margin-left: 14px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  color: var(--sidebar-text);
  font-size: 12.5px;
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.nav-sub:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text-active);
}

.nav-sub.is-active {
  background: var(--sidebar-active);
  color: var(--sidebar-text-active);
}

.nav-sub__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}

.sidebar__meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--sidebar-border);
  color: var(--sidebar-text);
  font-size: 11.5px;
}

.sidebar__meta.is-collapsed {
  justify-content: center;
  padding: 12px 0;
}

.sidebar__version {
  font-family: var(--font-mono);
}
</style>
