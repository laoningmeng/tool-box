<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@renderer/stores/app'

const appStore = useAppStore()

const collapsed = computed(() => appStore.sidebarCollapsed)
const version = computed(() => appStore.systemInfo?.appVersion ?? '1.0.0')
const online = computed(() => appStore.ready)
</script>

<template>
  <header class="titlebar">
    <div class="titlebar__brand" :class="{ 'is-collapsed': collapsed }">
      <div class="titlebar__logo">{{ appStore.initial }}</div>
      <transition name="brand">
        <div v-if="!collapsed" class="titlebar__titles">
          <strong>{{ appStore.systemName }}</strong>
        </div>
      </transition>
    </div>

    <div class="titlebar__drag">
      <span class="titlebar__pill">v{{ version }}</span>
      <span class="titlebar__hint">本地运行 · 数据不出本机</span>
    </div>

    <div class="titlebar__status">
      <i class="titlebar__dot" :class="{ 'is-on': online }" />
      <span>{{ online ? '服务就绪' : '初始化中' }}</span>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: var(--titlebar-height);
  flex: none;
  color: var(--titlebar-fg);
  /* 渐变在 80% 处抵达终点色并保持纯色，保证右侧原生窗口按钮区的纯色 overlay 无缝衔接 */
  background: linear-gradient(
    90deg,
    var(--titlebar-bg-from) 0%,
    var(--titlebar-bg-mid) 55%,
    var(--titlebar-bg-to) 80%
  );
  border-bottom: 1px solid var(--titlebar-border);
  -webkit-app-region: drag;
  user-select: none;
  position: relative;
  z-index: 10;
}

html[data-platform='win32'] .titlebar {
  padding-right: 148px;
}

.titlebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  width: var(--sidebar-width);
  padding: 0 18px;
  flex: none;
  transition: width var(--dur-slow) var(--ease-out), padding var(--dur-slow) var(--ease-out);
}

.titlebar__brand.is-collapsed {
  width: var(--sidebar-width-collapsed);
  padding: 0 0 0 20px;
}

.titlebar__logo {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #22d3ee);
  box-shadow: 0 4px 14px -4px rgba(99, 102, 241, 0.9);
}

.titlebar__titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
  white-space: nowrap;
}

.titlebar__titles strong {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.titlebar__drag {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding-left: 6px;
}

.titlebar__pill {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  color: var(--titlebar-pill-fg);
  background: var(--titlebar-pill-bg);
  border: 1px solid var(--titlebar-pill-border);
  letter-spacing: 0.03em;
}

.titlebar__hint {
  font-size: 11.5px;
  color: var(--titlebar-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.titlebar__status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--titlebar-muted);
  padding-right: 4px;
  white-space: nowrap;
}

.titlebar__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
  transition: background var(--dur-base) linear;
}

.titlebar__dot.is-on {
  background: #34d399;
  color: #34d399;
  animation: pulse-dot 2.4s var(--ease-in-out) infinite;
}

.brand-enter-active,
.brand-leave-active {
  transition: opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.brand-enter-from,
.brand-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}
</style>
