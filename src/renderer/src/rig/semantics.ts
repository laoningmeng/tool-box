import * as THREE from 'three'
import { ALL_ROLES, ROLE_LABELS } from './types'
import type { BoneInfo, BoneRole, RigInfo, SemanticRig } from './types'

/**
 * Skeleton semantic analyser.
 *
 * The app has to work with AI generated rigs whose bones are called `Bone_000`,
 * `Bone_001`, ... with no semantic names at all (Tripo SmartRig / Meshy).
 * Therefore roles must be derived from *geometry + topology*, with the option
 * of a manual override that rebuilds derived chains.
 *
 * Strategy (all geometric, no bone name hard-coding):
 * 1. Rebuild the bone tree and walk the "vertical spine" from the hierarchy root
 *    upwards (the child that keeps rising while staying close to the body axis).
 * 2. Find the hips: lowest common ancestor of the bones that reach the ground.
 * 3. Legs = children of the hips whose subtree touches the ground.
 * 4. Facing: foot -> toe direction (fallback: knee joint offset, marker bone
 *    names such as `headfront`, then the shoulder line / caller `rig.forward`).
 *    `right = forward x up` (the character's own right; `_L` / `_R` suffixes
 *    follow the character, not the screen).
 * 5. Arms = the widest pair of lateral chains branching off the spine.
 * 6. Head = the lowest spine bone above the shoulder junction whose skin weights
 *    cover a meaningful part of the head volume (falls back to a height ratio
 *    when there are no skin weights).
 * 7. Ears / hair / tail from the attachment point and direction of the remaining
 *    head / pelvis subtrees.
 * 8. Duplicate same-side chains (SmartRig emits some rigs twice) are detected by
 *    comparing joint positions within ~1% of the model height and written to
 *    `followMap` as follower -> driver. Mirrored chains on opposite sides are
 *    NEVER mapped: a real biped has two mirrored legs, they are not redundant.
 *
 * `rig.forward` / `rig.right` are refreshed from the detected geometry, because
 * the imported facing direction is not reliable (glTF exporters disagree) and
 * every action / weight diagnostic depends on it.
 */

const EPS = 1e-9

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isEndMarker(name: string): boolean {
  return (
    /(?:^|[_\-.\s])(?:end|tip|leaf)(?:$|[_\-.\s])/i.test(name) ||
    /(?:end|tip)$/i.test(name)
  )
}

function isKnownRole(role: string): role is BoneRole {
  return (ALL_ROLES as string[]).includes(role)
}

/**
 * 骨骼「名字」里的语义线索。
 *
 * 几何推断对 T-pose 很好用，但遇到「摆好姿势的模型」（比如双手端着枪的机甲）就会
 * 把脊椎误判成手臂 —— 这时名字往往是最可靠的证据：L_Upperarm、R_Calf、mixamorig:LeftHand、
 * upper_arm.L、Bip01 L Thigh ……
 *
 * 只认**有把握**的部件名（四肢 / 头颈 / 耳尾毛发），hips / spine / chest 这类
 * 「要按链条位置决定」的角色仍交给几何推断。返回 null 表示这个名字没有可用线索。
 */
function roleFromName(raw: string): BoneRole | null {
  const name = (raw ?? '').trim()
  if (!name) return null
  // 变形辅助骨：扭骨 / 末端骨 / IK / 约束目标都不是语义主体
  if (/twist|roll|helper|nub|pole|aim|constraint/i.test(name)) return null
  if (isEndMarker(name)) return null

  // 驼峰先拆开：mixamorig:LeftUpLeg → mixamorig:Left Up Leg
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  const norm = ` ${spaced.replace(/[^a-z0-9]+/g, ' ').trim()} `
  const tokens = norm.trim().split(/\s+/)
  // 左右：left/right 单词，以及 L_ / .L / "L Thigh" 这种单字母
  const side: 'L' | 'R' | null = tokens.includes('left')
    ? 'L'
    : tokens.includes('right')
      ? 'R'
      : tokens.includes('l')
        ? 'L'
        : tokens.includes('r')
          ? 'R'
          : null
  const sided = (role: string): BoneRole | null => (side ? (`${role}_${side}` as BoneRole) : null)

  if (/ thumb /.test(norm)) return sided('thumb')
  if (/ finger | digit | index | middle | ring | pinky | little /.test(norm)) return sided('finger')
  if (/ clavicle | collar | shoulder /.test(norm)) return sided('clavicle')
  if (/ forearm | fore arm | lowerarm | lower arm /.test(norm)) return sided('forearm')
  if (/(^| )(upperarm|upper arm|uparm|arm)( |$)/.test(norm)) return sided('upperArm')
  if (/ hand | wrist /.test(norm)) return sided('hand')
  if (/ thigh | upleg | up leg | upperleg | upper leg /.test(norm)) return sided('thigh')
  if (/ calf | shin | lowerleg | lower leg | knee /.test(norm)) return sided('shin')
  // Mixamo 的 RightLeg / LeftLeg 指小腿
  if (/ leg /.test(norm)) return sided('shin')
  if (/ foot | ankle /.test(norm)) return sided('foot')
  if (/ toebase | toe base | toe /.test(norm)) return sided('toe')
  if (/ ear /.test(norm)) return sided('ear')
  if (/ jaw | chin /.test(norm)) return 'jaw'
  if (/ hair | ponytail | braid | bangs /.test(norm)) return 'hair'
  if (/ tail /.test(norm)) return 'tail'
  if (/ head /.test(norm)) return 'head'
  if (/ neck /.test(norm)) return 'neck'
  return null
}

/** 名字线索里属于哪条肢体（用来过滤几何候选）。 */
function nameLimbKind(role: BoneRole | null): 'arm' | 'leg' | null {
  if (!role) return null
  if (/^(clavicle|upperArm|forearm|hand|finger|thumb)_/.test(role)) return 'arm'
  if (/^(thigh|shin|foot|toe)_/.test(role)) return 'leg'
  return null
}

/** Remove the component of `v` along `axis` (a project onto the plane ⟂ axis). */
function withoutAxis(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  const out = v.clone()
  out.addScaledVector(axis, -v.dot(axis))
  return out
}

function unit(v: THREE.Vector3): THREE.Vector3 {
  const l = v.length()
  return l > EPS ? v.clone().multiplyScalar(1 / l) : new THREE.Vector3()
}

function relY(p: THREE.Vector3, groundY: number, height: number): number {
  return (p.y - groundY) / Math.max(height, 1e-6)
}

function sideSuffix(side: number): 'L' | 'R' {
  return side >= 0 ? 'R' : 'L'
}

/* -------------------------------------------------------------------------- */
/* skeleton topology                                                          */
/* -------------------------------------------------------------------------- */

interface SkeletonTopology {
  count: number
  parent: number[]
  children: number[][]
  depth: number[]
  descendantCount: number[]
  root: number
}

function topologyOf(rig: RigInfo): SkeletonTopology {
  const bones = rig.boneInfo ?? []
  const count = bones.length
  const parent: number[] = new Array(count).fill(-1)
  const children: number[][] = []
  for (let i = 0; i < count; i++) children.push([])
  for (let i = 0; i < count; i++) {
    const p = bones[i]?.parentIndex ?? -1
    if (p >= 0 && p < count && p !== i) {
      parent[i] = p
      children[p].push(i)
    }
  }
  // depth (guard against malformed chains)
  const depth: number[] = new Array(count).fill(0)
  for (let i = 0; i < count; i++) {
    let d = 0
    let cur = i
    let guard = 0
    while (parent[cur] >= 0 && guard++ < count) {
      d++
      cur = parent[cur]
    }
    depth[i] = d
  }
  // descendant count (children always deeper than parents)
  const descendantCount: number[] = new Array(count).fill(1)
  const byDepth = [...Array(count).keys()].sort((a, b) => depth[b] - depth[a])
  for (const i of byDepth) {
    const p = parent[i]
    if (p >= 0) descendantCount[p] += descendantCount[i]
  }
  const roots: number[] = []
  for (let i = 0; i < count; i++) if (parent[i] < 0) roots.push(i)
  roots.sort((a, b) => descendantCount[b] - descendantCount[a] || a - b)
  return { count, parent, children, depth, descendantCount, root: roots[0] ?? -1 }
}

function subtreeIndices(t: SkeletonTopology, start: number): number[] {
  const out: number[] = []
  if (start < 0 || start >= t.count) return out
  const stack = [start]
  while (stack.length) {
    const i = stack.pop() as number
    out.push(i)
    for (const c of t.children[i]) stack.push(c)
  }
  return out
}

/** Largest axis-aligned extent of the bone heads inside a subtree. */
function subtreeBBoxSpan(t: SkeletonTopology, bones: BoneInfo[], start: number): number {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const i of subtreeIndices(t, start)) {
    const h = bones[i].head
    minX = Math.min(minX, h.x)
    maxX = Math.max(maxX, h.x)
    minY = Math.min(minY, h.y)
    maxY = Math.max(maxY, h.y)
    minZ = Math.min(minZ, h.z)
    maxZ = Math.max(maxZ, h.z)
  }
  if (!Number.isFinite(minX)) return 0
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ)
}

/** Max distance between `from` and any bone head of the subtree. */
function subtreeReach(t: SkeletonTopology, bones: BoneInfo[], start: number, from: THREE.Vector3): number {
  let max = 0
  for (const i of subtreeIndices(t, start)) {
    const d = bones[i].head.distanceTo(from)
    if (d > max) max = d
  }
  return max
}

/** Highest bone head (world Y) reachable inside a subtree. */
function subtreeMaxHeadY(t: SkeletonTopology, bones: BoneInfo[], start: number): number {
  let max = -Infinity
  for (const i of subtreeIndices(t, start)) {
    if (bones[i].head.y > max) max = bones[i].head.y
  }
  return max
}

function lowestCommonAncestor(t: SkeletonTopology, a: number, b: number): number {
  if (a < 0 || b < 0 || a >= t.count || b >= t.count) return -1
  const ancestors = new Set<number>()
  let cur = a
  let guard = 0
  while (cur >= 0 && guard++ <= t.count) {
    ancestors.add(cur)
    cur = t.parent[cur]
  }
  cur = b
  guard = 0
  while (cur >= 0 && guard++ <= t.count) {
    if (ancestors.has(cur)) return cur
    cur = t.parent[cur]
  }
  return -1
}

/**
 * Walk down from `start` following the branch that reaches farthest away.
 * (Limbs can branch at the hand or an ear tip; the longest continuation is the
 * representative chain.)
 */
function walkDownLongest(t: SkeletonTopology, bones: BoneInfo[], start: number): number[] {
  const chain: number[] = []
  if (start < 0 || start >= t.count) return chain
  const seen = new Set<number>()
  let cur = start
  while (cur >= 0 && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    const kids = t.children[cur].filter((k) => !seen.has(k))
    if (kids.length === 0) break
    let next = kids[0]
    let best = -Infinity
    for (const k of kids) {
      const score = subtreeReach(t, bones, k, bones[cur].head) + 0.01 * t.descendantCount[k]
      if (score > best) {
        best = score
        next = k
      }
    }
    cur = next
  }
  return chain
}

function stripTrailingEndMarkers(bones: BoneInfo[], chain: number[]): number[] {
  const out = chain.slice()
  while (out.length > 1 && isEndMarker(bones[out[out.length - 1]].name)) out.pop()
  return out
}

/**
 * Split a set of bones (all sharing one role) into connected base->tip chains.
 * A linear finger / ear / hair strand gives exactly one chain; a branched hair
 * tuft gives one chain per leaf (sharing the base bone).
 */
function extractRoleChains(t: SkeletonTopology, bones: BoneInfo[], indices: number[]): number[][] {
  const set = new Set(indices)
  const chains: number[][] = []
  const roots = indices.filter((i) => !set.has(t.parent[i])).sort((a, b) => a - b)
  for (const root of roots) {
    let frontier: number[][] = [[root]]
    for (let guard = 0; guard <= indices.length + 1 && frontier.length; guard++) {
      const next: number[][] = []
      let advanced = false
      for (const path of frontier) {
        const cur = path[path.length - 1]
        const kids = t.children[cur].filter((k) => set.has(k) && path.indexOf(k) < 0)
        if (kids.length === 0) {
          chains.push(path)
          continue
        }
        advanced = true
        for (const k of kids) next.push([...path, k])
      }
      if (!advanced) break
      frontier = next
    }
  }
  // dedupe (a branch may produce the same path twice with malformed input)
  const seen = new Set<string>()
  const unique: number[][] = []
  for (const c of chains) {
    const key = c.join('>')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(c)
  }
  unique.sort((a, b) => a[0] - b[0] || a.length - b.length)
  return unique
}

/** Base -> tip order for all bones of a single appendage (tail). */
function orderAppendageBones(t: SkeletonTopology, bones: BoneInfo[], indices: number[]): string[] {
  if (indices.length === 0) return []
  const set = new Set(indices)
  const out: number[] = []
  const added = new Set<number>()
  const visit = (i: number): void => {
    if (added.has(i)) return
    added.add(i)
    out.push(i)
    for (const k of t.children[i]) if (set.has(k)) visit(k)
  }
  indices
    .filter((i) => !set.has(t.parent[i]))
    .sort((a, b) => a - b)
    .forEach(visit)
  for (const i of indices) if (!added.has(i)) out.push(i)
  return out.map((i) => bones[i].name)
}

/* -------------------------------------------------------------------------- */
/* roles that actions need                                                    */
/* -------------------------------------------------------------------------- */

const SPINE_ROLES: BoneRole[] = ['hips', 'spine', 'chest', 'upperChest']

const REQUIRED_ROLES: BoneRole[] = [
  'hips',
  'spine',
  'head',
  'upperArm_L',
  'forearm_L',
  'hand_L',
  'upperArm_R',
  'forearm_R',
  'hand_R',
  'thigh_L',
  'shin_L',
  'foot_L',
  'thigh_R',
  'shin_R',
  'foot_R',
]

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

export function emptySemantics(): SemanticRig {
  return {
    bones: {},
    spineChain: [],
    tailChain: [],
    hairChains: [],
    fingerChains: { L: [], R: [] },
    earChains: { L: [], R: [] },
    followMap: {},
    warnings: [],
    autoGenerated: false,
  }
}

/**
 * Rebuild all derived chains (spineChain, tailChain, fingerChains, earChains,
 * hairChains, followMap) from a boneName -> role mapping. Used after any manual
 * role edit in the UI.
 *
 * The order inside a chain is always topology based (parent before child);
 * when several bones share the same spine role they are ordered bottom -> top
 * by hierarchy depth (ties broken by rest height), so a manually re-assigned
 * rig keeps a sane `spineChain`.
 */
export function deriveSemantics(
  rig: RigInfo,
  boneRoles: Record<string, BoneRole>,
  followMap?: Record<string, string>,
): SemanticRig {
  const t = topologyOf(rig)
  const bones = rig.boneInfo
  const warnings: string[] = []
  const sem = emptySemantics()
  sem.warnings = warnings

  if (t.count === 0 || !rig.boneInfo) {
    warnings.push('骨架中没有骨骼，无法识别语义角色')
    return sem
  }

  // ---- resolve the provided name -> role map against the real skeleton ----
  const byIndex = new Map<number, BoneRole>()
  const unknown: string[] = []
  for (const [name, role] of Object.entries(boneRoles)) {
    if (!isKnownRole(role)) continue
    let idx = rig.boneIndexByName.get(name)
    if (idx === undefined) {
      // fall back to a name search (manual maps may be built from boneInfo)
      idx = bones.findIndex((b) => b.name === name)
    }
    if (idx === undefined || idx < 0 || idx >= t.count) {
      unknown.push(name)
      continue
    }
    byIndex.set(idx, role)
  }
  if (unknown.length) {
    warnings.push(
      `角色映射中有 ${unknown.length} 个骨骼名不存在，已忽略：${unknown.slice(0, 5).join('、')}${
        unknown.length > 5 ? ' 等' : ''
      }`,
    )
  }

  // stable insertion order: shallow bones first so chain bases are "first"
  const ordered = [...byIndex.keys()].sort(
    (a, b) => t.depth[a] - t.depth[b] || bones[a].head.y - bones[b].head.y || a - b,
  )
  for (const i of ordered) {
    const role = byIndex.get(i) as BoneRole
    sem.bones[bones[i].name] = role
    bones[i].role = role
  }
  for (let i = 0; i < t.count; i++) if (!byIndex.has(i)) bones[i].role = null

  const indicesOf = (roles: BoneRole[]): number[] =>
    ordered.filter((i) => roles.includes(byIndex.get(i) as BoneRole))
  const hasRole = (role: BoneRole): boolean => indicesOf([role]).length > 0

  // ---- spine chain: hips -> top, hierarchy order (never include neck/head) ----
  const spineIdx = indicesOf(SPINE_ROLES).sort(
    (a, b) => t.depth[a] - t.depth[b] || bones[a].head.y - bones[b].head.y || a - b,
  )
  sem.spineChain = spineIdx.map((i) => bones[i].name)

  // ---- tail (every tail bone, base -> tip) ----
  sem.tailChain = orderAppendageBones(t, bones, indicesOf(['tail']))

  // ---- hair / back attachments (one chain per strand) ----
  sem.hairChains = extractRoleChains(t, bones, indicesOf(['hair'])).map((c) =>
    c.map((i) => bones[i].name),
  )

  // ---- ears / antennae (single chain per side) ----
  for (const side of ['L', 'R'] as const) {
    const chains = extractRoleChains(t, bones, indicesOf([`ear_${side}` as BoneRole]))
    if (chains.length === 0) continue
    chains.sort((a, b) => b.length - a.length || a[0] - b[0])
    if (chains.length > 1) {
      warnings.push(
        `${side === 'L' ? '左' : '右'}耳骨骼有 ${chains.length} 条分支，仅保留最长的一条作为耳链`,
      )
    }
    sem.earChains[side] = chains[0].map((i) => bones[i].name)
  }

  // ---- fingers: up to 5 chains per hand, base -> tip ----
  for (const side of ['L', 'R'] as const) {
    let chains = extractRoleChains(t, bones, indicesOf([`finger_${side}` as BoneRole]))
    if (chains.length > 5) {
      warnings.push(
        `${side === 'L' ? '左' : '右'}手识别到 ${chains.length} 条手指链，仅保留前 5 条`,
      )
      chains = chains.slice(0, 5)
    }
    sem.fingerChains[side] = chains.map((c) => c.map((i) => bones[i].name))
  }

  // ---- follow map validation ----
  const follow = followMap ?? {}
  let dropped = 0
  for (const [follower, driver] of Object.entries(follow)) {
    const fi = rig.boneIndexByName.get(follower)
    const di = rig.boneIndexByName.get(driver)
    if (fi === undefined || di === undefined || fi === di) {
      dropped++
      continue
    }
    sem.followMap[follower] = driver
  }
  if (dropped > 0) warnings.push(`followMap 中有 ${dropped} 条无效映射（骨骼不存在或自引用），已忽略`)
  // break cycles
  for (const start of Object.keys(sem.followMap)) {
    let cur = sem.followMap[start]
    const visited = new Set<string>([start])
    let cycle = false
    let guard = 0
    while (cur !== undefined && guard++ < 64) {
      if (visited.has(cur)) {
        cycle = true
        break
      }
      visited.add(cur)
      cur = sem.followMap[cur]
    }
    if (cycle) {
      delete sem.followMap[start]
      warnings.push(`followMap 中的 ${start} 形成循环跟随，已忽略`)
    }
  }

  // ---- coverage warnings (Chinese, actionable) ----
  if (!hasRole('hips')) warnings.push('未识别到骨盆 hips 骨骼，躯干旋转与根运动将不可用')
  if (sem.spineChain.length === 0) {
    warnings.push('未识别到脊柱链（hips/spine/chest），躯干动作将不可用')
  }
  if (!hasRole('head')) warnings.push('未识别到头部 head 骨骼，头部动画将不可用')
  if (!hasRole('neck')) {
    warnings.push('未检测到独立颈部骨骼，头部旋转将直接作用在 head 骨骼上')
  }

  for (const side of ['L', 'R'] as const) {
    const cn = side === 'L' ? '左' : '右'
    const armOk = hasRole(`upperArm_${side}` as BoneRole) && hasRole(`hand_${side}` as BoneRole)
    if (!armOk) {
      warnings.push(`未识别到${cn}手臂骨骼链（upperArm/forearm/hand），该侧手臂动作将不可用`)
    }
    const legOk = hasRole(`thigh_${side}` as BoneRole) && hasRole(`foot_${side}` as BoneRole)
    if (!legOk) {
      warnings.push(`未识别到${cn}腿骨骼链（thigh/shin/foot），该侧腿部动作将不可用`)
    }
  }

  const fingersL = sem.fingerChains.L.length
  const fingersR = sem.fingerChains.R.length
  if (fingersL === 0 && fingersR === 0) {
    warnings.push('未检测到手指骨骼链，握拳/手势动作将不可用')
  } else {
    for (const side of ['L', 'R'] as const) {
      const n = sem.fingerChains[side].length
      if (n === 0) {
        warnings.push(`未检测到${side === 'L' ? '左' : '右'}手手指骨骼链`)
      } else if (n < 5) {
        warnings.push(
          `${side === 'L' ? '左' : '右'}手仅识别到 ${n} 条手指链（常见为 5 条：四指 + 拇指）`,
        )
      }
    }
  }

  if (!sem.earChains.L.length && !sem.earChains.R.length) {
    warnings.push('未检测到耳朵/触角骨骼链（耳朵将保持静止）')
  } else {
    for (const side of ['L', 'R'] as const) {
      if (!sem.earChains[side].length) {
        warnings.push(`未检测到${side === 'L' ? '左' : '右'}耳/触角骨骼链`)
      }
    }
  }
  if (sem.tailChain.length === 0) warnings.push('未检测到尾巴骨骼（尾巴摆动动作将不可用）')
  if (sem.hairChains.length === 0) warnings.push('未检测到头发/披风骨骼链（后摆将保持静止）')

  return sem
}

/** First bone name for every role (chains use `spineChain` etc. instead). */
export function roleBoneMap(sem: SemanticRig): Map<BoneRole, string> {
  const out = new Map<BoneRole, string>()
  for (const role of ALL_ROLES) {
    if (role === 'extra') continue
    for (const [name, r] of Object.entries(sem.bones)) {
      if (r === role) {
        out.set(role, name)
        break
      }
    }
  }
  // chain roles: report the base of the chain, not whoever appeared first
  const chainBases: Array<[BoneRole, string | undefined]> = [
    ['finger_L', sem.fingerChains.L[0]?.[0]],
    ['finger_R', sem.fingerChains.R[0]?.[0]],
    ['ear_L', sem.earChains.L[0]],
    ['ear_R', sem.earChains.R[0]],
    ['tail', sem.tailChain[0]],
    ['hair', sem.hairChains[0]?.[0]],
  ]
  for (const [role, name] of chainBases) if (name) out.set(role, name)
  return out
}

/** Roles that an action needs but which are missing from the rig. */
export function missingRoles(sem: SemanticRig): BoneRole[] {
  const present = new Set(Object.values(sem.bones))
  const out: BoneRole[] = []
  for (const role of ALL_ROLES) {
    if (REQUIRED_ROLES.includes(role) && !present.has(role)) out.push(role)
  }
  return out
}

export function roleOfBone(sem: SemanticRig, boneName: string): BoneRole | null {
  return sem.bones[boneName] ?? null
}

/* -------------------------------------------------------------------------- */
/* detection helpers                                                          */
/* -------------------------------------------------------------------------- */

function estimateGroundY(rig: RigInfo): number {
  let minY = Infinity
  let hasMesh = false
  for (const mesh of rig.meshes ?? []) {
    const geo = mesh.geometry
    if (!geo) continue
    if (!geo.boundingBox) geo.computeBoundingBox()
    const bb = geo.boundingBox
    if (!bb) continue
    const world = bb.clone().applyMatrix4(mesh.matrixWorld)
    if (world.min.y < minY) minY = world.min.y
    hasMesh = true
  }
  if (!hasMesh) {
    for (const b of rig.boneInfo) minY = Math.min(minY, b.head.y)
  }
  return Number.isFinite(minY) ? minY : 0
}

function estimateHeight(rig: RigInfo, groundY: number): number {
  if (Number.isFinite(rig.height) && rig.height > 1e-4) return rig.height
  let maxY = groundY
  for (const b of rig.boneInfo) maxY = Math.max(maxY, b.head.y, b.tail.y)
  return Math.max(maxY - groundY, 1e-3)
}

/** Horizontal axis with the widest bone-head spread: the shoulder line. */
function estimateLateralAxis(t: SkeletonTopology, bones: BoneInfo[], up: THREE.Vector3): THREE.Vector3 {
  const origin = new THREE.Vector3()
  for (const b of bones) origin.add(b.head)
  if (bones.length) origin.multiplyScalar(1 / bones.length)
  const pts = bones.map((b) => withoutAxis(b.head.clone().sub(origin), up))
  let e1 = withoutAxis(new THREE.Vector3(1, 0, 0), up)
  if (e1.lengthSq() < 1e-6) e1 = withoutAxis(new THREE.Vector3(0, 0, 1), up)
  e1 = unit(e1)
  const e2 = unit(new THREE.Vector3().crossVectors(up, e1))
  let best = e1.clone()
  let bestSpan = -1
  for (let deg = 0; deg < 180; deg++) {
    const a = (deg * Math.PI) / 180
    const dir = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a))
    let min = Infinity
    let max = -Infinity
    for (const p of pts) {
      const d = p.dot(dir)
      if (d < min) min = d
      if (d > max) max = d
    }
    if (max - min > bestSpan) {
      bestSpan = max - min
      best = dir
    }
  }
  return unit(best)
}

/**
 * Skin-weight sum of every bone over the "head volume": vertices above the
 * shoulder junction and close to the body axis (arms / hands / skirt excluded).
 * Returns null when the model has no usable skin data.
 */
function scanHeadRegionWeights(
  rig: RigInfo,
  yThreshold: number,
  axisX: number,
  axisZ: number,
  axisLimit: number,
): Float64Array | null {
  const bones = rig.boneInfo
  const sums = new Float64Array(bones.length)
  let total = 0
  const limitSq = axisLimit * axisLimit
  const m = new THREE.Matrix4()
  for (const mesh of rig.meshes ?? []) {
    const geo = mesh.geometry
    const pos = geo?.attributes?.position
    const skinIndex = geo?.attributes?.skinIndex
    const skinWeight = geo?.attributes?.skinWeight
    if (!pos || !skinIndex || !skinWeight) continue
    m.copy(mesh.matrixWorld)
    const e = m.elements
    const count = pos.count
    for (let v = 0; v < count; v++) {
      const lx = pos.getX(v)
      const ly = pos.getY(v)
      const lz = pos.getZ(v)
      const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12]
      const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13]
      const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14]
      if (wy < yThreshold) continue
      const dx = wx - axisX
      const dz = wz - axisZ
      if (dx * dx + dz * dz > limitSq) continue
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(v, k)
        if (w <= 0) continue
        const bi = skinIndex.getComponent(v, k)
        if (bi >= 0 && bi < sums.length) {
          sums[bi] += w
          total += w
        }
      }
    }
  }
  return total > 1e-6 ? sums : null
}

interface LimbCandidate {
  chain: number[]
  clean: number[]
  side: number
  latExtent: number
  startRel: number
  leafRel: number
  netLen: number
}

/**
 * Every "limb / appendage" chain of the skeleton: start at a leaf, walk up
 * while every ancestor has a single child, stop right below the branch point.
 * Returned base -> leaf.
 */
function leafChains(t: SkeletonTopology, bones: BoneInfo[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < t.count; i++) {
    if (t.children[i].length > 0) continue
    const chain = [i]
    let cur = i
    for (let guard = 0; guard <= t.count; guard++) {
      const p = t.parent[cur]
      if (p < 0) break
      if (t.children[p].length >= 2) break
      chain.push(p)
      cur = p
    }
    chain.reverse()
    if (chain.length >= 2) out.push(chain)
  }
  return out
}

/**
 * Duplicate-chain detection for SmartRig style rigs that contain the same limb
 * twice. Both chains must be on the SAME side and every joint must coincide
 * within ~1% of the model height; mirrored legs (left + right) never match, so
 * a normal biped yields an empty follow map.
 */
function detectDuplicateChains(
  t: SkeletonTopology,
  bones: BoneInfo[],
  hipsHead: THREE.Vector3,
  anatomicalRight: THREE.Vector3,
  height: number,
): { followMap: Record<string, string>; warnings: string[] } {
  const followMap: Record<string, string> = {}
  const warnings: string[] = []
  const chains = leafChains(t, bones)
  const tolerance = 0.01 * height
  const sideDeadzone = 0.005 * height
  const sideOf = (chain: number[]): number => {
    const s = bones[chain[0]].head.clone().sub(hipsHead).dot(anatomicalRight)
    return Math.abs(s) < sideDeadzone ? 0 : Math.sign(s)
  }
  const mappedFollower = new Set<string>()
  const mappedDriver = new Set<string>()
  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      const a = chains[i]
      const b = chains[j]
      if (a.length !== b.length || a.length < 2) continue
      if (a.some((x) => b.includes(x))) continue
      const sideA = sideOf(a)
      if (sideA === 0 || sideA !== sideOf(b)) continue
      let match = true
      for (let k = 0; k < a.length; k++) {
        if (bones[a[k]].head.distanceTo(bones[b[k]].head) > tolerance) {
          match = false
          break
        }
      }
      if (!match) continue
      const [follower, driver] = a[0] > b[0] ? [a, b] : [b, a]
      const followerRoot = bones[follower[0]].name
      const driverRoot = bones[driver[0]].name
      if (mappedFollower.has(followerRoot) || mappedDriver.has(driverRoot)) continue
      if (mappedDriver.has(followerRoot)) continue
      mappedFollower.add(followerRoot)
      mappedDriver.add(driverRoot)
      for (let k = 0; k < follower.length; k++) {
        followMap[bones[follower[k]].name] = bones[driver[k]].name
      }
      warnings.push(
        `检测到冗余/重合骨骼链：${followerRoot} 链与 ${driverRoot} 链关节位置几乎相同（同一侧），已写入 followMap（${followerRoot} 跟随 ${driverRoot}）`,
      )
    }
  }
  return { followMap, warnings }
}

/* -------------------------------------------------------------------------- */
/* auto detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Detect anatomical roles from the rest pose.
 *
 * Every detection is returned as `SemanticRig.bones` entries; the derived
 * chains are built by `deriveSemantics` so the manual-override path and the
 * automatic path always agree.
 */
export function autoDetectSemantics(rig: RigInfo): SemanticRig {
  const t = topologyOf(rig)
  const bones = rig.boneInfo
  const n = t.count
  const warnings: string[] = []
  const roles = new Map<number, BoneRole>()

  if (n === 0) {
    const sem = emptySemantics()
    sem.warnings.push('骨架中没有骨骼，无法识别语义角色')
    return sem
  }

  const up =
    rig.up && rig.up.lengthSq() > 1e-8 ? rig.up.clone().normalize() : new THREE.Vector3(0, 1, 0)
  const groundY = estimateGroundY(rig)
  const height = estimateHeight(rig, groundY)
  const rel = (p: THREE.Vector3): number => relY(p, groundY, height)
  const hipsHead = new THREE.Vector3(0, 0, 0)
  const assign = (i: number, role: BoneRole): void => {
    if (i < 0 || i >= n) return
    if (!roles.has(i)) roles.set(i, role)
  }
  const hasMeshWeights = (rig.meshes ?? []).some((m) => {
    const g = m.geometry
    return !!g?.attributes?.position && !!g?.attributes?.skinIndex && !!g?.attributes?.skinWeight
  })

  /* ---- 0. 名字先验：四肢 / 头颈 / 耳尾毛发 -------------------------------- */
  // 名字比几何更可靠（尤其是摆好姿势的模型），先把有把握的部件角色定下来，
  // 后面的几何推断只填空缺、并据此过滤「把脊椎当手臂」这类误判。
  const nameRoles = new Map<number, BoneRole>()
  for (let i = 0; i < n; i++) {
    const role = roleFromName(bones[i].name)
    if (role) nameRoles.set(i, role)
  }
  for (const [i, role] of nameRoles) assign(i, role)
  const namedArmCount = [...nameRoles.values()].filter((r) => nameLimbKind(r) === 'arm').length
  const namedLegCount = [...nameRoles.values()].filter((r) => nameLimbKind(r) === 'leg').length
  const hasNamePrior = nameRoles.size > 0
  /** 名字里的左右（1 = 角色自身左侧，-1 = 右侧，0 = 未知） */
  const nameSideOf = (idx: number): 1 | -1 | 0 => {
    const role = nameRoles.get(idx)
    if (!role) return 0
    if (role.endsWith('_L')) return 1
    if (role.endsWith('_R')) return -1
    return 0
  }

  /* ---- 1. hips = LCA of the bones that touch the ground ------------------ */
  let hipsIdx = -1
  {
    const groundLeaves: number[] = []
    for (let i = 0; i < n; i++) {
      if (t.children[i].length > 0) continue
      if (rel(bones[i].head) < 0.16) groundLeaves.push(i)
    }
    let bestPair: [number, number] | null = null
    let bestDist = -1
    for (let i = 0; i < groundLeaves.length; i++) {
      for (let j = i + 1; j < groundLeaves.length; j++) {
        const d = withoutAxis(
          bones[groundLeaves[i]].head.clone().sub(bones[groundLeaves[j]].head),
          up,
        ).length()
        if (d > bestDist) {
          bestDist = d
          bestPair = [groundLeaves[i], groundLeaves[j]]
        }
      }
    }
    if (bestPair) hipsIdx = lowestCommonAncestor(t, bestPair[0], bestPair[1])
    if (hipsIdx < 0) {
      // fallback: follow the branch that reaches the highest point in the model
      // and pick the bone closest to mid height (also tolerates non-monotonic
      // parent joints such as Tripo's root -> pelvis dip)
      let cur = t.root
      const seen = new Set<number>()
      let bestIdx = t.root
      let bestDiff = Infinity
      while (cur >= 0 && !seen.has(cur)) {
        seen.add(cur)
        const d = Math.abs(rel(bones[cur].head) - 0.52)
        if (d < bestDiff) {
          bestDiff = d
          bestIdx = cur
        }
        let next = -1
        let bestReach = -Infinity
        for (const c of t.children[cur]) {
          const reach = subtreeMaxHeadY(t, bones, c)
          if (reach > bestReach) {
            bestReach = reach
            next = c
          }
        }
        if (next < 0 || bestReach <= bones[cur].head.y + 0.02 * height) break
        cur = next
      }
      hipsIdx = bestIdx
      warnings.push('无法从落地骨骼确定骨盆位置，已沿最高分支按身体高度比例近似 hips')
    }
    if (hipsIdx < 0) {
      warnings.push('未识别到骨盆 hips 骨骼，躯干与腿部识别结果可能不准确')
      hipsIdx = t.root
    }
  }
  if (hipsIdx >= 0) hipsHead.copy(bones[hipsIdx].head)

  /* ---- 2. central axis: root -> hips -> (highest branch) -> top ---------- */
  // Note: joints are NOT guaranteed to rise monotonically (Tripo has
  // Bone_002 above Bone_001); therefore the axis is built from the hierarchy
  // plus "which child still reaches the highest point of the model".
  const central: number[] = []
  {
    const down: number[] = []
    const seen = new Set<number>()
    let cur = hipsIdx
    while (cur >= 0 && !seen.has(cur)) {
      seen.add(cur)
      down.push(cur)
      cur = t.parent[cur]
    }
    down.reverse()
    central.push(...down)
    cur = hipsIdx
    for (let guard = 0; guard <= n; guard++) {
      let next = -1
      let bestReach = bones[cur].head.y + 0.02 * height
      for (const c of t.children[cur]) {
        if (seen.has(c)) continue
        const reach = subtreeMaxHeadY(t, bones, c)
        if (reach > bestReach) {
          bestReach = reach
          next = c
        }
      }
      if (next < 0) break
      central.push(next)
      seen.add(next)
      cur = next
    }
  }
  const centralSet = new Set(central)

  /* ---- 3. legs = hip children whose subtree reaches the ground ----------- */
  interface LegCandidate {
    chain: number[]
    startRel: number
    offset: number
  }
  const legCandidates: LegCandidate[] = []
  for (const c of t.children[hipsIdx]) {
    if (centralSet.has(c)) continue
    // 名字说这是手臂 / 头颈等其它部件时，不要当腿
    if (hasNamePrior && nameLimbKind(nameRoles.get(c) ?? null) === 'arm') continue
    const chain = walkDownLongest(t, bones, c)
    if (chain.length === 0) continue
    const leafRel = rel(bones[chain[chain.length - 1]].head)
    const startRel = rel(bones[c].head)
    const hOffset = withoutAxis(bones[c].head.clone().sub(hipsHead), up).length()
    if (leafRel < 0.16 && startRel > 0.3 && hOffset > 0.012 * height) {
      legCandidates.push({ chain, startRel, offset: hOffset })
    }
  }
  // 有名字线索时，只保留名字确认是腿的候选（避免把下垂的机械臂当腿）
  if (namedLegCount >= 1) {
    const named = legCandidates.filter((l) => nameLimbKind(nameRoles.get(l.chain[0]) ?? null) === 'leg')
    if (named.length) legCandidates.splice(0, legCandidates.length, ...named)
  }
  let legChains: number[][] = legCandidates.map((l) => l.chain)
  if (legCandidates.length > 2) {
    legCandidates.sort((a, b) => b.offset - a.offset)
    const picked: LegCandidate[] = []
    for (const cand of legCandidates) {
      if (picked.length >= 2) break
      picked.push(cand)
    }
    legChains = picked.map((l) => l.chain)
    warnings.push(
      `检测到 ${legCandidates.length} 条落地骨骼链，已取最外侧的 ${legChains.length} 条作为双腿，其余忽略`,
    )
  }
  if (legChains.length === 1) {
    warnings.push('只检测到一条落地腿链（另一条腿缺失或姿态特殊）')
  }

  /* ---- 4. facing direction ---------------------------------------------- */
  const lateralHint = estimateLateralAxis(t, bones, up)
  interface ForwardGuess {
    dir: THREE.Vector3
    source: 'feet' | 'knee' | 'marker'
  }
  const guessForward = (): ForwardGuess | null => {
    // 4a. foot -> toe
    const sum = new THREE.Vector3()
    for (const chain of legChains) {
      if (chain.length < 3) continue
      const foot = bones[chain[2]].head
      const toe = bones[chain[chain.length - 1]].head
      sum.add(withoutAxis(toe.clone().sub(foot), up))
    }
    if (sum.length() > 0.02 * height) return { dir: unit(sum), source: 'feet' }
    // 4b. knee offset from the hip -> ankle line
    const kneeSum = new THREE.Vector3()
    for (const chain of legChains) {
      if (chain.length < 3) continue
      const hip = bones[chain[0]].head
      const knee = bones[chain[1]].head
      const ankle = bones[chain[2]].head
      const axis = ankle.clone().sub(hip)
      const lenSq = axis.lengthSq()
      if (lenSq < EPS) continue
      const tt = Math.max(0, Math.min(1, knee.clone().sub(hip).dot(axis) / lenSq))
      const proj = hip.clone().addScaledVector(axis, tt)
      kneeSum.add(withoutAxis(knee.clone().sub(proj), up))
    }
    if (kneeSum.length() > 0.008 * height) return { dir: unit(kneeSum), source: 'knee' }
    // 4c. clearly named face markers ("headfront", "nose", "jaw", ...)
    const markerSum = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      if (t.parent[i] < 0) continue
      if (!/(front|face|nose|snout|jaw|chin|beak|muzzle)/i.test(bones[i].name)) continue
      if (rel(bones[i].head) < 0.5) continue
      markerSum.add(withoutAxis(bones[i].head.clone().sub(bones[t.parent[i]].head), up))
    }
    if (markerSum.length() > 0.01 * height) return { dir: unit(markerSum), source: 'marker' }
    return null
  }
  const guess = guessForward()
  let forwardSource: string = guess?.source ?? 'fallback'
  let forward: THREE.Vector3
  if (guess) {
    const ortho = withoutAxis(guess.dir, lateralHint)
    forward = ortho.lengthSq() > 1e-6 ? unit(ortho) : unit(guess.dir)
  } else {
    // no foot / knee cue: use the widest horizontal axis as the shoulder line
    let fwd = unit(new THREE.Vector3().crossVectors(up, lateralHint))
    const ref = withoutAxis(rig.forward ? rig.forward.clone() : new THREE.Vector3(), up)
    if (ref.lengthSq() > 1e-6 && fwd.dot(unit(ref)) < 0) fwd = fwd.multiplyScalar(-1)
    forward = fwd
  }
  let right = unit(new THREE.Vector3().crossVectors(forward, up))
  if (right.lengthSq() < 1e-6) {
    // forward parallel to up (degenerate model) - keep a stable fallback
    right = unit(new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), up))
    forward = unit(new THREE.Vector3().crossVectors(up, right))
  }

  /* ---- 5. arms = widest lateral pair branching off the spine ------------- */
  // A "finger hub" is a joint with >=3 short child chains: an arm chain is
  // truncated there so `hand` ends up on the palm, not on a fingertip.
  const fingerHubOf = (chain: number[]): number => {
    for (let k = 1; k < chain.length; k++) {
      const kids = t.children[chain[k]]
      if (kids.length < 3) continue
      if (kids.every((kid) => subtreeBBoxSpan(t, bones, kid) < 0.2 * height)) return k
    }
    return -1
  }
  const limbCandidates: LimbCandidate[] = []
  const legBoneSet = new Set<number>()
  for (const chain of legChains) for (const i of chain) legBoneSet.add(i)
  const subtreeTouchesGround = (start: number): boolean => {
    const chain = walkDownLongest(t, bones, start)
    if (chain.length === 0) return false
    return rel(bones[chain[chain.length - 1]].head) < 0.2
  }
  for (const bIdx of central) {
    for (const c of t.children[bIdx]) {
      if (centralSet.has(c) || legBoneSet.has(c)) continue
      // 名字说是腿就不要当手臂
      if (hasNamePrior && nameLimbKind(nameRoles.get(c) ?? null) === 'leg') continue
      if (subtreeTouchesGround(c)) continue
      const rawChain = walkDownLongest(t, bones, c)
      if (rawChain.length === 0) continue
      const hub = fingerHubOf(rawChain)
      const chain = hub >= 0 ? rawChain.slice(0, hub + 1) : rawChain
      const clean = stripTrailingEndMarkers(bones, chain)
      if (clean.length === 0) continue
      let latExtent = 0
      for (const i of chain) {
        const lat = Math.abs(bones[i].head.clone().sub(hipsHead).dot(right))
        if (lat > latExtent) latExtent = lat
      }
      const startRel = rel(bones[c].head)
      const last = chain[chain.length - 1]
      const leafRel = rel(bones[last].head)
      const netLen = bones[chain[0]].head.distanceTo(bones[last].head)
      const sideRaw = bones[c].head.clone().sub(hipsHead).dot(right)
      const side = Math.abs(sideRaw) < 0.005 * height ? 0 : Math.sign(sideRaw)
      const isLimbCandidate =
        startRel > 0.42 &&
        startRel < 0.99 &&
        latExtent > 0.16 * height &&
        netLen > 0.1 * height &&
        leafRel > 0.25
      if (!isLimbCandidate) continue
      limbCandidates.push({ chain, clean, side, latExtent, startRel, leafRel, netLen })
    }
  }
  let arms: LimbCandidate[] = []
  {
    // A) 名字点名了手臂：直接从名字骨骼往下走链，绕开几何阈值。
    //    摆好姿势的模型（例如双手端枪的机甲）手臂横向范围很小，几何阈值会漏掉它们，
    //    然后退而把脊椎当手臂 —— 这是「骨骼和模型对不上」的根源。
    if (namedArmCount >= 1) {
      const bySide = new Map<number, LimbCandidate>()
      /** 沿着名字走：优先走「名字更像肢体末端」的子骨骼，绕开扭骨/辅助骨 */
      const chainFromNamedRoot = (root: number): number[] => {
        const chain = [root]
        let cur = root
        for (let depth = 0; depth < 8; depth++) {
          const kids = t.children[cur].filter((k) => !isEndMarker(bones[k].name))
          if (!kids.length) break
          const rank = (k: number): number => {
            const r = nameRoles.get(k) ?? ''
            if (/^(hand|finger|thumb|foot|toe)_/.test(r)) return 5
            if (/^(forearm|shin)_/.test(r)) return 4
            if (/^(upperArm|thigh|clavicle)_/.test(r)) return 3
            if (r) return 2
            return 0
          }
          const named = kids.filter((k) => nameRoles.has(k))
          let next = -1
          if (named.length) {
            next = named.reduce((a, b) => (rank(b) > rank(a) ? b : a))
          } else {
            // 没有名字线索：走最深的那条（但跳过扭骨）
            const plain = kids.filter((k) => !/twist|roll/i.test(bones[k].name))
            const pool = plain.length ? plain : kids
            next = pool.reduce((a, b) => (t.descendantCount[b] > t.descendantCount[a] ? b : a))
          }
          if (next < 0 || chain.includes(next)) break
          chain.push(next)
          cur = next
        }
        return chain
      }
      for (const [idx, role] of nameRoles) {
        if (!/^(clavicle|upperArm)_/.test(role)) continue
        const rawChain = chainFromNamedRoot(idx)
        if (!rawChain.length) continue
        const hub = fingerHubOf(rawChain)
        const chain = hub >= 0 ? rawChain.slice(0, hub + 1) : rawChain
        const clean = stripTrailingEndMarkers(bones, chain)
        if (!clean.length) continue
        const side = nameSideOf(idx) || 0
        const latExtent = Math.abs(bones[idx].head.clone().sub(hipsHead).dot(right))
        const startRel = rel(bones[idx].head)
        const leafRel = rel(bones[chain[chain.length - 1]].head)
        const netLen = bones[idx].head.distanceTo(bones[chain[chain.length - 1]].head)
        const candidate: LimbCandidate = { chain, clean, side, latExtent, startRel, leafRel, netLen }
        const prev = bySide.get(side)
        // 同一侧可能同时命中 clavicle 与 upperArm：保留更长（更靠上）的那条
        if (!prev || candidate.chain.length > prev.chain.length) bySide.set(side, candidate)
      }
      arms = [...bySide.values()]
    }

    // B) 名字没提供线索：沿用几何「最宽的一对横向分支」
    if (!arms.length) {
      const namedArms = limbCandidates.filter((c) => nameLimbKind(nameRoles.get(c.chain[0]) ?? null) === 'arm')
      if (namedArms.length >= 1) limbCandidates.splice(0, limbCandidates.length, ...namedArms)
      // 名字带 L/R 时以名字定左右（姿态特殊时几何左右也会判错）
      for (const c of limbCandidates) {
        const ns = nameSideOf(c.chain[0])
        if (ns) c.side = ns
      }
    }
    if (!arms.length) {
      let bestScore = -Infinity
      for (let i = 0; i < limbCandidates.length; i++) {
        for (let j = i + 1; j < limbCandidates.length; j++) {
          const a = limbCandidates[i]
          const b = limbCandidates[j]
          if (a.side === 0 || b.side === 0 || a.side === b.side) continue
          if (Math.abs(a.startRel - b.startRel) > 0.12) continue
          const score = a.latExtent + b.latExtent
          if (score > bestScore) {
            bestScore = score
            arms = [a, b]
          }
        }
      }
      if (arms.length === 0 && limbCandidates.length === 1) {
        const only = limbCandidates[0]
        // a single arm is plausible only when it really sits at shoulder height
        if (only.startRel > 0.55 && only.leafRel > 0.5) {
          arms = [only]
          warnings.push('只识别到一条手臂骨骼链（另一侧缺失或姿态特殊）')
        }
      }
      if (arms.length === 0 && limbCandidates.length > 1) {
        const widest = limbCandidates.reduce((a, b) => (b.latExtent > a.latExtent ? b : a))
        if (widest.startRel > 0.55 && widest.leafRel > 0.5) {
          arms = [widest]
          warnings.push('只识别到一条手臂骨骼链（另一侧缺失或姿态特殊）')
        }
      }
    }
  }

  // If facing had to be guessed, refine it from the symmetric arm pair.
  if (forwardSource === 'fallback' && arms.length === 2) {
    const armR = arms.find((a) => a.side > 0)
    const armL = arms.find((a) => a.side < 0)
    if (armR && armL) {
      const tipR = bones[armR.chain[armR.chain.length - 1]].head
      const tipL = bones[armL.chain[armL.chain.length - 1]].head
      let lat = unit(withoutAxis(tipR.clone().sub(tipL), up))
      if (lat.lengthSq() > 1e-6) {
        if (lat.dot(right) < 0) lat = lat.multiplyScalar(-1)
        right = lat
        forward = unit(new THREE.Vector3().crossVectors(up, right))
        forwardSource = 'arms'
      }
    }
  } else if (guess && arms.length === 2) {
    const armR = arms.find((a) => a.side > 0)
    const armL = arms.find((a) => a.side < 0)
    if (armR && armL) {
      const tipR = bones[armR.chain[armR.chain.length - 1]].head
      const tipL = bones[armL.chain[armL.chain.length - 1]].head
      const armLat = unit(withoutAxis(tipR.clone().sub(tipL), up))
      if (armLat.lengthSq() > 1e-6 && Math.abs(armLat.dot(right)) < 0.5) {
        warnings.push('肩线方向与脚趾朝向差异较大，左右角色判定请人工复核')
      }
    }
  }
  // final orthonormal frame: `right` here is the character's OWN right
  // (forward x up), which is what all `_L` / `_R` role suffixes use.
  right = unit(new THREE.Vector3().crossVectors(forward, up))
  if (right.lengthSq() < 1e-6) right = unit(new THREE.Vector3(1, 0, 0))
  rig.forward.copy(forward)
  // RigInfo.right follows the convention the rest of the app uses (rig.ts
  // `refineOrientation` + actions.ts): right = up x forward.  Note that vector
  // points at the character's LEFT; use `anatomicalRight = forward x up` when
  // classifying left / right roles (done above via `right`).
  rig.right.copy(new THREE.Vector3().crossVectors(up, forward).normalize())
  if (rig.right.lengthSq() < 1e-6) rig.right.copy(right)
  if (forwardSource === 'fallback') {
    warnings.push(
      '无法从脚趾/膝盖几何判定模型朝向，已使用肩线宽度回退；左右角色可能互换，请手动检查',
    )
  } else if (forwardSource === 'arms') {
    warnings.push('模型朝向由双臂连线推定，请人工确认左右方向是否正确')
  }

  // keep the refined frame for the rest of the detection
  const sideOf = (p: THREE.Vector3): number => {
    const s = p.clone().sub(hipsHead).dot(right)
    return Math.abs(s) < 1e-5 ? 0 : Math.sign(s)
  }

  /* ---- 6. assign links: root / hips / legs / arms ------------------------ */

  if (central[0] !== undefined && central[0] !== hipsIdx) assign(central[0], 'root')
  assign(hipsIdx, 'hips')

  interface AssignedLeg {
    chain: number[]
    clean: number[]
    side: number
    lat: number
  }
  const assignedLegs: AssignedLeg[] = []
  for (const chain of legChains) {
    const clean = stripTrailingEndMarkers(bones, chain)
    const lat = bones[chain[0]].head.clone().sub(hipsHead).dot(right)
    const ns = nameSideOf(chain[0])
    assignedLegs.push({ chain, clean, side: ns || (lat >= 0 ? 1 : -1), lat })
  }
  if (assignedLegs.length === 2 && assignedLegs[0].side === assignedLegs[1].side) {
    // both legs on one side of the body: force the shorter one to the other side
    const idx = Math.abs(assignedLegs[0].lat) < Math.abs(assignedLegs[1].lat) ? 0 : 1
    assignedLegs[idx].side = -assignedLegs[idx].side
    warnings.push('两条腿链位于身体同一侧，已按位置强制分配左右')
  }
  for (const leg of assignedLegs) {
    const suffix = sideSuffix(leg.side)
    const c = leg.clean
    if (c.length >= 4) {
      assign(c[0], `thigh_${suffix}` as BoneRole)
      assign(c[1], `shin_${suffix}` as BoneRole)
      assign(c[2], `foot_${suffix}` as BoneRole)
      assign(c[3], `toe_${suffix}` as BoneRole)
    } else if (c.length === 3) {
      assign(c[0], `thigh_${suffix}` as BoneRole)
      assign(c[1], `shin_${suffix}` as BoneRole)
      assign(c[2], `foot_${suffix}` as BoneRole)
    } else if (c.length === 2) {
      assign(c[0], `thigh_${suffix}` as BoneRole)
      assign(c[1], `shin_${suffix}` as BoneRole)
    } else if (c.length === 1) {
      assign(c[0], `thigh_${suffix}` as BoneRole)
    }
  }

  interface AssignedArm {
    chain: number[]
    clean: number[]
    side: number
    handIdx: number
  }
  const assignedArms: AssignedArm[] = []
  for (const arm of arms) {
    const ns = nameSideOf(arm.chain[0])
    const suffix = sideSuffix(ns || arm.side)
    const c = arm.clean
    let handIdx = -1
    if (c.length >= 4) {
      assign(c[0], `clavicle_${suffix}` as BoneRole)
      assign(c[1], `upperArm_${suffix}` as BoneRole)
      assign(c[2], `forearm_${suffix}` as BoneRole)
      handIdx = c[c.length - 1]
      assign(handIdx, `hand_${suffix}` as BoneRole)
    } else if (c.length === 3) {
      assign(c[0], `clavicle_${suffix}` as BoneRole)
      assign(c[1], `upperArm_${suffix}` as BoneRole)
      handIdx = c[2]
      assign(handIdx, `hand_${suffix}` as BoneRole)
    } else if (c.length === 2) {
      assign(c[0], `upperArm_${suffix}` as BoneRole)
      handIdx = c[1]
      assign(handIdx, `hand_${suffix}` as BoneRole)
    } else if (c.length === 1) {
      handIdx = c[0]
      assign(c[0], `upperArm_${suffix}` as BoneRole)
    }
    assignedArms.push({ chain: arm.chain, clean: c, side: arm.side, handIdx })
  }

  // fingers: short chains branching from the hand hub
  for (const arm of assignedArms) {
    if (arm.handIdx < 0) continue
    const suffix = sideSuffix(arm.side)
    const kids = t.children[arm.handIdx].filter((k) => !isEndMarker(bones[k].name))
    if (kids.length < 3) continue
    const shortKids = kids.filter((k) => {
      if (t.descendantCount[k] > 10) return false
      return subtreeBBoxSpan(t, bones, k) < 0.2 * height
    })
    if (shortKids.length < 3) continue
    for (const k of shortKids) {
      for (const i of subtreeIndices(t, k)) assign(i, `finger_${suffix}` as BoneRole)
    }
  }

  /* ---- 7. head / neck / torso on the central chain ----------------------- */
  const armAttachIdx = assignedArms.length
    ? t.parent[assignedArms[0].chain[0]]
    : -1
  const armAttachPos = armAttachIdx >= 0 ? central.indexOf(armAttachIdx) : -1

  let weights: Float64Array | null = null
  if (hasMeshWeights) {
    const yThreshold =
      armAttachIdx >= 0
        ? bones[armAttachIdx].head.y + 0.02 * height
        : groundY + 0.62 * height
    weights = scanHeadRegionWeights(rig, yThreshold, hipsHead.x, hipsHead.z, 0.3 * height)
  }

  let candidates: number[] = []
  if (armAttachPos >= 0) {
    candidates = central.slice(armAttachPos + 1).filter((i) => !isEndMarker(bones[i].name))
  } else {
    candidates = central.filter(
      (i) => rel(bones[i].head) > 0.6 && !isEndMarker(bones[i].name),
    )
  }
  let headIdx = -1
  if (candidates.length > 0) {
    if (weights) {
      let max = 0
      for (const i of candidates) if (weights[i] > max) max = weights[i]
      if (max > 0) {
        for (const i of candidates) {
          if (weights[i] >= 0.25 * max) {
            headIdx = i
            break
          }
        }
      }
    }
    if (headIdx < 0) {
      // a skull-top marker ("head_end" / "head_top" ...) hangs off the head bone
      for (let k = central.length - 1; k > 0; k--) {
        if (!isEndMarker(bones[central[k]].name)) continue
        if (armAttachPos >= 0 && k <= armAttachPos) continue
        const parent = central[k - 1]
        if (!isEndMarker(bones[parent].name) && candidates.includes(parent)) {
          headIdx = parent
          break
        }
      }
      if (headIdx >= 0 && hasMeshWeights) {
        warnings.push('头部骨骼权重覆盖不足，已按头顶末端骨骼反推 head')
      }
    }
    if (headIdx < 0) {
      // ratio fallback (no skin weights): the skull pivot sits around 77% height
      let bestDiff = Infinity
      for (const i of candidates) {
        const d = Math.abs(rel(bones[i].head) - 0.77)
        if (d < bestDiff) {
          bestDiff = d
          headIdx = i
        }
      }
      if (hasMeshWeights) {
        warnings.push('头部骨骼权重覆盖不足，已按身体高度比例近似 head')
      } else {
        warnings.push('模型没有蒙皮权重数据，头部/躯干识别使用骨骼高度比例回退，结果可能不准')
      }
    }
    assign(headIdx, 'head')
  }

  const headPos = headIdx >= 0 ? central.indexOf(headIdx) : -1
  let neckIdx = -1
  if (headPos > 0) {
    // the joint directly under the head; in AI rigs (Tripo) it may also parent
    // the arms - that is expected, do NOT drop it for being the shoulder hub
    const below = central[headPos - 1]
    const belowRel = rel(bones[below].head)
    if (!isEndMarker(bones[below].name) && belowRel > 0.6 && belowRel < 0.88) {
      neckIdx = below
    }
  }
  assign(neckIdx, 'neck')

  const hipsPos = central.indexOf(hipsIdx)
  let torso: number[] = []
  if (hipsPos >= 0) {
    const stopPos =
      neckIdx >= 0
        ? central.indexOf(neckIdx)
        : headPos >= 0
          ? headPos
          : central.length
    torso = central.slice(hipsPos + 1, stopPos).filter((i) => !isEndMarker(bones[i].name))
  }
  if (torso.length >= 3) {
    // bottom -> top: spine, (extra bones), chest, upperChest
    assign(torso[0], 'spine')
    const chestIdx = torso[Math.floor((torso.length - 1) / 2)]
    assign(chestIdx, 'chest')
    assign(torso[torso.length - 1], 'upperChest')
    if (torso.length > 3) {
      warnings.push(
        `检测到 ${torso.length} 节脊柱骨骼，已按顺序映射为 spine/chest/upperChest，中间多出的 ${
          torso.length - 3
        } 节标记为 extra`,
      )
    }
  } else if (torso.length === 2) {
    assign(torso[0], 'spine')
    assign(torso[1], 'chest')
  } else if (torso.length === 1) {
    assign(torso[0], 'spine')
  }

  /* ---- 8. ears / hair / tail -------------------------------------------- */
  const assignedSet = (): Set<number> => new Set(roles.keys())
  const assignSubtree = (root: number, role: BoneRole): void => {
    for (const i of subtreeIndices(t, root)) assign(i, role)
  }
  for (const bIdx of central) {
    const parentRel = rel(bones[bIdx].head)
    for (const c of t.children[bIdx]) {
      if (centralSet.has(c) || assignedSet().has(c)) continue
      const chain = walkDownLongest(t, bones, c)
      if (chain.length === 0) continue
      const base = bones[c].head
      const firstDir = base.clone().sub(bones[bIdx].head)
      const horizFirst = withoutAxis(firstDir, up)
      const horizLen = horizFirst.length()
      const lateralDelta = Math.abs(firstDir.dot(right))
      const last = chain[chain.length - 1]
      const netDir = bones[last].head.clone().sub(bones[bIdx].head)
      const netLen = netDir.length()
      const chainLen = chain.reduce(
        (sum, i, k) => (k === 0 ? sum : sum + bones[i].head.distanceTo(bones[chain[k - 1]].head)),
        0,
      )
      const backward =
        horizLen > 1e-6 && horizFirst.dot(forward) < -0.25 * horizLen
      let role: BoneRole | null = null
      if (parentRel > 0.7) {
        // appendage attached to the head / above the head
        if (backward) {
          role = 'hair'
        } else if (lateralDelta > 0.012 * height && horizLen > 0.015 * height) {
          role = sideOf(base) >= 0 ? 'ear_R' : 'ear_L'
        } else if (netDir.y < -0.05 * height && chainLen > 0.05 * height) {
          role = 'hair'
        }
      } else if (bIdx === hipsIdx || parentRel < 0.58) {
        // attachments around the pelvis: a tail hangs backwards / downwards
        const pelvisTail =
          netLen > 0.06 * height && (backward || (netDir.y < -0.04 * height && horizLen < 0.05 * height))
        if (pelvisTail) role = 'tail'
      } else if (backward && chainLen > 0.05 * height) {
        // cape / back hair hanging from the chest
        role = 'hair'
      }
      if (!role) continue
      assignSubtree(c, role)
    }
  }

  /* ---- 9. duplicate same-side chains -> followMap ----------------------- */
  const duplicates = detectDuplicateChains(t, bones, hipsHead, right, height)
  warnings.push(...duplicates.warnings)
  const followMap = duplicates.followMap

  /* ---- 9.5 名字兜底：几何没认出来的躯干 / 颈 --------------------------- */
  // 只填空缺，绝不覆盖几何结论（Tripo / Mixamo 这类标准骨架完全不受影响）。
  {
    const roleTaken = (role: BoneRole): boolean => [...roles.values()].includes(role)
    if (!roleTaken('spine')) {
      const cand = bones.findIndex((b, i) => !roles.has(i) && /waist|spine|torso|abdomen/i.test(b.name))
      if (cand >= 0) {
        assign(cand, 'spine')
        warnings.push(`脊椎链按骨骼名兜底：spine → ${bones[cand].name}`)
      }
    }
    if (!roleTaken('chest')) {
      const cand = bones.findIndex((b, i) => !roles.has(i) && /chest|upper.?spine/i.test(b.name))
      if (cand >= 0) assign(cand, 'chest')
    }
    if (!roleTaken('neck')) {
      const cand = bones.findIndex((b, i) => !roles.has(i) && /neck/i.test(b.name))
      if (cand >= 0) assign(cand, 'neck')
    }
  }

  /* ---- 10. build the role map and derive every chain --------------------- */
  const record: Record<string, BoneRole> = {}
  for (let i = 0; i < n; i++) record[bones[i].name] = roles.get(i) ?? 'extra'
  const sem = deriveSemantics(rig, record, followMap)
  sem.autoGenerated = true
  sem.warnings.push(...warnings)
  return sem
}

/* -------------------------------------------------------------------------- */
/* human readable report (debug / tests)                                      */
/* -------------------------------------------------------------------------- */

/** Multi-line Chinese report of a detection result, used by the test script. */
export function describeDetection(rig: RigInfo, sem: SemanticRig): string {
  const bones = rig.boneInfo
  const lines: string[] = []
  const roleNames = new Map<BoneRole, string[]>()
  for (const [name, role] of Object.entries(sem.bones)) {
    const arr = roleNames.get(role) ?? []
    arr.push(name)
    roleNames.set(role, arr)
  }
  lines.push(
    `骨骼 ${bones.length} 根 | 自动识别=${sem.autoGenerated} | 模型高度=${rig.height.toFixed(3)} | forward=(${rig.forward.x.toFixed(2)}, ${rig.forward.y.toFixed(2)}, ${rig.forward.z.toFixed(2)}) right=(${rig.right.x.toFixed(2)}, ${rig.right.y.toFixed(2)}, ${rig.right.z.toFixed(2)})`,
  )
  lines.push('骨骼 → 角色:')
  for (const role of ALL_ROLES) {
    const names = roleNames.get(role)
    if (!names || names.length === 0) continue
    lines.push(`  ${role.padEnd(11)} ${ROLE_LABELS[role].padEnd(14)} ${names.join(', ')}`)
  }
  lines.push(`脊柱链: ${sem.spineChain.join(' -> ') || '(空)'}`)
  lines.push(`尾巴链: ${sem.tailChain.join(' -> ') || '(空)'}`)
  lines.push(
    `头发链: ${sem.hairChains.length ? sem.hairChains.map((c) => c.join(' -> ')).join(' | ') : '(空)'}`,
  )
  lines.push(`耳链 L: ${sem.earChains.L.join(' -> ') || '(空)'}`)
  lines.push(`耳链 R: ${sem.earChains.R.join(' -> ') || '(空)'}`)
  for (const side of ['L', 'R'] as const) {
    const chains = sem.fingerChains[side]
    lines.push(
      `手指链 ${side}: ${chains.length ? chains.map((c) => c.join(' -> ')).join(' | ') : '(空)'}`,
    )
  }
  const followEntries = Object.entries(sem.followMap)
  lines.push(
    `followMap: ${
      followEntries.length ? followEntries.map(([f, d]) => `${f} -> ${d}`).join(', ') : '(空)'
    }`,
  )
  lines.push(`警告 (${sem.warnings.length}):`)
  for (const w of sem.warnings) lines.push(`  - ${w}`)
  return lines.join('\n')
}
