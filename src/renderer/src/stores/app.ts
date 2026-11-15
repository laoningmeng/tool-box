import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings, AppSystemInfo, PythonStatus } from '@shared/types'
import { defaultSettings } from '@shared/seed'

/**
 * 应用级 store：设置、主题、侧栏折叠、系统信息、Python 运行时状态。
 * 主题色与暗色模式都通过 CSS 变量注入，组件里只使用变量。
 */

function applyAccent(color: string): void {
  const root = document.documentElement
  root.style.setProperty('--accent', color)
  // 生成 Element Plus 的 primary 色阶（light-1..9 / dark-2）
  const rgb = hexToRgb(color)
  if (!rgb) return
  for (let index = 1; index <= 9; index += 1) {
    const ratio = index / 10
    const mixed = {
      r: Math.round(rgb.r + (255 - rgb.r) * ratio),
      g: Math.round(rgb.g + (255 - rgb.g) * ratio),
      b: Math.round(rgb.b + (255 - rgb.b) * ratio)
    }
    root.style.setProperty(`--el-color-primary-light-${index}`, `rgb(${mixed.r}, ${mixed.g}, ${mixed.b})`)
  }
  const dark = {
    r: Math.round(rgb.r * 0.8),
    g: Math.round(rgb.g * 0.8),
    b: Math.round(rgb.b * 0.8)
  }
  root.style.setProperty('--el-color-primary-dark-2', `rgb(${dark.r}, ${dark.g}, ${dark.b})`)
  root.style.setProperty('--el-color-primary', color)
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!match) return null
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
}

export const useAppStore = defineStore('app', () => {
  const settings = ref<AppSettings>({ ...defaultSettings })
  const systemInfo = ref<AppSystemInfo | null>(null)
  const pythonStatus = ref<PythonStatus | null>(null)
  const sidebarCollapsed = ref(localStorage.getItem('app:sidebar') === '1')
  const ready = ref(false)
  const loadingSystemInfo = ref(false)
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')

  const isDark = computed(() => {
    if (settings.value.themeMode === 'dark') return true
    if (settings.value.themeMode === 'light') return false
    return darkMedia.matches
  })

  const systemName = computed(() => settings.value.systemName || '穷哥们的工具箱')
  const tagline = computed(() => 'TOOLBOX STUDIO')
  const initial = computed(() => systemName.value.slice(0, 1))

  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', isDark.value)
    applyAccent(settings.value.accentColor || '#4f46e5')
    applyTitlebar()
  }

  /**
   * 同步 Windows 原生窗口按钮区的底色。
   * 自绘标题栏是深色玻璃，右上角那块由 titleBarOverlay 铺纯色，
   * 不跟着标题栏走就会出现「右上角和主题不符」的白块。
   */
  function applyTitlebar(): void {
    const styles = getComputedStyle(document.documentElement)
    const color = styles.getPropertyValue('--titlebar-overlay').trim() || '#0b1220'
    const symbolColor = styles.getPropertyValue('--titlebar-symbol').trim() || '#e2e8f0'
    window.api.window.setTitlebar({ color, symbolColor })
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
    localStorage.setItem('app:sidebar', sidebarCollapsed.value ? '1' : '0')
  }

  async function load(): Promise<void> {
    settings.value = await window.api.settings.get()
    applyTheme()
    void loadSystemInfo()
    void loadPythonStatus()
  }

  async function loadSystemInfo(): Promise<void> {
    loadingSystemInfo.value = true
    try {
      systemInfo.value = await window.api.system.info()
    } catch {
      systemInfo.value = null
    } finally {
      loadingSystemInfo.value = false
    }
  }

  async function loadPythonStatus(): Promise<void> {
    try {
      pythonStatus.value = await window.api.python.status()
    } catch {
      pythonStatus.value = null
    }
  }

  async function save(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await window.api.settings.save(patch)
    applyTheme()
  }

  async function reset(): Promise<void> {
    settings.value = await window.api.settings.reset()
    applyTheme()
  }

  function markReady(value: boolean): void {
    ready.value = value
  }

  darkMedia.addEventListener('change', () => {
    if (settings.value.themeMode === 'system') applyTheme()
  })

  return {
    settings,
    systemInfo,
    pythonStatus,
    sidebarCollapsed,
    ready,
    isDark,
    systemName,
    tagline,
    initial,
    load,
    loadSystemInfo,
    loadPythonStatus,
    save,
    reset,
    applyTheme,
    toggleSidebar,
    markReady,
    loadingSystemInfo,
    /** 兼容旧调用：init 等同 load */
    init: load
  }
})
