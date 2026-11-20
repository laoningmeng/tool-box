<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, VideoPlay } from '@element-plus/icons-vue'
import { COMFY_SAMPLE_SIZE } from '@shared/constants'
import type { ComfyInputs, ComfyWorkflow } from '@shared/types'
import { useWorkflowStore } from '@renderer/stores/workflow'

/** 执行流程：选择流程 → 填参数 → 运行 → 轮询进度 → 展示结果 */
const store = useWorkflowStore()
const route = useRoute()

const selectedId = ref('')
const form = ref({
  prompt: 'a cinematic photo, soft rim light, 8k',
  negative: 'blurry, low quality',
  size: '1024x1024',
  steps: 28,
  cfg: 7,
  seed: -1
})

const selected = computed<ComfyWorkflow | null>(
  () => store.workflows.find((item) => item.id === selectedId.value) ?? null
)

/** 参考图槽位：按流程里的 LoadImage 数量动态生成 */
const imageSlots = computed(() => selected.value?.imageInputs ?? 0)
const sizeOptions = computed(() => {
  const list = [...COMFY_SAMPLE_SIZE]
  if (!list.includes(form.value.size)) list.unshift(form.value.size)
  return list
})

// 切换流程时按流程自带的采样默认值预填（turbo 流程是 steps 8 / cfg 1，不能套用通用 28/7）
watch(
  selected,
  (workflow) => {
    const defaults = workflow?.defaults
    if (!defaults) return
    if (Number.isFinite(defaults.steps)) form.value.steps = defaults.steps as number
    if (Number.isFinite(defaults.cfg)) form.value.cfg = defaults.cfg as number
    if (Number.isFinite(defaults.width) && Number.isFinite(defaults.height)) {
      form.value.size = `${defaults.width}x${defaults.height}`
    }
  },
  { immediate: true }
)
const referenceImages = ref<Array<{ name: string } | null>>([])
const uploadingSlot = ref(-1)
const lastSeed = ref<number | null>(null)

watch(imageSlots, (count) => {
  const next: Array<{ name: string } | null> = []
  for (let index = 0; index < count; index += 1) next.push(referenceImages.value[index] ?? null)
  referenceImages.value = next
  if (count > 0 && form.value.prompt.includes('cinematic photo')) {
    form.value.prompt = '保持角色特征，生成统一的画面风格'
  }
})

async function pickReference(index: number): Promise<void> {
  uploadingSlot.value = index
  try {
    const result = await window.api.comfy.uploadImage()
    if (!result.ok || !result.name) return
    const next = [...referenceImages.value]
    next[index] = { name: result.name }
    referenceImages.value = next
    ElMessage.success(`参考图已上传：${result.name}`)
  } catch (error) {
    ElMessage.error(`上传失败：${(error as Error).message}`)
  } finally {
    uploadingSlot.value = -1
  }
}

function clearReference(index: number): void {
  const next = [...referenceImages.value]
  next[index] = null
  referenceImages.value = next
}

const progress = computed(() => Math.round((store.job?.progress ?? 0) * 100))

const runnableWorkflows = computed(() => store.workflows.filter((item) => item.runnable))

onMounted(async () => {
  await store.refresh()
  const queryId = String(route.query.id ?? '')
  selectedId.value =
    runnableWorkflows.value.find((item) => item.id === queryId)?.id ?? runnableWorkflows.value[0]?.id ?? ''
})

onBeforeUnmount(() => store.stopPolling())

async function start(): Promise<void> {
  if (!selected.value) {
    ElMessage.warning('请先选择可执行的流程')
    return
  }
  const [width, height] = form.value.size.split('x').map((value) => Number(value))
  const usedSeed = form.value.seed >= 0 ? form.value.seed : Math.floor(Math.random() * 1_000_000)
  lastSeed.value = usedSeed
  const images = referenceImages.value
    .map((item) => item?.name)
    .filter((name): name is string => Boolean(name))
  if (imageSlots.value > 0 && images.length === 0) {
    ElMessage.warning('这个流程需要参考图，请先上传')
    return
  }
  const inputs: ComfyInputs = {
    prompt: form.value.prompt.trim(),
    images: images.length > 0 ? images : undefined,
    negative: form.value.negative.trim(),
    width,
    height,
    steps: form.value.steps,
    cfg: form.value.cfg,
    seed: usedSeed
  }
  try {
    await store.run(selected.value, inputs)
    ElMessage.success('已提交任务')
  } catch (error) {
    ElMessage.error(`提交失败：${(error as Error).message}`)
  }
}

function download(item: { filename: string; dataUrl: string }): void {
  const link = document.createElement('a')
  link.href = item.dataUrl
  link.download = item.filename
  link.click()
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">执行流程</h1>
        <p class="page-desc">
          选择一个可执行流程，填写参数后提交到 ComfyUI；进度与结果由本地后端轮询返回。
        </p>
      </div>
      <el-button type="primary" :icon="VideoPlay" :loading="store.running" @click="start">
        开始生成
      </el-button>
    </header>

    <div class="run-grid">
      <section class="panel">
        <header class="panel__head">
          <div>
            <h2 class="panel__title">参数</h2>
            <p class="panel__subtitle">
              参数会按节点类型注入到流程图中
              <template v-if="selected?.defaults?.steps">
                · 已按流程默认值预填（{{ selected.defaults.steps }} 步 / CFG {{ selected.defaults.cfg }}）
              </template>
            </p>
          </div>
        </header>
        <div class="panel__body">
          <el-form label-position="top">
            <el-form-item label="流程">
              <el-select v-model="selectedId" class="full" placeholder="选择可执行流程">
                <el-option
                  v-for="item in runnableWorkflows"
                  :key="item.id"
                  :label="`${item.name} · ${item.nodeCount} 节点`"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item :label="selected?.category === 't2a' ? '音效描述' : selected?.category === 'split' ? '拆分方向（可选）' : '提示词'">
              <el-input v-model="form.prompt" type="textarea" :rows="3" maxlength="500" show-word-limit />
            </el-form-item>
            <el-form-item v-if="imageSlots > 0" :label="`参考图（${imageSlots} 张）`">
              <div class="refs">
                <div v-for="(slot, index) in referenceImages" :key="index" class="refs__slot">
                  <template v-if="slot">
                    <span class="refs__name mono">{{ slot.name }}</span>
                    <div class="refs__actions">
                      <el-button link type="primary" size="small" @click="pickReference(index)">换一张</el-button>
                      <el-button link type="danger" size="small" @click="clearReference(index)">移除</el-button>
                    </div>
                  </template>
                  <template v-else>
                    <span class="refs__empty">第 {{ index + 1 }} 张</span>
                    <el-button size="small" :loading="uploadingSlot === index" @click="pickReference(index)">
                      选择图片
                    </el-button>
                  </template>
                </div>
              </div>
            </el-form-item>
            <el-form-item label="负向提示词">
              <el-input v-model="form.negative" type="textarea" :rows="2" maxlength="300" />
            </el-form-item>
            <div class="grid-2">
              <el-form-item label="尺寸">
                <el-select v-model="form.size">
                  <el-option v-for="item in sizeOptions" :key="item" :label="item" :value="item" />
                </el-select>
              </el-form-item>
              <el-form-item label="随机种子 (-1 随机)">
                <el-input-number v-model="form.seed" :min="-1" :max="99999999" class="full" />
              </el-form-item>
              <el-form-item label="步数">
                <el-input-number v-model="form.steps" :min="1" :max="80" class="full" />
              </el-form-item>
              <el-form-item label="CFG">
                <el-input-number v-model="form.cfg" :min="1" :max="20" :step="0.5" class="full" />
              </el-form-item>
            </div>
          </el-form>
        </div>
      </section>

      <section class="panel">
        <header class="panel__head">
          <div>
            <h2 class="panel__title">结果</h2>
            <p class="panel__subtitle">
              {{ store.job?.message || '尚未开始' }}
              <span v-if="lastSeed !== null" class="seed-hint num">· 种子 {{ lastSeed }}</span>
            </p>
          </div>
        </header>
        <div class="panel__body">
          <el-progress
            v-if="store.job"
            :percentage="progress"
            :status="store.job.status === 'failed' ? 'exception' : undefined"
          />
          <div v-if="store.outputs.length" class="gallery">
            <figure v-for="item in store.outputs" :key="item.filename" class="gallery__item">
              <img v-if="item.type === 'image'" :src="item.dataUrl" :alt="item.filename" />
              <video v-else :src="item.dataUrl" controls />
              <figcaption>
                <span class="mono text-muted">{{ item.filename }}</span>
                <el-button link type="primary" size="small" :icon="Download" @click="download(item)">
                  下载
                </el-button>
              </figcaption>
            </figure>
          </div>
          <el-empty v-else :description="store.running ? '生成中，请稍候' : '提交后在这里查看结果'" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.seed-hint {
  margin-left: 4px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.run-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 16px;
  align-items: start;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.full {
  width: 100%;
}

.refs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
}

.refs__slot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-size: 11.5px;
}

.refs__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.refs__empty {
  color: var(--text-tertiary);
}

.refs__actions {
  display: flex;
  gap: 4px;
}

.gallery {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.gallery__item {
  margin: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--bg-subtle);
}

.gallery__item img,
.gallery__item video {
  width: 100%;
  display: block;
}

.gallery__item figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
}

@media (max-width: 1100px) {
  .run-grid {
    grid-template-columns: 1fr;
  }
}
</style>
