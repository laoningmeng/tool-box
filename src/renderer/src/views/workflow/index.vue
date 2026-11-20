<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Link, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { WORKFLOW_CATEGORIES, WORKFLOW_CATEGORY_META } from '@shared/constants'
import type { ComfyParseReport, ComfyWorkflow, WorkflowCategory } from '@shared/types'
import { useWorkflowStore } from '@renderer/stores/workflow'

/**
 * 流程列表：上传 / 解析 / 入库 / 删除，并展示 ComfyUI 连接状态。
 * 解析逻辑在主进程（services/workflow.ts），这里只负责确认与展示。
 */

const store = useWorkflowStore()
const router = useRouter()

const activeCategory = ref<WorkflowCategory | 'all'>('all')
const parseVisible = ref(false)
const parsing = ref(false)
const parsed = ref<{ report: ComfyParseReport; graph: Record<string, unknown> } | null>(null)
const form = reactive({ name: '', category: 't2i' as WorkflowCategory, description: '', tags: '' })

const filtered = computed(() =>
  activeCategory.value === 'all'
    ? store.workflows
    : store.workflows.filter((item) => item.category === activeCategory.value)
)

const counts = computed(() => {
  const map: Record<string, number> = { all: store.workflows.length }
  for (const category of WORKFLOW_CATEGORIES) {
    map[category] = store.workflows.filter((item) => item.category === category).length
  }
  return map
})

onMounted(async () => {
  await Promise.all([store.refresh(), store.loadStatus()])
})

async function handleUpload(): Promise<void> {
  if (parsing.value) return
  parsing.value = true
  try {
    const result = await store.parseFile()
    if (!result.ok || !result.report || !result.graph) {
      if (!result.canceled && result.report?.warnings?.length) {
        ElMessage.warning(result.report.warnings[0])
      }
      return
    }
    parsed.value = { report: result.report, graph: result.graph }
    form.name = result.report.fileName.replace(/\.json$/i, '')
    form.category = result.report.category ?? 't2i'
    form.description = ''
    form.tags = result.report.models.slice(0, 2).join(',')
    parseVisible.value = true
  } catch (error) {
    ElMessage.error(`解析失败：${(error as Error).message}`)
  } finally {
    parsing.value = false
  }
}

async function confirmUpload(): Promise<void> {
  if (!parsed.value) return
  if (!parsed.value.report.runnable) {
    ElMessage.warning('该流程无法直接执行，已作为「仅存档」保存')
  }
  try {
    await store.upload({
      fileName: parsed.value.report.fileName,
      name: form.name.trim() || '未命名流程',
      category: form.category,
      graph: parsed.value.graph,
      description: form.description,
      tags: form.tags
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      runnable: parsed.value.report.runnable,
      format: parsed.value.report.format
    })
    ElMessage.success('已保存到流程库')
    parseVisible.value = false
    parsed.value = null
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  }
}

async function handleRemove(item: ComfyWorkflow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${item.name}」？`, '删除流程', { type: 'warning' })
  } catch {
    return
  }
  await store.remove(item.id)
  ElMessage.success('已删除')
}

function useWorkflow(item: ComfyWorkflow): void {
  void router.push({ path: '/workflow/run', query: { id: item.id } })
}

function openComfy(): void {
  void window.api.comfy.openComfy()
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          流程列表
          <span class="chip">{{ store.workflows.length }} 个流程</span>
        </h1>
        <p class="page-desc">
          上传并解析 ComfyUI 流程：API 格式（Save (API Format)）或界面格式（Save，含子图会自转换），入库后可到「执行流程」页运行。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Link" @click="openComfy">打开 ComfyUI</el-button>
        <el-button :icon="Refresh" :loading="store.loading" @click="store.refresh()">刷新</el-button>
        <el-button type="primary" :icon="Plus" :loading="parsing" @click="handleUpload">
          上传流程
        </el-button>
      </div>
    </header>

    <section class="panel status-bar" :class="{ 'is-offline': !store.connected }">
      <el-icon><Connection /></el-icon>
      <span v-if="store.statusLoading">正在检测 ComfyUI 连接…</span>
      <span v-else-if="store.connected">
        已连接 {{ store.status?.url }} · {{ store.status?.version || '版本未知' }}
        <template v-if="store.status?.device"> · {{ store.status.device }}</template>
        <template v-if="store.status?.vram"> · 显存 {{ store.status.vram }}</template>
      </span>
      <span v-else>
        ComfyUI 未连接：{{ store.status?.error || '请先启动 ComfyUI' }}
      </span>
      <el-button link type="primary" @click="store.loadStatus()">重新检测</el-button>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ 'is-active': activeCategory === 'all' }"
            @click="activeCategory = 'all'"
          >
            全部 {{ counts.all }}
          </button>
          <button
            v-for="category in WORKFLOW_CATEGORIES"
            :key="category"
            type="button"
            class="tab"
            :class="{ 'is-active': activeCategory === category }"
            @click="activeCategory = category"
          >
            {{ WORKFLOW_CATEGORY_META[category].label }} {{ counts[category] }}
          </button>
        </div>
      </header>
      <div class="panel__body panel__body--flush">
        <el-empty v-if="!filtered.length" description="还没有流程，点右上角「上传流程」导入一个" />
        <el-table v-else :data="filtered">
          <el-table-column label="名称" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.name }}</span>
              <span v-if="row.builtin" class="chip chip--sm chip--builtin">内置</span>
              <span v-if="row.imageInputs" class="chip chip--sm">{{ row.imageInputs }} 张参考图</span>
            </template>
          </el-table-column>
          <el-table-column label="分类" width="110">
            <template #default="{ row }">
              <span class="chip">{{ WORKFLOW_CATEGORY_META[row.category as WorkflowCategory].label }}</span>
            </template>
          </el-table-column>
          <el-table-column label="节点" width="80">
            <template #default="{ row }">
              <span class="num">{{ row.nodeCount }}</span>
            </template>
          </el-table-column>
          <el-table-column label="模型" min-width="200">
            <template #default="{ row }">
              <span v-for="model in row.models.slice(0, 2)" :key="model" class="chip chip--sm mono">
                {{ model }}
              </span>
              <span v-if="row.models.length > 2" class="text-muted">+{{ row.models.length - 2 }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="132">
            <template #default="{ row }">
              <el-tag size="small" :type="row.runnable ? 'success' : 'warning'" effect="light">
                {{ row.runnable ? '可执行' : '仅存档' }}
              </el-tag>
              <span class="chip chip--sm mono">{{ row.format === 'comfy-ui' ? '界面格式' : 'API' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" :disabled="!row.runnable" @click="useWorkflow(row)">
                使用
              </el-button>
              <el-button link type="danger" size="small" @click="handleRemove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <!-- 解析确认弹窗 -->
    <el-dialog v-model="parseVisible" title="解析流程文件" width="660px" append-to-body>
      <div v-if="parsed" class="parse">
        <div class="parse__head">
          <strong>{{ parsed.report.fileName }}</strong>
          <span class="chip">{{ parsed.report.format === 'comfy-ui' ? '界面格式（运行时自动转 API）' : parsed.report.format }}</span>
          <span class="chip">{{ parsed.report.nodeCount }} 节点</span>
          <el-tag size="small" :type="parsed.report.runnable ? 'success' : 'warning'">
            {{ parsed.report.runnable ? '可执行' : '仅存档' }}
          </el-tag>
        </div>
        <el-alert
          v-for="(warning, index) in parsed.report.warnings"
          :key="index"
          type="warning"
          :closable="false"
          show-icon
          :title="warning"
          class="parse__alert"
        />
        <div class="parse__grid">
          <div>
            <p class="parse__label">节点构成</p>
            <div class="parse__chips">
              <span v-for="row in parsed.report.classTypes" :key="row.classType" class="chip mono">
                {{ row.classType }}<template v-if="row.count > 1"> ×{{ row.count }}</template>
              </span>
            </div>
          </div>
          <div>
            <p class="parse__label">引用模型</p>
            <div class="parse__chips">
              <span v-for="model in parsed.report.models" :key="model" class="chip mono">{{ model }}</span>
              <span v-if="!parsed.report.models.length" class="text-muted">未识别到模型</span>
            </div>
          </div>
        </div>
        <el-form label-width="76px">
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="40" show-word-limit />
          </el-form-item>
          <el-form-item label="分类">
            <el-radio-group v-model="form.category">
              <el-radio-button
                v-for="category in WORKFLOW_CATEGORIES"
                :key="category"
                :value="category"
              >
                {{ WORKFLOW_CATEGORY_META[category].label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="标签">
            <el-input v-model="form.tags" placeholder="逗号分隔" />
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="form.description" type="textarea" :rows="2" maxlength="200" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="parseVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmUpload">保存到流程库</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.chip--builtin {
  margin-left: 6px;
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.page-head__actions {
  display: flex;
  gap: 8px;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.status-bar.is-offline {
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border-color));
  background: var(--warning-soft);
}

.status-bar > el-button {
  margin-left: auto;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tab {
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-color);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.tab.is-active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.parse {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.parse__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.parse__alert {
  margin: 0;
}

.parse__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.parse__label {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}

.parse__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip--sm {
  font-size: 11px;
  margin-right: 4px;
}
</style>
