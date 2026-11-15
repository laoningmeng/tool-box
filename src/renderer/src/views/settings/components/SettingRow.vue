<script setup lang="ts">
/** 设置项行：左侧标题 + 说明，右侧控件插槽。 */
defineProps<{
  /** 设置项名称 */
  title: string
  /** 一句灰色说明文字，解释该设置的作用 */
  desc?: string
}>()
</script>

<template>
  <div class="setting-row">
    <div class="setting-row__meta">
      <span class="setting-row__title">{{ title }}</span>
      <span v-if="desc" class="setting-row__desc">{{ desc }}</span>
    </div>
    <div class="setting-row__control">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: 1px dashed var(--border-color);
}

.setting-row:first-child {
  padding-top: 2px;
}

.setting-row:last-child {
  padding-bottom: 2px;
  border-bottom: none;
}

.setting-row__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  max-width: 420px;
}

.setting-row__title {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--text-primary);
  line-height: 1.5;
}

.setting-row__desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

.setting-row__control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 1 330px;
  min-width: 200px;
  padding-top: 1px;
}

.setting-row__control :deep(.el-input),
.setting-row__control :deep(.el-select),
.setting-row__control :deep(.el-input-number) {
  width: 100%;
}

@media (max-width: 980px) {
  .setting-row {
    flex-direction: column;
    gap: 10px;
  }

  .setting-row__control {
    flex: none;
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
