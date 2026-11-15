<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type {
  ViewerBone,
  ViewerClip,
  ViewerPart,
  ViewerStructure
} from './model-viewer-types'

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
  }>(),
  {
    format: 'glb',
    autoRotate: true,
    wireframe: false,
    showGrid: true,
    showSkeleton: false,
    background: '#0b1220',
    exposure: 1
  }
)

const emit = defineEmits<{
  parsed: [structure: ViewerStructure]
  tick: [state: { time: number; duration: number; playing: boolean; index: number }]
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
let skeletonHelper: THREE.SkeletonHelper | null = null
let boneMarker: THREE.Mesh | null = null
/** 选中高亮改过的材质，取消选中时要还原 */
let highlighted: Array<{ material: THREE.MeshStandardMaterial; emissive: THREE.Color; intensity: number }> = []

let mixer: THREE.AnimationMixer | null = null
let actions: THREE.AnimationAction[] = []
let activeAction: THREE.AnimationAction | null = null
let lastTick = 0
let lastFrame = performance.now()

const partObjects = new Map<string, THREE.Object3D>()
const partByKey = new Map<string, THREE.Object3D>()
const boneObjects = new Map<string, THREE.Bone>()
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
  const bones = collectBones(root)
  if (bones.length === 0) return []

  const boneSet = new Set<THREE.Bone>(bones)
  const result: ViewerBone[] = []
  const childCount = new Map<THREE.Object3D, number>()
  for (const bone of bones) {
    boneObjects.set(bone.uuid, bone)
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
  if (boneMarker) {
    scene.remove(boneMarker)
    boneMarker.geometry.dispose()
    ;(boneMarker.material as THREE.Material).dispose()
    boneMarker = null
  }
}

/** 选中部件：给材质加一点自发光，保持整体视图不变（不画包围盒、不推镜头） */
function highlightPart(object: THREE.Object3D): void {
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
      m.emissive = new THREE.Color(0xffb74d)
      m.emissiveIntensity = 0.45
    }
  })
}

function highlightBone(bone: THREE.Bone): void {
  if (!scene) return
  const world = new THREE.Vector3()
  bone.getWorldPosition(world)
  const radius = Math.max(modelRadius * 0.008, 0.0015)
  boneMarker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffb74d, depthTest: false })
  )
  boneMarker.position.copy(world)
  boneMarker.renderOrder = 999
  scene.add(boneMarker)
}

/* ------------------------------- 骨架可视化 ------------------------------- */

function refreshSkeletonHelper(): void {
  if (!scene) return
  if (skeletonHelper) {
    scene.remove(skeletonHelper)
    skeletonHelper.geometry.dispose()
    ;(skeletonHelper.material as THREE.Material).dispose()
    skeletonHelper = null
  }
  if (!props.showSkeleton || !current || boneObjects.size === 0) return
  skeletonHelper = new THREE.SkeletonHelper(current)
  ;(skeletonHelper.material as THREE.LineBasicMaterial).depthTest = false
  ;(skeletonHelper.material as THREE.LineBasicMaterial).transparent = true
  ;(skeletonHelper.material as THREE.LineBasicMaterial).opacity = 0.9
  scene.add(skeletonHelper)
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
  clearSelectionVisual()
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
  selectionId = ''
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

    refreshSkeletonHelper()
    emit(
      'parsed',
      buildStructure(gltf.animations, `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`)
    )
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
    highlightPart(part)
    return
  }
  const bone = boneObjects.get(id)
  if (bone) highlightBone(bone)
}

/** 按稳定 key 批量高亮（应用分组时用） */
function highlightParts(keys: string[]): void {
  selectionId = ''
  clearSelectionVisual()
  for (const key of keys) {
    const object = partByKey.get(key)
    if (object) highlightPart(object)
  }
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
  controls?.update()
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
  mixer = null
  clearModel()
  refreshSkeletonHelper()
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
    refreshSkeletonHelper()
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
