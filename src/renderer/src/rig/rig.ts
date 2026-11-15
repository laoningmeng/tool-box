import * as THREE from 'three'
import type { BoneInfo, LocalTransform, RigInfo, SemanticRig } from './types'

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _m1 = new THREE.Matrix4()
const _box = new THREE.Box3()

/** Collect all skinned meshes below a root object. */
export function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = []
  root.traverse((obj) => {
    const m = obj as THREE.SkinnedMesh
    if (m.isSkinnedMesh && m.skeleton && m.skeleton.bones.length > 0) out.push(m)
  })
  return out
}

/** Collect every renderable mesh (skinned or not) below a root object. */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((obj) => {
    const m = obj as THREE.Mesh
    if (m.isMesh && m.geometry?.attributes?.position) out.push(m)
  })
  return out
}

/** Collect bone objects below a root object (GLTFLoader creates Bones for skin joints). */
export function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const out: THREE.Bone[] = []
  root.traverse((obj) => {
    const b = obj as THREE.Bone
    if (b.isBone) out.push(b)
  })
  return out
}

/** Compute a bone "tail" from its children or parent direction (best effort). */
function computeTail(bone: THREE.Bone, children: THREE.Bone[], fallbackDir: THREE.Vector3): THREE.Vector3 {
  const head = _v1.setFromMatrixPosition(bone.matrixWorld).clone()
  if (children.length === 1) {
    return _v2.setFromMatrixPosition(children[0].matrixWorld).clone()
  }
  if (children.length > 1) {
    // average child direction, keep a sensible length
    const avg = new THREE.Vector3()
    for (const c of children) {
      avg.add(_v2.setFromMatrixPosition(c.matrixWorld).sub(head).normalize())
    }
    if (avg.lengthSq() < 1e-6) avg.copy(fallbackDir)
    avg.normalize()
    return head.clone().add(avg.multiplyScalar(0.03))
  }
  return head.clone().add(fallbackDir.clone().multiplyScalar(0.03))
}

/**
 * Build the analysis structure for an imported model.
 * The model must already be added to a scene and `updateMatrixWorld(true)` called.
 *
 * @param meshes          蒙皮网格；「只有骨架 + 动画」的 GLB 传空数组
 * @param skeletonOverride 没有蒙皮网格时传入由骨骼手工构造的 Skeleton
 */
export function buildRig(
  scene: THREE.Object3D,
  meshes: THREE.SkinnedMesh[],
  skeletonOverride?: THREE.Skeleton,
): RigInfo {
  const skeleton = skeletonOverride ?? meshes[0]?.skeleton
  if (!skeleton || !skeleton.bones.length) throw new Error('没有可用的骨骼数据')
  const bones = skeleton.bones as THREE.Bone[]
  skeleton.update()

  const indexByBone = new Map<THREE.Bone, number>()
  bones.forEach((b, i) => indexByBone.set(b, i))

  const childBones = new Map<THREE.Bone, THREE.Bone[]>()
  for (const b of bones) {
    const p = b.parent as THREE.Bone | null
    if (p && (p as THREE.Bone).isBone) {
      const arr = childBones.get(p) ?? []
      arr.push(b)
      childBones.set(p, arr)
    }
  }

  // world bbox of bind pose meshes
  let box: THREE.Box3 | null = null
  let skinnedVertexCount = 0
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox()
    if (mesh.geometry.boundingBox) {
      const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld)
      box = box ? box.union(b) : b
    }
    skinnedVertexCount += mesh.geometry.attributes.position?.count ?? 0
  }
  if (!box) {
    // 没有网格（只有骨架 / 动画）时，用骨骼世界坐标估一个包围盒
    const boneBox = new THREE.Box3()
    const point = new THREE.Vector3()
    for (const bone of bones) {
      point.setFromMatrixPosition(bone.matrixWorld)
      boneBox.expandByPoint(point)
    }
    if (boneBox.isEmpty()) boneBox.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1.8, 0.5))
    else boneBox.expandByScalar(Math.max(0.05, boneBox.getSize(new THREE.Vector3()).length() * 0.05))
    box = boneBox
  }
  const size = box.getSize(new THREE.Vector3())
  const height = Math.max(size.y, 0.001)

  // depth = hierarchy depth
  const depthCache = new Map<THREE.Bone, number>()
  const depthOf = (b: THREE.Bone): number => {
    const cached = depthCache.get(b)
    if (cached !== undefined) return cached
    const p = b.parent as THREE.Bone | null
    const d = p && (p as THREE.Bone).isBone ? depthOf(p) + 1 : 0
    depthCache.set(b, d)
    return d
  }

  const boneIndexByName = new Map<string, number>()
  const boneInfo: BoneInfo[] = bones.map((bone, index) => {
    boneIndexByName.set(bone.name, index)
    const parent = bone.parent as THREE.Bone | null
    const parentIndex = parent && (parent as THREE.Bone).isBone ? indexByBone.get(parent) ?? -1 : -1
    const children = (childBones.get(bone) ?? []).map((c) => indexByBone.get(c) ?? -1).filter((i) => i >= 0)
    const head = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
    const fallbackDir = parentIndex >= 0
      ? new THREE.Vector3().setFromMatrixPosition(bones[parentIndex].matrixWorld).sub(head).normalize().negate()
      : new THREE.Vector3(0, 1, 0)
    const tail = computeTail(bone, childBones.get(bone) ?? [], fallbackDir)
    return {
      name: bone.name,
      index,
      parentIndex,
      depth: depthOf(bone),
      head,
      tail,
      length: head.distanceTo(tail),
      children,
      role: null,
    }
  })

  const restLocal = bones.map((b) => ({
    position: b.position.clone(),
    quaternion: b.quaternion.clone(),
    scale: b.scale.clone(),
  }))
  const restWorldQuat = bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()))

  const rig: RigInfo = {
    scene,
    skeleton,
    bones,
    boneInfo,
    meshes,
    height,
    center: box.getCenter(new THREE.Vector3()),
    up: new THREE.Vector3(0, 1, 0),
    forward: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(-1, 0, 0),
    restLocal,
    restWorldQuat,
    boneIndexByName,
    skinnedVertexCount,
  }
  return rig
}

/** Restore the bind pose (also used as "reset pose"). */
export function applyRestPose(rig: RigInfo): void {
  rig.bones.forEach((b, i) => {
    const rest = rig.restLocal[i]
    b.position.copy(rest.position)
    b.quaternion.copy(rest.quaternion)
    b.scale.copy(rest.scale)
  })
  rig.scene.updateMatrixWorld(true)
  rig.skeleton.update()
}

/** Store the current bone transforms as the new bind pose and rebuild inverse bind matrices. */
export function commitRestPose(rig: RigInfo): void {
  rig.scene.updateMatrixWorld(true)
  rig.bones.forEach((b, i) => {
    rig.restLocal[i].position.copy(b.position)
    rig.restLocal[i].quaternion.copy(b.quaternion)
    rig.restLocal[i].scale.copy(b.scale)
    rig.restWorldQuat[i].copy(b.getWorldQuaternion(new THREE.Quaternion()))
    rig.skeleton.boneInverses[i].copy(b.matrixWorld).invert()
  })
  rig.skeleton.update()
  for (const m of rig.meshes) {
    m.bindMatrix.copy(m.matrixWorld)
    m.bindMatrixInverse.copy(m.bindMatrix).invert()
  }
  // Refresh bone info heads / tails from the new rest pose
  refreshBoneInfo(rig)
}

/** Recompute BoneInfo head/tail from the current rest pose. */
export function refreshBoneInfo(rig: RigInfo): void {
  for (const info of rig.boneInfo) {
    info.head.setFromMatrixPosition(rig.bones[info.index].matrixWorld)
    const children = info.children.map((i) => rig.boneInfo[i])
    if (children.length) {
      const avg = new THREE.Vector3()
      for (const c of children) avg.add(c.head)
      avg.multiplyScalar(1 / children.length)
      info.tail.copy(avg)
    } else {
      const p = info.parentIndex >= 0 ? rig.boneInfo[info.parentIndex] : null
      const dir = p ? info.head.clone().sub(p.head).normalize() : new THREE.Vector3(0, 1, 0)
      info.tail.copy(info.head).add(dir.multiplyScalar(Math.max(0.02, rig.height * 0.03)))
    }
    info.length = info.head.distanceTo(info.tail)
  }
}

/**
 * Conjugate a world-space rotation delta into the bone's local space.
 * Rotating by the returned quaternion rotates the bone about its own head,
 * around the given world axis, exactly like `q_world * restWorld`.
 */
export function worldDeltaToLocal(restWorldQuat: THREE.Quaternion, worldQuat: THREE.Quaternion): THREE.Quaternion {
  const inv = _q1.copy(restWorldQuat).invert()
  return inv.multiply(worldQuat).multiply(restWorldQuat).clone()
}

/** Local pose quaternion = restLocal * localDelta */
export function localPoseQuat(restLocalQuat: THREE.Quaternion, localDelta: THREE.Quaternion): THREE.Quaternion {
  return restLocalQuat.clone().multiply(localDelta)
}

/** Build a world-space axis angle quaternion. */
export function axisAngle(axis: THREE.Vector3, angle: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle)
}

/** Signed lateral offset of a bone from the hips, +1 = character's right. */
export function lateralSign(rig: RigInfo, boneName: string): number {
  const idx = rig.boneIndexByName.get(boneName)
  if (idx === undefined) return 1
  const hips = rig.boneInfo.find((b) => b.role === 'hips') ?? rig.boneInfo[0]
  const d = _v1.copy(rig.boneInfo[idx].head).sub(hips.head).dot(rig.right)
  if (Math.abs(d) < 1e-5) return 1
  return d > 0 ? 1 : -1
}

/** Guess the horizontal facing direction from foot -> toe direction if available. */
export function refineOrientation(rig: RigInfo, semantics: SemanticRig): void {
  const roleBone = (r: string) => {
    for (const [name, role] of Object.entries(semantics.bones)) if (role === r) return name
    return undefined
  }
  const dirs: THREE.Vector3[] = []
  for (const side of ['L', 'R'] as const) {
    const foot = roleBone(`foot_${side}`)
    const toe = roleBone(`toe_${side}`)
    if (foot && toe) {
      const fi = rig.boneIndexByName.get(foot)
      const ti = rig.boneIndexByName.get(toe)
      if (fi !== undefined && ti !== undefined) {
        const d = rig.boneInfo[ti].head.clone().sub(rig.boneInfo[fi].head)
        d.y = 0
        if (d.lengthSq() > 1e-8) dirs.push(d.normalize())
      }
    }
  }
  if (dirs.length === 0) {
    // fall back to hand direction? keep +Z
    return
  }
  const avg = new THREE.Vector3()
  for (const d of dirs) avg.add(d)
  if (avg.lengthSq() > 1e-8) {
    avg.normalize()
    rig.forward.copy(avg)
    rig.right.copy(new THREE.Vector3().crossVectors(rig.up, rig.forward).normalize())
  }
}

/**
 * World-space positions of every skinned vertex of one mesh, reflecting the current pose.
 * The mesh must have its matrixWorld and skeleton matrices updated.
 */
export function computeSkinnedPositions(mesh: THREE.SkinnedMesh): Float32Array {
  const geo = mesh.geometry
  const pos = geo.attributes.position
  if (!pos) return new Float32Array(0)
  const count = pos.count
  const out = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  mesh.updateMatrixWorld(true)
  for (let i = 0; i < count; i++) {
    if (!mesh.getVertexPosition) {
      // very old three fallback: bind-space position
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    } else {
      mesh.getVertexPosition(i, v)
      v.applyMatrix4(mesh.matrixWorld)
    }
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  return out
}

/** Bind-space (rest) world positions, cheap alternative when the pose is unchanged. */
export function computeBindPositions(mesh: THREE.SkinnedMesh): Float32Array {
  const pos = mesh.geometry.attributes.position
  const out = new Float32Array(pos.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  return out
}

/** Remove every object of a rig from its parent and dispose GPU resources. */
export function disposeRig(rig: RigInfo): void {
  rig.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m) continue
        for (const key of Object.keys(m) as (keyof typeof m)[]) {
          const val = (m as unknown as Record<string, unknown>)[key as string]
          if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose()
        }
        m.dispose()
      }
    }
  })
  rig.scene.removeFromParent()
}

export function boxOfRig(rig: RigInfo): THREE.Box3 {
  const b = _box.clone()
  b.makeEmpty()
  for (const mesh of rig.meshes) {
    mesh.geometry.computeBoundingBox()
    if (mesh.geometry.boundingBox) b.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld))
  }
  return b
}

export function boneWorldMatrix(rig: RigInfo, index: number): THREE.Matrix4 {
  return _m1.copy(rig.bones[index].matrixWorld)
}
