<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import type { ResourceInput, ResourceItem } from '@shared/types'

/** 通用表单弹窗：新建 / 编辑复用同一个组件 */
const props = defineProps<{
  modelValue: boolean
  record: ResourceItem | null
  categories: string[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [] }>()

const visible = ref(props.modelValue)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive<ResourceInput>({
  name: '',
  category: '默认分组',
  tags: [],
  description: '',
  score: 60,
  status: 'active'
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  category: [{ required: true, message: '请选择或输入分组', trigger: 'change' }]
}

watch(
  () => props.modelValue,
  (open) => {
    visible.value = open
    if (!open) return
    if (props.record) {
      Object.assign(form, {
        name: props.record.name,
        category: props.record.category,
        tags: [...props.record.tags],
        description: props.record.description,
        score: props.record.score,
        status: props.record.status
      })
    } else {
      Object.assign(form, {
        name: '',
        category: props.categories[0] ?? '默认分组',
        tags: [],
        description: '',
        score: 60,
        status: 'active'
      })
    }
  },
  { immediate: true }
)

watch(visible, (open) => emit('update:modelValue', open))

async function submit(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (props.record) {
      await window.api.resource.update(props.record.id, { ...form })
      ElMessage.success('已保存')
    } else {
      await window.api.resource.create({ ...form })
      ElMessage.success('已创建')
    }
    emit('saved')
    visible.value = false
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="record ? '编辑资源' : '新建资源'" width="520px" append-to-body>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="82px">
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" maxlength="32" show-word-limit placeholder="资源名称" />
      </el-form-item>
      <el-form-item label="分组" prop="category">
        <el-select
          v-model="form.category"
          filterable
          allow-create
          default-first-option
          class="full"
        >
          <el-option v-for="item in categories" :key="item" :label="item" :value="item" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-radio-group v-model="form.status">
          <el-radio-button value="active">运行中</el-radio-button>
          <el-radio-button value="paused">已暂停</el-radio-button>
          <el-radio-button value="draft">草稿</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="评分">
        <el-slider v-model="form.score" :min="0" :max="100" :step="1" show-input />
      </el-form-item>
      <el-form-item label="标签">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          class="full"
          placeholder="回车创建标签"
        />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="form.description" type="textarea" :rows="3" maxlength="200" show-word-limit />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.full {
  width: 100%;
}
</style>
