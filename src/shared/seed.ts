import type { AppSettings, ComfyWorkflow, ModelConfigStored, ResourceItem } from './types'

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

/** 内置工作流模板：最小可执行的 API 格式图（需在 ComfyUI 中装好对应 checkpoint） */
export const seedWorkflows: Array<Omit<ComfyWorkflow, 'fileName' | 'createdAt' | 'updatedAt'> & {
  graph: Record<string, unknown>
}> = [
  {
    id: 'builtin-t2i-basic',
    name: '基础文生图（SDXL）',
    category: 't2i',
    description: 'SDXL Base 标准流程：正负提示词 → 空 latent → KSampler → VAE 解码 → 保存图片。',
    tags: ['SDXL', '基础', '1024'],
    models: ['sd_xl_base_1.0.safetensors'],
    nodeCount: 7,
    builtin: true,
    runnable: true,
    format: 'comfy-api',
    graph: {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a cinematic photo, soft light, 8k', clip: ['1', 1] }
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'blurry, low quality', clip: ['1', 1] }
      },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed: 42,
          steps: 28,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0]
        }
      },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'app_t2i', images: ['6', 0] } }
    }
  }
]
