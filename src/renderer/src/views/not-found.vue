<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Back, Compass, DataBoard, WarningFilled } from '@element-plus/icons-vue'
import { useAppStore } from '@renderer/stores/app'

const appStore = useAppStore()
const route = useRoute()
const router = useRouter()

const currentPath = computed(() => route.fullPath)

function goHome(): void {
  void router.push('/dashboard')
}

function goBack(): void {
  if (window.history.length > 1) router.back()
  else void router.push('/dashboard')
}
</script>

<template>
  <div class="notfound">
    <!-- 独立页面的窗口拖拽条（404 路由不在主布局内） -->
    <header class="notfound__bar">
      <div class="notfound__brand">
        <span class="notfound__logo">数</span>
        <span class="notfound__brand-text">{{ appStore.systemName }}</span>
      </div>
      <span class="notfound__bar-hint">页面不存在</span>
    </header>

    <main class="notfound__main">
      <div class="notfound__glow notfound__glow--a" />
      <div class="notfound__glow notfound__glow--b" />

      <div class="notfound__content">
        <div class="notfound__visual">
          <span class="notfound__code">404</span>
          <span class="notfound__icon">
            <el-icon><Compass /></el-icon>
          </span>
        </div>

        <h1 class="notfound__title">页面走丢了</h1>
        <p class="notfound__desc">
          没有找到你访问的页面，链接可能已失效或地址输入有误。可以返回工作台继续操作。
        </p>

        <div class="notfound__path" :title="currentPath">
          <el-icon><WarningFilled /></el-icon>
          <span class="mono">{{ currentPath }}</span>
        </div>

        <div class="notfound__actions">
          <el-button type="primary" size="large" :icon="DataBoard" @click="goHome">
            返回工作台
          </el-button>
          <el-button size="large" :icon="Back" @click="goBack">返回上一页</el-button>
        </div>

        <nav class="notfound__links">
          <router-link to="/dashboard">工作台</router-link>
          <span class="divider-v" />
          <router-link to="/digital-human">数字人管理</router-link>
          <span class="divider-v" />
          <router-link to="/settings">系统设置</router-link>
        </nav>
      </div>
    </main>
  </div>
</template>

<style scoped>
.notfound {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-app);
  background-image: var(--bg-app-accent);
}

/* -------------------------------- 窗口拖拽条 ------------------------------- */
.notfound__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--titlebar-height);
  padding: 0 16px;
  color: var(--sidebar-text);
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--sidebar-border);
  -webkit-app-region: drag;
  user-select: none;
}

html[data-platform='win32'] .notfound__bar {
  padding-right: 148px;
}
.notfound__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.notfound__logo {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent-ink);
  background: linear-gradient(
    135deg,
    var(--accent),
    color-mix(in srgb, var(--accent) 45%, var(--info))
  );
}

.notfound__brand-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--sidebar-text-active);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notfound__bar-hint {
  margin-left: auto;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}

/* --------------------------------- 主体 ---------------------------------- */
.notfound__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 32px 24px;
  overflow: hidden;
}

.notfound__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(64px);
  pointer-events: none;
}

.notfound__glow--a {
  width: 420px;
  height: 420px;
  top: -120px;
  left: 12%;
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

.notfound__glow--b {
  width: 380px;
  height: 380px;
  right: 10%;
  bottom: -140px;
  background: color-mix(in srgb, var(--info) 20%, transparent);
}

.notfound__content {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: notfound-in var(--dur-slow) var(--ease-out) both;
}

/* --------------------------------- 404 视觉 ------------------------------- */
.notfound__visual {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notfound__code {
  font-size: clamp(96px, 15vw, 152px);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.05em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(
    120deg,
    var(--accent) 0%,
    color-mix(in srgb, var(--accent) 45%, var(--info)) 100%
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  opacity: 0.92;
}

.notfound__icon {
  position: absolute;
  right: -6px;
  bottom: 14px;
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 24px;
  color: var(--accent);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-md);
  animation: notfound-float 4.8s var(--ease-in-out) infinite;
}

/* --------------------------------- 文案 ---------------------------------- */
.notfound__title {
  margin: 6px 0 0;
  font-size: 23px;
  font-weight: 680;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.notfound__desc {
  margin: 10px 0 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-secondary);
  max-width: 430px;
}

.notfound__path {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  margin-top: 16px;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  font-size: 12px;
}

.notfound__path .el-icon {
  flex: none;
  color: var(--warning);
  font-size: 13px;
}

.notfound__path .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notfound__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
}

.notfound__links {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px dashed var(--border-color);
  font-size: 12.5px;
}

.notfound__links a {
  color: var(--text-secondary);
  transition: color var(--dur-fast) linear;
}

.notfound__links a:hover {
  color: var(--accent);
}

@keyframes notfound-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes notfound-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-7px);
  }
}
</style>
