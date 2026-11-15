/** ModelViewer 解析出来的结构数据（外部 UI 用的类型，避免在 script setup 里导出接口）。 */

export interface ViewerPart {
  id: string
  name: string
  /** mesh | skinned | group */
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
