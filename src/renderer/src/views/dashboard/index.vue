<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Connection, Plus, Refresh, Setting } from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@renderer/stores/app'
import { useResourceStore } from '@renderer/stores/resources'
import { RESOURCE_STATUS_META } from '@shared/constants'
import { formatDateTime } from '@renderer/utils/format'
import type { ResourceItem } from '@shared/types'

/** 工作台：欢迎区 + 关键指标 + 快捷入口（数据来自本地 store / 主进程） */
const appStore = useAppStore()
const resourceStore = useResourceStore()
const router = useRouter()
const { summary, items } = storeToRefs(resourceStore)

const today = computed(() =>
  new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
)

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '凌晨好'
  if (hour < 12) return '上午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const stats = computed(() => [
  { label: '资源总数', value: summary.value?.total ?? 0, hint: '本地数据库' },
  { label: '运行中', value: summary.value?.active ?? 0, hint: '状态为 active' },
  { label: '已暂停', value: summary.value?.paused ?? 0, hint: '可随时恢复' },
  { label: '草稿', value: summary.value?.draft ?? 0, hint: '未上线' }
])

onMounted(() => {
  void resourceStore.refresh()
  void appStore.loadPythonStatus()
})
</script>

<template>
  <div class="app-page">
    <section class="hero">
      <div class="hero__main">
        <p class="hero__date">{{ today }}</p>
        <h1 class="hero__title">{{ greeting }}，欢迎回来</h1>
        <p class="hero__desc">
          {{ appStore.systemName }} 是一个本地优先的 Electron + Vue 应用：数据保存在本机，
          工作流通过内置 Python 后端代理到 ComfyUI。
        </p>
        <div class="hero__actions">
          <el-button type="primary" :icon="Plus" @click="router.push('/resources')">
            管理资源
          </el-button>
          <el-button :icon="Connection" @click="router.push('/workflow')">打开工作流</el-button>
          <el-button :icon="Setting" plain @click="router.push('/settings')">系统设置</el-button>
        </div>
      </div>
      <div class="hero__badge">
        <span class="hero__badge-label">本地服务</span>
        <strong>{{ appStore.ready ? '就绪' : '初始化中' }}</strong>
        <span class="hero__badge-hint">Python {{ appStore.pythonStatus?.version || '未就绪' }}</span>
      </div>
    </section>

    <section class="stat-grid">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-card__label">{{ item.label }}</span>
        <strong class="stat-card__value num">{{ item.value }}</strong>
        <span class="stat-card__hint">{{ item.hint }}</span>
      </article>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">最近资源</h2>
          <p class="panel__subtitle">来自本地 JSON 数据库的最新 5 条记录</p>
        </div>
        <el-button link type="primary" @click="resourceStore.refresh()">刷新</el-button>
      </header>
      <div class="panel__body panel__body--flush">
        <el-table :data="items.slice(0, 5)" class="dash-table">
          <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
          <el-table-column prop="category" label="分组" width="140" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                effect="light"
                :type="RESOURCE_STATUS_META[row.status as ResourceItem['status']].tone"
              >
                {{ RESOURCE_STATUS_META[row.status as ResourceItem['status']].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="200">
            <template #default="{ row }">
              <span class="num text-muted">{{ formatDateTime(row.updatedAt, true) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 30px 32px;
  border-radius: var(--radius-xl);
  color: #fff;
  background:
    radial-gradient(600px 260px at 8% -10%, rgba(255, 255, 255, 0.22), transparent 60%),
    linear-gradient(120deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #1e1b4b));
  box-shadow: var(--shadow-lg);
}

.hero__date {
  margin: 0 0 8px;
  font-size: 12.5px;
  opacity: 0.8;
}

.hero__title {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 700;
}

.hero__desc {
  margin: 0 0 18px;
  max-width: 620px;
  font-size: 13px;
  line-height: 1.7;
  opacity: 0.88;
}

.hero__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.hero__badge {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 24px;
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(6px);
  text-align: center;
}

.hero__badge-label,
.hero__badge-hint {
  font-size: 11.5px;
  opacity: 0.8;
}

.hero__badge strong {
  font-size: 22px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.stat-card__label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.stat-card__value {
  font-size: 28px;
  font-weight: 650;
  color: var(--text-primary);
}

.stat-card__hint {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.dash-table {
  width: 100%;
}

@media (max-width: 1100px) {
  .hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
