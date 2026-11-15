<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight } from '@element-plus/icons-vue'

/**
 * 可折叠面板区块。
 * - 标题整行可点，箭头旋转表示开合
 * - open 状态按 storageKey 存 localStorage，刷新/重启后保持
 * - actions 插槽放右侧操作按钮（不会触发折叠）
 */
const props = withDefaults(
  defineProps<{
    title: string
    count?: string | number
    storageKey?: string
    defaultOpen?: boolean
    /** 强调样式（精修这类"当前正在进行"的区块） */
    tone?: 'default' | 'accent'
  }>(),
  { count: undefined, storageKey: '', defaultOpen: true, tone: 'default' }
)

const STORAGE_PREFIX = 'lab:section:'

function readInitial(): boolean {
  if (!props.storageKey) return props.defaultOpen
  const raw = localStorage.getItem(STORAGE_PREFIX + props.storageKey)
  if (raw === null) return props.defaultOpen
  return raw === '1'
}

const open = ref(readInitial())

function toggle(): void {
  open.value = !open.value
  if (props.storageKey) {
    localStorage.setItem(STORAGE_PREFIX + props.storageKey, open.value ? '1' : '0')
  }
}
</script>

<template>
  <section class="panel-section" :class="[`is-${tone}`, { 'is-collapsed': !open }]">
    <div class="panel-section__head">
      <button class="panel-section__toggle" type="button" @click="toggle">
        <el-icon class="panel-section__chevron" :class="{ 'is-open': open }"><ArrowRight /></el-icon>
        <span class="panel-section__title">{{ title }}</span>
        <span v-if="count !== undefined && count !== ''" class="panel-section__count">{{ count }}</span>
      </button>
      <span class="panel-section__actions">
        <slot name="actions" />
      </span>
    </div>
    <div v-show="open" class="panel-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
}

.panel-section.is-accent {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.panel-section__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}

.panel-section__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
}

.panel-section__toggle:hover {
  color: var(--text-secondary);
}

.panel-section__chevron {
  font-size: 11px;
  transition: transform var(--dur-fast) ease;
}

.panel-section__chevron.is-open {
  transform: rotate(90deg);
}

.panel-section__title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel-section__count {
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-section__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.panel-section__actions :deep(.el-button) {
  height: 22px;
  padding: 0 8px;
  font-size: 11.5px;
  margin-left: 0;
}

.panel-section__actions :deep(.el-button.is-icon-only) {
  width: 24px;
  padding: 0;
}

.panel-section__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
</style>
