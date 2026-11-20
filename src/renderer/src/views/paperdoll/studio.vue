<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, MagicStick, RefreshLeft, ZoomIn } from '@element-plus/icons-vue'

/** 纸娃娃系统 · 换装台（骨架页）：左角色 / 中预览 / 右部件槽位 */
const characterName = ref('')
const zoom = ref(100)
const slots = [
  { key: 'hair', label: '发型' },
  { key: 'head', label: '头饰' },
  { key: 'body', label: '身体' },
  { key: 'top', label: '上衣' },
  { key: 'bottom', label: '下装' },
  { key: 'shoes', label: '鞋子' },
  { key: 'accessory', label: '装饰' }
]

function notify(): void {
  ElMessage.info('换装数据层还没接：先把部件库与角色槽位定义好，这里就能实时拼装')
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">换装台</h1>
        <p class="page-desc">
          选角色 → 按槽位勾选部件 → 实时预览图层叠加效果，可导出整套换装方案。
        </p>
      </div>
      <div class="page-actions">
        <el-button :icon="Download" @click="notify">导出换装图</el-button>
        <el-button type="primary" :icon="MagicStick" @click="notify">保存方案</el-button>
      </div>
    </header>

    <div class="studio">
      <aside class="panel studio__side">
        <header class="panel__head">
          <h2 class="panel__title">角色</h2>
        </header>
        <div class="panel__body">
          <el-empty description="还没有角色" :image-size="80" />
        </div>
      </aside>

      <section class="panel studio__stage">
        <header class="panel__head">
          <h2 class="panel__title">预览</h2>
          <div class="stage-tools">
            <el-button size="small" :icon="ZoomIn" @click="zoom = Math.min(200, zoom + 10)">
              {{ zoom }}%
            </el-button>
            <el-button size="small" :icon="RefreshLeft" @click="zoom = 100">复位</el-button>
          </div>
        </header>
        <div class="panel__body studio__canvas">
          <div class="canvas-placeholder" :style="{ transform: `scale(${zoom / 100})` }">
            <el-icon><MagicStick /></el-icon>
            <strong>换装预览区</strong>
            <span>角色底图 + 部件图层叠加会显示在这里</span>
          </div>
        </div>
      </section>

      <aside class="panel studio__side">
        <header class="panel__head">
          <h2 class="panel__title">部件槽位</h2>
          <span class="text-muted">{{ slots.length }} 个槽位</span>
        </header>
        <div class="panel__body slot-list">
          <div v-for="slot in slots" :key="slot.key" class="slot-row">
            <span class="slot-row__name">{{ slot.label }}</span>
            <span class="slot-row__value text-muted">未选择</span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}

.studio {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 260px;
  gap: 12px;
  min-height: 520px;
}

.studio__side,
.studio__stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.studio__canvas {
  flex: 1;
  display: grid;
  place-items: center;
  background:
    linear-gradient(45deg, var(--bg-subtle) 25%, transparent 25%),
    linear-gradient(-45deg, var(--bg-subtle) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--bg-subtle) 75%),
    linear-gradient(-45deg, transparent 75%, var(--bg-subtle) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}

.canvas-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 28px 34px;
  border-radius: var(--radius-lg);
  border: 1px dashed color-mix(in srgb, var(--accent) 40%, var(--border-color));
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  transition: transform var(--dur-fast) linear;
}

.canvas-placeholder .el-icon {
  font-size: 26px;
  color: var(--accent);
}

.stage-tools {
  display: flex;
  gap: 6px;
}

.slot-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.slot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  font-size: 12px;
}

.slot-row__value {
  font-size: 11px;
}

@media (max-width: 1200px) {
  .studio {
    grid-template-columns: 1fr;
  }
}
</style>
