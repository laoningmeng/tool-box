<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@renderer/stores/app'
import AppTitlebar from '@renderer/components/layout/AppTitlebar.vue'
import AppSidebar from '@renderer/components/layout/AppSidebar.vue'
import AppHeader from '@renderer/components/layout/AppHeader.vue'

const appStore = useAppStore()

const shellClass = computed(() => ({
  'is-collapsed': appStore.sidebarCollapsed
}))
</script>

<template>
  <div class="shell" :class="shellClass">
    <AppTitlebar />
    <div class="shell__body">
      <AppSidebar />
      <div class="shell__main">
        <AppHeader />
        <main class="shell__content">
          <!--
            不使用 <transition mode="out-in">：页面自身 .app-page 的入场动画已提供过渡感，
            而 out-in 在存在 Teleport 弹窗的页面之间切换时偶发「离开动画不结束」，
            会导致内容区停留在上一个页面（面包屑已更新、内容未换）。
          -->
          <router-view v-slot="{ Component, route }">
            <component :is="Component" :key="route.path" />
          </router-view>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.shell__main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  background: transparent;
}

.shell__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
}
</style>
