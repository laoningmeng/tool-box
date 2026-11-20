<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Avatar, Grid, MagicStick, Plus, ShoppingBag } from '@element-plus/icons-vue'

/** 纸娃娃系统 · 角色列表（骨架页：数据结构与接口后续接入） */
const router = useRouter()
const loading = ref(false)
const characters = ref<Array<{ id: string; name: string; slotCount: number }>>([])

const stats = computed(() => ({
  characters: characters.value.length,
  slots: 0,
  outfits: 0
}))

const modules = [
  {
    path: '/paperdoll/parts',
    title: '部件库',
    caption: '头 / 身体 / 手臂 / 腿 / 装饰等可换装部件',
    icon: Grid
  },
  {
    path: '/paperdoll/studio',
    title: '换装台',
    caption: '选角色 → 勾选部件 → 实时预览与导出',
    icon: MagicStick
  }
]

function createCharacter(): void {
  ElMessage.info('角色管理的数据结构与接口还没接，先在「换装台」规划好部件槽位再回来')
}

function openModule(path: string): void {
  void router.push(path)
}

onMounted(() => {
  loading.value = false
})
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">纸娃娃系统</h1>
        <p class="page-desc">
          2D 角色换装：角色按槽位拼装部件，部件可复用、可分层导出。当前为模块骨架，数据接入后在这里管理角色与换装方案。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="createCharacter">新建角色</el-button>
    </header>

    <section class="overview">
      <article class="stat-card">
        <span class="stat-card__label">角色</span>
        <strong class="stat-card__value num">{{ stats.characters }}</strong>
        <span class="stat-card__hint">换装主体</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">部件</span>
        <strong class="stat-card__value num">{{ stats.slots }}</strong>
        <span class="stat-card__hint">可换装素材</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">换装方案</span>
        <strong class="stat-card__value num">{{ stats.outfits }}</strong>
        <span class="stat-card__hint">保存的成套搭配</span>
      </article>
    </section>

    <section class="module-grid">
      <article
        v-for="item in modules"
        :key="item.path"
        class="module-card"
        role="button"
        tabindex="0"
        @click="openModule(item.path)"
        @keyup.enter="openModule(item.path)"
      >
        <el-icon class="module-card__icon"><component :is="item.icon" /></el-icon>
        <div class="module-card__body">
          <strong>{{ item.title }}</strong>
          <span class="text-muted">{{ item.caption }}</span>
        </div>
      </article>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">角色列表</h2>
          <p class="panel__subtitle">每个角色对应一套槽位定义，部件按槽位挂载</p>
        </div>
      </header>
      <div class="panel__body">
        <el-empty v-loading="loading" description="还没有角色：数据接入后可在这里新建角色并配置槽位" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.stat-card__label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.stat-card__value {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.stat-card__hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.module-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color var(--dur-fast) linear, transform var(--dur-fast) linear;
}

.module-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color));
  transform: translateY(-1px);
}

.module-card__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--accent-softer);
  color: var(--accent);
  font-size: 18px;
  flex: none;
}

.module-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .overview,
  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
