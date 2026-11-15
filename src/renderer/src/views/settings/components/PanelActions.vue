<script setup lang="ts">
import { computed } from 'vue'
import { CircleCheck, InfoFilled, RefreshLeft } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    /** 是否存在未保存的本地修改 */
    dirty: boolean
    /** 是否正在保存 */
    saving?: boolean
  }>(),
  { saving: false }
)

const emit = defineEmits<{
  save: []
  discard: []
}>()

const saving = computed(() => props.saving)
</script>

<template>
  <footer class="panel-actions">
    <span class="panel-actions__state" :class="{ 'is-dirty': dirty }">
      <el-icon>
        <component :is="dirty ? InfoFilled : CircleCheck" />
      </el-icon>
      <span>{{ dirty ? '有未保存的修改' : '所有修改均已保存到本机' }}</span>
    </span>

    <div class="panel-actions__btns">
      <el-button :icon="RefreshLeft" :disabled="!dirty || saving" @click="emit('discard')">
        还原
      </el-button>
      <el-button type="primary" :loading="saving" :disabled="!dirty" @click="emit('save')">
        保存更改
      </el-button>
    </div>
  </footer>
</template>

<style scoped>
.panel-actions {
  position: sticky;
  bottom: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 18px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow-md);
}

.panel-actions__state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  transition: color var(--dur-fast) linear;
}

.panel-actions__state .el-icon {
  font-size: 14px;
}

.panel-actions__state.is-dirty {
  color: var(--warning);
}

.panel-actions__btns {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
