import * as THREE from 'three'
import type { BoneRole } from './types'

/**
 * 外部动作重定向（Mixamo / 其他人形骨架的 FBX、GLB 动作）。
 *
 * 思路：不做骨骼名对齐，而是走「语义角色」——
 * 1. 从源文件里按 Mixamo 命名（mixamorig:LeftArm ...）识别出角色 → 源骨骼
 * 2. 采样动画每一帧，算出源骨骼相对绑定姿态的世界旋转增量 delta
 * 3. 把 delta 套到目标模型同角色的骨骼上（目标绑定姿态 × delta），再换算回局部四元数
 *
 * 这样 Mixamo 的 T-pose 动画能直接套到 Tripo / Meshy 的 A-pose 骨架上。
 */

/** Mixamo 标准命名 → 语义角色 */
const NAME_ROLE_MAP: Record<string, BoneRole> = {
  hips: 'hips',
  pelvis: 'hips',
  spine: 'spine',
  spine1: 'chest',
  spine2: 'upperChest',
  chest: 'chest',
  upperchest: 'upperChest',
  neck: 'neck',
  head: 'head',
  leftshoulder: 'clavicle_L',
  leftarm: 'upperArm_L',
  leftforearm: 'forearm_L',
  lefthand: 'hand_L',
  rightshoulder: 'clavicle_R',
  rightarm: 'upperArm_R',
  rightforearm: 'forearm_R',
  righthand: 'hand_R',
  leftupleg: 'thigh_L',
  leftleg: 'shin_L',
  leftfoot: 'foot_L',
  lefttoebase: 'toe_L',
  rightupleg: 'thigh_R',
  rightleg: 'shin_R',
  rightfoot: 'foot_R',
  righttoebase: 'toe_R'
}

/** 去掉 mixamorig: / mixamorig_ 前缀和非字母字符后查表 */
function normalizeBoneName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mixamorig[:_\s-]*/, '')
    .replace(/[^a-z]/g, '')
}

/** 从源场景里按命名识别角色 -> 骨骼 */
export function mapSourceRoles(root: THREE.Object3D): Map<BoneRole, THREE.Bone> {
  const map = new Map<BoneRole, THREE.Bone>()
  root.traverse((node) => {
    const bone = node as THREE.Bone
    if (!bone.isBone) return
    const role = NAME_ROLE_MAP[normalizeBoneName(bone.name)]
    if (role && !map.has(role)) map.set(role, bone)
  })
  return map
}

export interface RetargetTarget {
  /** 目标模型：角色 -> 骨骼 */
  boneByRole: Map<BoneRole, THREE.Bone>
  /** 任意骨骼在绑定姿态下的世界四元数 */
  restWorldQuat: (bone: THREE.Bone) => THREE.Quaternion
}

export interface RetargetTrack {
  bone: string
  times: number[]
  quats: number[]
}

export interface RetargetResult {
  name: string
  duration: number
  loop: boolean
  fps: number
  tracks: RetargetTrack[]
  /** 命中的角色数量，用来提示「不像人形」 */
  matched: number
  missing: BoneRole[]
}

function worldQuatOf(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  bone.updateWorldMatrix(true, false)
  return bone.getWorldQuaternion(out)
}

/**
 * 把一个源动画片段重定向到目标骨架。
 * 只处理旋转（人形动作足够）；根位移忽略，保持原地播放。
 */
export function retargetClip(
  sourceRoot: THREE.Object3D,
  sourceClip: THREE.AnimationClip,
  target: RetargetTarget,
  options: { fps?: number; name?: string } = {}
): RetargetResult | null {
  const fps = options.fps ?? 30
  const sourceRoles = mapSourceRoles(sourceRoot)
  if (sourceRoles.size === 0) return null

  const pairs: Array<{ role: BoneRole; src: THREE.Bone; tgt: THREE.Bone }> = []
  const missing: BoneRole[] = []
  for (const [role, src] of sourceRoles) {
    const tgt = target.boneByRole.get(role)
    if (tgt) pairs.push({ role, src, tgt })
    else missing.push(role)
  }
  // 至少命中 hips + 一条腿/手链，才认为可以套到当前模型
  const hasCore = pairs.some((item) => item.role === 'hips') && pairs.length >= 8
  if (!hasCore) return null

  // 源绑定姿态（动画开始前）的世界旋转
  sourceRoot.updateMatrixWorld(true)
  const sourceRest = new Map<BoneRole, THREE.Quaternion>()
  for (const item of pairs) {
    sourceRest.set(item.role, worldQuatOf(item.src, new THREE.Quaternion()))
  }

  // 目标绑定姿态：自身 & 父级（用于把世界旋转换回局部）
  const targetRest = new Map<BoneRole, THREE.Quaternion>()
  const parentRest = new Map<BoneRole, THREE.Quaternion>()
  const roleByTargetBone = new Map<THREE.Bone, BoneRole>()
  for (const item of pairs) {
    roleByTargetBone.set(item.tgt, item.role)
    targetRest.set(item.role, target.restWorldQuat(item.tgt))
    const parent = item.tgt.parent as THREE.Bone | null
    // 父级若是未映射骨骼（Root / twist 等），它在动作里不动，直接用绑定姿态
    parentRest.set(
      item.role,
      parent ? target.restWorldQuat(parent) : new THREE.Quaternion()
    )
  }

  const roleOrder = [...pairs].sort((a, b) => depthOf(a.tgt) - depthOf(b.tgt))
  const times: number[] = []
  const frames = Math.max(2, Math.round(sourceClip.duration * fps) + 1)
  const quatsByRole = new Map<BoneRole, THREE.Quaternion[]>()
  for (const item of pairs) quatsByRole.set(item.role, [])

  const mixer = new THREE.AnimationMixer(sourceRoot)
  const action = mixer.clipAction(sourceClip)
  action.play()

  for (let index = 0; index < frames; index += 1) {
    const time = Math.min(sourceClip.duration, index / fps)
    mixer.setTime(time)
    sourceRoot.updateMatrixWorld(true)
    times.push(Number(time.toFixed(4)))

    // 1) 每个角色的世界旋转增量（相对于源绑定姿态）
    const deltaWorld = new Map<BoneRole, THREE.Quaternion>()
    for (const item of pairs) {
      const now = worldQuatOf(item.src, new THREE.Quaternion())
      const rest = sourceRest.get(item.role)!
      deltaWorld.set(item.role, now.multiply(rest.clone().invert()))
    }

    // 2) 目标世界旋转 = delta × 目标绑定姿态；再换回局部
    const targetWorld = new Map<BoneRole, THREE.Quaternion>()
    for (const item of pairs) {
      targetWorld.set(item.role, deltaWorld.get(item.role)!.clone().multiply(targetRest.get(item.role)!))
    }
    for (const item of roleOrder) {
      const parentRole = (() => {
        const parent = item.tgt.parent as THREE.Bone | null
        if (!parent) return undefined
        for (const [role, bone] of target.boneByRole) {
          if (bone === parent) return role
        }
        return undefined
      })()
      const parentWorld = parentRole && targetWorld.has(parentRole) ? targetWorld.get(parentRole)! : parentRest.get(item.role)!
      const local = parentWorld.clone().invert().multiply(targetWorld.get(item.role)!)
      quatsByRole.get(item.role)!.push(local)
    }
  }

  mixer.stopAllAction()
  mixer.uncacheRoot(sourceRoot)

  const tracks: RetargetTrack[] = []
  for (const item of pairs) {
    const list = quatsByRole.get(item.role)!
    const quats: number[] = []
    for (const quaternion of list) quats.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    tracks.push({ bone: item.tgt.name, times: [...times], quats })
  }

  return {
    name: options.name ?? sourceClip.name ?? '外部动作',
    duration: Number(sourceClip.duration.toFixed(4)),
    loop: true,
    fps,
    tracks,
    matched: pairs.length,
    missing
  }
}

function depthOf(bone: THREE.Object3D): number {
  let depth = 0
  let node: THREE.Object3D | null = bone
  while (node) {
    depth += 1
    node = node.parent
  }
  return depth
}
