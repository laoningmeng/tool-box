import type { WorkflowCategory } from '../../shared/types'

/**
 * ComfyUI 界面格式（Workflow → Save）→ API 格式（Save (API Format)）转换。
 *
 * 为什么需要：
 * - 界面格式是「节点数组 + links + 子图定义（definitions.subgraphs）」，ComfyUI 的 /prompt 只吃 API 格式；
 * - 新版 ComfyUI 用子图（subgraph）把一堆节点折叠成一个节点，直接丢给接口会报 class_type 不存在。
 *
 * 规则（基于 ComfyUI 0.45 的导出数据）：
 * - 节点输入：node.inputs[slot] 里的 link 指向 links 里的连接；-10 表示「子图输入」，-20 表示「子图输出」
 * - 控件值：优先用 widgets_values_named（按名字），没有时按 /object_info 的输入声明顺序回退
 * - 子图：把实例节点展开成内部节点，id 用 `实例id_内部id` 前缀避免冲突，输入由外层连线或实例控件值提供
 */

export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

interface UiInput {
  name?: string
  type?: string
  widget?: { name?: string }
  link?: number | null
}

interface UiNode {
  id: number
  type: string
  mode?: number
  inputs?: UiInput[]
  outputs?: Array<{ name?: string; type?: string; links?: number[] }>
  widgets_values?: unknown
  widgets_values_named?: Record<string, unknown>
}

interface UiSubgraph {
  id: string
  name?: string
  inputs: Array<{ name: string; type?: string; linkIds?: number[] }>
  outputs: Array<{ name: string; type?: string; linkIds?: number[] }>
  nodes: UiNode[]
  links: unknown[]
}

interface UiWorkflow {
  nodes?: UiNode[]
  links?: unknown[]
  definitions?: { subgraphs?: UiSubgraph[] }
}

interface LinkInfo {
  id: number
  originId: number
  originSlot: number
  targetId: number
  targetSlot: number
}

export interface ConvertResult {
  graph: ApiGraph
  warnings: string[]
  /** 图片输入节点数量（用于执行页动态生成上传槽） */
  imageInputs: number
}

export function isUiWorkflow(graph: Record<string, unknown>): boolean {
  return Array.isArray((graph as { nodes?: unknown }).nodes)
}

function normalizeLink(raw: unknown): LinkInfo | null {
  if (Array.isArray(raw)) {
    const [id, originId, originSlot, targetId, targetSlot] = raw as number[]
    if ([id, originId, originSlot, targetId, targetSlot].some((value) => typeof value !== 'number')) return null
    return { id, originId, originSlot, targetId, targetSlot }
  }
  if (raw && typeof raw === 'object') {
    const item = raw as Record<string, unknown>
    return {
      id: Number(item.id),
      originId: Number(item.origin_id),
      originSlot: Number(item.origin_slot),
      targetId: Number(item.target_id),
      targetSlot: Number(item.target_slot)
    }
  }
  return null
}

/** 控件类型判断：这些类型是「控件」而不是连线插槽 */
function isWidgetType(type: unknown): boolean {
  if (Array.isArray(type)) return true
  return ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(String(type))
}

interface WidgetSlot {
  name: string
  /** seed 这类控件后面还跟一个 control_after_generate 值 */
  extra: boolean
}

/** 从 /object_info 解析某节点的控件顺序（用于没有 widgets_values_named 的旧文件） */
function widgetSlots(classType: string, objectInfo: Record<string, any> | null): WidgetSlot[] {
  const def = objectInfo?.[classType]?.input
  if (!def) return []
  const slots: WidgetSlot[] = []
  for (const group of ['required', 'optional']) {
    const entries = def[group] as Record<string, unknown> | undefined
    if (!entries) continue
    for (const [name, raw] of Object.entries(entries)) {
      const spec = raw as unknown[]
      const type = spec?.[0]
      const opts = (spec?.[1] ?? {}) as Record<string, unknown>
      if (!isWidgetType(type)) continue
      slots.push({ name, extra: Boolean(opts.control_after_generate) })
    }
  }
  return slots
}

/** 把界面格式流程转成 API 格式 */
export function convertUiToApi(
  raw: Record<string, unknown>,
  objectInfo: Record<string, any> | null = null
): ConvertResult {
  const workflow = raw as UiWorkflow
  const warnings: string[] = []
  const subgraphs = new Map<string, UiSubgraph>()
  for (const sg of workflow.definitions?.subgraphs ?? []) {
    if (sg?.id) subgraphs.set(sg.id, sg)
  }

  const result: ApiGraph = {}
  const instanceOutputs = new Map<string, Map<number, unknown>>()

  const resolveLink = (
    link: LinkInfo,
    prefix: string,
    inputValues?: Map<number, unknown>
  ): unknown => {
    if (link.originId === -10) return inputValues?.get(link.originSlot)
    if (link.originId === -20) return undefined
    const nested = instanceOutputs.get(`${prefix}${link.originId}`)
    if (nested) return nested.get(link.originSlot)
    return [`${prefix}${link.originId}`, link.originSlot]
  }

  const expand = (
    nodes: UiNode[],
    rawLinks: unknown[],
    prefix = '',
    inputValues?: Map<number, unknown>
  ): Map<number, unknown> => {
    const links = rawLinks.map(normalizeLink).filter((item): item is LinkInfo => Boolean(item))
    const linkById = new Map(links.map((link) => [link.id, link]))

    const expandInstance = (node: UiNode): void => {
      const subgraph = subgraphs.get(node.type)
      if (!subgraph) return
      const values = new Map<number, unknown>()
      subgraph.inputs.forEach((input, index) => {
        const incoming = links.find((link) => link.targetId === node.id && link.targetSlot === index)
        if (incoming) {
          values.set(index, resolveLink(incoming, prefix, inputValues))
          return
        }
        const named = node.widgets_values_named?.[input.name]
        if (named !== undefined) {
          values.set(index, named)
          return
        }
        if (Array.isArray(node.widgets_values)) values.set(index, (node.widgets_values as unknown[])[index])
      })
      const innerOutputs = expand(subgraph.nodes, subgraph.links, `${prefix}${node.id}_`, values)
      instanceOutputs.set(`${prefix}${node.id}`, innerOutputs)
    }

    const convertNode = (node: UiNode): void => {
      const apiId = `${prefix}${node.id}`
      const inputs: Record<string, unknown> = {}
      const named = node.widgets_values_named
      if (named && typeof named === 'object') {
        for (const [key, value] of Object.entries(named)) inputs[key] = value
      } else if (Array.isArray(node.widgets_values)) {
        const slots = widgetSlots(node.type, objectInfo)
        const values = node.widgets_values as unknown[]
        if (slots.length === 0) {
          warnings.push(`${node.type} 缺少控件定义，控件值按序号回退`)
          values.forEach((value, index) => {
            inputs[`widget_${index}`] = value
          })
        } else {
          let cursor = 0
          for (const slot of slots) {
            if (cursor >= values.length) break
            inputs[slot.name] = values[cursor]
            cursor += 1
            if (slot.extra && cursor < values.length) cursor += 1 // 跳过 control_after_generate
          }
        }
      }

      ;(node.inputs ?? []).forEach((entry, slot) => {
        if (!entry || entry.link == null) return
        const link = linkById.get(entry.link)
        if (!link) return
        const value = resolveLink(link, prefix, inputValues)
        if (value === undefined) return
        const name = entry.widget?.name ?? entry.name
        if (!name) return
        inputs[name] = value
      })

      result[apiId] = { class_type: node.type, inputs }
    }

    const ordered = nodes.filter((item) => item && typeof item.id === 'number' && item.mode !== 2)
    // 阶段一：先展开子图实例（登记输出引用），避免节点在数组里的先后顺序影响解析
    for (const node of ordered) if (subgraphs.has(node.type)) expandInstance(node)
    // 阶段二：转换普通节点（此时子图输出引用已就绪）
    for (const node of ordered) if (!subgraphs.has(node.type)) convertNode(node)

    // 子图输出：links 里 target_id = -20 的连接
    const outputs = new Map<number, unknown>()
    for (const link of links) {
      if (link.targetId !== -20) continue
      const value = resolveLink(link, prefix, inputValues)
      if (value !== undefined) outputs.set(link.targetSlot, value)
    }
    return outputs
  }

  expand(workflow.nodes ?? [], workflow.links ?? [])

  // 引用校验：所有 [id, slot] 引用必须在结果里
  for (const [id, node] of Object.entries(result)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2) continue
      const target = String(value[0])
      if (typeof value[1] !== 'number') continue
      if (!result[target]) warnings.push(`节点 ${id}.${name} 引用了不存在的节点 ${target}`)
    }
  }

  let imageInputs = 0
  for (const node of Object.values(result)) {
    if (node.class_type === 'LoadImage' || node.class_type === 'LoadImageMask') imageInputs += 1
  }
  return { graph: result, warnings, imageInputs }
}

/** 递归收集界面格式里的所有 class_type（含子图） */
export function collectUiClassTypes(graph: Record<string, unknown>): string[] {
  const workflow = graph as UiWorkflow
  const types = new Set<string>()
  const walk = (nodes: UiNode[] | undefined, subgraphs: UiSubgraph[] | undefined): void => {
    for (const node of nodes ?? []) types.add(node.type)
    for (const sg of subgraphs ?? []) walk(sg.nodes, undefined)
  }
  walk(workflow.nodes, workflow.definitions?.subgraphs)
  return [...types]
}

/** 根据节点类型集合判定分类（界面/API 格式通用） */
export function detectCategoryFromTypes(types: Iterable<string>): WorkflowCategory | null {
  const set = new Set(types)
  const has = (pattern: RegExp): boolean => [...set].some((type) => pattern.test(type))

  if (has(/SeeThrough|LayerDiff/i)) return 'split'
  if (has(/^(SaveVideo|SaveAnimatedWEBP|VHS_VideoCombine|CreateVideo|SVD_img2vid_Conditioning)$/)) return 'i2v'
  if (has(/^(SaveAudio|SaveAudioAdvanced|SaveAudioMP3|SaveAudioOpus)$/) || has(/^Woosh/)) return 't2a'
  if (set.has('LoadImage') && (set.has('VAEEncode') || set.has('KSampler') || set.has('SaveImageAdvanced'))) return 'i2i'
  if ((set.has('EmptyLatentImage') || set.has('EmptySD3LatentImage')) && set.has('KSampler')) return 't2i'
  if (set.has('SaveImage') || set.has('SaveImageAdvanced')) return 't2i'
  return null
}
