<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { buildRig, collectSkinnedMeshes, lateralSign } from '../rig/rig'
import { autoDetectSemantics, missingRoles, roleBoneMap } from '../rig/semantics'
import { generateAction } from '../rig/actions'
import { ROLE_LABELS } from '../rig/types'
import type { ActionKind, BoneRole, PoseClip, RigInfo, SemanticRig } from '../rig/types'
import type {
  ClipEditState,
  QuickPoseAction,
  SemanticSummary,
  ViewerBone,
  ViewerClip,
  ViewerPart,
  ViewerStructure
} from './model-viewer-types'
import { retargetClip } from '../rig/retarget'
import type { RetargetResult, RetargetTarget } from '../rig/retarget'
import type { ActionAssetFile, ModelAction, ModelActionInput, ModelActionTrack } from '@shared/types'

/**
 * 3D 预览 / 实验台画布（three.js）。
 *
 * 负责三件事：
 * 1. 渲染 glb/gltf，并按需给出「部件树 / 骨骼树 / 动作列表」的结构数据（emit parsed）
 * 2. 提供实验台要用的操作：部件显隐、节点聚焦、骨骼显示、动作播放/暂停/拖动
 * 3. 卸载时彻底释放 WebGL / 几何 / 材质 / 贴图
 *
 * 组件本身不持有业务状态：选中的是谁、播到第几帧都由外部（lab.vue）决定。
 */

const props = withDefaults(
  defineProps<{
    bytes: Uint8Array | ArrayBuffer | null
    format?: string
    autoRotate?: boolean
    wireframe?: boolean
    showGrid?: boolean
    showSkeleton?: boolean
    background?: string
    exposure?: number
    /** 选中部件/骨骼的高亮颜色 */
    highlightColor?: string
    /** 高亮强度（自发光强度），0.05 ~ 1.5 */
    highlightIntensity?: number
    /** 骨骼编辑 gizmo：rotate / translate / off */
    gizmoMode?: 'rotate' | 'translate' | 'scale' | 'off'
    /** 仅骨骼：冻结网格形变，摆骨骼时模型不动 */
    freezeMesh?: boolean
  }>(),
  {
    format: 'glb',
    autoRotate: true,
    wireframe: false,
    showGrid: true,
    showSkeleton: false,
    background: '#0b1220',
    exposure: 1,
    highlightColor: '#ffb74d',
    highlightIntensity: 0.45,
    gizmoMode: 'off',
    freezeMesh: false
  }
)

const emit = defineEmits<{
  parsed: [structure: ViewerStructure]
  semantics: [summary: SemanticSummary]
  tick: [state: { time: number; duration: number; playing: boolean; index: number }]
  /** 骨骼被 gizmo 拖动或数值修改后的局部变换（旋转为角度制） */
  'bone-transform': [
    payload: {
      id: string
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number }
    }
  ]
  /** 精修会话状态变化 */
  'edit-state': [state: ClipEditState]
  /** 撤销/重做栈变化 */
  'history-state': [state: { undo: number; redo: number }]
  /** 视口里点中骨骼（uuid） */
  'select-bone': [id: string]
  /** 视口里点中部件（uuid） */
  'select-part': [id: string]
  /** 冻结骨骼集合变化 */
  'freeze-state': [state: { frozen: string[] }]
  /** 视口框选骨骼（Shift + 拖拽矩形） */
  'select-bones': [ids: string[]]
  error: [message: string]
}>()

const host = ref<HTMLDivElement | null>(null)
const loading = ref(false)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let frameId = 0
let resizeObserver: ResizeObserver | null = null
let gridHelper: THREE.GridHelper | null = null
let current: THREE.Group | null = null
let pmrem: THREE.PMREMGenerator | null = null
let envTexture: THREE.Texture | null = null
/**
 * 骨架叠加层：骨骼连线 + 每个关节的球体节点。
 * 不用 THREE.SkeletonHelper，因为它只画细线、没有关节，动画播放时也难看清结构。
 */
let boneOverlay: {
  group: THREE.Group
  lines: THREE.LineSegments
  joints: THREE.InstancedMesh
  edges: Array<[THREE.Bone, THREE.Bone]>
  bones: THREE.Bone[]
} | null = null
/** 当前选中的骨骼（标记环每帧跟着它走） */
let selectedBone: THREE.Bone | null = null
/** 骨骼编辑 gizmo（TransformControls） */
let gizmo: TransformControls | null = null
/** 多选骨骼的组变换：手柄挂在一个「质心指挥棒」上，拖动时把同一个世界增量套给每根骨骼 */
let groupPivot: THREE.Object3D | null = null
let groupBoneIds: string[] = []
let groupStart: null | {
  pivotPos: THREE.Vector3
  pivotQuat: THREE.Quaternion
  items: Array<{ bone: THREE.Bone; worldPos: THREE.Vector3; worldQuat: THREE.Quaternion }>
} = null
/** 冻结网格时换上的「定格骨架」：原始 skeleton -> 冻结点 */
const frozenSkeletons = new Map<THREE.SkinnedMesh, THREE.Skeleton>()
/** 绑定姿态下的局部变换，用于「复位」 */
const initialLocal = new Map<
  string,
  { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
>()
let boneMarker: THREE.Mesh | null = null
/** 选中高亮改过的材质，取消选中时要还原 */
let highlighted: Array<{ material: THREE.MeshStandardMaterial; emissive: THREE.Color; intensity: number }> = []
/** 当前高亮的对象，颜色/强度变化时用来重刷 */
let lastHighlight: { type: 'part' | 'parts' | 'bone'; value: string | string[] } | null = null

let mixer: THREE.AnimationMixer | null = null
let actions: THREE.AnimationAction[] = []
let activeAction: THREE.AnimationAction | null = null
let lastTick = 0
let lastFrame = performance.now()

const partObjects = new Map<string, THREE.Object3D>()
const partByKey = new Map<string, THREE.Object3D>()
/** 部件对象 -> 部件 id，视口点选时反查 */
const partIdByObject = new Map<THREE.Object3D, string>()
const boneObjects = new Map<string, THREE.Bone>()
const boneByName = new Map<string, THREE.Bone>()
/** 骨架语义引擎（rig-studio 移植）：只在有蒙皮骨骼时可用 */
let rigInfo: RigInfo | null = null
let semanticRig: SemanticRig | null = null
let generatedClip: THREE.AnimationClip | null = null
let modelRadius = 1
let selectionId = ''

const BG = new THREE.Color()

/* ------------------------------- 小工具 ------------------------------- */

function normalizeBytes(input: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
}

function countTriangles(object: THREE.Object3D): number {
  let total = 0
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    if (geometry.index) total += geometry.index.count / 3
    else if (geometry.attributes.position) total += geometry.attributes.position.count / 3
  })
  return Math.round(total)
}

/** 可渲染对象：网格 / 线（Tripo 有些导出是纯骨架线）/ 点 */
function renderableType(object: THREE.Object3D): string {
  const anyObject = object as unknown as { isSkinnedMesh?: boolean; isMesh?: boolean; isLine?: boolean; isPoints?: boolean }
  if (anyObject.isSkinnedMesh) return 'skinned'
  if (anyObject.isMesh) return 'mesh'
  if (anyObject.isLine) return 'lines'
  if (anyObject.isPoints) return 'points'
  return ''
}

function countRenderables(object: THREE.Object3D): number {
  let total = 0
  object.traverse((child) => {
    if (renderableType(child)) total += 1
  })
  return total
}

function meshGeometryInfo(object: THREE.Object3D): { triangles: number; vertices: number } {
  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  if (!geometry) return { triangles: 0, vertices: 0 }
  const vertices = geometry.attributes.position?.count ?? 0
  const isSurface = Boolean((object as THREE.Mesh).isMesh)
  const triangles = isSurface
    ? geometry.index
      ? geometry.index.count / 3
      : vertices / 3
    : 0
  return { triangles: Math.round(triangles), vertices }
}

function applyWireframe(): void {
  if (!current) return
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const m = material as THREE.MeshStandardMaterial
      if ('wireframe' in m) {
        // 线框关闭时恢复原样（有些材质本来就关着）
        m.wireframe = props.wireframe
      }
    }
  })
}

function applyBackground(): void {
  if (!scene) return
  BG.set(props.background)
  scene.background = BG
}

/* ------------------------------- 结构解析 ------------------------------- */

function parseParts(root: THREE.Object3D): ViewerPart[] {
  const parts: ViewerPart[] = []
  partObjects.clear()
  partByKey.clear()
  const push = (object: THREE.Object3D, depth: number, key: string): void => {
    if (parts.length >= 800) return
    const type = renderableType(object)
    if (type) {
      const info = meshGeometryInfo(object)
      const id = object.uuid
      partObjects.set(id, object)
      partByKey.set(key, object)
      partIdByObject.set(object, id)
      parts.push({
        id,
        key,
        name: object.name || `mesh_${parts.length}`,
        type,
        depth,
        triangles: info.triangles,
        vertices: info.vertices,
        visible: object.visible,
        childCount: object.children.length
      })
    }
    // 网格下面也可能挂着骨骼节点，继续往下走
    object.children.forEach((child, index) => push(child, depth + 1, `${key}.${index}`))
  }
  root.children.forEach((child, index) => push(child, 0, String(index)))
  return parts
}

function collectBones(root: THREE.Object3D): THREE.Bone[] {
  let skinned: THREE.SkinnedMesh | null = null
  root.traverse((child) => {
    if (!skinned && (child as THREE.SkinnedMesh).isSkinnedMesh) skinned = child as THREE.SkinnedMesh
  })
  const fromSkeleton = (skinned as THREE.SkinnedMesh | null)?.skeleton?.bones ?? []
  if (fromSkeleton.length > 0) return fromSkeleton

  // 纯线条导出的模型没有 SkinnedMesh，但层级里仍有 Bone 节点
  const bones: THREE.Bone[] = []
  root.traverse((child) => {
    if ((child as unknown as { isBone?: boolean }).isBone) bones.push(child as THREE.Bone)
  })
  return bones
}

function parseBones(root: THREE.Object3D): ViewerBone[] {
  boneObjects.clear()
  boneByName.clear()
  initialLocal.clear()
  const bones = collectBones(root)
  if (bones.length === 0) return []

  const boneSet = new Set<THREE.Bone>(bones)
  const result: ViewerBone[] = []
  const childCount = new Map<THREE.Object3D, number>()
  for (const bone of bones) {
    boneObjects.set(bone.uuid, bone)
    if (bone.name) boneByName.set(bone.name, bone)
    // 记下绑定姿态，用于「复位骨骼 / 复位全部姿态」
    initialLocal.set(bone.uuid, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone()
    })
    const parent = bone.parent
    if (parent && boneSet.has(parent as THREE.Bone)) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
    }
  }
  for (const bone of bones) {
    let depth = 0
    let parent = bone.parent
    while (parent && boneSet.has(parent as THREE.Bone)) {
      depth += 1
      parent = parent.parent
    }
    result.push({
      id: bone.uuid,
      name: bone.name || `bone_${result.length}`,
      depth,
      childCount: childCount.get(bone) ?? 0
    })
  }
  return result
}

function buildStructure(clips: THREE.AnimationClip[], sizeText: string): ViewerStructure {
  const root = current as THREE.Group
  const parts = parseParts(root)
  const bones = parseBones(root)
  return {
    parts,
    bones,
    clips: clips.map((clip, index) => ({
      index,
      name: clip.name || `clip_${index + 1}`,
      duration: clip.duration,
      tracks: clip.tracks.length
    })),
    stats: {
      triangles: countTriangles(root),
      meshes: countRenderables(root),
      size: sizeText,
      skinned: bones.length > 0
    }
  }
}

/* ------------------------------- 骨骼语义 ------------------------------- */

/** 用移植过来的 rig 引擎做语义识别：给骨骼贴角色标签，并决定动作库是否可用 */
function analyzeSemantics(root: THREE.Object3D): void {
  rigInfo = null
  semanticRig = null
  const empty: SemanticSummary = {
    available: false,
    boneCount: boneObjects.size,
    roleCount: 0,
    missing: [],
    warnings: [],
    roles: {}
  }
  const meshes = collectSkinnedMeshes(root)
  if (meshes.length === 0 || boneObjects.size === 0) {
    emit('semantics', { ...empty, warnings: ['该模型没有蒙皮骨骼，动作库不可用'] })
    return
  }
  try {
    rigInfo = buildRig(root, meshes)
    semanticRig = autoDetectSemantics(rigInfo)
    const roleMap = roleBoneMap(semanticRig)
    const roles: Record<string, string> = {}
    for (const [boneName, role] of Object.entries(semanticRig.bones)) {
      const bone = boneByName.get(boneName)
      if (bone) roles[bone.uuid] = ROLE_LABELS[role] ?? role
    }
    emit('semantics', {
      available: true,
      boneCount: rigInfo.bones.length,
      roleCount: roleMap.size,
      missing: missingRoles(semanticRig).map((role) => ROLE_LABELS[role] ?? role),
      warnings: semanticRig.warnings ?? [],
      roles
    })
  } catch (error) {
    rigInfo = null
    semanticRig = null
    emit('semantics', {
      ...empty,
      warnings: [`语义识别失败：${(error as Error).message}`]
    })
  }
}

function poseClipToAnimationClip(pose: PoseClip): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of pose.tracks) {
    const bone = boneByName.get(track.bone)
    if (!bone || track.times.length === 0) continue
    const values: number[] = []
    for (const quat of track.quats) values.push(quat.x, quat.y, quat.z, quat.w)
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, track.times, values))
    if (track.points && track.points.length === track.times.length) {
      const positions: number[] = []
      for (const point of track.points) positions.push(point.x, point.y, point.z)
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, track.times, positions))
    }
  }
  return new THREE.AnimationClip(pose.name || 'action', pose.duration || 1, tracks)
}

function playAnimationClip(clip: THREE.AnimationClip, loop = true): void {
  if (!mixer) return
  if (generatedClip && generatedClip !== clip) mixer.uncacheClip(generatedClip)
  mixer.stopAllAction()
  generatedClip = clip
  const action = mixer.clipAction(clip)
  action.reset()
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
  action.clampWhenFinished = !loop
  action.timeScale = 1
  action.play()
  activeAction = action
  emit('tick', { time: 0, duration: clip.duration, playing: true, index: -1 })
}

/** 组装动作库上下文（语义识别结果 -> 生成动作需要的东西） */
function buildPoseClip(kind: ActionKind): PoseClip | null {
  if (!rigInfo || !semanticRig) return null
  const rig = rigInfo
  const sem = semanticRig
  const roleMap = roleBoneMap(sem)
  const context = {
    rig,
    semantics: sem,
    roleBone: (role: BoneRole) => roleMap.get(role),
    restLocalQuat: (name: string): THREE.Quaternion => {
      const index = rig.boneIndexByName.get(name)
      return index === undefined ? new THREE.Quaternion() : rig.restLocal[index].quaternion.clone()
    },
    restWorldQuat: (name: string): THREE.Quaternion => {
      const index = rig.boneIndexByName.get(name)
      return index === undefined ? new THREE.Quaternion() : rig.restWorldQuat[index].clone()
    },
    lateralSign: (name: string): number => lateralSign(rig, name)
  }
  return generateAction(kind, context)
}

/** 用内置动作库现场生成一个动作并播放（不需要模型自带动画） */
function generateActionClip(kind: ActionKind): { ok: boolean; name?: string; message?: string } {
  if (!rigInfo || !semanticRig) return { ok: false, message: '该模型没有可用骨骼，动作库不可用' }
  try {
    const pose = buildPoseClip(kind)
    if (!pose) return { ok: false, message: '该模型没有可用骨骼，动作库不可用' }
    const clip = poseClipToAnimationClip(pose)
    if (clip.tracks.length === 0) {
      return { ok: false, message: '该模型的骨骼没有匹配到动作所需角色' }
    }
    playAnimationClip(clip, pose.loop)
    return { ok: true, name: pose.name }
  } catch (error) {
    return { ok: false, message: `生成动作失败：${(error as Error).message}` }
  }
}

/* ------------------------------- 骨骼编辑 ------------------------------- */

function toDeg(rad: number): number {
  return Math.round(((rad * 180) / Math.PI) * 100) / 100
}

function stopAnimationForEdit(): void {
  if (!mixer || !activeAction) return
  mixer.stopAllAction()
  activeAction = null
  emit('tick', { time: 0, duration: 0, playing: false, index: -1 })
}

function emitBoneTransform(): void {
  if (!selectedBone) return
  const euler = new THREE.Euler().setFromQuaternion(selectedBone.quaternion, 'XYZ')
  emit('bone-transform', {
    id: selectedBone.uuid,
    position: {
      x: Math.round(selectedBone.position.x * 1000) / 1000,
      y: Math.round(selectedBone.position.y * 1000) / 1000,
      z: Math.round(selectedBone.position.z * 1000) / 1000
    },
    rotation: { x: toDeg(euler.x), y: toDeg(euler.y), z: toDeg(euler.z) }
  })
}

function attachGizmo(bone: THREE.Object3D | null): void {
  if (!gizmo) return
  const helper = gizmo.getHelper()
  if (!bone || props.gizmoMode === 'off') {
    gizmo.detach()
    helper.visible = false
    return
  }
  gizmo.setMode(props.gizmoMode)
  gizmo.attach(bone)
  helper.visible = true
}

/** 多选骨骼：手柄挂到质心，拖动时整组一起动 */
function setBoneGroup(ids: string[]): void {
  groupBoneIds = ids
  groupStart = null
  if (ids.length === 1) {
    selectNode(ids[0])
    return
  }
  if (!scene) return
  if (!groupPivot) {
    groupPivot = new THREE.Object3D()
    groupPivot.name = 'group-pivot'
    scene.add(groupPivot)
  }
  if (ids.length === 0) {
    selectedBone = null
    attachGizmo(null)
    return
  }
  const center = new THREE.Vector3()
  let count = 0
  for (const id of ids) {
    const bone = boneObjects.get(id)
    if (!bone) continue
    bone.getWorldPosition(_v)
    center.add(_v)
    count += 1
  }
  if (count === 0) {
    attachGizmo(null)
    return
  }
  center.divideScalar(count)
  groupPivot.position.copy(center)
  groupPivot.quaternion.identity()
  groupPivot.scale.set(1, 1, 1)
  groupPivot.updateMatrixWorld(true)
  selectedBone = null
  attachGizmo(groupPivot)
}

/** 拖动开始时记录每根骨骼的初始世界变换 */
function captureGroupStart(): void {
  if (!groupPivot || groupBoneIds.length < 2) {
    groupStart = null
    return
  }
  const items: Array<{ bone: THREE.Bone; worldPos: THREE.Vector3; worldQuat: THREE.Quaternion }> = []
  for (const id of groupBoneIds) {
    const bone = boneObjects.get(id)
    if (!bone) continue
    items.push({
      bone,
      worldPos: bone.getWorldPosition(new THREE.Vector3()),
      worldQuat: bone.getWorldQuaternion(new THREE.Quaternion())
    })
  }
  groupStart = {
    pivotPos: groupPivot.position.clone(),
    pivotQuat: groupPivot.quaternion.clone(),
    items
  }
}

function boneDepth(bone: THREE.Object3D): number {
  let depth = 0
  let node: THREE.Object3D | null = bone
  while (node) {
    depth += 1
    node = node.parent
  }
  return depth
}

/** 把指挥棒的位移/旋转增量套到组里每根骨骼上（位置绕质心转动） */
function applyGroupDelta(): void {
  if (!groupPivot || !groupStart) return
  const deltaQuat = groupPivot.quaternion.clone().multiply(groupStart.pivotQuat.clone().invert())
  const deltaPos = groupPivot.position.clone().sub(groupStart.pivotPos)
  const items = [...groupStart.items].sort((a, b) => boneDepth(a.bone) - boneDepth(b.bone))
  const tempWorldPos = new THREE.Vector3()
  const tempParentQuat = new THREE.Quaternion()
  const tempParentPos = new THREE.Vector3()
  for (const item of items) {
    // 位置：先绕质心旋转，再加上平移
    tempWorldPos.copy(item.worldPos).sub(groupStart.pivotPos).applyQuaternion(deltaQuat).add(groupStart.pivotPos).add(deltaPos)
    const newWorldQuat = deltaQuat.clone().multiply(item.worldQuat)
    const bone = item.bone
    const parent = bone.parent
    if (!parent) {
      bone.position.copy(tempWorldPos)
      bone.quaternion.copy(newWorldQuat)
      continue
    }
    parent.getWorldQuaternion(tempParentQuat)
    parent.getWorldPosition(tempParentPos)
    bone.quaternion.copy(tempParentQuat.clone().invert().multiply(newWorldQuat))
    bone.position.copy(tempWorldPos.sub(tempParentPos).applyQuaternion(tempParentQuat.clone().invert()))
  }
  if (current) current.updateMatrixWorld(true)
  emitBoneTransform()
  if (boneOverlay) updateSkeletonOverlay()
}

function getBoneTransform(id: string): {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
} | null {
  const bone = boneObjects.get(id)
  if (!bone) return null
  const euler = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ')
  return {
    position: { x: bone.position.x, y: bone.position.y, z: bone.position.z },
    rotation: { x: toDeg(euler.x), y: toDeg(euler.y), z: toDeg(euler.z) }
  }
}

/** 数值面板改骨骼：旋转用角度制；只动传进来的分量 */
function setBoneTransform(
  id: string,
  patch: {
    position?: Partial<{ x: number; y: number; z: number }>
    rotation?: Partial<{ x: number; y: number; z: number }>
  }
): void {
  const bone = boneObjects.get(id)
  if (!bone) return
  pushHistory('修改骨骼')
  stopAnimationForEdit()

  if (patch.position) {
    if (patch.position.x !== undefined) bone.position.x = patch.position.x
    if (patch.position.y !== undefined) bone.position.y = patch.position.y
    if (patch.position.z !== undefined) bone.position.z = patch.position.z
  }
  if (patch.rotation) {
    const euler = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ')
    bone.quaternion.setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(patch.rotation.x ?? toDeg(euler.x)),
        THREE.MathUtils.degToRad(patch.rotation.y ?? toDeg(euler.y)),
        THREE.MathUtils.degToRad(patch.rotation.z ?? toDeg(euler.z)),
        'XYZ'
      )
    )
  }
  bone.updateMatrixWorld(true)
  emitBoneTransform()
  if (boneOverlay) updateSkeletonOverlay()
}

function resetBone(id: string): void {
  const bone = boneObjects.get(id)
  const rest = initialLocal.get(id)
  if (!bone || !rest) return
  pushHistory('复位骨骼')
  stopAnimationForEdit()
  bone.position.copy(rest.position)
  bone.quaternion.copy(rest.quaternion)
  bone.scale.copy(rest.scale)
  bone.updateMatrixWorld(true)
  emitBoneTransform()
  if (boneOverlay) updateSkeletonOverlay()
}

/** 取消选中：清高亮、摘手柄、清记录 */
function clearSelection(): void {
  selectionId = ''
  lastHighlight = null
  selectedBone = null
  groupBoneIds = []
  groupStart = null
  clearSelectionVisual()
  if (gizmo) {
    gizmo.detach()
    gizmo.getHelper().visible = false
  }
  if (boneOverlay) updateSkeletonOverlay()
}

function resetPose(): void {
  pushHistory('复位姿态')
  stopAnimationForEdit()
  for (const [id, bone] of boneObjects) {
    const rest = initialLocal.get(id)
    if (!rest) continue
    bone.position.copy(rest.position)
    bone.quaternion.copy(rest.quaternion)
    bone.scale.copy(rest.scale)
  }
  if (current) current.updateMatrixWorld(true)
  emitBoneTransform()
  if (boneOverlay) updateSkeletonOverlay()
}

/* ------------------------------- 外部动作（Mixamo FBX / glb） ------------------------------- */

let externalActions: RetargetResult[] = []

/** 把模型骨骼按角色整成重定向目标 */
function buildRetargetTarget(): RetargetTarget | null {
  if (!rigInfo || !semanticRig) return null
  const roleMap = roleBoneMap(semanticRig)
  const boneByRole = new Map<BoneRole, THREE.Bone>()
  for (const [role, name] of roleMap) {
    const bone = boneByName.get(name)
    if (bone) boneByRole.set(role, bone)
  }
  return {
    boneByRole,
    restWorldQuat: (bone: THREE.Bone) => {
      const index = rigInfo!.boneIndexByName.get(bone.name)
      return index === undefined ? new THREE.Quaternion() : rigInfo!.restWorldQuat[index].clone()
    }
  }
}

async function parseActionFile(file: ActionAssetFile): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const buffer = file.bytes.buffer.slice(
    file.bytes.byteOffset,
    file.bytes.byteOffset + file.bytes.byteLength
  ) as ArrayBuffer
  if (ext === 'fbx') {
    const object = new FBXLoader().parse(buffer, '')
    return { root: object, animations: object.animations ?? [] }
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  return { root: gltf.scene, animations: gltf.animations ?? [] }
}

/** 解析外部动作文件并按语义角色重定向到当前模型 */
async function importExternalActions(
  files: ActionAssetFile[]
): Promise<{ ok: boolean; message?: string; items: Array<{ name: string; duration: number; matched: number }> }> {
  const target = buildRetargetTarget()
  if (!target) return { ok: false, message: '该模型没有可用骨骼，无法套用外部动作', items: [] }
  const items: RetargetResult[] = []
  const failures: string[] = []
  for (const file of files) {
    try {
      const { root, animations } = await parseActionFile(file)
      if (animations.length === 0) {
        failures.push(`${file.name}：没有动画数据`)
        continue
      }
      const baseName = file.name.replace(/\.[^.]+$/, '')
      for (const clip of animations) {
        const result = retargetClip(root, clip, target, {
          name: (clip.name || baseName).slice(0, 40)
        })
        if (result) items.push(result)
        else failures.push(`${file.name} / ${clip.name || '未命名'}：骨骼对不上`)
      }
    } catch (error) {
      failures.push(`${file.name}：${(error as Error).message}`)
    }
  }
  if (items.length === 0) {
    return { ok: false, message: failures[0] ?? '没有解析到可用动作', items: [] }
  }
  externalActions = items
  return {
    ok: true,
    items: items.map((item) => ({ name: item.name, duration: item.duration, matched: item.matched })),
    message: failures.length > 0 ? `${failures.length} 个文件被跳过：${failures[0]}` : undefined
  }
}

function externalToAnimationClip(index: number): THREE.AnimationClip | null {
  const item = externalActions[index]
  if (!item) return null
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of item.tracks) {
    const bone = boneByName.get(track.bone)
    if (!bone) continue
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, track.times, track.quats))
  }
  if (tracks.length === 0) return null
  return new THREE.AnimationClip(item.name, item.duration, tracks)
}

/** 播放导入的外部动作（先回到绑定姿态，避免和当前姿势叠在一起） */
function playExternalAction(index: number): { ok: boolean; message?: string } {
  const clip = externalToAnimationClip(index)
  if (!clip) return { ok: false, message: '该动作不可用' }
  for (const [id, bone] of boneObjects) {
    const rest = initialLocal.get(id)
    if (!rest) continue
    bone.position.copy(rest.position)
    bone.quaternion.copy(rest.quaternion)
    bone.scale.copy(rest.scale)
  }
  if (current) current.updateMatrixWorld(true)
  if (boneOverlay) updateSkeletonOverlay()
  playAnimationClip(clip, true)
  return { ok: true }
}

/** 取外部动作的轨道，交给主进程绑定到模型 */
function getExternalAction(index: number): ModelActionInput | null {
  const item = externalActions[index]
  if (!item) return null
  return {
    name: item.name.slice(0, 40),
    duration: item.duration,
    loop: true,
    fps: item.fps,
    origin: 'custom',
    tracks: item.tracks.map((track) => ({ ...track, times: [...track.times], quats: [...track.quats] })),
    edited: false
  }
}

function clearExternalActions(): void {
  externalActions = []
}

/* ------------------------------- 动作精修 ------------------------------- */

interface EditTrack {
  times: number[]
  quats: THREE.Quaternion[]
}

interface EditSession {
  name: string
  duration: number
  loop: boolean
  fps: number
  origin: 'native' | 'library' | 'custom'
  sourceKind?: string
  tracks: Map<string, EditTrack>
  dirty: boolean
}

let editSession: EditSession | null = null
let editTime = 0
let editPlaying = false

function tracksFromPoseClip(pose: PoseClip): Map<string, EditTrack> {
  const result = new Map<string, EditTrack>()
  for (const track of pose.tracks) {
    if (track.times.length === 0) continue
    result.set(track.bone, {
      times: [...track.times],
      quats: track.quats.map((quat) => quat.clone())
    })
  }
  return result
}

function tracksFromSaved(tracks: ModelActionTrack[]): Map<string, EditTrack> {
  const result = new Map<string, EditTrack>()
  for (const track of tracks) {
    if (!track.bone || track.times.length === 0) continue
    const quats: THREE.Quaternion[] = []
    for (let index = 0; index + 3 < track.quats.length; index += 4) {
      quats.push(new THREE.Quaternion(track.quats[index], track.quats[index + 1], track.quats[index + 2], track.quats[index + 3]))
    }
    if (quats.length !== track.times.length) continue
    result.set(track.bone, { times: [...track.times], quats })
  }
  return result
}

/** 把模型自带动画按 30fps 采样成每条骨骼一组关键帧 */
function sampleNativeClip(clip: THREE.AnimationClip): Map<string, EditTrack> {
  const result = new Map<string, EditTrack>()
  if (!mixer) return result
  const bones = [...boneObjects.values()]
  const fps = 30
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1)
  const times: number[] = []
  const samples: THREE.Quaternion[][] = bones.map(() => [])
  const action = mixer.clipAction(clip)
  action.reset()
  action.play()
  for (let index = 0; index < frames; index += 1) {
    const time = Math.min(clip.duration, index / fps)
    mixer.setTime(time)
    times.push(Number(time.toFixed(4)))
    bones.forEach((bone, boneIndex) => samples[boneIndex].push(bone.quaternion.clone()))
  }
  action.stop()
  mixer.stopAllAction()
  bones.forEach((bone, boneIndex) => {
    if (bone.name) result.set(bone.name, { times: [...times], quats: samples[boneIndex] })
  })
  return result
}

function sampleTrackAt(track: EditTrack, time: number): THREE.Quaternion {
  const { times, quats } = track
  if (times.length === 0) return new THREE.Quaternion()
  if (time <= times[0]) return quats[0].clone()
  const last = times.length - 1
  if (time >= times[last]) return quats[last].clone()
  let low = 0
  let high = last
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (times[mid] <= time) low = mid
    else high = mid
  }
  const span = times[high] - times[low]
  const alpha = span > 1e-6 ? (time - times[low]) / span : 0
  return quats[low].clone().slerp(quats[high], alpha)
}

function sampleEditTracks(time: number): void {
  if (!editSession) return
  for (const [boneName, track] of editSession.tracks) {
    const bone = boneByName.get(boneName)
    if (!bone) continue
    bone.quaternion.copy(sampleTrackAt(track, time))
  }
  if (current) current.updateMatrixWorld(true)
}

function emitEditState(): void {
  if (!editSession) {
    emit('edit-state', {
      editing: false,
      name: '',
      duration: 0,
      fps: 30,
      time: 0,
      playing: false,
      keyCount: 0,
      boneKeys: [],
      dirty: false
    })
    return
  }
  let keyCount = 0
  for (const track of editSession.tracks.values()) keyCount += track.times.length
  const selectedName = selectedBone?.name
  const selectedTrack = selectedName ? editSession.tracks.get(selectedName) : undefined
  emit('edit-state', {
    editing: true,
    name: editSession.name,
    duration: editSession.duration,
    fps: editSession.fps,
    time: editTime,
    playing: editPlaying,
    keyCount,
    boneKeys: selectedTrack ? [...selectedTrack.times] : [],
    dirty: editSession.dirty
  })
}

function emitEditTick(): void {
  emit('tick', {
    time: editTime,
    duration: editSession?.duration ?? 0,
    playing: editPlaying,
    index: -1
  })
}

function beginEdit(options: {
  name?: string
  origin: 'native' | 'library' | 'custom'
  sourceKind?: string
  clipIndex?: number
  kind?: ActionKind
  tracks?: ModelActionTrack[]
  duration?: number
  loop?: boolean
}): { ok: boolean; message?: string } {
  if (!mixer) return { ok: false, message: '模型还没加载完' }
  mixer.stopAllAction()
  activeAction = null
  generatedClip = null

  let tracks = new Map<string, EditTrack>()
  let name = options.name ?? '精修动作'
  let duration = options.duration ?? 2
  let loop = options.loop ?? true
  let sourceKind = options.sourceKind
  const fps = 30

  if (options.tracks && options.tracks.length > 0) {
    tracks = tracksFromSaved(options.tracks)
    const maxTime = Math.max(...options.tracks.map((item) => item.times[item.times.length - 1] ?? 0))
    duration = Math.max(duration, maxTime)
  } else if (options.kind) {
    const pose = buildPoseClip(options.kind)
    if (!pose) return { ok: false, message: '该模型没有可用骨骼，无法精修动作' }
    tracks = tracksFromPoseClip(pose)
    name = options.name ?? pose.name
    duration = pose.duration
    loop = options.loop ?? pose.loop
    sourceKind = options.kind
  } else if (options.clipIndex !== undefined) {
    const action = actions[options.clipIndex]
    if (!action) return { ok: false, message: '找不到该动画片段' }
    const clip = action.getClip()
    tracks = sampleNativeClip(clip)
    name = options.name ?? clip.name ?? '模型动作'
    duration = clip.duration
    loop = options.loop ?? true
  }

  if (tracks.size === 0) return { ok: false, message: '没有可编辑的骨骼轨道' }

  // 先把姿态复位，避免残留上一段动作
  for (const [id, bone] of boneObjects) {
    const rest = initialLocal.get(id)
    if (!rest) continue
    bone.position.copy(rest.position)
    bone.quaternion.copy(rest.quaternion)
    bone.scale.copy(rest.scale)
  }
  editSession = {
    name,
    duration: Math.max(duration, 0.1),
    loop,
    fps,
    origin: options.origin,
    sourceKind,
    tracks,
    dirty: false
  }
  editTime = 0
  editPlaying = false
  resetHistory()
  sampleEditTracks(0)
  emitEditState()
  emitEditTick()
  return { ok: true }
}

function endEdit(): void {
  editSession = null
  editPlaying = false
  editTime = 0
  emitEditState()
}

function playEdit(): void {
  if (!editSession) return
  editPlaying = true
  emitEditState()
  emitEditTick()
}

function pauseEdit(): void {
  editPlaying = false
  emitEditState()
  emitEditTick()
}

function seekEdit(time: number): void {
  if (!editSession) return
  const clamped = Math.min(Math.max(time, 0), editSession.duration)
  editTime = clamped
  sampleEditTracks(clamped)
  emitEditState()
  emitEditTick()
}

function stepEditFrame(delta: number): void {
  if (!editSession) return
  seekEdit(editTime + delta / editSession.fps)
}

function setKey(track: EditTrack, time: number, quat: THREE.Quaternion): void {
  const epsilon = 1 / 240
  const existing = track.times.findIndex((value) => Math.abs(value - time) < epsilon)
  if (existing >= 0) {
    track.quats[existing].copy(quat)
    track.times[existing] = Number(time.toFixed(4))
    return
  }
  let index = track.times.findIndex((value) => value > time)
  if (index < 0) index = track.times.length
  track.times.splice(index, 0, Number(time.toFixed(4)))
  track.quats.splice(index, 0, quat.clone())
}

/** 把当前选中骨骼的姿态记一个关键帧 */
function recordKey(): { ok: boolean; message?: string } {
  if (!editSession) return { ok: false, message: '当前不在精修模式' }
  if (!selectedBone || !selectedBone.name) return { ok: false, message: '先选中一根骨骼' }
  pushHistory('记录关键帧')
  const name = selectedBone.name
  let track = editSession.tracks.get(name)
  if (!track) {
    track = { times: [], quats: [] }
    editSession.tracks.set(name, track)
  }
  setKey(track, editTime, selectedBone.quaternion)
  editSession.dirty = true
  emitEditState()
  return { ok: true }
}

/** 记录整帧：所有已有轨道的骨骼都在当前时间打一帧 */
/** 把当前姿态快照写进指定时间点（所有骨骼，缺轨道就补） */
function keyAllBonesAt(time: number): number {
  if (!editSession) return 0
  let count = 0
  for (const bone of boneObjects.values()) {
    let track = editSession.tracks.get(bone.name)
    if (!track) {
      track = { times: [], quats: [] }
      editSession.tracks.set(bone.name, track)
    }
    setKey(track, time, bone.quaternion)
    count += 1
  }
  return count
}

function recordAllKeys(): { ok: boolean; count: number } {
  if (!editSession) return { ok: false, count: 0 }
  pushHistory('记录整帧')
  // 记录「整帧」= 当前姿态快照：动作原本没动的骨骼（比如快捷姿态刚摆的）也要补上轨道，
  // 否则它们只在暂停时看着对，一播放/跳帧就丢。
  const count = keyAllBonesAt(editTime)
  editSession.dirty = true
  emitEditState()
  return { ok: true, count }
}

/** 把当前骨骼状态原样应用到下一帧（复制一帧），常用于把姿势保持住 */
function applyToNextFrame(): { ok: boolean; message?: string; count?: number } {
  if (!editSession) return { ok: false, message: '当前不在精修模式' }
  const step = 1 / editSession.fps
  const nextTime = editTime + step
  if (nextTime > editSession.duration + 1e-6) {
    return { ok: false, message: '已经是最后一帧了' }
  }
  pushHistory('应用到下一帧')
  const count = keyAllBonesAt(nextTime)
  editSession.dirty = true
  editTime = Math.min(nextTime, editSession.duration)
  // 跳到下一帧后按新关键帧采样一次，保证画面与数据一致
  sampleEditTracks(editTime)
  restoreFrozenBones()
  emitEditState()
  emitEditTick()
  return { ok: true, count }
}

/** 删除当前时间点上选中骨骼的关键帧 */
function deleteKey(): { ok: boolean; message?: string } {
  if (!editSession) return { ok: false, message: '当前不在精修模式' }
  if (!selectedBone?.name) return { ok: false, message: '先选中一根骨骼' }
  const track = editSession.tracks.get(selectedBone.name)
  if (!track) return { ok: false, message: '这根骨骼还没有关键帧' }
  const epsilon = 1 / 240
  const index = track.times.findIndex((value) => Math.abs(value - editTime) < epsilon)
  if (index < 0) return { ok: false, message: '当前帧没有关键帧' }
  pushHistory('删除关键帧')
  track.times.splice(index, 1)
  track.quats.splice(index, 1)
  editSession.dirty = true
  emitEditState()
  return { ok: true }
}

function getEditResult(): ModelActionInput | null {
  if (!editSession) return null
  const tracks: ModelActionTrack[] = []
  for (const [bone, track] of editSession.tracks) {
    if (track.times.length === 0) continue
    const quats: number[] = []
    for (const quat of track.quats) quats.push(quat.x, quat.y, quat.z, quat.w)
    tracks.push({ bone, times: [...track.times], quats })
  }
  if (tracks.length === 0) return null
  return {
    name: editSession.name,
    duration: editSession.duration,
    loop: editSession.loop,
    fps: editSession.fps,
    origin: editSession.origin,
    sourceKind: editSession.sourceKind,
    tracks,
    edited: true
  }
}

/** 播放一条已绑定到模型的动作 */
function playStoredAction(action: ModelAction): { ok: boolean; message?: string } {
  if (!mixer) return { ok: false, message: '模型还没加载完' }
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of action.tracks) {
    const bone = boneByName.get(track.bone)
    if (!bone || track.times.length === 0) continue
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, track.times, track.quats))
  }
  if (tracks.length === 0) return { ok: false, message: '这条动作没有可用的骨骼轨道' }
  const clip = new THREE.AnimationClip(action.name, action.duration, tracks)
  playAnimationClip(clip, action.loop)
  return { ok: true }
}

/* ------------------------------- 撤销 / 重做 ------------------------------- */

interface PoseSnapshot {
  label: string
  bones: Map<
    string,
    {
      position: [number, number, number]
      quaternion: [number, number, number, number]
      scale: [number, number, number]
    }
  >
  tracks?: Map<string, EditTrack>
}

const HISTORY_LIMIT = 60
const undoStack: PoseSnapshot[] = []
const redoStack: PoseSnapshot[] = []

function emitHistoryState(): void {
  emit('history-state', { undo: undoStack.length, redo: redoStack.length })
}

function cloneTracks(tracks: Map<string, EditTrack>): Map<string, EditTrack> {
  const copy = new Map<string, EditTrack>()
  for (const [bone, track] of tracks) {
    copy.set(bone, { times: [...track.times], quats: track.quats.map((quat) => quat.clone()) })
  }
  return copy
}

function captureSnapshot(label: string): PoseSnapshot {
  const bones = new Map<
    string,
    {
      position: [number, number, number]
      quaternion: [number, number, number, number]
      scale: [number, number, number]
    }
  >()
  for (const [id, bone] of boneObjects) {
    const name = bone.name || id
    bones.set(name, {
      position: [bone.position.x, bone.position.y, bone.position.z],
      quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      scale: [bone.scale.x, bone.scale.y, bone.scale.z]
    })
  }
  return {
    label,
    bones,
    tracks: editSession ? cloneTracks(editSession.tracks) : undefined
  }
}

function applySnapshot(snapshot: PoseSnapshot): void {
  for (const [name, value] of snapshot.bones) {
    const bone = boneByName.get(name)
    if (!bone) continue
    bone.position.set(value.position[0], value.position[1], value.position[2])
    bone.quaternion.set(value.quaternion[0], value.quaternion[1], value.quaternion[2], value.quaternion[3])
    bone.scale.set(value.scale[0], value.scale[1], value.scale[2])
  }
  if (editSession && snapshot.tracks) {
    editSession.tracks = cloneTracks(snapshot.tracks)
    editSession.dirty = true
    sampleEditTracks(editTime)
  } else if (current) {
    current.updateMatrixWorld(true)
  }
  if (boneOverlay) updateSkeletonOverlay()
  emitBoneTransform()
  if (editSession) emitEditState()
}

/** 记录一步历史（在真正修改之前调用） */
function pushHistory(label: string): void {
  if (boneObjects.size === 0) return
  undoStack.push(captureSnapshot(label))
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
  emitHistoryState()
}

function resetHistory(): void {
  undoStack.length = 0
  redoStack.length = 0
  emitHistoryState()
}

function undo(): { ok: boolean; label?: string } {
  quickPoseBase = null
  const snapshot = undoStack.pop()
  if (!snapshot) return { ok: false }
  redoStack.push(captureSnapshot(snapshot.label))
  if (redoStack.length > HISTORY_LIMIT) redoStack.shift()
  applySnapshot(snapshot)
  emitHistoryState()
  return { ok: true, label: snapshot.label }
}

function redo(): { ok: boolean; label?: string } {
  quickPoseBase = null
  const snapshot = redoStack.pop()
  if (!snapshot) return { ok: false }
  undoStack.push(captureSnapshot(snapshot.label))
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  applySnapshot(snapshot)
  emitHistoryState()
  return { ok: true, label: snapshot.label }
}

/* ------------------------------- 仅骨骼模式 ------------------------------- */

/**
 * 冻结网格：把每块蒙皮网格的 skeleton 换成一份「定格骨架」——
 * 假骨骼的 matrixWorld 固定为当前姿态，于是挪真骨骼时网格不再跟着形变。
 * 松开时把原 skeleton 换回去。
 */
function applyFreezeMesh(freeze: boolean): void {
  if (!current) return
  if (!freeze) {
    for (const [mesh, original] of frozenSkeletons) {
      mesh.skeleton = original
    }
    frozenSkeletons.clear()
    return
  }
  if (frozenSkeletons.size > 0) return
  current.updateMatrixWorld(true)
  for (const mesh of collectSkinnedMeshes(current)) {
    const original = mesh.skeleton
    if (!original) continue
    const fakeBones: THREE.Bone[] = []
    for (const bone of original.bones) {
      const frozenBone = new THREE.Bone()
      frozenBone.name = bone.name
      frozenBone.matrixAutoUpdate = false
      frozenBone.matrix.copy(bone.matrixWorld)
      frozenBone.matrixWorld.copy(bone.matrixWorld)
      fakeBones.push(frozenBone)
    }
    const frozen = new THREE.Skeleton(fakeBones, original.boneInverses)
    frozenSkeletons.set(mesh, original)
    mesh.skeleton = frozen
  }
}

/* ------------------------------- 骨骼冷冻 ------------------------------- */

/** 框选/多选高亮的骨骼 */
const highlightedBones = new Set<string>()

/** 被冻结的骨骼：uuid -> 冻结那一刻的局部变换；播放动画时每帧恢复回去 */
const frozenBones = new Map<
  string,
  { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
>()

function emitFreezeState(): void {
  emit('freeze-state', { frozen: [...frozenBones.keys()] })
}

function setBoneFrozen(id: string, frozen: boolean): { ok: boolean } {
  const bone = boneObjects.get(id)
  if (!bone) return { ok: false }
  if (frozen) {
    frozenBones.set(id, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone()
    })
  } else {
    frozenBones.delete(id)
  }
  emitFreezeState()
  return { ok: true }
}

/** 批量冻结/解冻 */
function setBonesFrozen(ids: string[], frozen: boolean): void {
  let changed = false
  for (const id of ids) {
    const bone = boneObjects.get(id)
    if (!bone) continue
    if (frozen) {
      frozenBones.set(id, {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone()
      })
      changed = true
    } else if (frozenBones.delete(id)) {
      changed = true
    }
  }
  if (changed) emitFreezeState()
}

/** 框选/多选高亮：只影响关节球颜色，不改变骨骼姿态 */
function setSelectedBones(ids: string[]): void {
  highlightedBones.clear()
  for (const id of ids) highlightedBones.add(id)
  lastFrozenCount = -1 // 强制重刷一次颜色
}

function clearFrozenBones(): void {
  if (frozenBones.size === 0) return
  frozenBones.clear()
  emitFreezeState()
}

function isBoneFrozen(id: string): boolean {
  return frozenBones.has(id)
}

/** 播放/精修推进后把冻结骨骼的局部变换恢复回去 */
function restoreFrozenBones(): void {
  if (frozenBones.size === 0) return
  for (const [id, pose] of frozenBones) {
    const bone = boneObjects.get(id)
    if (!bone) continue
    bone.position.copy(pose.position)
    bone.quaternion.copy(pose.quaternion)
    bone.scale.copy(pose.scale)
  }
}

/* ------------------------------- 快捷姿态 ------------------------------- */


const QUICK_POSE_LABEL: Record<QuickPoseAction, string> = {
  'legs-in': '双腿内收',
  'legs-out': '双腿外展',
  'legs-forward': '双腿前摆',
  'legs-back': '双腿后摆',
  'arms-in': '双臂内收',
  'arms-out': '双臂外展',
  'arms-forward': '双臂前摆',
  'arms-back': '双臂后摆',
  'head-down': '低头',
  'head-up': '抬头',
  'lean-forward': '身体前倾',
  'lean-back': '身体后仰',
  reset: '重置姿态'
}

/** 绕世界轴旋转某根骨骼（换算到父空间后 premultiply，保持骨骼自身朝向不跑） */
function applyWorldDelta(bone: THREE.Bone, axis: THREE.Vector3, degrees: number): void {
  const parentWorld = new THREE.Quaternion()
  if (bone.parent) bone.parent.getWorldQuaternion(parentWorld)
  const rotation = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees))
  const localDelta = parentWorld.clone().invert().multiply(rotation).multiply(parentWorld)
  bone.quaternion.premultiply(localDelta)
  bone.updateMatrixWorld(true)
}

/** 骨骼在世界空间里的指向（头 -> 第一个子骨骼；末端骨用本地 +Y 估算） */
function boneDirection(bone: THREE.Bone): THREE.Vector3 {
  const head = new THREE.Vector3()
  bone.getWorldPosition(head)

  // 用「最深的末端骨骼」当方向锚点：腿 -> 脚趾、手臂 -> 手指。
  // 不能只用第一个子骨骼，Tripo 这类骨架里第一个子节点常是 twist 骨（位置和父骨几乎重合、
  // 方向也不代表肢体走向），会导致内收变成乱转。
  let deepest: { bone: THREE.Bone; depth: number } | null = null
  const walk = (node: THREE.Bone, depth: number): void => {
    for (const child of node.children) {
      if (!(child as THREE.Bone).isBone) continue
      const next = child as THREE.Bone
      if (!deepest || depth + 1 > deepest.depth) deepest = { bone: next, depth: depth + 1 }
      walk(next, depth + 1)
    }
  }
  walk(bone, 0)
  if (deepest) {
    const tail = new THREE.Vector3()
    ;(deepest as { bone: THREE.Bone }).bone.getWorldPosition(tail)
    const direction = tail.sub(head)
    if (direction.lengthSq() > 1e-6) return direction.normalize()
  }

  const quat = new THREE.Quaternion()
  bone.getWorldQuaternion(quat)
  return new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize()
}

/**
 * 内收 / 外展：把骨骼朝（或背离）身体中轴方向转。
 * 旋转轴取「骨骼方向 × 指向中轴方向」，所以手臂朝前、朝下、朝侧面都能正确收拢。
 */
function rotateTowardBody(bone: THREE.Bone, inward: boolean, step: number): boolean {
  if (!rigInfo) return false
  const roleMap = roleBoneMap(semanticRig!)
  const hipsName = roleMap.get('hips')
  const hipsBone = hipsName ? boneByName.get(hipsName) : null
  const head = new THREE.Vector3()
  bone.getWorldPosition(head)
  const hipsHead = new THREE.Vector3()
  if (hipsBone) hipsBone.getWorldPosition(hipsHead)
  else hipsHead.copy(head)

  const up = rigInfo.up
  const heightOffset = head.clone().sub(hipsHead).dot(up)
  const axisPoint = hipsHead.clone().add(up.clone().multiplyScalar(heightOffset))
  const towardCenter = axisPoint.sub(head)
  if (towardCenter.lengthSq() < 1e-8) return false

  const direction = boneDirection(bone)
  const axis = new THREE.Vector3().crossVectors(direction, towardCenter)
  if (axis.lengthSq() < 1e-8) return false
  axis.normalize()
  applyWorldDelta(bone, axis, inward ? step : -step)
  return true
}

/**
 * 一键姿态微调：按语义角色找骨骼，绕世界轴转固定角度。
 * 左右对称的动作用 lateralSign 决定正负，所以不依赖模型朝 +Z。
 */
/** 快捷姿态的「基准姿态」：拖动滑杆时先恢复到这里，再按角度重新施加 */
let quickPoseBase: { action: QuickPoseAction; snapshot: PoseSnapshot } | null = null

function restorePoseSnapshot(snapshot: PoseSnapshot): void {
  for (const [name, value] of snapshot.bones) {
    const bone = boneByName.get(name)
    if (!bone) continue
    bone.position.set(value.position[0], value.position[1], value.position[2])
    bone.quaternion.set(value.quaternion[0], value.quaternion[1], value.quaternion[2], value.quaternion[3])
    bone.scale.set(value.scale[0], value.scale[1], value.scale[2])
  }
  if (current) current.updateMatrixWorld(true)
}

/** 按角度施加一次快捷姿态增量，返回动到几根骨骼 */
function applyQuickPoseDelta(action: QuickPoseAction, step: number): number {
  if (!semanticRig || !rigInfo) return 0
  const rig = rigInfo
  const roleMap = roleBoneMap(semanticRig)
  const right = rig.right.clone().normalize()

  const rotate = (role: BoneRole, axis: THREE.Vector3, degrees: number): boolean => {
    const name = roleMap.get(role)
    if (!name) return false
    const bone = boneByName.get(name)
    if (!bone) return false
    applyWorldDelta(bone, axis, degrees)
    return true
  }
  const rotateToward = (roles: [BoneRole, BoneRole], inward: boolean): number => {
    let moved = 0
    for (const role of roles) {
      const name = roleMap.get(role)
      if (!name) continue
      const bone = boneByName.get(name)
      if (!bone) continue
      if (rotateTowardBody(bone, inward, step)) moved += 1
    }
    return moved
  }

  switch (action) {
    case 'legs-in':
      return rotateToward(['thigh_L', 'thigh_R'], true)
    case 'legs-out':
      return rotateToward(['thigh_L', 'thigh_R'], false)
    case 'legs-forward':
      return Number(rotate('thigh_L', right, -step)) + Number(rotate('thigh_R', right, -step))
    case 'legs-back':
      return Number(rotate('thigh_L', right, step)) + Number(rotate('thigh_R', right, step))
    case 'arms-in':
      return rotateToward(['upperArm_L', 'upperArm_R'], true)
    case 'arms-out':
      return rotateToward(['upperArm_L', 'upperArm_R'], false)
    case 'arms-forward':
      return Number(rotate('upperArm_L', right, -step)) + Number(rotate('upperArm_R', right, -step))
    case 'arms-back':
      return Number(rotate('upperArm_L', right, step)) + Number(rotate('upperArm_R', right, step))
    case 'head-down':
      return Number(rotate('head', right, step))
    case 'head-up':
      return Number(rotate('head', right, -step))
    case 'lean-forward':
      return Number(rotate('spine', right, step * 0.6)) + Number(rotate('chest', right, step * 0.4))
    case 'lean-back':
      return Number(rotate('spine', right, -step * 0.6)) + Number(rotate('chest', right, -step * 0.4))
    default:
      return 0
  }
}

/** 开始一个快捷姿态：记录基准姿态并压一行历史 */
function beginQuickPose(action: QuickPoseAction): { ok: boolean; message?: string } {
  if (action === 'reset') {
    quickPoseBase = null
    resetPose()
    return { ok: true }
  }
  if (!semanticRig || !rigInfo) return { ok: false, message: '该模型没有可用骨骼' }
  pushHistory('快捷姿态 · ' + (QUICK_POSE_LABEL[action] ?? action))
  quickPoseBase = { action, snapshot: captureSnapshot(QUICK_POSE_LABEL[action] ?? action) }
  return { ok: true }
}

/** 拖动滑杆：恢复基准后按当前角度重新施加（0° 等于没动） */
function setQuickPoseAmount(action: QuickPoseAction, amount: number): { ok: boolean; message?: string } {
  if (!quickPoseBase || quickPoseBase.action !== action) {
    const started = beginQuickPose(action)
    if (!started.ok) return started
  }
  if (!quickPoseBase) return { ok: false, message: '快捷姿态未初始化' }
  restorePoseSnapshot(quickPoseBase.snapshot)
  const moved = applyQuickPoseDelta(action, Math.abs(amount))
  if (boneOverlay) updateSkeletonOverlay()
  emitBoneTransform()
  if (editSession) emitEditState()
  if (moved === 0) {
    return { ok: false, message: '该模型没识别到对应骨骼（可先看骨架页签的角色标签）' }
  }
  return { ok: true }
}

/** 结束调整：保留当前姿态，丢掉基准 */
function endQuickPose(): void {
  quickPoseBase = null
}
/* ------------------------------- 视口点选 ------------------------------- */

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()
let pointerStart: { x: number; y: number; time: number } | null = null

function findPartId(object: THREE.Object3D): string | null {
  let node: THREE.Object3D | null = object
  while (node) {
    const id = partIdByObject.get(node)
    if (id) return id
    node = node.parent
  }
  return null
}

/** 屏幕空间找最近的骨骼节点（关节球很小，按像素距离容差比射线更稳） */
function pickBoneByScreen(clientX: number, clientY: number, maxPixels = 14): string | null {
  if (!camera || !renderer) return null
  const rect = renderer.domElement.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const world = new THREE.Vector3()
  let bestId: string | null = null
  let bestDistance = maxPixels
  for (const [id, bone] of boneObjects) {
    bone.getWorldPosition(world)
    world.project(camera)
    if (world.z < -1 || world.z > 1) continue
    const screenX = rect.left + ((world.x + 1) / 2) * rect.width
    const screenY = rect.top + ((1 - world.y) / 2) * rect.height
    const distance = Math.hypot(screenX - clientX, screenY - clientY)
    if (distance <= bestDistance) {
      bestDistance = distance
      bestId = id
    }
  }
  return bestId
}

/** 视口里点一下：先找骨骼节点，其次找网格部件 */
function pickAt(clientX: number, clientY: number): void {
  if (!camera || !renderer || !current) return

  const boneId = pickBoneByScreen(clientX, clientY)
  if (boneId) {
    emit('select-bone', boneId)
    return
  }

  const rect = renderer.domElement.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  pointerNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  )
  raycaster.setFromCamera(pointerNdc, camera)

  const meshes: THREE.Object3D[] = []
  current.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child)
  })
  const hits = raycaster.intersectObjects(meshes, false)
  for (const hit of hits) {
    const id = findPartId(hit.object)
    if (id) {
      emit('select-part', id)
      return
    }
  }
}
/* ------------------------------- 框选骨骼（Shift + 拖拽） ------------------------------- */

/** 框选模式：开启后直接左键拖拽就是框选（不必按 Shift） */
let boxSelectMode = false

function setBoxSelectMode(enabled: boolean): void {
  boxSelectMode = enabled
}

const boxSelect = {
  active: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0
}
let boxSelectEl: HTMLDivElement | null = null

function ensureBoxOverlay(): HTMLDivElement {
  if (boxSelectEl && boxSelectEl.isConnected) return boxSelectEl
  const el = document.createElement('div')
  el.className = 'viewer-box-select'
  el.style.cssText =
    'position:absolute;border:1px solid #4f46e5;background:rgba(79,70,229,0.14);pointer-events:none;z-index:6;display:none;border-radius:2px;'
  host.value?.appendChild(el)
  boxSelectEl = el
  return el
}

function updateBoxOverlay(): void {
  const el = ensureBoxOverlay()
  const left = Math.min(boxSelect.startX, boxSelect.currentX)
  const top = Math.min(boxSelect.startY, boxSelect.currentY)
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  el.style.width = `${Math.abs(boxSelect.currentX - boxSelect.startX)}px`
  el.style.height = `${Math.abs(boxSelect.currentY - boxSelect.startY)}px`
  el.style.display = 'block'
}

/** 选出矩形内的骨骼（按关节球屏幕位置判断） */
function bonesInBox(left: number, top: number, right: number, bottom: number): string[] {
  if (!camera) return []
  const ids: string[] = []
  const point = new THREE.Vector3()
  for (const [id, bone] of boneObjects) {
    bone.getWorldPosition(point)
    const projected = point.clone().project(camera)
    if (projected.z < -1 || projected.z > 1) continue
    const screenX = ((projected.x + 1) / 2) * sizeWidth
    const screenY = ((1 - projected.y) / 2) * sizeHeight
    if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) ids.push(id)
  }
  return ids
}

let sizeWidth = 1
let sizeHeight = 1

function onCanvasPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if ((event.shiftKey || boxSelectMode) && boneObjects.size > 0) {
    const rect = renderer?.domElement.getBoundingClientRect()
    if (!rect) return
    boxSelect.active = true
    boxSelect.startX = event.clientX - rect.left
    boxSelect.startY = event.clientY - rect.top
    boxSelect.currentX = boxSelect.startX
    boxSelect.currentY = boxSelect.startY
    sizeWidth = rect.width
    sizeHeight = rect.height
    if (controls) controls.enabled = false
    renderer?.domElement.setPointerCapture(event.pointerId)
    updateBoxOverlay()
    event.preventDefault()
    return
  }
  pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() }
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (!boxSelect.active) return
  const rect = renderer?.domElement.getBoundingClientRect()
  if (!rect) return
  boxSelect.currentX = event.clientX - rect.left
  boxSelect.currentY = event.clientY - rect.top
  updateBoxOverlay()
}

function onCanvasPointerUp(event: PointerEvent): void {
  if (boxSelect.active) {
    boxSelect.active = false
    const el = boxSelectEl
    if (el) el.style.display = 'none'
    if (controls) controls.enabled = true
    renderer?.domElement.releasePointerCapture?.(event.pointerId)
    const rect = renderer?.domElement.getBoundingClientRect()
    if (rect) {
      const width = Math.abs(boxSelect.currentX - boxSelect.startX)
      const height = Math.abs(boxSelect.currentY - boxSelect.startY)
      if (width > 4 || height > 4) {
        const left = Math.min(boxSelect.startX, boxSelect.currentX)
        const top = Math.min(boxSelect.startY, boxSelect.currentY)
        const ids = bonesInBox(left, top, left + width, top + height)
        setSelectedBones(ids)
        emit('select-bones', ids)
      }
    }
    return
  }
  const start = pointerStart
  pointerStart = null
  if (!start || event.button !== 0) return
  // 拖动视角/拖手柄时不当作点选
  const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
  if (moved > 5 || performance.now() - start.time > 700) return
  pickAt(event.clientX, event.clientY)
}

/* ------------------------------- 绑定姿态 ------------------------------- */

/**
 * 把当前骨骼世界变换定为新的绑定姿态（重建 inverse bind matrix）。
 * 配合「仅骨骼」冻结网格使用：骨骼挪动时不看网格形变，应用后从新的绑定姿态开始变形。
 */
function applyBindPose(): { ok: boolean; message?: string } {
  if (!current) return { ok: false, message: '模型还没加载完' }
  const meshes = collectSkinnedMeshes(current)
  if (meshes.length === 0) return { ok: false, message: '该模型没有蒙皮网格，无法设置绑定姿态' }
  pushHistory('应用为绑定姿态')
  stopAnimationForEdit()
  current.updateMatrixWorld(true)
  for (const mesh of meshes) {
    const skeleton = mesh.skeleton
    if (!skeleton) continue
    for (let index = 0; index < skeleton.bones.length; index += 1) {
      const bone = skeleton.bones[index]
      bone.updateWorldMatrix(true, false)
      skeleton.boneInverses[index].copy(bone.matrixWorld).invert()
    }
    skeleton.update()
  }
  // 新的绑定姿态成为「复位」基准
  for (const [id, bone] of boneObjects) {
    initialLocal.set(id, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone()
    })
  }
  // 语义与动作库依赖绑定姿态，重新跑一遍识别
  try {
    rigInfo = buildRig(current, collectSkinnedMeshes(current))
    semanticRig = autoDetectSemantics(rigInfo)
  } catch {
    rigInfo = null
    semanticRig = null
  }
  if (boneOverlay) updateSkeletonOverlay()
  emitBoneTransform()
  return { ok: true }
}

/* ------------------------------- 相机与网格 ------------------------------- */

function frameObject(object: THREE.Object3D, padding = 1.35): void {
  if (!camera || !controls) return
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  modelRadius = Math.max(size.length() / 2, 0.001)
  const distance = (modelRadius / Math.tan((camera.fov * Math.PI) / 360)) * padding
  controls.target.copy(center)
  camera.position.copy(center).add(new THREE.Vector3(distance * 0.62, distance * 0.48, distance * 0.62))
  camera.near = Math.max(modelRadius / 100, 0.001)
  camera.far = modelRadius * 100
  camera.updateProjectionMatrix()
  controls.update()
  updateGrid(box)
}

function updateGrid(box: THREE.Box3): void {
  if (!scene) return
  if (gridHelper) {
    scene.remove(gridHelper)
    gridHelper.geometry.dispose()
    ;(gridHelper.material as THREE.Material).dispose()
    gridHelper = null
  }
  if (!props.showGrid) return
  const size = new THREE.Vector3()
  box.getSize(size)
  const span = Math.max(size.x, size.z, 1) * 2.2
  gridHelper = new THREE.GridHelper(span, 20, 0x2b3a55, 0x1b2436)
  gridHelper.position.y = box.min.y
  gridHelper.position.x = (box.min.x + box.max.x) / 2
  gridHelper.position.z = (box.min.z + box.max.z) / 2
  scene.add(gridHelper)
}

/* ------------------------------- 选中高亮 ------------------------------- */

function clearSelectionVisual(): void {
  if (!scene) return
  for (const item of highlighted) {
    item.material.emissive.copy(item.emissive)
    item.material.emissiveIntensity = item.intensity
  }
  highlighted = []
  selectedBone = null
  if (boneMarker) {
    scene.remove(boneMarker)
    boneMarker.geometry.dispose()
    ;(boneMarker.material as THREE.Material).dispose()
    boneMarker = null
  }
}

/** 选中部件：给材质加一点自发光，保持整体视图不变（不画包围盒、不推镜头） */
function highlightPart(object: THREE.Object3D): void {
  const color = new THREE.Color(props.highlightColor || '#ffb74d')
  const intensity = Math.max(0.01, props.highlightIntensity ?? 0.45)
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const m = material as THREE.MeshStandardMaterial
      if (!m.emissive) continue
      highlighted.push({
        material: m,
        emissive: m.emissive.clone(),
        intensity: m.emissiveIntensity ?? 1
      })
      m.emissive.copy(color)
      m.emissiveIntensity = intensity
    }
  })
}

function highlightBone(bone: THREE.Bone): void {
  if (!scene) return
  const world = new THREE.Vector3()
  bone.getWorldPosition(world)
  selectedBone = bone
  // 单位圆环 + 每帧按屏幕像素缩放、始终朝向相机
  boneMarker = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.16, 10, 32),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(props.highlightColor || '#ffb74d'),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.98
    })
  )
  boneMarker.position.copy(world)
  if (camera) boneMarker.quaternion.copy(camera.quaternion)
  boneMarker.scale.setScalar(pixelRadiusAt(world, 9))
  boneMarker.renderOrder = 999
  scene.add(boneMarker)
}

/* ------------------------------- 骨架可视化 ------------------------------- */

const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

/** 某个距离上「1 像素」对应多少世界单位 */
function worldPerPixelAt(distance: number): number {
  if (!camera || !renderer) return 0.005
  const height = renderer.domElement.clientHeight || 800
  return (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height
}

/** 关节球尺寸按屏幕像素换算成世界尺寸，且按每根骨骼到相机的距离各自计算 */
function pixelRadiusAt(position: THREE.Vector3, pixels: number): number {
  if (!camera) return 0.01
  const distance = camera.position.distanceTo(position)
  return Math.max(pixels * worldPerPixelAt(distance), 1e-5)
}

function disposeSkeletonOverlay(): void {
  if (!boneOverlay) return
  if (scene) scene.remove(boneOverlay.group)
  boneOverlay.lines.geometry.dispose()
  ;(boneOverlay.lines.material as THREE.Material).dispose()
  boneOverlay.joints.geometry.dispose()
  ;(boneOverlay.joints.material as THREE.Material).dispose()
  boneOverlay.joints.dispose()
  boneOverlay = null
}

/** 每帧把关节球和连线对齐到骨骼当前世界位置（动画播放时也跟着动） */
const FROZEN_JOINT_COLOR = new THREE.Color('#c4b5fd')
const SELECTED_JOINT_COLOR = new THREE.Color('#fbbf24')
const NORMAL_JOINT_COLOR = new THREE.Color('#67e8f9')
// 用于判断颜色是否需要重刷：>0 表示有需要着色的状态
let lastFrozenCount = 0

function updateSkeletonOverlay(): void {
  if (!boneOverlay) return
  const { edges, joints, bones, lines } = boneOverlay
  const attribute = lines.geometry.attributes.position as THREE.BufferAttribute
  let cursor = 0
  for (const [bone, child] of edges) {
    bone.getWorldPosition(_v)
    attribute.setXYZ(cursor++, _v.x, _v.y, _v.z)
    child.getWorldPosition(_v)
    attribute.setXYZ(cursor++, _v.x, _v.y, _v.z)
  }
  attribute.needsUpdate = true
  lines.geometry.computeBoundingSphere()

  for (let index = 0; index < bones.length; index += 1) {
    bones[index].getWorldPosition(_v)
    // 按各自到相机的距离换算，远近的关节在屏幕上一样大
    _s.setScalar(pixelRadiusAt(_v, 3))
    _m.compose(_v, _q, _s)
    joints.setMatrixAt(index, _m)
    if (frozenBones.size > 0 || highlightedBones.size > 0 || lastFrozenCount !== 0) {
      const bone = bones[index]
      joints.setColorAt(
        index,
        frozenBones.has(bone.uuid)
          ? FROZEN_JOINT_COLOR
          : highlightedBones.has(bone.uuid)
            ? SELECTED_JOINT_COLOR
            : NORMAL_JOINT_COLOR
      )
    }
  }
  joints.instanceMatrix.needsUpdate = true
  if (frozenBones.size > 0 || highlightedBones.size > 0 || lastFrozenCount !== 0) {
    if (joints.instanceColor) joints.instanceColor.needsUpdate = true
    lastFrozenCount = frozenBones.size + highlightedBones.size
  }

  // 选中的骨骼套一圈黄色圆环，始终正对相机
  if (boneMarker && selectedBone) {
    selectedBone.getWorldPosition(_v)
    boneMarker.position.copy(_v)
    if (camera) boneMarker.quaternion.copy(camera.quaternion)
    boneMarker.scale.setScalar(pixelRadiusAt(_v, 9))
    boneMarker.visible = true
  }
}
function rebuildSkeletonOverlay(): void {
  disposeSkeletonOverlay()
  if (!scene || !props.showSkeleton || !current || boneObjects.size === 0) return

  const bones = [...boneObjects.values()]
  const boneSet = new Set<THREE.Bone>(bones)
  const edges: Array<[THREE.Bone, THREE.Bone]> = []
  for (const bone of bones) {
    for (const child of bone.children) {
      if (boneSet.has(child as THREE.Bone)) edges.push([bone, child as THREE.Bone])
    }
  }

  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(Math.max(edges.length, 1) * 2 * 3), 3)
  )
  const lines = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false
    })
  )
  lines.frustumCulled = false
  lines.renderOrder = 900

  // 关节球用单位球，每帧按屏幕像素缩放（见 updateSkeletonOverlay）
  const joints = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false
    }),
    bones.length
  )
  joints.frustumCulled = false
  joints.renderOrder = 901

  const group = new THREE.Group()
  group.name = 'skeleton-overlay'
  group.add(lines)
  group.add(joints)
  scene.add(group)

  boneOverlay = { group, lines, joints, edges, bones }
  updateSkeletonOverlay()
}

/* ------------------------------- 加载与释放 ------------------------------- */

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const m = material as THREE.MeshStandardMaterial
      if (m.map) m.map.dispose()
      m.dispose()
    }
  })
}

function clearModel(): void {
  if (!scene || !current) return
  applyFreezeMesh(false)
  clearSelectionVisual()
  gizmo?.detach()
  if (gizmo) gizmo.getHelper().visible = false
  editSession = null
  editPlaying = false
  editTime = 0
  frozenBones.clear()
  resetHistory()
  disposeSkeletonOverlay()
  if (mixer) {
    mixer.stopAllAction()
    mixer.uncacheRoot(current)
    mixer = null
  }
  actions = []
  activeAction = null
  scene.remove(current)
  disposeObject(current)
  current = null
  partObjects.clear()
  partByKey.clear()
  partIdByObject.clear()
  boneObjects.clear()
  boneByName.clear()
  rigInfo = null
  semanticRig = null
  generatedClip = null
  selectionId = ''
  lastHighlight = null
}

async function loadModel(bytes: Uint8Array | ArrayBuffer): Promise<void> {
  if (!scene) return
  loading.value = true
  clearModel()
  const buffer = normalizeBytes(bytes)
  const loader = new GLTFLoader()
  // GLB 内嵌贴图走 blob: URL；file:// 页面下一旦设置 crossOrigin 就会 CORS 失败（白模）
  ;(loader as unknown as { crossOrigin?: string }).crossOrigin = undefined
  try {
    const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
      (resolve, reject) => {
        loader.parse(
          buffer,
          '',
          (result) => resolve({ scene: result.scene, animations: result.animations ?? [] }),
          reject
        )
      }
    )
    if (!scene) return
    current = gltf.scene
    scene.add(gltf.scene)
    applyWireframe()
    frameObject(gltf.scene)

    const box = new THREE.Box3().setFromObject(gltf.scene)
    const size = new THREE.Vector3()
    box.getSize(size)
    const fmt = (value: number): string => `${value >= 1 ? value.toFixed(2) : value.toFixed(3)} m`

    mixer = new THREE.AnimationMixer(gltf.scene)
    actions = gltf.animations.map((clip) => mixer!.clipAction(clip))

    emit(
      'parsed',
      buildStructure(gltf.animations, `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`)
    )
    analyzeSemantics(gltf.scene)
    // 必须等 buildStructure 解析完骨骼（填充 boneObjects）再建骨架叠加层
    rebuildSkeletonOverlay()
    if (props.freezeMesh) applyFreezeMesh(true)
    emit('tick', { time: 0, duration: 0, playing: false, index: -1 })
  } catch (error) {
    const message = (error as Error)?.message || '模型解析失败'
    emit(
      'error',
      /draco|khr_draco/i.test(message)
        ? '该模型使用了 Draco 压缩，预览暂不支持（可用 Blender 重新导出未压缩的 glb）'
        : `模型解析失败：${message}`
    )
  } finally {
    loading.value = false
  }
}

/* ------------------------------- 对外操作 ------------------------------- */

function resetView(): void {
  if (current) frameObject(current)
}

function screenshot(): string {
  if (!renderer || !scene || !camera) return ''
  renderer.render(scene, camera)
  return renderer.domElement.toDataURL('image/png')
}

function setPartVisible(id: string, visible: boolean): void {
  const object = partObjects.get(id)
  if (!object) return
  object.visible = visible
}

/** 只选中并高亮，不动镜头（点列表时的默认行为，保持整体视图） */
function selectNode(id: string): void {
  // 单选时清掉多选组（手柄重新挂到单根骨骼上）
  groupBoneIds = []
  groupStart = null
  selectionId = id
  clearSelectionVisual()
  const part = partObjects.get(id)
  if (part) {
    lastHighlight = { type: 'part', value: id }
    highlightPart(part)
    attachGizmo(null)
    return
  }
  const bone = boneObjects.get(id)
  if (bone) {
    lastHighlight = { type: 'bone', value: id }
    highlightBone(bone)
    attachGizmo(bone)
    emitBoneTransform()
  }
}

/** 按稳定 key 批量高亮（应用分组时用） */
function highlightParts(keys: string[]): void {
  selectionId = ''
  lastHighlight = keys.length ? { type: 'parts', value: [...keys] } : null
  clearSelectionVisual()
  attachGizmo(null)
  for (const key of keys) {
    const object = partByKey.get(key)
    if (object) highlightPart(object)
  }
}

/** 高亮颜色/强度被改了：按当前选中项重刷一遍 */
function reapplyHighlight(): void {
  if (!lastHighlight) return
  if (lastHighlight.type === 'parts') highlightParts(lastHighlight.value as string[])
  else selectNode(lastHighlight.value as string)
}

function setVisibleByKeys(keys: string[], visible: boolean): void {
  for (const key of keys) {
    const object = partByKey.get(key)
    if (object) object.visible = visible
  }
}

/**
 * 把一组部件导出成 glb 字节。
 * 部件很多是 SkinnedMesh，直接导出会带上外部骨骼引用；这里统一烘焙成静态网格
 * （保留世界变换与材质贴图），导出的就是一个可单独使用的道具/部件模型。
 */
async function exportParts(keys: string[]): Promise<ArrayBuffer> {
  // 选中高亮是改材质 emissive 实现的（只是给用户看的提示），导出前必须临时清掉，
  // 否则提示色会被烘进导出的 glb 材质里。
  const hadHighlight = lastHighlight
  clearSelectionVisual()
  try {
    return await buildPartGroupGlb(keys)
  } finally {
    if (hadHighlight) reapplyHighlight()
  }
}

async function buildPartGroupGlb(keys: string[]): Promise<ArrayBuffer> {
  const group = new THREE.Group()
  group.name = 'part-group'
  const seen = new Set<string>()

  for (const key of keys) {
    const source = partByKey.get(key)
    if (!source || seen.has(source.uuid)) continue
    seen.add(source.uuid)
    const geometry = (source as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!geometry) continue

    source.updateWorldMatrix(true, false)
    const material = (source as THREE.Mesh).material as THREE.Material
    const anySource = source as unknown as { isLine?: boolean; isPoints?: boolean }
    const clone = anySource.isLine
      ? new THREE.LineSegments(geometry, material)
      : anySource.isPoints
        ? new THREE.Points(geometry, material)
        : new THREE.Mesh(geometry, material)
    clone.name = source.name || `part_${key}`
    source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale)
    group.add(clone)
  }

  if (group.children.length === 0) throw new Error('没有可导出的部件')

  const exporter = new GLTFExporter()
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result)
        else reject(new Error('导出结果不是二进制 glb'))
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      { binary: true, onlyVisible: false }
    )
  })
}

/** 选中并把镜头推到该节点（双击 / 聚焦按钮触发） */
function focusNode(id: string): void {
  if (!camera || !controls) return
  selectNode(id)

  const part = partObjects.get(id)
  if (part) {
    const box = new THREE.Box3().setFromObject(part)
    if (box.isEmpty()) return
    const center = new THREE.Vector3()
    const size = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(size)
    const radius = Math.max(size.length() / 2, 0.001)
    const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 2.2
    controls.target.copy(center)
    camera.position.copy(center).add(new THREE.Vector3(distance * 0.7, distance * 0.5, distance * 0.7))
    camera.updateProjectionMatrix()
    controls.update()
    return
  }

  const bone = boneObjects.get(id)
  if (bone) {
    const world = new THREE.Vector3()
    bone.getWorldPosition(world)
    const distance = Math.max(modelRadius * 0.6, 0.2)
    controls.target.copy(world)
    camera.position.copy(world).add(new THREE.Vector3(distance, distance * 0.6, distance))
    camera.updateProjectionMatrix()
    controls.update()
  }
}

function playClip(index: number): void {
  if (!mixer || !actions[index]) return
  const next = actions[index]
  if (activeAction && activeAction !== next) activeAction.stop()
  activeAction = next
  next.reset()
  next.setLoop(THREE.LoopRepeat, Infinity)
  next.clampWhenFinished = false
  next.play()
  emit('tick', { time: 0, duration: next.getClip().duration, playing: true, index })
}

function pauseClip(): void {
  if (!mixer || !activeAction) return
  activeAction.paused = true
  emit('tick', {
    time: activeAction.time,
    duration: activeAction.getClip().duration,
    playing: false,
    index: actions.indexOf(activeAction)
  })
}

function resumeClip(): void {
  if (!mixer || !activeAction) return
  activeAction.paused = false
  emit('tick', {
    time: activeAction.time,
    duration: activeAction.getClip().duration,
    playing: true,
    index: actions.indexOf(activeAction)
  })
}

function seekClip(time: number): void {
  if (!activeAction) return
  activeAction.time = Math.min(Math.max(time, 0), activeAction.getClip().duration)
  mixer?.update(0)
}

function setClipSpeed(speed: number): void {
  if (activeAction) activeAction.timeScale = speed
}

function stopClip(): void {
  if (mixer) mixer.stopAllAction()
  activeAction = null
  emit('tick', { time: 0, duration: 0, playing: false, index: -1 })
}

/* ------------------------------- 主循环 ------------------------------- */

function animate(): void {
  frameId = requestAnimationFrame(animate)
  const now = performance.now()
  const delta = Math.min((now - lastFrame) / 1000, 0.1)
  lastFrame = now
  if (mixer && activeAction && !activeAction.paused) mixer.update(delta)
  // 冷冻骨骼：无论哪种动作（自带 / 动作库 / 已绑定 / 外部）推进后都把它们还原
  restoreFrozenBones()
  // 精修模式自己驱动播放头，不走 mixer
  if (editSession && editPlaying) {
    editTime += delta
    if (editTime > editSession.duration) {
      editTime = editSession.loop ? editTime % editSession.duration : editSession.duration
      if (!editSession.loop) editPlaying = false
    }
    sampleEditTracks(editTime)
    restoreFrozenBones()
    if (now - lastTick > 100) {
      lastTick = now
      emitEditState()
      emitEditTick()
    }
  }
  controls?.update()
  // 骨骼在动，关节球和连线要跟着刷新
  if (boneOverlay) updateSkeletonOverlay()
  if (renderer && scene && camera) renderer.render(scene, camera)

  if (activeAction && now - lastTick > 100) {
    lastTick = now
    emit('tick', {
      time: activeAction.time,
      duration: activeAction.getClip().duration,
      playing: !activeAction.paused,
      index: actions.indexOf(activeAction)
    })
  }
}

function resize(): void {
  if (!host.value || !renderer || !camera) return
  const width = host.value.clientWidth
  const height = host.value.clientHeight
  if (width === 0 || height === 0) return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

onMounted(() => {
  if (!host.value) return
  const width = host.value.clientWidth || 640
  const height = host.value.clientHeight || 420

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = props.exposure
  host.value.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown)
  renderer.domElement.addEventListener('pointermove', onCanvasPointerMove)
  renderer.domElement.addEventListener('pointerup', onCanvasPointerUp)

  scene = new THREE.Scene()
  applyBackground()

  camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000)
  camera.position.set(2.2, 1.6, 2.8)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.autoRotate = props.autoRotate
  controls.autoRotateSpeed = 1.4
  controls.maxPolarAngle = Math.PI * 0.92
  controls.addEventListener('start', () => {
    if (controls) controls.autoRotate = false
  })

  // 骨骼编辑 gizmo：旋转/移动，拖动时暂停轨道控制
  gizmo = new TransformControls(camera, renderer.domElement)
  gizmo.setSpace('local')
  gizmo.setMode(props.gizmoMode === 'off' ? 'rotate' : props.gizmoMode)
  gizmo.setSize(0.8)
  const gizmoHelper = gizmo.getHelper()
  gizmoHelper.visible = false
  gizmoHelper.renderOrder = 1000
  gizmoHelper.traverse((child) => {
    const mesh = child as THREE.Mesh
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    const list = Array.isArray(material) ? material : material ? [material] : []
    for (const item of list) {
      item.depthTest = false
      item.depthWrite = false
    }
  })
  scene.add(gizmoHelper)
  gizmo.addEventListener('dragging-changed', (event) => {
    const dragging = Boolean((event as unknown as { value: boolean }).value)
    if (controls) controls.enabled = !dragging
    if (dragging) {
      pushHistory('拖动骨骼')
      stopAnimationForEdit()
      captureGroupStart()
    } else {
      groupStart = null
    }
  })
  gizmo.addEventListener('objectChange', () => {
    if (groupBoneIds.length > 1 && groupStart) {
      applyGroupDelta()
      return
    }
    emitBoneTransform()
    if (boneOverlay) updateSkeletonOverlay()
  })

  pmrem = new THREE.PMREMGenerator(renderer)
  envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTexture
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x1a2333, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(4, 6, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5)
  fill.position.set(-5, 2, -4)
  scene.add(fill)

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host.value)
  animate()

  if (props.bytes) void loadModel(props.bytes)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  controls?.dispose()
  gizmo?.detach()
  gizmo?.dispose()
  gizmo = null
  mixer = null
  clearModel()
  disposeSkeletonOverlay()
  envTexture?.dispose()
  pmrem?.dispose()
  renderer?.dispose()
  if (renderer?.domElement) {
    renderer.domElement.removeEventListener('pointerdown', onCanvasPointerDown)
    renderer.domElement.removeEventListener('pointermove', onCanvasPointerMove)
    renderer.domElement.removeEventListener('pointerup', onCanvasPointerUp)
  }
  boxSelectEl?.remove()
  boxSelectEl = null
  if (renderer?.domElement.parentElement) {
    renderer.domElement.parentElement.removeChild(renderer.domElement)
  }
  renderer = null
  scene = null
  camera = null
  controls = null
})

watch(
  () => props.bytes,
  (value) => {
    if (value) void loadModel(value)
    else clearModel()
  }
)

watch(
  () => props.autoRotate,
  (value) => {
    if (controls) controls.autoRotate = value
  }
)

watch(
  () => props.showGrid,
  () => {
    if (current) frameObject(current)
  }
)

watch(
  () => props.showSkeleton,
  () => {
    rebuildSkeletonOverlay()
  }
)

watch(
  () => props.gizmoMode,
  (mode) => {
    if (!gizmo) return
    const helper = gizmo.getHelper()
    if (mode === 'off') {
      gizmo.detach()
      helper.visible = false
      return
    }
    gizmo.setMode(mode)
    if (groupBoneIds.length > 1) {
      if (groupPivot) {
        gizmo.attach(groupPivot)
        helper.visible = true
      }
      return
    }
    if (selectedBone) {
      gizmo.attach(selectedBone)
      helper.visible = true
    }
  }
)

watch(
  () => props.freezeMesh,
  (freeze) => {
    applyFreezeMesh(freeze)
  }
)

watch(
  () => [props.highlightColor, props.highlightIntensity] as const,
  () => {
    reapplyHighlight()
  }
)

watch(
  () => [props.wireframe, props.background, props.exposure] as const,
  () => {
    applyWireframe()
    applyBackground()
    if (renderer) renderer.toneMappingExposure = props.exposure
  }
)

defineExpose({
  resetView,
  screenshot,
  setPartVisible,
  setVisibleByKeys,
  selectNode,
  highlightParts,
  exportParts,
  generateActionClip,
  getBoneTransform,
  setBoneTransform,
  resetBone,
  resetPose,
  clearSelection,
  beginEdit,
  endEdit,
  playEdit,
  pauseEdit,
  seekEdit,
  stepEditFrame,
  recordKey,
  recordAllKeys,
  applyToNextFrame,
  deleteKey,
  getEditResult,
  playStoredAction,
  undo,
  redo,
  setBoneFrozen,
  setBonesFrozen,
  setBoxSelectMode,
  setSelectedBones,
  setBoneGroup,
  clearFrozenBones,
  isBoneFrozen,
  importExternalActions,
  playExternalAction,
  getExternalAction,
  clearExternalActions,
  beginQuickPose,
  setQuickPoseAmount,
  endQuickPose,
  applyBindPose,
  focusNode,
  playClip,
  pauseClip,
  resumeClip,
  seekClip,
  setClipSpeed,
  stopClip
})
</script>

<template>
  <div ref="host" v-loading="loading" class="viewer">
    <div v-if="!props.bytes" class="viewer__hint">暂无可预览的模型数据</div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  background: #0b1220;
}

.viewer__hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgba(226, 232, 240, 0.6);
  font-size: 13px;
}
</style>
