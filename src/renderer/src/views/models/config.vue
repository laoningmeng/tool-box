<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CircleCheckFilled,
  CircleCloseFilled,
  Connection,
  Delete,
  FolderOpened,
  Lock,
  Refresh
} from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import type { ApiKeyTestResult, ModelConfigPatch } from '@shared/types'
import { useModelStore } from '@renderer/stores/models'

/**
 * 3D 工具配置：Tripo / Meshy 的 API Key + 导入偏好。
 * Key 由主进程用系统安全存储加密后落库，渲染层只能拿到掩码，不会回显明文。
 * 「测试」会拿输入框里的值（没填就用已保存的）去请求对方的余额接口，判断 Key 是否可用。
 */

type Tool = 'tripo' | 'meshy'

const store = useModelStore()
const { config, configLoading } = storeToRefs(store)

const TOOL_LABEL: Record<Tool, string> = { tripo: 'Tripo', meshy: 'Meshy' }

/** 输入框草稿：只有「改过」才在保存时提交，避免把空值误写成清除 */
const tripoDraft = ref('')
const meshyDraft = ref('')
const tripoEdited = ref(false)
const meshyEdited = ref(false)
const dirDraft = ref('')
const autoDraft = ref(true)
const saving = ref(false)
const testing = ref<Tool | null>(null)
const testResults = reactive<Record<Tool, ApiKeyTestResult | null>>({ tripo: null, meshy: null })

const dirty = computed(() => {
  if (tripoEdited.value || meshyEdited.value) return true
  return (
    dirDraft.value !== (config.value?.defaultImportDir ?? '') ||
    autoDraft.value !== (config.value?.autoDetectSource ?? true)
  )
})

function syncDraft(): void {
  tripoDraft.value = ''
  meshyDraft.value = ''
  tripoEdited.value = false
  meshyEdited.value = false
  dirDraft.value = config.value?.defaultImportDir ?? ''
  autoDraft.value = config.value?.autoDetectSource ?? true
  testResults.tripo = null
  testResults.meshy = null
}

onMounted(async () => {
  await store.loadConfig()
  syncDraft()
})

async function reload(): Promise<void> {
  await store.loadConfig()
  syncDraft()
}

async function handlePickDir(): Promise<void> {
  const picked = await store.pickImportDir()
  if (picked) dirDraft.value = picked
}

async function handleSave(): Promise<void> {
  if (saving.value) return
  const patch: ModelConfigPatch = {}
  if (tripoEdited.value) patch.tripoApiKey = tripoDraft.value.trim()
  if (meshyEdited.value) patch.meshyApiKey = meshyDraft.value.trim()
  if (dirDraft.value !== (config.value?.defaultImportDir ?? '')) patch.defaultImportDir = dirDraft.value.trim()
  if (autoDraft.value !== (config.value?.autoDetectSource ?? true)) patch.autoDetectSource = autoDraft.value

  if (Object.keys(patch).length === 0) {
    ElMessage.info('没有需要保存的修改')
    return
  }

  saving.value = true
  try {
    await store.saveConfig(patch)
    syncDraft()
    ElMessage.success('配置已保存')
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

function clearKey(tool: Tool): void {
  if (tool === 'tripo') {
    tripoDraft.value = ''
    tripoEdited.value = true
  } else {
    meshyDraft.value = ''
    meshyEdited.value = true
  }
  testResults[tool] = null
  ElMessage.info('已清空输入框，点击「保存配置」后生效')
}

function canTest(tool: Tool): boolean {
  if (testing.value) return false
  if (tool === 'tripo') {
    return Boolean(tripoEdited.value ? tripoDraft.value.trim() : config.value?.tripo.configured)
  }
  return Boolean(meshyEdited.value ? meshyDraft.value.trim() : config.value?.meshy.configured)
}

function markEdited(tool: Tool): void {
  if (tool === 'tripo') tripoEdited.value = true
  else meshyEdited.value = true
  testResults[tool] = null
}

/** 优先测输入框里的新值，没改过就用已保存的 Key */
async function handleTest(tool: Tool): Promise<void> {
  if (!canTest(tool)) return
  const draft = tool === 'tripo' ? tripoDraft.value : meshyDraft.value
  const edited = tool === 'tripo' ? tripoEdited.value : meshyEdited.value
  testing.value = tool
  testResults[tool] = null
  try {
    const result = await window.api.modelConfig.test(tool, edited ? draft : undefined)
    testResults[tool] = result
    if (result.ok) ElMessage.success(`${TOOL_LABEL[tool]} 密钥可用`)
    else ElMessage.error(`${TOOL_LABEL[tool]} 密钥不可用：${result.message}`)
  } catch (error) {
    testResults[tool] = {
      ok: false,
      status: 0,
      message: `检测失败：${(error as Error).message}`,
      latencyMs: 0
    }
  } finally {
    testing.value = null
  }
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          配置管理
          <span class="chip">本地存储</span>
        </h1>
        <p class="page-desc">
          配置 Tripo、Meshy 的 API Key，供后续调用建模 / 生成接口使用。密钥只保存在本机，
          页面只回显掩码，不会把明文再传给渲染层。
        </p>
      </div>
      <el-button :icon="Refresh" :loading="configLoading" @click="reload">重新读取</el-button>
    </header>

    <div v-if="config && !config.secureStorage" class="notice notice--warn">
      <el-icon><Lock /></el-icon>
      <span>当前系统未提供安全存储（DPAPI / Keychain），密钥将以明文写入本机数据库。</span>
    </div>

    <section class="panel config-card">
      <header class="panel__head">
        <div class="config-head">
          <span class="source-dot source-dot--tripo" />
          <div>
            <h2 class="panel__title">Tripo API Key</h2>
            <p class="panel__subtitle">在 Tripo 控制台创建，用于文本/图片生成 3D 模型。</p>
          </div>
        </div>
        <el-tag size="small" effect="light" :type="config?.tripo.configured ? 'success' : 'info'">
          {{ config?.tripo.configured ? '已配置' : '未配置' }}
        </el-tag>
      </header>
      <div class="panel__body config-body">
        <el-input
          v-model="tripoDraft"
          class="key-input"
          type="password"
          show-password
          clearable
          autocomplete="off"
          :placeholder="config?.tripo.masked || '粘贴 Tripo API Key，例如 tsk_xxx'"
          @input="markEdited('tripo')"
        />
        <div class="config-meta">
          <span v-if="config?.tripo.configured" class="mono text-muted">当前：{{ config.tripo.masked }}</span>
          <span v-else class="text-muted">尚未配置，填写后点「保存配置」</span>
          <el-button
            v-if="config?.tripo.configured"
            link
            type="danger"
            size="small"
            :icon="Delete"
            @click="clearKey('tripo')"
          >
            清除
          </el-button>
        </div>
        <div class="test-row">
          <el-button
            size="small"
            :icon="Connection"
            :loading="testing === 'tripo'"
            :disabled="!canTest('tripo')"
            @click="handleTest('tripo')"
          >
            测试连接
          </el-button>
          <span
            v-if="testResults.tripo"
            class="test-result"
            :class="testResults.tripo.ok ? 'is-ok' : 'is-bad'"
            :title="testResults.tripo.detail || ''"
          >
            <el-icon>
              <component :is="testResults.tripo.ok ? CircleCheckFilled : CircleCloseFilled" />
            </el-icon>
            <span>{{ testResults.tripo.message }}</span>
            <span v-if="testResults.tripo.latencyMs" class="num test-result__ms">
              {{ testResults.tripo.latencyMs }}ms
            </span>
          </span>
        </div>
      </div>
    </section>

    <section class="panel config-card">
      <header class="panel__head">
        <div class="config-head">
          <span class="source-dot source-dot--meshy" />
          <div>
            <h2 class="panel__title">Meshy API Key</h2>
            <p class="panel__subtitle">在 Meshy 控制台创建，用于 3D 生成与贴图任务。</p>
          </div>
        </div>
        <el-tag size="small" effect="light" :type="config?.meshy.configured ? 'success' : 'info'">
          {{ config?.meshy.configured ? '已配置' : '未配置' }}
        </el-tag>
      </header>
      <div class="panel__body config-body">
        <el-input
          v-model="meshyDraft"
          class="key-input"
          type="password"
          show-password
          clearable
          autocomplete="off"
          :placeholder="config?.meshy.masked || '粘贴 Meshy API Key'"
          @input="markEdited('meshy')"
        />
        <div class="config-meta">
          <span v-if="config?.meshy.configured" class="mono text-muted">当前：{{ config.meshy.masked }}</span>
          <span v-else class="text-muted">尚未配置，填写后点「保存配置」</span>
          <el-button
            v-if="config?.meshy.configured"
            link
            type="danger"
            size="small"
            :icon="Delete"
            @click="clearKey('meshy')"
          >
            清除
          </el-button>
        </div>
        <div class="test-row">
          <el-button
            size="small"
            :icon="Connection"
            :loading="testing === 'meshy'"
            :disabled="!canTest('meshy')"
            @click="handleTest('meshy')"
          >
            测试连接
          </el-button>
          <span
            v-if="testResults.meshy"
            class="test-result"
            :class="testResults.meshy.ok ? 'is-ok' : 'is-bad'"
            :title="testResults.meshy.detail || ''"
          >
            <el-icon>
              <component :is="testResults.meshy.ok ? CircleCheckFilled : CircleCloseFilled" />
            </el-icon>
            <span>{{ testResults.meshy.message }}</span>
            <span v-if="testResults.meshy.latencyMs" class="num test-result__ms">
              {{ testResults.meshy.latencyMs }}ms
            </span>
          </span>
        </div>
      </div>
    </section>

    <section class="panel config-card">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">导入偏好</h2>
          <p class="panel__subtitle">影响「模型列表」里导入文件时的默认位置与来源识别方式。</p>
        </div>
      </header>
      <div class="panel__body">
        <el-form label-width="120px" label-position="left">
          <el-form-item label="默认导入目录">
            <div class="dir-row">
              <el-input v-model="dirDraft" readonly placeholder="未设置（每次使用系统默认位置）" class="dir-input">
                <template #prefix>
                  <el-icon><FolderOpened /></el-icon>
                </template>
              </el-input>
              <el-button @click="handlePickDir">选择目录</el-button>
              <el-button v-if="dirDraft" link type="danger" @click="dirDraft = ''">清空</el-button>
            </div>
          </el-form-item>
          <el-form-item label="自动识别来源">
            <div class="switch-row">
              <el-switch v-model="autoDraft" />
              <span class="text-muted switch-row__hint">
                按文件路径/文件名里的 tripo、meshy、blender 特征自动归类；关闭后仅按扩展名推断（.blend → Blender）
              </span>
            </div>
          </el-form-item>
        </el-form>
      </div>
    </section>

    <footer class="config-actions">
      <span class="config-actions__state">
        <template v-if="dirty">有未保存的修改</template>
        <template v-else>所有修改均已保存到本机</template>
      </span>
      <div class="config-actions__buttons">
        <el-button :disabled="!dirty || saving" @click="syncDraft">放弃修改</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" @click="handleSave">保存配置</el-button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 12.5px;
  border: 1px solid var(--border-color);
  background: var(--bg-subtle);
  color: var(--text-secondary);
}

.notice--warn {
  border-color: color-mix(in srgb, var(--warning) 40%, transparent);
  background: var(--warning-soft);
  color: var(--text-primary);
}

.config-card {
  margin-top: 0;
}

.config-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.source-dot {
  width: 10px;
  height: 10px;
  margin-top: 6px;
  border-radius: 50%;
  flex: none;
}

.source-dot--tripo {
  background: #10b981;
  box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.14);
}

.source-dot--meshy {
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
}

.config-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.key-input {
  max-width: 560px;
}

.config-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  min-height: 20px;
}

.test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.test-result {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
}

.test-result.is-ok {
  color: var(--success);
  background: var(--success-soft);
}

.test-result.is-bad {
  color: var(--danger);
  background: var(--danger-soft);
}

.test-result__ms {
  opacity: 0.75;
  font-size: 11px;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 640px;
}

.dir-input {
  flex: 1;
  min-width: 0;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.switch-row__hint {
  font-size: 12px;
  line-height: 1.6;
  max-width: 520px;
}

.config-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  position: sticky;
  bottom: 12px;
}

.config-actions__state {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.config-actions__buttons {
  display: flex;
  gap: 8px;
}
</style>
