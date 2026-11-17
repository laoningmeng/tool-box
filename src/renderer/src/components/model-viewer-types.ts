/** ModelViewer 解析出来的结构数据（外部 UI 用的类型，避免在 script setup 里导出接口）。 */

export interface ViewerPart {
  id: string
  /** 稳定的结构路径（如 0.3.12），跨次加载不变，用于持久化分组 */
  key: string
  name: string
  /** skinned | mesh | lines | points */
  type: string
  depth: number
  triangles: number
  vertices: number
  visible: boolean
  childCount: number
}

export interface ViewerBone {
  id: string
  name: string
  depth: number
  childCount: number
}

export interface ViewerClip {
  index: number
  name: string
  duration: number
  tracks: number
}

export interface ViewerStructure {
  parts: ViewerPart[]
  bones: ViewerBone[]
  clips: ViewerClip[]
  stats: { triangles: number; meshes: number; size: string; skinned: boolean }
}

/** 骨骼语义识别结果（来自 rig 引擎，界面只要摘要） */
export interface SemanticSummary {
  available: boolean
  boneCount: number
  /** 识别出的角色数量 */
  roleCount: number
  /** 缺失的关键角色（中文名） */
  missing: string[]
  warnings: string[]
  /** bone uuid -> 角色中文名 */
  roles: Record<string, string>
}

/** 精修会话状态（viewer -> 界面） */
export interface ClipEditState {
  editing: boolean
  name: string
  duration: number
  fps: number
  time: number
  playing: boolean
  /** 所有轨道的总关键帧数 */
  keyCount: number
  /** 当前选中骨骼的关键帧时间点 */
  boneKeys: number[]
  dirty: boolean
}

/** 快捷姿态动作 */
export type QuickPoseAction =
  | 'legs-in'
  | 'legs-out'
  | 'legs-forward'
  | 'legs-back'
  | 'foot-lift_L'
  | 'foot-lift_R'
  | 'arms-in'
  | 'arms-out'
  | 'arms-forward'
  | 'arms-back'
  | 'head-down'
  | 'head-up'
  | 'lean-forward'
  | 'lean-back'
  | 'reset'
