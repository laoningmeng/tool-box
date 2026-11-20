<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderAdd, Picture, Upload } from '@element-plus/icons-vue'

/** 纸娃娃系统 · 部件库（骨架页） */
interface PartRow {
  id: string
  name: string
  slot: string
  layer: number
  source: string
}

const parts = ref<PartRow[]>([])
const activeSlot = ref('all')

const slots = [
  { value: 'all', label: '全部' },
  { value: 'hair', label: '发型' },
  { value: 'head', label: '头饰' },
  { value: 'body', label: '身体' },
  { value: 'top', label: '上衣' },
  { value: 'bottom', label: '下装' },
  { value: 'shoes', label: '鞋子' },
  { value: 'accessory', label: '装饰' }
]

function pickParts(): void {
  ElMessage.info('从媒体库选择 / 导入部件图的接口还没接，后续在这里挂载 PNG 图层')
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">部件库</h1>
        <p class="page-desc">
          纸娃娃的换装素材：每个部件属于一个槽位，按图层顺序叠加到角色底图上。支持从媒体库挑选生成图作为部件。
        </p>
      </div>
      <div class="page-actions">
        <el-button :icon="FolderAdd" @click="pickParts">从媒体库选择</el-button>
        <el-button type="primary" :icon="Upload" @click="pickParts">导入部件</el-button>
      </div>
    </header>

    <section class="panel">
      <header class="panel__head">
        <div class="tabs">
          <button
            v-for="item in slots"
            :key="item.value"
            type="button"
            class="tab"
            :class="{ 'is-active': activeSlot === item.value }"
            @click="activeSlot = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <span class="text-muted">{{ parts.length }} 个部件</span>
      </header>
      <div class="panel__body">
        <el-empty v-if="!parts.length" description="还没有部件：接入后可从媒体库挑选图片，或直接导入 PNG 图层">
          <el-button type="primary" plain :icon="Picture" @click="pickParts">导入第一个部件</el-button>
        </el-empty>
        <el-table v-else :data="parts">
          <el-table-column prop="name" label="部件名" min-width="180" />
          <el-table-column prop="slot" label="槽位" width="120" />
          <el-table-column prop="layer" label="图层" width="90" />
          <el-table-column prop="source" label="来源" min-width="160" />
        </el-table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tab {
  padding: 5px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--dur-fast) linear;
}

.tab:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border-color));
}

.tab.is-active {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}
</style>
