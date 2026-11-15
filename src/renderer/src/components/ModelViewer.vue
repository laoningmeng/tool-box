<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { buildRig, collectSkinnedMeshes, lateralSign } from '../rig/rig'
import { autoDetectSemantics, missingRoles, roleBoneMap } from '../rig/semantics'
import { generateAction } from '../rig/actions'
import { ROLE_LABELS } from '../rig/types'
import type { ActionKind, BoneRole, PoseClip, RigInfo, SemanticRig } from '../rig/types'
import type {
  ClipEditState,
  SemanticSummary,
  ViewerBone,
  ViewerClip,
  ViewerPart,
  ViewerStructure
} from './model-viewer-types'
import type { ModelAction, ModelActionInput, ModelActionTrack } from '@shared/types'

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
    gizmoMode?: 'rotate' | 'translate' | 'off'
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

function attachGizmo(bone: THREE.Bone | null): void {
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
function recordAllKeys(): { ok: boolean; count: number } {
  if (!editSession) return { ok: false, count: 0 }
  pushHistory('记录整帧')
  let count = 0
  for (const [boneName, track] of editSession.tracks) {
    const bone = boneByName.get(boneName)
    if (!bone) continue
    setKey(track, editTime, bone.quaternion)
    count += 1
  }
  editSession.dirty = true
  emitEditState()
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
  const snapshot = undoStack.pop()
  if (!snapshot) return { ok: false }
  redoStack.push(captureSnapshot(snapshot.label))
  if (redoStack.length > HISTORY_LIMIT) redoStack.shift()
  applySnapshot(snapshot)
  emitHistoryState()
  return { ok: true, label: snapshot.label }
}

function redo(): { ok: boolean; label?: string } {
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
  }
  joints.instanceMatrix.needsUpdate = true

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
  // 精修模式自己驱动播放头，不走 mixer
  if (editSession && editPlaying) {
    editTime += delta
    if (editTime > editSession.duration) {
      editTime = editSession.loop ? editTime % editSession.duration : editSession.duration
      if (!editSession.loop) editPlaying = false
    }
    sampleEditTracks(editTime)
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
  gizmo.setMode(props.gizmoMode === 'translate' ? 'translate' : 'rotate')
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
    }
  })
  gizmo.addEventListener('objectChange', () => {
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
  beginEdit,
  endEdit,
  playEdit,
  pauseEdit,
  seekEdit,
  stepEditFrame,
  recordKey,
  recordAllKeys,
  deleteKey,
  getEditResult,
  playStoredAction,
  undo,
  redo,
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
