<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import { useAppStore } from '@renderer/stores/app'

const appStore = useAppStore()
const router = useRouter()

/** 组件库语言跟随「系统设置 → 界面语言」，界面自有文案为中文 */
const locale = computed(() => (appStore.settings.language === 'en-US' ? en : zhCn))

onMounted(() => {
  // 全局快捷键：Ctrl+1/2/3 快速切换模块
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    const map: Record<string, string> = {
      '1': '/dashboard',
      '2': '/resources',
      '3': '/workflow',
      '4': '/settings',
      ',': '/settings'
    }
    const target = map[event.key]
    if (target) {
      event.preventDefault()
      void router.push(target)
    }
  })
})
</script>

<template>
  <el-config-provider :locale="locale">
    <router-view />
  </el-config-provider>
</template>
