import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIcons from '@element-plus/icons-vue'

import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@renderer/styles/variables.css'
import '@renderer/styles/index.css'

import App from '@renderer/App.vue'
import router from '@renderer/router'
import { useAppStore } from '@renderer/stores/app'

async function bootstrap(): Promise<void> {
  const app = createApp(App)

  // 记录运行平台，供样式区分 Windows 原生窗口按钮留白
  document.documentElement.dataset.platform = navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'other'

  app.use(createPinia())

  Object.entries(ElementPlusIcons).forEach(([name, component]) => {
    app.component(name, component)
  })

  app.use(ElementPlus, { locale: zhCn })

  // 先加载设置并应用主题，避免首屏出现白色闪屏
  const appStore = useAppStore()
  await appStore.load()

  app.use(router)
  await router.isReady()
  app.mount('#app')
}

void bootstrap()
