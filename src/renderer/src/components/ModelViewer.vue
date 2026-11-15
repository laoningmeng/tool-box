<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * 3D 预览画布（based on three.js）。
 *
 * 只负责「把 glb/gltf 的字节渲染出来 + 一组可调显示项」，不关心业务：
 * 预览弹窗与实验台共用，通过 props 控制显示，通过 expose 暴露重置视角/截图。
 */

const props = withDefaults(
  defineProps<{
    /** 模型文件字节（glb / gltf）；null 表示还没加载 */
    bytes: Uint8Array | ArrayBuffer | null
    format?: string
    autoRotate?: boolean
    wireframe?: boolean
    showGrid?: boolean
    background?: string
    /** 光照/曝光强度，0.2 ~ 2.5 */
    exposure?: number
  }>(),
  {
    format: 'glb',
    autoRotate: true,
    wireframe: false,
    showGrid: true,
    background: '#0b1220',
    exposure: 1
  }
)

const emit = defineEmits<{
  loaded: [info: { triangles: number; meshes: number; size: string }]
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
let current: THREE.Object3D | null = null
let pmrem: THREE.PMREMGenerator | null = null
let envTexture: THREE.Texture | null = null

const BG = new THREE.Color()
const UP = new THREE.Vector3(0, 1, 0)

function normalizeBytes(input: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
}

function applyBackground(): void {
  if (!scene) return
  BG.set(props.background)
  scene.background = BG
}

function applyExposure(): void {
  if (renderer) renderer.toneMappingExposure = props.exposure
}

function applyWireframe(): void {
  if (!current) return
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      const m = material as THREE.MeshStandardMaterial
      if ('wireframe' in m) m.wireframe = props.wireframe
    }
  })
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

function frameObject(object: THREE.Object3D): void {
  if (!camera || !controls) return
  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const radius = Math.max(size.length() / 2, 0.001)
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.35

  controls.target.copy(center)
  camera.position.copy(center).add(new THREE.Vector3(distance * 0.62, distance * 0.48, distance * 0.62))
  camera.near = Math.max(radius / 100, 0.001)
  camera.far = radius * 100
  camera.updateProjectionMatrix()
  controls.update()

  const fmt = (value: number): string =>
    `${value >= 1 ? value.toFixed(2) : value.toFixed(3)} m`
  emit('loaded', {
    triangles: countTriangles(object),
    meshes: countMeshes(object),
    size: `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`
  })

  updateGrid(box)
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

function countMeshes(object: THREE.Object3D): number {
  let total = 0
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) total += 1
  })
  return total
}

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
  scene.remove(current)
  disposeObject(current)
  current = null
}

async function loadModel(bytes: Uint8Array | ArrayBuffer): Promise<void> {
  if (!scene) return
  loading.value = true
  clearModel()
  const buffer = normalizeBytes(bytes)
  const loader = new GLTFLoader()
  // GLB 里的贴图会被 three 转成 blob: URL 再加载。页面是 file:// 起源，
  // 一旦给 <img> 设了 crossOrigin（默认 anonymous，设成 '' 也一样）就会走 CORS 而失败，
  // 表现是「模型有几何但贴图全白」。这里把它清成 undefined，让 ImageLoader 不加该属性。
  ;(loader as unknown as { crossOrigin?: string }).crossOrigin = undefined
  try {
    const gltf = await new Promise<THREE.Group>((resolve, reject) => {
      loader.parse(buffer, '', (result) => resolve(result.scene), reject)
    })
    if (!scene) return
    current = gltf
    scene.add(gltf)
    applyWireframe()
    frameObject(gltf)
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

function resetView(): void {
  if (current) frameObject(current)
  else if (controls && camera) controls.update()
}

function screenshot(): string {
  if (!renderer || !scene || !camera) return ''
  renderer.render(scene, camera)
  return renderer.domElement.toDataURL('image/png')
}

function animate(): void {
  frameId = requestAnimationFrame(animate)
  controls?.update()
  if (renderer && scene && camera) renderer.render(scene, camera)
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
  scene.fog = null

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

  // 环境光照：RoomEnvironment 让 PBR 材质有反射，不然金属模型是黑的
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
  clearModel()
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
  () => [props.wireframe, props.background, props.exposure] as const,
  () => {
    applyWireframe()
    applyBackground()
    applyExposure()
  }
)

defineExpose({ resetView, screenshot })
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
