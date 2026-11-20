import type { AppSettings, ComfyWorkflow, ModelConfigStored, ResourceItem } from './types'
import t2iZImage from './builtin-workflows/t2i-z-image-turbo.json'
import i2iThreeSide from './builtin-workflows/i2i-three-side.json'
import i2i2Refs from './builtin-workflows/i2i-2-refs.json'
import i2i3Refs from './builtin-workflows/i2i-3-refs.json'
import i2vMinimax from './builtin-workflows/i2v-minimax-3s.json'
import t2aAudio from './builtin-workflows/t2a-text-to-audio.json'
import splitSeeThrough from './builtin-workflows/split-seethrough.json'

/** 首次启动写入数据库的默认设置 */
export const defaultSettings: AppSettings = {
  systemName: '穷哥们的工具箱',
  company: '穷哥们的工具箱',
  themeMode: 'light',
  accentColor: '#4f46e5',
  compactMode: false,
  showBreadcrumb: true,
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  autoLaunch: false,
  minimizeToTray: false,
  closeToTray: false,
  logLevel: 'info',
  maxConcurrent: 2,
  autoBackup: true,
  backupInterval: 'daily',
  clearCacheOnExit: false,
  dataDir: '',
  modelDir: '',
  comfyUrl: 'http://127.0.0.1:8188',
  autoStartPython: true
}

/** 3D 模型模块的默认配置（密钥留空，首次进入配置管理页填写） */
export const defaultModelConfig: ModelConfigStored = {
  tripoApiKey: '',
  meshyApiKey: '',
  defaultImportDir: '',
  autoDetectSource: true
}

/** 示例数据：用于占位，接入真实业务时删掉或改造成导入功能 */
export const seedResources: Array<Omit<ResourceItem, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: '示例资源 A',
    category: '默认分组',
    tags: ['示例', '可删除'],
    description: '这条数据用于演示列表 / 详情 / 编辑流程，接入业务后可直接删除。',
    score: 82,
    status: 'active'
  },
  {
    name: '示例资源 B',
    category: '默认分组',
    tags: ['示例'],
    description: '状态与标签都可以编辑，表单校验规则在 ResourceDialog 中。',
    score: 64,
    status: 'paused'
  },
  {
    name: '示例资源 C',
    category: '第二分组',
    tags: ['草稿'],
    description: '草稿状态不参与统计里的「运行中」，用于演示筛选。',
    score: 45,
    status: 'draft'
  }
]

/** 内置工作流（界面格式，运行时会自动转成 API 格式） */
export const seedWorkflows: Array<Omit<ComfyWorkflow, 'fileName' | 'createdAt' | 'updatedAt'> & {
  graph: Record<string, unknown>
}> = [
  {
    id: 'builtin-t2i-zimage-turbo',
    name: '文生图 · Z-Image Turbo（8 步）',
    category: 't2i',
    description: 'Z-Image Turbo 快速文生图：8 步出图，内置 Qwen3 文本编码，适合快速抽卡。界面格式流程，运行时会自动转成 API 格式。',
    tags: ["Z-Image","Turbo","快速","内置"],
    models: ["zImageTurbo_turbo.safetensors","qwen3_4b.safetensors","ae.safetensors"],
    nodeCount: 10,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 0,
    defaults: { steps: 8, cfg: 1, width: 1024, height: 1024 },
    graph: t2iZImage as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-i2i-three-side',
    name: '图生图 · 三视图（1 参考图）',
    category: 'i2i',
    description: '上传 1 张参考图生成角色三视图，用于设定图/多角度预览。',
    tags: ["三视图","1 参考图","内置"],
    models: [],
    nodeCount: 13,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 1,
    graph: i2iThreeSide as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-i2i-2-refs',
    name: '图生图 · 2 张参考图',
    category: 'i2i',
    description: '两张参考图融合重绘（角色 + 风格/服装），适合保持角色一致性换装。',
    tags: ["2 参考图","融合","内置"],
    models: [],
    nodeCount: 21,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 2,
    graph: i2i2Refs as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-i2i-3-refs',
    name: '图生图 · 3 张参考图',
    category: 'i2i',
    description: '三张参考图融合重绘（多角度/多素材），适合复杂构图与角色设定。',
    tags: ["3 参考图","融合","内置"],
    models: [],
    nodeCount: 22,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 3,
    graph: i2i3Refs as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-i2v-minimax-3s',
    name: '图生视频 · MiniMax 3 秒',
    category: 'i2v',
    description: '上传 1 张图生成 3 秒视频（MiniMax 视频模型）。',
    tags: ["图生视频","MiniMax","3 秒","内置"],
    models: [],
    nodeCount: 29,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 1,
    graph: i2vMinimax as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-t2a-text-audio',
    name: '文生音效 · 文本转音效',
    category: 't2a',
    description: '输入一段音效描述（如「gun shot」），生成对应音效（Woosh 模型）。',
    tags: ["音效","Woosh","内置"],
    models: ["Woosh-Flow"],
    nodeCount: 4,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 0,
    graph: t2aAudio as unknown as Record<string, unknown>
  },
  {
    id: 'builtin-split-seethrough',
    name: '角色拆分 · SeeThrough',
    category: 'split',
    description: '上传 1 张角色图，按图层拆分前景/背景/头发等，输出分层结果，方便后期改姿势或换背景。',
    tags: ["角色拆分","图层","SeeThrough","内置"],
    models: [],
    nodeCount: 7,
    builtin: true,
    runnable: true,
    format: 'comfy-ui',
    imageInputs: 1,
    graph: splitSeeThrough as unknown as Record<string, unknown>
  }
]
