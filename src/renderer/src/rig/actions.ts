import * as THREE from 'three'
import type {
  ActionKind,
  ActionParams,
  BoneRole,
  PoseClip,
  PoseTrack,
  RigInfo,
  SampledPose,
  SemanticRig,
} from './types'
import { axisAngle, localPoseQuat, worldDeltaToLocal } from './rig'

/**
 * Procedural action library.
 *
 * 姿态约定（保证与具体骨骼朝向 / roll 无关）：
 * - 所有角度都在“世界轴”上定义，再由 rig.ts 的 worldDeltaToLocal 共轭到骨骼局部空间。
 * - rig.forward / rig.right / rig.up 由 rig.ts 保证 right = up × forward 的右手系：
 *     绕 rig.right 转   → 前后摆（本文件 "swing" 正 = 朝 forward）
 *     绕 rig.forward 转 → 侧向抬展（本文件 "lift/abduct" 正 = 远离身体）
 *     绕 rig.up 转      → 水平扭转（"yaw"）
 * - 左右镜像一律来自语义角色（_L / _R）与 ctx.lateralSign，绝不假设模型朝 +Z。
 * - T-pose / A-pose 通用：手臂“放下”不写死角度，而是用 aim() 把骨骼 rest 方向转到目标方向，
 *   所以同一套动作能适配手臂沿 X 展开（human）或沿 Z 展开（Tripo Q 版）的骨架。
 *
 * 输出：30fps，绝对局部四元数轨道；首帧 time=0，末帧 time=duration。
 * 循环动作首尾帧完全一致；非循环动作首尾回到中立站姿（便于和 idle 混合）。
 * 数值全部有命名常量，按动作分组，方便后续调参。
 */

/** 动作采样帧率：与编辑器统一为 30fps。 */
export const ACTION_FPS = 30

const TAU = Math.PI * 2
/** 角度 → 弧度（常量表统一用角度书写，读起来更直观） */
const deg = (d: number) => (d * Math.PI) / 180
type Side = 'L' | 'R'

// ─────────────────────────── 数学 / 曲线小工具 ───────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function clamp01(x: number): number {
  return clamp(x, 0, 1)
}

/** 0→1 平滑过渡（首尾导数为 0，动作起停更柔和） */
function smoothstep01(x: number): number {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** u 从 a 到 b 的 0→1 平滑过渡 */
function ramp(u: number, a: number, b: number): number {
  if (b - a < 1e-9) return u >= b ? 1 : 0
  return smoothstep01((u - a) / (b - a))
}

/** a→b 上升、c→d 回落的平滑窗口（“抬手 → 保持 → 放下”这类动作） */
function window4(u: number, a: number, b: number, c: number, d: number): number {
  return ramp(u, a, b) * (1 - ramp(u, c, d))
}

/** 关键帧曲线：points 必须 u 升序，段间用 smoothstep 插值，超出范围钳制 */
function curve(points: Array<[number, number]>, u: number): number {
  const first = points[0]
  if (!first) return 0
  if (u <= first[0]) return first[1]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]
    const p1 = points[i + 1]
    if (u <= p1[0]) {
      const span = p1[0] - p0[0]
      const t = span > 1e-9 ? smoothstep01((u - p0[0]) / span) : 1
      return p0[1] + (p1[1] - p0[1]) * t
    }
  }
  return points[points.length - 1][1]
}

/** 周期振荡；cycles 取整数时 u∈[0,1] 首尾完全一致（循环动作无缝的前提） */
function osc(cycles: number, u: number, phase = 0): number {
  return Math.sin(TAU * (cycles * u + phase))
}

/** 把一次旋转按比例缩放（用于把躯干总俯仰均摊到整条脊柱链上） */
function scaleRotation(q: THREE.Quaternion, factor: number): THREE.Quaternion {
  const n = q.clone().normalize()
  if (n.w < 0) {
    n.x = -n.x
    n.y = -n.y
    n.z = -n.z
    n.w = -n.w
  }
  const sinHalf = Math.sqrt(Math.max(0, 1 - n.w * n.w))
  if (sinHalf < 1e-9 || Math.abs(factor) < 1e-9) return new THREE.Quaternion()
  const angle = 2 * Math.acos(clamp(n.w, -1, 1))
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(n.x / sinHalf, n.y / sinHalf, n.z / sinHalf),
    angle * factor,
  )
}

// ─────────────────────────── 动作库定义 ───────────────────────────

export interface ActionContext {
  rig: RigInfo
  semantics: SemanticRig
  /** bone name for a single-role bone */
  roleBone: (role: BoneRole) => string | undefined
  /** rest local quaternion of the given bone */
  restLocalQuat: (boneName: string) => THREE.Quaternion
  /** rest world quaternion of the given bone */
  restWorldQuat: (boneName: string) => THREE.Quaternion
  /** +1 if the bone sits on the character's right of the hips, else -1 */
  lateralSign: (boneName: string) => number
}

export interface ActionDefinition {
  kind: ActionKind
  label: string
  description: string
  defaultDuration: number
  loop: boolean
}

export const ACTION_LIBRARY: ActionDefinition[] = [
  { kind: 'idle', label: '待机 Idle', description: '呼吸 + 重心微摆，可无缝循环', defaultDuration: 4, loop: true },
  { kind: 'walk', label: '行走 Walk', description: '原地步循环：腿摆、屈膝、手臂反摆、身体起伏', defaultDuration: 1.2, loop: true },
  { kind: 'run', label: '奔跑 Run', description: '更大摆幅 + 前倾 + 腾空起伏', defaultDuration: 0.8, loop: true },
  { kind: 'wave', label: '挥手 Wave', description: '抬臂、小臂弯曲、手掌左右摆动', defaultDuration: 2.5, loop: false },
  { kind: 'grip', label: '握拳/手势 Grip', description: '手指由张开到握拳再到指向', defaultDuration: 3, loop: false },
  { kind: 'sit', label: '坐下/起立 Sit', description: '下蹲落座、待机、起立回位', defaultDuration: 6, loop: false },
  { kind: 'pickup', label: '拾取物品 Pickup', description: '弯腰、伸手、抓取、抬起到胸前、还原', defaultDuration: 5, loop: false },
  { kind: 'jump', label: '跳跃 Jump', description: '预蹲、起跳、空中收腿、落地缓冲', defaultDuration: 2, loop: false },
  { kind: 'cheer', label: '欢呼 Cheer', description: '双臂上举 + 小幅弹跳', defaultDuration: 2.5, loop: false },
  { kind: 'sad', label: '低落 Sad', description: '含胸低头、肩膀下沉', defaultDuration: 4, loop: true },
  { kind: 'bow', label: '鞠躬 Bow', description: '双臂自然下垂，脊柱前倾约 35° 鞠躬，再回正', defaultDuration: 2, loop: false },
  { kind: 'nod', label: '点头 Nod', description: '颈/头小幅点头两次，肩背轻微跟随', defaultDuration: 1.2, loop: false },
  { kind: 'shake_head', label: '摇头 Shake', description: '头部左右 yaw 摆动两次，脖子轻微反相', defaultDuration: 1.6, loop: false },
  { kind: 'clap', label: '鼓掌 Clap', description: '双臂抬到胸前，双手靠拢再分开，可无缝循环', defaultDuration: 2, loop: true },
  { kind: 'dance', label: '跳舞 Dance', description: '重心左右摆 + 髋部转动 + 双臂交替上举 + 膝盖轻弹', defaultDuration: 4, loop: true },
  { kind: 'stretch', label: '伸懒腰 Stretch', description: '双臂上举过头、胸腔后仰、踮脚拉长身体，再放松回位', defaultDuration: 3, loop: false },
  { kind: 'crouch', label: '蹲下 Crouch', description: '屈膝下蹲、身体前倾、手臂前伸保持平衡，再起身', defaultDuration: 3, loop: false },
  { kind: 'think', label: '思考 Think', description: '一手抬到下巴、头微低偏侧，另一手抱在身前，可循环', defaultDuration: 4, loop: true },
  { kind: 'point', label: '指向 Point', description: '单臂向前伸出、食指指出，身体轻微前倾后收回', defaultDuration: 2, loop: false },
  { kind: 'punch', label: '出拳 Punch', description: '收拳蓄力后单臂快速前伸，躯干扭转，再收回', defaultDuration: 1.6, loop: false },
  { kind: 'kick', label: '踢腿 Kick', description: '单腿抬起前踢（髋前摆 + 屈膝后绷直），支撑腿微屈', defaultDuration: 1.6, loop: false },
  { kind: 'pray', label: '祈祷 Pray', description: '双手在胸前合拢、肘部外张、头微低，轻微前后摇晃', defaultDuration: 3, loop: false },
]

// ─────────────────────────── 中立站姿常量 ───────────────────────────

/** 手臂自然下垂时向外偏一点，避免贴穿身体 */
const ARM_OUT_BIAS = 0.16
/** 手臂自然下垂时向前偏一点 */
const ARM_FWD_BIAS = 0.04
/** 放松状态的小臂微屈 */
const ELBOW_RELAX = deg(9)
/** 放松状态下锁骨轻微下沉 */
const CLAV_DROP = deg(3)
/** 手指自然微屈（0 = 完全伸直，1 ≈ 握拳） */
const FINGER_RELAX = 0.12
/** 每节指骨分担的弯曲比例（掌根 → 指尖） */
const FINGER_SEG_CURL = [0.55, 0.75, 0.65, 0.45]
/** “指向”手势里伸直的那根手指残留的弯曲 */
const FINGER_POINT_CURL = 0.05
/** 腕部随握力产生的屈腕角（握拳时最明显，也能让人形骨架的 grip 有动作） */
const WRIST_CURL = 0.35
/** 中立站姿的放松屈腕角（让手骨在所有动作里都有一条自然轨道） */
const WRIST_RELAX = 0.09

// ── idle：呼吸 + 重心微摆 + 头微动 ──
const IDLE_BREATH_PITCH = deg(0.9)
const IDLE_BREATH_ROOT = 0.004
const IDLE_SWAY_ROLL = deg(1.2)
const IDLE_SWAY_YAW = deg(0.7)
const IDLE_SWAY_ROOT = 0.006
const IDLE_ARM_SWING = deg(1.8)
const IDLE_HEAD_YAW = deg(2.0)
const IDLE_HEAD_ROLL = deg(1.1)

// ── breath：深呼吸（ActionKind 里的 breath，未放进 UI 动作库）──
const BREATH_CHEST = deg(2.4)
const BREATH_CLAV = deg(3.5)
const BREATH_ROOT = 0.006

// ── walk ──
const WALK_THIGH = deg(24)
const WALK_KNEE_MIN = deg(6)
const WALK_KNEE_AMP = deg(48)
/** 摆动腿屈膝峰值所在的相位（u） */
const WALK_KNEE_PEAK = 0.65
const WALK_ARM = deg(22)
const WALK_ELBOW = deg(12)
const WALK_LEAN = deg(4)
const WALK_BOB = 0.02
const WALK_SWAY = 0.01
const WALK_HIP_YAW = deg(6)
const WALK_ROLL = deg(1.6)
/** 单腿脚掌俯仰关键帧：[相位 u, 角度]，正 = 脚尖下压 */
const WALK_FOOT: Array<[number, number]> = [
  [0.0, deg(-14)],
  [0.12, 0],
  [0.38, deg(3)],
  [0.5, deg(26)],
  [0.62, deg(4)],
  [0.82, deg(-8)],
  [1.0, deg(-14)],
]
const WALK_EAR = deg(5)
const WALK_HAIR = deg(6)
const WALK_TAIL = deg(7)

// ── run ──
const RUN_THIGH = deg(42)
const RUN_KNEE_MIN = deg(10)
const RUN_KNEE_AMP = deg(85)
const RUN_KNEE_PEAK = 0.62
const RUN_ARM = deg(38)
const RUN_ELBOW = deg(80)
const RUN_LEAN_HIP = deg(4)
const RUN_LEAN_SPINE = deg(11)
const RUN_LEAN_HEAD = deg(10)
const RUN_BOB = 0.028
const RUN_SWAY = 0.008
const RUN_HIP_YAW = deg(8)
const RUN_ROLL = deg(2)
const RUN_FOOT: Array<[number, number]> = [
  [0.0, deg(-6)],
  [0.1, deg(4)],
  [0.34, deg(10)],
  [0.46, deg(42)],
  [0.6, deg(4)],
  [0.8, deg(-18)],
  [1.0, deg(-6)],
]

// ── wave：右臂侧上方抬起、小臂竖起、小臂/手掌左右摆 ──
const WAVE_LIFT = deg(104)
const WAVE_SWING = deg(10)
const WAVE_OSC_CYCLES = 3.5
const WAVE_FOREARM_OSC = 0.38
const WAVE_HAND_OSC = 0.55
const WAVE_HEAD_YAW = deg(9)

// ── grip：张开 → 握拳 → 指向（食指伸出）→ 放松 ──
const GRIP_FIST: Array<[number, number]> = [
  [0.0, 0.1],
  [0.12, 0.0],
  [0.3, 1.0],
  [0.5, 1.0],
  [0.62, 1.0],
  [0.75, 0.15],
  [0.9, 0.0],
  [1.0, 0.1],
]
const GRIP_POINT: Array<[number, number]> = [
  [0.0, 0.0],
  [0.55, 0.0],
  [0.66, 1.0],
  [0.8, 1.0],
  [0.9, 0.0],
  [1.0, 0.0],
]
const GRIP_ARM_LIFT = deg(8)
const GRIP_ARM_SWING = deg(10)
const GRIP_ELBOW = deg(12)

// ── sit：骨盆下沉、屈膝、手臂前搭 ──
/** 骨盆下沉量（× height），与任务约定一致 */
const SIT_DROP = 0.18
const SIT_THIGH = deg(72)
const SIT_KNEE = deg(72)
const SIT_ARM_LIFT = deg(10)
const SIT_ARM_SWING = deg(26)
const SIT_ELBOW = deg(52)
const SIT_HIP_TILT = deg(6)
const SIT_SPINE = deg(5)

// ── pickup：弯腰 → 下探 → 抓取 → 抬到胸前 → 还原 ──
const PICKUP_BEND: Array<[number, number]> = [
  [0.0, 0.0],
  [0.2, 1.0],
  [0.38, 1.0],
  [0.62, 0.15],
  [0.85, 0.0],
  [1.0, 0.0],
]
const PICKUP_GRAB: Array<[number, number]> = [
  [0.0, 0.0],
  [0.2, 0.0],
  [0.34, 1.0],
  [0.72, 1.0],
  [0.82, 0.0],
  [1.0, 0.0],
]
const PICKUP_CARRY: Array<[number, number]> = [
  [0.0, 0.0],
  [0.34, 0.0],
  [0.55, 1.0],
  [0.72, 1.0],
  [0.9, 0.0],
  [1.0, 0.0],
]
const PICKUP_HIP_PITCH = deg(10)
const PICKUP_SPINE_PITCH = deg(38)
const PICKUP_NECK_PITCH = deg(10)
const PICKUP_HEAD_PITCH = deg(14)
const PICKUP_KNEE = deg(38)
const PICKUP_THIGH = deg(6)
const PICKUP_CROUCH = 0.085
const PICKUP_REACH_SWING = deg(74)
const PICKUP_CARRY_SWING = deg(26)
const PICKUP_CARRY_ELBOW = deg(78)

// ── jump：预蹲 → 起跳 → 空中收腿 → 落地缓冲 ──
const JUMP_ROOT: Array<[number, number]> = [
  [0.0, 0.0],
  [0.16, -0.1],
  [0.24, 0.0],
  [0.36, 0.18],
  [0.48, 0.0],
  [0.56, -0.08],
  [0.7, -0.01],
  [0.85, 0.0],
  [1.0, 0.0],
]
const JUMP_CROUCH: Array<[number, number]> = [
  [0.0, 0.0],
  [0.1, 0.7],
  [0.17, 1.0],
  [0.24, 0.1],
  [0.3, 0.0],
  [0.5, 0.0],
  [0.56, 0.75],
  [0.68, 0.15],
  [0.8, 0.0],
  [1.0, 0.0],
]
const JUMP_TUCK: Array<[number, number]> = [
  [0.0, 0.0],
  [0.26, 0.0],
  [0.34, 1.0],
  [0.44, 0.8],
  [0.52, 0.0],
  [1.0, 0.0],
]
const JUMP_ARM: Array<[number, number]> = [
  [0.0, 0.0],
  [0.12, -0.8],
  [0.22, 0.5],
  [0.3, 1.0],
  [0.42, 0.9],
  [0.52, 0.3],
  [0.6, -0.2],
  [0.72, 0.05],
  [1.0, 0.0],
]
const JUMP_CROUCH_KNEE = deg(58)
const JUMP_CROUCH_THIGH = deg(40)
const JUMP_TUCK_THIGH = deg(48)
const JUMP_TUCK_KNEE = deg(72)
const JUMP_ARM_LIFT = deg(105)
const JUMP_ARM_SWING = deg(40)
const JUMP_TORSO_PITCH = deg(15)

// ── cheer：双臂上举 + 两次小跳 ──
const CHEER_LIFT = deg(142)
const CHEER_HOP = 0.04
const CHEER_KNEE = deg(12)
const CHEER_HEAD = deg(8)
const CHEER_ARCH = deg(3)

// ── sad：含胸低头、肩膀下沉 ──
const SAD_HIP_PITCH = deg(3)
const SAD_SPINE_PITCH = deg(14)
const SAD_SPINE_WAVE = deg(1.2)
const SAD_NECK_PITCH = deg(9)
const SAD_HEAD_PITCH = deg(16)
const SAD_HEAD_WAVE = deg(1.0)
const SAD_SHOULDER = deg(8)
const SAD_ARM_SWING = deg(7)
const SAD_ELBOW = deg(26)
const SAD_DROP = 0.015
const SAD_HEAD_YAW = deg(2)

// ── bow 鞠躬：脊柱+胸前倾，手臂自然下垂 ──
const BOW_HIP_PITCH = deg(6)
const BOW_SPINE_PITCH = deg(34)
const BOW_NECK_PITCH = deg(8)
const BOW_HEAD_PITCH = deg(12)
const BOW_KNEE = deg(10)
const BOW_ARM_SWING = deg(7)

// ── nod 点头：颈/头小幅点头两次 ──
const NOD_HEAD = deg(15)
const NOD_NECK = deg(4.5)
const NOD_SPINE = deg(2)
const NOD_CYCLES = 2

// ── shake_head 摇头：头部左右 yaw 摆动两次 ──
const SHAKE_HEAD_YAW = deg(18)
const SHAKE_NECK_YAW = deg(5)
const SHAKE_HEAD_ROLL = deg(3)
const SHAKE_CYCLES = 2

// ── clap 鼓掌：双手在胸前拍合 ──
const CLAP_ARM_LIFT = deg(6)
const CLAP_ARM_SWING = deg(10)
/** 前臂朝前的分量（越大越向前伸） */
const CLAP_FWD = 0.9
/** 前臂朝上的分量（让手停在胸前高度） */
const CLAP_UP = 0.8
/** 双手合拢 / 张开时前臂朝身体中线的分量（合拢时足够大，手掌才会拍到一起） */
const CLAP_INWARD_CLOSED = 1.9
const CLAP_INWARD_OPEN = 0.55
const CLAP_CYCLES = 4
const CLAP_FINGER = 0.22
const CLAP_CLAV = deg(2)
const CLAP_KNEE = deg(4)
const CLAP_NOD = deg(2)

// ── dance 跳舞：重心摆 + 髋转 + 双臂交替上举 + 弹跳 ──
const DANCE_SWAY = 0.03
const DANCE_HIP_ROLL = deg(7)
const DANCE_HIP_YAW = deg(11)
const DANCE_KNEE = deg(12)
const DANCE_KNEE_AMP = deg(10)
const DANCE_ARM_LIFT = deg(74)
const DANCE_ARM_AMP = deg(46)
const DANCE_ARM_SWING = deg(8)
const DANCE_ELBOW = deg(24)
const DANCE_HEAD_YAW = deg(10)
const DANCE_HEAD_ROLL = deg(6)
const DANCE_HEAD_PITCH = deg(4)

// ── stretch 伸懒腰：双臂上举过头 + 胸腔后仰 + 轻微踮脚 ──
const STRETCH_ARM_LIFT = deg(152)
const STRETCH_SPINE = deg(9)
const STRETCH_HIP = deg(3)
const STRETCH_NECK = deg(3)
const STRETCH_HEAD = deg(9)
const STRETCH_ROOT = 0.008
const STRETCH_FOOT = deg(5)
const STRETCH_TOE = deg(-4)

// ── crouch 蹲下：自适应“脚掌踩地”的深蹲 ──
const CROUCH_DROP = 0.22
/** 蹲到底时小腿相对竖直向前的倾角（膝盖越过脚尖的自然深蹲） */
const CROUCH_SHIN_TILT = deg(28)
const CROUCH_HIP_PITCH = deg(14)
const CROUCH_SPINE_PITCH = deg(22)
const CROUCH_NECK_PITCH = deg(-8)
const CROUCH_HEAD_PITCH = deg(-14)
const CROUCH_ARM_SWING = deg(55)
const CROUCH_ARM_LIFT = deg(12)
const CROUCH_ELBOW = deg(25)

// ── think 思考：一手抬到下巴，另一手抱在身前 ──
const THINK_HEAD_PITCH = deg(7)
const THINK_HEAD_ROLL = deg(8)
const THINK_HEAD_YAW = deg(8)
const THINK_HIP_ROLL = deg(1.5)
/** 右前臂朝上朝内的方向分量（手抬到下巴/脸侧） */
const THINK_FOREARM_FWD = 0.22
const THINK_FOREARM_UP = 0.96
const THINK_FOREARM_IN = -0.32
/** 左前臂横过身体的方向分量（抱臂） */
const THINK_LEFT_FWD = 0.45
const THINK_LEFT_UP = 0.18
const THINK_LEFT_IN = -0.88

// ── point 指向：单臂向前伸出 + 食指指出 ──
const POINT_LEAN = deg(5)
const POINT_TWIST = deg(6)
const POINT_HEAD_YAW = deg(4)
const POINT_UA_UP = 0.18
const POINT_UA_OUT = 0.18
const POINT_FINGER_OTHER = 0.85

// ── punch 出拳：蓄力收拳 → 快速前伸 → 收回 ──
/** 收拳蓄力（0 = 中立，1 = 拳收在胸前） */
const PUNCH_CHAMBER: Array<[number, number]> = [
  [0.0, 0.0],
  [0.12, 1.0],
  [0.24, 1.0],
  [0.36, 0.0],
  [0.8, 0.0],
  [0.92, 0.2],
  [1.0, 0.0],
]
/** 出拳伸展（0 = 收着，1 = 手臂完全打直） */
const PUNCH_EXTEND: Array<[number, number]> = [
  [0.0, 0.0],
  [0.18, 0.0],
  [0.3, 1.0],
  [0.46, 1.0],
  [0.62, 0.35],
  [0.9, 0.0],
  [1.0, 0.0],
]
const PUNCH_BODY_TWIST = deg(12)
const PUNCH_HIP_YAW = deg(4)
const PUNCH_LEAN = deg(5)
const PUNCH_GUARD_LIFT = deg(16)
const PUNCH_GUARD_SWING = deg(22)
const PUNCH_GUARD_ELBOW = deg(72)
const PUNCH_FIST = 0.95

// ── kick 踢腿：髋前摆 + 膝先屈后伸 + 脚背绷直 ──
/** 踢腿抬起量 */
const KICK_RAISE: Array<[number, number]> = [
  [0.0, 0.0],
  [0.12, 0.25],
  [0.3, 1.0],
  [0.45, 1.0],
  [0.6, 0.4],
  [0.85, 0.0],
  [1.0, 0.0],
]
/** 起腿阶段的屈膝（踢出时伸直） */
const KICK_FLEX: Array<[number, number]> = [
  [0.0, 0.0],
  [0.15, 1.0],
  [0.28, 0.9],
  [0.34, 0.0],
  [0.6, 0.2],
  [0.85, 0.0],
  [1.0, 0.0],
]
const KICK_THIGH = deg(55)
const KICK_KNEE = deg(85)
const KICK_FOOT = deg(22)
const KICK_HIP_LEAN = deg(4)
const KICK_LEAN = deg(8)
const KICK_BALANCE_LIFT = deg(40)
const KICK_BALANCE_SWING = deg(-8)
const KICK_BALANCE_ELBOW = deg(20)
const KICK_SUPPORT_KNEE = deg(8)

// ── pray 祈祷/拜托：双手胸前合拢、肘部外张、头微低 ──
const PRAY_ARM_LIFT = deg(8)
const PRAY_ARM_SWING = deg(14)
const PRAY_FOREARM_FWD = 0.5
const PRAY_FOREARM_UP = 0.7
const PRAY_INWARD = 1.45
const PRAY_FINGER = 0.35
const PRAY_NECK = deg(4)
const PRAY_HEAD = deg(10)
const PRAY_ROCK = deg(1.5)
const PRAY_KNEE = deg(5)

// ─────────────────────────── 姿态写入器 ───────────────────────────

/** 单帧姿态的时间上下文 */
interface PoseMotion {
  /** 归一化相位 0..1 */
  u: number
  duration: number
  /** 动作幅度倍率（ActionParams.amplitude） */
  amp: number
}

/**
 * PoseWriter 负责“作者空间 → 骨骼局部空间”的换算。
 *
 * 骨骼世界旋转的合成关系（由 rig.ts 的共轭公式推导）：
 *   T_bone = T_parent * D_bone
 * 其中 D 是写入该骨骼的 rest 世界坐标系旋转。因此：
 *   - rel(bone, q): 以骨骼 rest 世界轴写“相对父骨”的旋转（适合膝/肘/手指这类铰链）；
 *   - abs(bone, q): 指定该骨骼相对 rest 的“世界总旋转”，内部自动扣掉父骨累积的旋转
 *     （适合“手臂指到某个世界方向”“脚掌保持水平”这类绝对目标）。
 * 写骨骼必须从根到叶的顺序进行（abs 依赖祖先已写入的旋转）。
 */
class PoseWriter {
  readonly rig: RigInfo
  readonly ctx: ActionContext
  readonly motion: PoseMotion
  /** 根骨骼（骨盆）的世界空间偏移 */
  readonly root = new THREE.Vector3()
  /** boneIndex -> 自身 delta（rest 世界坐标系内） */
  private readonly deltas = new Map<number, THREE.Quaternion>()
  /** boneIndex -> 累积世界旋转缓存 */
  private readonly worldCache = new Map<number, THREE.Quaternion>()

  constructor(ctx: ActionContext, motion: PoseMotion) {
    this.ctx = ctx
    this.rig = ctx.rig
    this.motion = motion
  }

  private indexOf(name: string | undefined): number | undefined {
    if (!name) return undefined
    return this.rig.boneIndexByName.get(name)
  }

  /** followMap 里的“跟随骨”交给编辑器约束驱动，这里不重复写轨道 */
  private isFollower(name: string): boolean {
    const follow = this.ctx.semantics?.followMap
    return !!follow && Object.prototype.hasOwnProperty.call(follow, name)
  }

  private worldOf(index: number): THREE.Quaternion {
    const cached = this.worldCache.get(index)
    if (cached) return cached
    const info = this.rig.boneInfo[index]
    const world = new THREE.Quaternion()
    if (!info) {
      this.worldCache.set(index, world)
      return world
    }
    if (info.parentIndex >= 0) world.copy(this.worldOf(info.parentIndex))
    const own = this.deltas.get(index)
    if (own) world.multiply(own)
    this.worldCache.set(index, world)
    return world
  }

  /** 相对父骨追加一个旋转（在骨骼 rest 世界坐标系里表达） */
  rel(name: string | undefined, q: THREE.Quaternion): void {
    if (!name || this.isFollower(name)) return
    const index = this.indexOf(name)
    if (index === undefined) return
    const existing = this.deltas.get(index)
    if (existing) existing.multiply(q)
    else this.deltas.set(index, q.clone())
    this.worldCache.clear()
  }

  /** 直接指定该骨骼相对 rest 的“世界总旋转” */
  abs(name: string | undefined, qWorld: THREE.Quaternion): void {
    if (!name || this.isFollower(name)) return
    const index = this.indexOf(name)
    if (index === undefined) return
    const info = this.rig.boneInfo[index]
    const parentWorld = new THREE.Quaternion()
    if (info.parentIndex >= 0) parentWorld.copy(this.worldOf(info.parentIndex))
    const own = parentWorld.invert().multiply(qWorld)
    this.deltas.set(index, own)
    this.worldCache.clear()
  }

  /** 该骨骼当前累积的世界旋转（调试用，不参与产出） */
  worldRotationOf(name: string): THREE.Quaternion {
    const index = this.indexOf(name)
    if (index === undefined) return new THREE.Quaternion()
    return this.worldOf(index)
  }

  /** 输出每根被写骨骼的绝对局部四元数（local = restLocal * localDelta） */
  buildLocals(): Map<string, THREE.Quaternion> {
    const out = new Map<string, THREE.Quaternion>()
    for (const [index, delta] of this.deltas) {
      const info = this.rig.boneInfo[index]
      if (!info) continue
      const restWorld = this.ctx.restWorldQuat(info.name)
      const restLocal = this.ctx.restLocalQuat(info.name)
      const localDelta = worldDeltaToLocal(restWorld, delta)
      out.set(info.name, localPoseQuat(restLocal, localDelta))
    }
    return out
  }
}

// ─────────────────────────── 骨骼几何 / 方向工具 ───────────────────────────

function armRole(side: Side): BoneRole {
  return side === 'L' ? 'upperArm_L' : 'upperArm_R'
}
function forearmRole(side: Side): BoneRole {
  return side === 'L' ? 'forearm_L' : 'forearm_R'
}
function handRole(side: Side): BoneRole {
  return side === 'L' ? 'hand_L' : 'hand_R'
}
function clavicleRole(side: Side): BoneRole {
  return side === 'L' ? 'clavicle_L' : 'clavicle_R'
}
function thighRole(side: Side): BoneRole {
  return side === 'L' ? 'thigh_L' : 'thigh_R'
}
function shinRole(side: Side): BoneRole {
  return side === 'L' ? 'shin_L' : 'shin_R'
}
function footRole(side: Side): BoneRole {
  return side === 'L' ? 'foot_L' : 'foot_R'
}
function toeRole(side: Side): BoneRole {
  return side === 'L' ? 'toe_L' : 'toe_R'
}

/** 骨骼 rest 姿态下的世界方向（head → tail） */
function restDirOf(rig: RigInfo, name: string): THREE.Vector3 {
  const index = rig.boneIndexByName.get(name)
  if (index === undefined) return new THREE.Vector3(0, 1, 0)
  const info = rig.boneInfo[index]
  const dir = new THREE.Vector3().subVectors(info.tail, info.head)
  if (dir.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0)
  return dir.normalize()
}

/** 该骨骼的“外侧”世界方向（远离身体中线） */
function outwardOf(rig: RigInfo, ctx: ActionContext, name: string): THREE.Vector3 {
  const sign = ctx.lateralSign(name) < 0 ? -1 : 1
  const out = new THREE.Vector3().copy(rig.right).multiplyScalar(sign)
  if (out.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1)
  return out.normalize()
}

/** 侧向符号（±1），用于镜像 */
function lateralSignSafe(w: PoseWriter, name: string): number {
  return w.ctx.lateralSign(name) < 0 ? -1 : 1
}

/** 把 from 方向旋到 to 方向的最短弧四元数（对反向退化有兜底） */
function aimQuat(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const f = from.clone()
  const t = to.clone()
  if (f.lengthSq() < 1e-12 || t.lengthSq() < 1e-12) return new THREE.Quaternion()
  f.normalize()
  t.normalize()
  if (f.dot(t) < -0.9999) {
    const axis = new THREE.Vector3(0, 1, 0).cross(f)
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).cross(f)
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), Math.PI)
  }
  return new THREE.Quaternion().setFromUnitVectors(f, t)
}

/** 前后摆：绕 rig.right 转，正 = 朝 forward（对下垂的四肢而言） */
function swingRot(rig: RigInfo, angle: number): THREE.Quaternion {
  return axisAngle(rig.right, -angle)
}

/** 侧向抬展：绕 rig.forward 转，正 = 远离身体（配 lateralSign 使用） */
function raiseRot(rig: RigInfo, sign: number, angle: number): THREE.Quaternion {
  return axisAngle(rig.forward, sign * angle)
}

/** 肘/膝铰链轴：垂直于肢体、朝身体前方弯曲 */
function elbowHingeAxis(rig: RigInfo, boneName: string): THREE.Vector3 {
  const dir = restDirOf(rig, boneName)
  const axis = new THREE.Vector3().crossVectors(rig.forward, dir)
  if (axis.lengthSq() < 1e-8) axis.copy(rig.up)
  return axis.normalize()
}

/** 手指/脚趾的弯曲轴：绕“指尖朝下”的轴弯曲 */
function curlAxisOf(rig: RigInfo, boneName: string): THREE.Vector3 {
  const dir = restDirOf(rig, boneName)
  const down = new THREE.Vector3().copy(rig.up).negate()
  const axis = new THREE.Vector3().crossVectors(dir, down)
  if (axis.lengthSq() < 1e-8) axis.copy(rig.right)
  return axis.normalize()
}

/** 累积世界空间偏移（rootTrack 用） */
function addRoot(w: PoseWriter, offset: { up?: number; right?: number; fwd?: number }): void {
  if (offset.up) w.root.addScaledVector(w.rig.up, offset.up)
  if (offset.right) w.root.addScaledVector(w.rig.right, offset.right)
  if (offset.fwd) w.root.addScaledVector(w.rig.forward, offset.fwd)
}

// ─────────────────────────── 通用姿态片段（供各动作复用） ───────────────────────────

interface TorsoPose {
  /** 前屈（正 = 朝 forward 弯） */
  pitch?: number
  /** 水平扭转 */
  yaw?: number
  /** 侧倾 */
  roll?: number
}

/** 躯干旋转：先俯仰、再侧倾、最后扭转 */
function composeTorso(rig: RigInfo, pose: TorsoPose): THREE.Quaternion | null {
  const pitch = pose.pitch ?? 0
  const roll = pose.roll ?? 0
  const yaw = pose.yaw ?? 0
  if (!pitch && !roll && !yaw) return null
  const q = new THREE.Quaternion()
  if (pitch) q.multiply(axisAngle(rig.right, pitch))
  if (roll) q.multiply(axisAngle(rig.forward, roll))
  if (yaw) q.multiply(axisAngle(rig.up, yaw))
  return q
}

function poseHips(w: PoseWriter, pose: TorsoPose): void {
  const q = composeTorso(w.rig, pose)
  if (q) w.rel(w.ctx.roleBone('hips'), q)
}

/** 躯干链（不含 hips / neck / head），语义缺失时回退到 spine/chest/upperChest 单骨 */
function torsoChain(ctx: ActionContext): string[] {
  const hips = ctx.roleBone('hips')
  const neck = ctx.roleBone('neck')
  const head = ctx.roleBone('head')
  const out: string[] = []
  for (const bone of ctx.semantics?.spineChain ?? []) {
    if (!bone || bone === hips || bone === neck || bone === head || out.includes(bone)) continue
    out.push(bone)
  }
  if (!out.length) {
    for (const role of ['spine', 'chest', 'upperChest'] as BoneRole[]) {
      const bone = ctx.roleBone(role)
      if (bone && bone !== hips && !out.includes(bone)) out.push(bone)
    }
  }
  return out
}

/** 脊柱链：把总俯仰/扭转均摊到每节脊椎（链条是嵌套的，累计刚好等于总角度） */
function poseSpine(w: PoseWriter, pose: TorsoPose): void {
  const chain = torsoChain(w.ctx)
  if (!chain.length) return
  const q = composeTorso(w.rig, pose)
  if (!q) return
  const part = scaleRotation(q, 1 / chain.length)
  for (const bone of chain) w.rel(bone, part)
}

interface NeckHeadPose {
  neckPitch?: number
  neckYaw?: number
  neckRoll?: number
  headPitch?: number
  headYaw?: number
  headRoll?: number
}

function poseNeckHead(w: PoseWriter, pose: NeckHeadPose): void {
  const neck = w.ctx.roleBone('neck')
  if (neck) {
    const q = composeTorso(w.rig, { pitch: pose.neckPitch, yaw: pose.neckYaw, roll: pose.neckRoll })
    if (q) w.rel(neck, q)
  }
  const head = w.ctx.roleBone('head')
  if (head) {
    const q = composeTorso(w.rig, { pitch: pose.headPitch, yaw: pose.headYaw, roll: pose.headRoll })
    if (q) w.rel(head, q)
  }
}

interface LegPose {
  /** 大腿前摆（正 = 向前抬） */
  swing?: number
  /** 大腿外展（正 = 远离身体） */
  abduct?: number
  /** 屈膝（正 = 小腿向后折） */
  knee?: number
  /** 脚掌俯仰（正 = 脚尖下压） */
  footPitch?: number
  /** 脚趾弯曲（正 = 向下压） */
  toe?: number
}

function poseLeg(w: PoseWriter, side: Side, pose: LegPose = {}): void {
  const rig = w.rig
  const thigh = w.ctx.roleBone(thighRole(side))
  if (thigh) {
    const q = new THREE.Quaternion()
    const swing = pose.swing ?? 0
    if (Math.abs(swing) > 1e-7) q.multiply(swingRot(rig, swing))
    const abduct = pose.abduct ?? 0
    if (Math.abs(abduct) > 1e-7) q.premultiply(raiseRot(rig, lateralSignSafe(w, thigh), abduct))
    // abs：大腿保持在世界坐标系里摆动，不随骨盆旋转（步态/落座时脚更稳）
    w.abs(thigh, q)
  }
  const knee = pose.knee ?? 0
  if (Math.abs(knee) > 1e-7) {
    const shin = w.ctx.roleBone(shinRole(side))
    if (shin) w.rel(shin, axisAngle(rig.right, knee))
  }
  const foot = w.ctx.roleBone(footRole(side))
  if (foot) {
    // 脚掌世界朝向 = rest + 俯仰（保持贴地）
    w.abs(foot, axisAngle(rig.right, pose.footPitch ?? 0))
  }
  const toeAngle = pose.toe ?? 0
  if (Math.abs(toeAngle) > 1e-7) {
    const toe = w.ctx.roleBone(toeRole(side))
    if (toe) w.rel(toe, axisAngle(rig.right, toeAngle))
  }
}

/** 上臂目标方向：lift=0 垂直向下，lift=90° 水平外展，lift>90° 举过头顶 */
function armTargetDir(rig: RigInfo, ctx: ActionContext, boneName: string, lift: number, reach: number): THREE.Vector3 {
  const out = outwardOf(rig, ctx, boneName)
  const dir = new THREE.Vector3()
    .copy(rig.up)
    .multiplyScalar(-Math.cos(lift))
    .addScaledVector(out, Math.sin(lift) + ARM_OUT_BIAS)
    .addScaledVector(rig.forward, ARM_FWD_BIAS + reach)
  if (dir.lengthSq() < 1e-8) dir.copy(rig.up).negate()
  return dir.normalize()
}

/**
 * 设定上臂世界朝向：先 aim 到目标方向（解决 T-pose / A-pose 差异），
 * 再绕 rig.right 做前后摆（walk/run 的手臂摆动）。
 */
function setArmWorld(w: PoseWriter, side: Side, lift: number, swing: number, reach = 0): string | undefined {
  const name = w.ctx.roleBone(armRole(side))
  if (!name) return undefined
  const target = armTargetDir(w.rig, w.ctx, name, lift, reach)
  const total = aimQuat(restDirOf(w.rig, name), target)
  if (Math.abs(swing) > 1e-7) total.premultiply(swingRot(w.rig, swing))
  w.abs(name, total)
  return name
}

/** 屈肘：铰链轴由骨骼 rest 方向推导，随上臂姿态一起被带动 */
function bendElbow(w: PoseWriter, side: Side, amount: number): void {
  if (Math.abs(amount) < 1e-6) return
  const name = w.ctx.roleBone(forearmRole(side))
  if (!name) return
  w.rel(name, axisAngle(elbowHingeAxis(w.rig, name), -amount))
}

/** 锁骨抬/沉（正 = 耸肩抬起） */
function poseClavicle(w: PoseWriter, side: Side, raise: number): void {
  if (Math.abs(raise) < 1e-6) return
  const name = w.ctx.roleBone(clavicleRole(side))
  if (!name) return
  w.rel(name, raiseRot(w.rig, lateralSignSafe(w, name), raise))
}

/** 手指链逐节 curl（curl: 0=伸直，1≈握拳） */
function poseOneChain(w: PoseWriter, chain: string[], curl: number): void {
  if (!chain?.length || Math.abs(curl) < 1e-5) return
  chain.forEach((bone, seg) => {
    const factor = FINGER_SEG_CURL[Math.min(seg, FINGER_SEG_CURL.length - 1)]
    const amount = curl * factor
    if (Math.abs(amount) < 1e-5) return
    w.rel(bone, axisAngle(curlAxisOf(w.rig, bone), amount))
  })
}

function poseFingerChains(w: PoseWriter, chains: string[][], curl: number): void {
  if (!chains?.length) return
  for (const chain of chains) poseOneChain(w, chain, curl)
}

interface ChainSwayOptions {
  /** 每个循环的振荡次数（整数保证循环无缝） */
  cycles?: number
  /** 水平摆幅（绕 rig.up） */
  ampYaw: number
  /** 俯仰摆幅（绕 rig.right） */
  ampPitch?: number
  /** 逐骨相位延迟，做出“链条跟随”的波浪感 */
  delay?: number
  phase?: number
  /** 额外幅度缩放（0 = 不动，用于非循环动作的起停） */
  scale?: number
}

/** 耳朵 / 头发 / 尾巴等装饰链的正弦延迟摆动 */
function poseChainSway(w: PoseWriter, chain: string[], opts: ChainSwayOptions): void {
  if (!chain?.length) return
  const scale = w.motion.amp * (opts.scale ?? 1)
  if (Math.abs(scale) < 1e-6) return
  const cycles = opts.cycles ?? 1
  const delay = opts.delay ?? 0.55
  chain.forEach((bone, i) => {
    const phase = TAU * cycles * w.motion.u - i * delay + (opts.phase ?? 0)
    const yaw = opts.ampYaw * scale * Math.sin(phase)
    const pitch = (opts.ampPitch ?? 0) * scale * Math.sin(phase + 0.9)
    if (Math.abs(yaw) < 1e-7 && Math.abs(pitch) < 1e-7) return
    const q = axisAngle(w.rig.up, yaw)
    if (Math.abs(pitch) > 1e-7) q.premultiply(axisAngle(w.rig.right, pitch))
    w.rel(bone, q)
  })
}

interface BasePoseOptions {
  armLiftL?: number
  armLiftR?: number
  /** 手臂前后摆（正 = 向前） */
  armSwingL?: number
  armSwingR?: number
  /** 向前伸的额外量（拾取用） */
  reachL?: number
  reachR?: number
  elbowL?: number
  elbowR?: number
  clavRaiseL?: number
  clavRaiseR?: number
  /** null = 不写手指（动作自己要控制手指时用） */
  fingerCurlL?: number | null
  fingerCurlR?: number | null
}

/** 中立站姿：手臂从 T/A-pose 放回体侧、肘微屈、腕放松、手指放松 */
function applyBasePose(w: PoseWriter, opts: BasePoseOptions = {}): void {
  setArmWorld(w, 'L', opts.armLiftL ?? 0, opts.armSwingL ?? 0, opts.reachL ?? 0)
  setArmWorld(w, 'R', opts.armLiftR ?? 0, opts.armSwingR ?? 0, opts.reachR ?? 0)
  bendElbow(w, 'L', opts.elbowL ?? ELBOW_RELAX)
  bendElbow(w, 'R', opts.elbowR ?? ELBOW_RELAX)
  poseClavicle(w, 'L', opts.clavRaiseL ?? -CLAV_DROP)
  poseClavicle(w, 'R', opts.clavRaiseR ?? -CLAV_DROP)
  // 手掌：放松屈腕（同时保证手骨在所有动作里都有一条轨道可被后续手工覆盖）
  for (const side of ['L', 'R'] as Side[]) {
    const hand = w.ctx.roleBone(handRole(side))
    if (hand) w.rel(hand, axisAngle(curlAxisOf(w.rig, hand), WRIST_RELAX))
  }
  const curlL = opts.fingerCurlL === undefined ? FINGER_RELAX : opts.fingerCurlL
  const curlR = opts.fingerCurlR === undefined ? FINGER_RELAX : opts.fingerCurlR
  if (curlL !== null) poseFingerChains(w, w.ctx.semantics?.fingerChains?.L ?? [], curlL)
  if (curlR !== null) poseFingerChains(w, w.ctx.semantics?.fingerChains?.R ?? [], curlR)
}

/** 骨盆扭转方向：让“向前迈的那条腿”同侧髋部向前 */
function hipsYawSign(w: PoseWriter): number {
  const thigh = w.ctx.roleBone(thighRole('R'))
  if (!thigh) return 1
  return -lateralSignSafe(w, thigh)
}

/** 走路/奔跑时耳朵、后发、尾巴的随动 */
function poseLocomotionFluff(w: PoseWriter, cycles: number, scale: number, earAmp: number, hairAmp: number, tailAmp: number): void {
  const sem = w.ctx.semantics
  poseChainSway(w, sem?.earChains?.L ?? [], {
    cycles, ampYaw: earAmp, ampPitch: earAmp * 0.8, delay: 0.6, phase: 0.2, scale,
  })
  poseChainSway(w, sem?.earChains?.R ?? [], {
    cycles, ampYaw: earAmp, ampPitch: earAmp * 0.8, delay: 0.6, phase: 0.2 + Math.PI, scale,
  })
  for (const chain of sem?.hairChains ?? []) {
    poseChainSway(w, chain, { cycles, ampYaw: hairAmp * 0.4, ampPitch: hairAmp, delay: 0.5, phase: 0.6, scale })
  }
  poseChainSway(w, sem?.tailChain ?? [], {
    cycles, ampYaw: tailAmp, ampPitch: tailAmp * 0.6, delay: 0.45, phase: 0.4, scale,
  })
}

// ─────────────────────────── 扩展动作通用工具 ───────────────────────────

/** 单位方向插值（线性插值后归一化；退化时返回 a） */
function lerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const v = new THREE.Vector3().lerpVectors(a, b, clamp01(t))
  return v.lengthSq() < 1e-10 ? a.clone() : v.normalize()
}

/** 骨骼在“中立站姿”下的世界方向（bent = 前臂/手，含肘部微屈带来的前倾） */
function armNeutralDir(w: PoseWriter, boneName: string, bent: boolean): THREE.Vector3 {
  const dir = armTargetDir(w.rig, w.ctx, boneName, 0, 0)
  if (bent) dir.applyQuaternion(swingRot(w.rig, ELBOW_RELAX))
  return dir.normalize()
}

/** 用世界轴分量构造方向；out 沿该骨骼的外侧方向（负值 = 朝身体中线） */
function dirOf(w: PoseWriter, boneName: string, fwd: number, up: number, out: number): THREE.Vector3 {
  const dir = new THREE.Vector3()
    .addScaledVector(w.rig.forward, fwd)
    .addScaledVector(w.rig.up, up)
    .addScaledVector(outwardOf(w.rig, w.ctx, boneName), out)
  if (dir.lengthSq() < 1e-10) return armNeutralDir(w, boneName, false)
  return dir.normalize()
}

/** 上臂世界朝向：目标任务方向与中立下垂方向的混合（env=0 时保持中立站姿） */
function setUpperArmTarget(w: PoseWriter, side: Side, dir: THREE.Vector3, env: number): void {
  const name = w.ctx.roleBone(armRole(side))
  if (!name) return
  const target = lerpDir(armNeutralDir(w, name, false), dir, env)
  w.abs(name, aimQuat(restDirOf(w.rig, name), target))
}

/** 前臂世界朝向：与 setUpperArmTarget 配套，env=0 时保持中立站姿的微屈方向 */
function setForearmTarget(w: PoseWriter, side: Side, dir: THREE.Vector3, env: number): void {
  const name = w.ctx.roleBone(forearmRole(side))
  if (!name) return
  const target = lerpDir(armNeutralDir(w, name, true), dir, env)
  w.abs(name, aimQuat(restDirOf(w.rig, name), target))
}

/** 手掌世界朝向（与手指指向一致） */
function setHandTarget(w: PoseWriter, side: Side, dir: THREE.Vector3, env: number): void {
  const name = w.ctx.roleBone(handRole(side))
  if (!name) return
  const target = lerpDir(armNeutralDir(w, name, true), dir, env)
  w.abs(name, aimQuat(restDirOf(w.rig, name), target))
}

/**
 * 一侧手指逐节 curl。
 * extend：0 = 全部按 curl 弯曲；1 = 第一条链（视为食指）伸直、其余按 curl 收起。
 */
function poseFingersSide(w: PoseWriter, side: Side, curl: number, extend = 0): void {
  const chains = w.ctx.semantics?.fingerChains?.[side] ?? []
  if (!chains.length) return
  const e = clamp01(extend)
  chains.forEach((chain, index) => {
    const isIndex = index === 0 && chains.length >= 3
    const amount = isIndex ? curl * (1 - e) + FINGER_POINT_CURL * e : curl
    poseOneChain(w, chain, amount)
  })
}

/** 腿的 rest 几何（长度 + 方向），用于“脚掌踩地”的精确补偿 */
interface LegGeometry {
  thighLength: number
  shinLength: number
  /** rest 世界方向上 髋→膝 单位向量 */
  thighDir: THREE.Vector3
  /** rest 世界方向上 膝→踝 单位向量 */
  shinDir: THREE.Vector3
  /** rest 世界方向上 髋→踝 向量 */
  ankleOffset: THREE.Vector3
}

function legGeometry(w: PoseWriter, side: Side): LegGeometry | null {
  const rig = w.rig
  const thigh = w.ctx.roleBone(thighRole(side))
  const shin = w.ctx.roleBone(shinRole(side))
  const foot = w.ctx.roleBone(footRole(side))
  if (!thigh || !shin || !foot) return null
  const ti = rig.boneIndexByName.get(thigh)
  const si = rig.boneIndexByName.get(shin)
  const fi = rig.boneIndexByName.get(foot)
  if (ti === undefined || si === undefined || fi === undefined) return null
  const thighHead = rig.boneInfo[ti].head
  const shinHead = rig.boneInfo[si].head
  const footHead = rig.boneInfo[fi].head
  const thighLength = thighHead.distanceTo(shinHead)
  const shinLength = shinHead.distanceTo(footHead)
  if (thighLength < 1e-6 || shinLength < 1e-6) return null
  return {
    thighLength,
    shinLength,
    thighDir: new THREE.Vector3().subVectors(shinHead, thighHead).normalize(),
    shinDir: new THREE.Vector3().subVectors(footHead, shinHead).normalize(),
    ankleOffset: new THREE.Vector3().subVectors(footHead, thighHead),
  }
}

/**
 * 蹲姿求解：给定骨盆下沉量，解出“脚掌原地踩地”的大腿前摆 / 屈膝角，
 * 并返回为保持双脚不滑、不穿地所需的 root 世界偏移。
 *
 * 做法：固定“小腿相对竖直向前的倾角”（shinTilt，越蹲越大），
 * 二分搜索大腿前摆角，使 髋→踝 的竖直跨距刚好等于 rest 跨距 - drop；
 * 再用精确的 FK 差值把脚踝水平 / 竖直位置补回原处。
 */
function plantedSquatPose(
  w: PoseWriter,
  drop: number,
  shinTilt: number,
): { thigh: number; knee: number; rootOffset: THREE.Vector3 } {
  const geo = legGeometry(w, 'R') ?? legGeometry(w, 'L')
  if (!geo) {
    return { thigh: deg(60), knee: deg(90), rootOffset: new THREE.Vector3(0, -drop, 0) }
  }
  const evaluate = (thighAngle: number): { thigh: number; knee: number; ankle: THREE.Vector3 } => {
    const kneeAngle = thighAngle + shinTilt
    const qThigh = swingRot(w.rig, thighAngle)
    const qKnee = axisAngle(w.rig.right, kneeAngle)
    const ankle = new THREE.Vector3()
      .copy(geo.thighDir)
      .applyQuaternion(qThigh)
      .multiplyScalar(geo.thighLength)
      .add(
        new THREE.Vector3()
          .copy(geo.shinDir)
          .applyQuaternion(qThigh)
          .applyQuaternion(qKnee)
          .multiplyScalar(geo.shinLength),
      )
    return { thigh: thighAngle, knee: kneeAngle, ankle }
  }
  // 二分：大腿越往前，腿的竖直跨距越小（骨盆下沉越深）
  const targetUp = -drop
  let lo = 0
  let hi = Math.PI * 0.62
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const up = geo.ankleOffset.y - evaluate(mid).ankle.y
    if (up > targetUp) lo = mid
    else hi = mid
  }
  const solution = evaluate((lo + hi) / 2)
  const rootOffset = new THREE.Vector3().subVectors(geo.ankleOffset, solution.ankle)
  return { thigh: solution.thigh, knee: solution.knee, rootOffset }
}

/**
 * 膝盖轻弹时保持双脚原地踩地的 root 补偿：
 * 小腿绕膝转动会让脚踝向后、向上移动，root 反向补偿即可。
 */
function kneeBounceRoot(w: PoseWriter, knee: number): { up: number; fwd: number } {
  const geo = legGeometry(w, 'R') ?? legGeometry(w, 'L')
  if (!geo) return { up: 0, fwd: 0 }
  return {
    up: -geo.shinLength * (1 - Math.cos(knee)),
    fwd: geo.shinLength * Math.sin(knee),
  }
}

/** 骨盆前倾会把大腿根（髋关节）带离 rest 位置，返回该位移 */
function hipJointShift(w: PoseWriter, pitch: number): THREE.Vector3 {
  const shift = new THREE.Vector3()
  if (Math.abs(pitch) < 1e-7) return shift
  const hips = w.ctx.roleBone('hips')
  if (!hips) return shift
  const hi = w.rig.boneIndexByName.get(hips)
  if (hi === undefined) return shift
  const thigh = w.ctx.roleBone(thighRole('R')) ?? w.ctx.roleBone(thighRole('L'))
  if (!thigh) return shift
  const ti = w.rig.boneIndexByName.get(thigh)
  if (ti === undefined) return shift
  const offset = new THREE.Vector3().subVectors(w.rig.boneInfo[ti].head, w.rig.boneInfo[hi].head)
  const rotated = offset.clone().applyQuaternion(axisAngle(w.rig.right, pitch))
  return rotated.sub(offset)
}

/** 让同侧肩膀前送所需的躯干扭转符号（出拳/指向用） */
function shoulderForwardYawSign(w: PoseWriter, side: Side): number {
  const name = w.ctx.roleBone(armRole(side))
  return name ? -lateralSignSafe(w, name) : 1
}

// ─────────────────────────── 具体动作 ───────────────────────────

type PoseFn = (w: PoseWriter) => void

/** 待机：呼吸（胸腔微俯仰）+ 重心微摆 + 头部微动 + 装饰链延迟摆动 */
function poseIdle(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const breath = osc(1, m.u)
  const sway = osc(1, m.u, -0.25)

  // 骨盆：呼吸带来的极轻微前后 + 重心左右摆
  poseHips(w, {
    pitch: deg(0.6) * breath * a,
    roll: IDLE_SWAY_ROLL * sway * a,
    yaw: IDLE_SWAY_YAW * sway * a,
  })
  // 脊柱：吸气时胸腔微微后仰抬起，呼气回落
  poseSpine(w, { pitch: -IDLE_BREATH_PITCH * breath * a, roll: deg(0.6) * sway * a })
  // 颈 / 头：呼吸带动 + 缓慢环顾
  poseNeckHead(w, {
    neckPitch: deg(0.5) * breath * a,
    neckYaw: deg(0.5) * sway * a,
    headPitch: -deg(0.8) * breath * a,
    headYaw: IDLE_HEAD_YAW * osc(1, m.u, 0.4) * a,
    headRoll: IDLE_HEAD_ROLL * sway * a,
  })
  // 双臂垂在体侧，随呼吸轻摆
  applyBasePose(w, {
    armSwingL: IDLE_ARM_SWING * osc(1, m.u, 0.15) * a,
    armSwingR: IDLE_ARM_SWING * osc(1, m.u, 0.05) * a,
    elbowL: ELBOW_RELAX + deg(1.5) * breath * a,
    elbowR: ELBOW_RELAX + deg(1.5) * breath * a,
  })
  // 耳朵 / 后发 / 尾巴
  poseLocomotionFluff(w, 1, 1, deg(4.5), deg(3), deg(6))
  // root：呼吸整体起伏 + 重心侧移
  addRoot(w, { up: IDLE_BREATH_ROOT * h * breath * a, right: IDLE_SWAY_ROOT * h * sway * a })
}

/** 深呼吸：循环动作，胸腔大幅扩张 + 耸肩 + 抬头 */
function poseBreath(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const breath = osc(1, m.u)
  const inhale = Math.max(0, breath)
  poseSpine(w, { pitch: -BREATH_CHEST * breath * a })
  poseNeckHead(w, {
    neckPitch: deg(1.0) * breath * a,
    headPitch: -deg(1.2) * breath * a,
  })
  applyBasePose(w, {
    clavRaiseL: -CLAV_DROP + BREATH_CLAV * inhale * a,
    clavRaiseR: -CLAV_DROP + BREATH_CLAV * inhale * a,
    armSwingL: deg(1.2) * breath * a,
    armSwingR: deg(1.2) * breath * a,
  })
  poseLocomotionFluff(w, 1, 1, deg(3), deg(2), deg(4))
  addRoot(w, { up: BREATH_ROOT * h * breath * a })
}

/** 行走：原地步循环（大腿 ±24°、屈膝、脚踝补偿、手臂反相摆、骨盆起伏 + 反向扭转） */
function poseWalk(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const rig = w.rig
  const h = Math.max(rig.height, 0.001)
  const ph = TAU * u
  const cosP = Math.cos(ph)
  const sinP = Math.sin(ph)

  // 骨盆扭转（迈出腿同侧髋向前）—— 必须先写骨盆，大腿 abs 才能保持世界朝向
  const yawSign = hipsYawSign(w)
  const hipsYaw = yawSign * WALK_HIP_YAW * cosP * a
  poseHips(w, { yaw: hipsYaw, roll: WALK_ROLL * sinP * a })

  // 大腿：右腿 u=0 在最前（脚跟着地），左腿反相
  const thighR = WALK_THIGH * cosP * a
  const thighL = -WALK_THIGH * cosP * a
  // 屈膝：摆动腿在 u≈0.65 屈膝最大，支撑期接近伸直
  const kneeR = (WALK_KNEE_MIN + WALK_KNEE_AMP * (0.5 + 0.5 * Math.cos(ph - TAU * WALK_KNEE_PEAK))) * a
  const kneeL = (WALK_KNEE_MIN + WALK_KNEE_AMP * (0.5 + 0.5 * Math.cos(ph + Math.PI - TAU * WALK_KNEE_PEAK))) * a
  // 脚掌：脚跟着地时脚尖微抬、蹬地时脚尖下压；脚趾反向补偿避免穿地
  const footR = curve(WALK_FOOT, u) * a
  const footL = curve(WALK_FOOT, (u + 0.5) % 1) * a
  poseLeg(w, 'R', { swing: thighR, knee: kneeR, footPitch: footR, toe: -0.45 * Math.max(0, footR) })
  poseLeg(w, 'L', { swing: thighL, knee: kneeL, footPitch: footL, toe: -0.45 * Math.max(0, footL) })

  // 骨盆起伏（2 倍步频，双脚支撑时最低）+ 重心左右移动
  addRoot(w, {
    up: -WALK_BOB * h * (0.5 + 0.5 * Math.cos(2 * ph)) * a,
    right: WALK_SWAY * h * sinP * a,
  })

  // 躯干反向扭转；头保持朝前
  poseSpine(w, { pitch: WALK_LEAN, yaw: -0.9 * hipsYaw, roll: -0.6 * WALK_ROLL * sinP * a })
  poseNeckHead(w, {
    neckYaw: 0.55 * hipsYaw,
    headYaw: 0.35 * hipsYaw,
    headPitch: -WALK_LEAN * 0.8,
  })

  // 手臂与同侧腿反相摆动：右腿前 → 右臂后
  applyBasePose(w, {
    armLiftL: deg(2),
    armLiftR: deg(2),
    armSwingR: -WALK_ARM * cosP * a,
    armSwingL: WALK_ARM * cosP * a,
    elbowR: ELBOW_RELAX + WALK_ELBOW * a * (0.5 - 0.5 * cosP),
    elbowL: ELBOW_RELAX + WALK_ELBOW * a * (0.5 + 0.5 * cosP),
  })

  poseLocomotionFluff(w, 2, 1, WALK_EAR, WALK_HAIR, WALK_TAIL)
}

/** 奔跑：更大摆幅 + 身体前倾 + 双脚腾空起伏 */
function poseRun(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const rig = w.rig
  const h = Math.max(rig.height, 0.001)
  const ph = TAU * u
  const cosP = Math.cos(ph)
  const sinP = Math.sin(ph)

  // 前倾：骨盆先写（大腿 abs 依赖它）；脊柱链随后
  const yawSign = hipsYawSign(w)
  const hipsYaw = yawSign * RUN_HIP_YAW * cosP * a
  poseHips(w, { pitch: RUN_LEAN_HIP * a, yaw: hipsYaw, roll: RUN_ROLL * sinP * a })

  const thighR = RUN_THIGH * cosP * a
  const thighL = -RUN_THIGH * cosP * a
  const kneeR = (RUN_KNEE_MIN + RUN_KNEE_AMP * (0.5 + 0.5 * Math.cos(ph - TAU * RUN_KNEE_PEAK))) * a
  const kneeL = (RUN_KNEE_MIN + RUN_KNEE_AMP * (0.5 + 0.5 * Math.cos(ph + Math.PI - TAU * RUN_KNEE_PEAK))) * a
  const footR = curve(RUN_FOOT, u) * a
  const footL = curve(RUN_FOOT, (u + 0.5) % 1) * a
  poseLeg(w, 'R', { swing: thighR, knee: kneeR, footPitch: footR, toe: -0.5 * Math.max(0, footR) })
  poseLeg(w, 'L', { swing: thighL, knee: kneeL, footPitch: footL, toe: -0.5 * Math.max(0, footL) })

  // 腾空起伏：每个循环两个波峰（双脚离地阶段最高）
  addRoot(w, {
    up: RUN_BOB * h * (0.5 - 0.5 * Math.cos(2 * ph)) * a,
    right: RUN_SWAY * h * sinP * a,
  })

  // 脊柱前倾；头部反向抬起保持看向前方
  poseSpine(w, { pitch: RUN_LEAN_SPINE * a, yaw: -0.9 * hipsYaw, roll: -0.6 * RUN_ROLL * sinP * a })
  poseNeckHead(w, {
    neckPitch: -RUN_LEAN_SPINE * 0.3 * a,
    headPitch: -RUN_LEAN_HEAD * a,
    headYaw: 0.3 * hipsYaw,
  })

  // 手臂：屈肘约 80°，与腿反相大幅摆动
  applyBasePose(w, {
    armLiftL: deg(7),
    armLiftR: deg(7),
    armSwingR: -RUN_ARM * cosP * a,
    armSwingL: RUN_ARM * cosP * a,
    elbowR: RUN_ELBOW + deg(8) * a * (0.5 - 0.5 * cosP),
    elbowL: RUN_ELBOW + deg(8) * a * (0.5 + 0.5 * cosP),
  })

  poseLocomotionFluff(w, 2, 1, deg(7), deg(10), deg(10))
}

/** 挥手：右臂抬到侧上方、小臂竖起、小臂/手掌左右摆动，2.5s 一次 */
function poseWave(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const rig = w.rig
  const ctx = w.ctx

  // 起停包络：0 → 1 → 0，保证首尾回到中立站姿
  const env = window4(u, 0.06, 0.26, 0.8, 0.96) * a
  const blend = clamp01(env)
  const wave = Math.sin(TAU * WAVE_OSC_CYCLES * u) * env

  // 先写躯干（上臂/小臂/手都是 abs 写入，必须放在祖先之后）
  const upperArmR = ctx.roleBone(armRole('R'))
  const sideSign = upperArmR ? lateralSignSafe(w, upperArmR) : 1
  poseHips(w, { yaw: deg(2) * sideSign * blend })
  poseSpine(w, { yaw: deg(4) * sideSign * blend, pitch: -deg(1.5) * blend })
  poseNeckHead(w, { headYaw: WAVE_HEAD_YAW * sideSign * blend, headPitch: -deg(4) * blend })

  // 右臂：抬到侧上方（lift > 90° 表示高过肩线），左臂垂放并带一点随动
  applyBasePose(w, {
    armLiftR: WAVE_LIFT * blend,
    armSwingR: WAVE_SWING * blend,
    armLiftL: 0,
    armSwingL: deg(3) * Math.sin(TAU * 1.5 * u) * blend,
    elbowR: ELBOW_RELAX,
    elbowL: ELBOW_RELAX,
  })
  // 小臂：从“自然下垂”插值到“竖直向上”，并把摆动叠加在竖直方向上
  const forearmR = ctx.roleBone(forearmRole('R'))
  if (forearmR) {
    // downVec 与上臂 lift=0 时的目标一致，保证 env→0 时小臂 delta 趋近单位旋转
    const downVec = armTargetDir(rig, ctx, forearmR, 0, 0)
    const upVec = new THREE.Vector3().copy(rig.up).addScaledVector(outwardOf(rig, ctx, forearmR), 0.15)
    upVec.normalize()
    const target = new THREE.Vector3().lerpVectors(downVec, upVec, blend)
    // 挥手是左右摇，所以摆幅叠加在侧向（outward）上，而不是前后方向
    target.addScaledVector(outwardOf(rig, ctx, forearmR), WAVE_FOREARM_OSC * wave).normalize()
    w.abs(forearmR, aimQuat(restDirOf(rig, forearmR), target))
  }
  // 手掌：跟随小臂方向，再多摆一点，读起来像“摇手”
  const handR = ctx.roleBone(handRole('R'))
  if (handR) {
    const downVec = armTargetDir(rig, ctx, handR, 0, 0)
    const upVec = new THREE.Vector3().copy(rig.up).addScaledVector(outwardOf(rig, ctx, handR), 0.1)
    upVec.normalize()
    const target = new THREE.Vector3().lerpVectors(downVec, upVec, blend)
    target.addScaledVector(outwardOf(rig, ctx, handR), WAVE_HAND_OSC * wave).normalize()
    w.abs(handR, aimQuat(restDirOf(rig, handR), target))
  }
  // 装饰链轻摆（幅度乘包络，首尾归零）
  poseLocomotionFluff(w, 2, blend, deg(5), deg(4), deg(5))
}

/** 握拳 / 手势：张开 → 握拳 → 指向（食指伸出）→ 放松 */
function poseGrip(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const fist = curve(GRIP_FIST, u)
  const point = curve(GRIP_POINT, u)

  // 头稍微低一点看自己的手（先写躯干，再写 abs 的手臂）
  poseNeckHead(w, { headPitch: deg(4) * fist })
  // 手臂微微前抬，让手势在画面里看清楚
  applyBasePose(w, {
    armLiftL: GRIP_ARM_LIFT * fist * a + deg(2) * a,
    armLiftR: GRIP_ARM_LIFT * fist * a + deg(2) * a,
    armSwingL: GRIP_ARM_SWING * fist * a,
    armSwingR: GRIP_ARM_SWING * fist * a,
    elbowL: ELBOW_RELAX + GRIP_ELBOW * fist * a + deg(5) * a,
    elbowR: ELBOW_RELAX + GRIP_ELBOW * fist * a + deg(5) * a,
    fingerCurlL: null,
    fingerCurlR: null,
  })

  for (const side of ['L', 'R'] as Side[]) {
    const chains = w.ctx.semantics?.fingerChains?.[side] ?? []
    if (chains.length) {
      chains.forEach((chain, index) => {
        let curl = fist
        // 第一条链当作食指：做“指向”手势时只有它伸直
        if (index === 0 && chains.length >= 3) curl = fist * (1 - point) + FINGER_POINT_CURL * point
        poseOneChain(w, chain, curl)
      })
    }
    // 腕部随握力微微弯曲（无手指骨的骨架也能看到 grip 动作）
    const hand = w.ctx.roleBone(handRole(side))
    if (hand) {
      const wristAngle = WRIST_CURL * fist * (0.6 + 0.4 * a)
      w.rel(hand, axisAngle(curlAxisOf(w.rig, hand), wristAngle))
    }
  }

  // 装饰链略动（幅度很小）
  poseLocomotionFluff(w, 2, fist, deg(2), deg(2), deg(2))
}

/** 坐下 / 起立：骨盆下沉、屈膝、手臂前搭，6s 一次 */
function poseSit(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  // 坐下 → 坐姿待机 → 起立回位
  const sit = window4(u, 0.05, 0.28, 0.7, 0.95)
  const s = sit * a
  const seatedBreath = osc(2, u) * s

  // 骨盆下沉（世界 -Y，约 0.18 * height），并在坐姿时稍微后倾
  addRoot(w, { up: -SIT_DROP * h * s })
  poseHips(w, { pitch: -SIT_HIP_TILT * s })
  // 脊柱保持直立（重心略前压）
  poseSpine(w, { pitch: SIT_SPINE * s + deg(0.7) * seatedBreath })
  // 大腿前抬 ~72°、屈膝 ~72°，脚掌保持水平（脚落在身体下方）
  poseLeg(w, 'L', { swing: SIT_THIGH * s, knee: SIT_KNEE * s, footPitch: 0 })
  poseLeg(w, 'R', { swing: SIT_THIGH * s, knee: SIT_KNEE * s, footPitch: 0 })
  // 坐姿时轻轻环顾 + 头随呼吸
  poseNeckHead(w, {
    neckPitch: deg(2) * s,
    headYaw: deg(7) * osc(2, u, 0.1) * s,
    headPitch: -deg(1) * seatedBreath,
    headRoll: deg(1.5) * osc(2, u, 0.35) * s,
  })
  // 手臂前搭在大腿上（abs 写在上臂，必须放在躯干/颈部之后）
  applyBasePose(w, {
    armLiftL: SIT_ARM_LIFT * s,
    armLiftR: SIT_ARM_LIFT * s,
    armSwingL: SIT_ARM_SWING * s,
    armSwingR: SIT_ARM_SWING * s,
    elbowL: ELBOW_RELAX + SIT_ELBOW * s,
    elbowR: ELBOW_RELAX + SIT_ELBOW * s,
    clavRaiseL: -CLAV_DROP,
    clavRaiseR: -CLAV_DROP,
  })
  // 装饰链轻微摆动（随坐姿包络起停）
  poseLocomotionFluff(w, 2, s, deg(4), deg(3), deg(5))
}

/** 拾取：弯腰 → 伸臂下探 → 抓取 → 抬到胸前 → 还原，5s 一次 */
function posePickup(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const bend = curve(PICKUP_BEND, u)
  const grab = curve(PICKUP_GRAB, u)
  const carry = curve(PICKUP_CARRY, u)

  // 躯干前屈：骨盆前倾 + 脊柱链前屈（总 ~48°）
  poseHips(w, { pitch: PICKUP_HIP_PITCH * bend * a })
  poseSpine(w, { pitch: PICKUP_SPINE_PITCH * bend * a })
  poseNeckHead(w, {
    neckPitch: PICKUP_NECK_PITCH * bend * a,
    headPitch: PICKUP_HEAD_PITCH * (bend * 0.8 - carry * 0.6) * a,
  })
  // 屈膝下蹲配合弯腰
  poseLeg(w, 'L', { swing: PICKUP_THIGH * bend * a, knee: PICKUP_KNEE * bend * a, footPitch: 0 })
  poseLeg(w, 'R', { swing: PICKUP_THIGH * bend * a, knee: PICKUP_KNEE * bend * a, footPitch: 0 })
  addRoot(w, { up: -PICKUP_CROUCH * h * bend * a })

  // 手臂：下探（前摆）→ 抬到胸前（屈肘）
  const swing = (PICKUP_REACH_SWING * bend * (1 - carry) + PICKUP_CARRY_SWING * carry) * a
  const lift = (deg(4) * bend + deg(10) * carry) * a
  applyBasePose(w, {
    armLiftL: lift,
    armLiftR: lift,
    armSwingL: swing,
    armSwingR: swing,
    elbowL: ELBOW_RELAX + (deg(6) * bend + PICKUP_CARRY_ELBOW * carry) * a,
    elbowR: ELBOW_RELAX + (deg(6) * bend + PICKUP_CARRY_ELBOW * carry) * a,
    fingerCurlL: null,
    fingerCurlR: null,
  })
  // 抓取：手指从放松到握紧，再保持一会儿
  const curl = FINGER_RELAX + grab * 0.85
  poseFingerChains(w, w.ctx.semantics?.fingerChains?.L ?? [], curl)
  poseFingerChains(w, w.ctx.semantics?.fingerChains?.R ?? [], curl)
  // 装饰链随弯腰/起身轻微晃动
  poseLocomotionFluff(w, 2, bend, deg(4), deg(5), deg(5))
}

/** 跳跃：预蹲 → 起跳（root 上移）→ 空中收腿 → 落地缓冲，2s 一次 */
function poseJump(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const crouch = curve(JUMP_CROUCH, u)
  const tuck = curve(JUMP_TUCK, u)
  const arm = curve(JUMP_ARM, u)
  const flight = clamp01(tuck + Math.max(0, arm))

  // root：预蹲下沉 → 起跳上移 → 落地再缓冲
  addRoot(w, { up: curve(JUMP_ROOT, u) * h * a })

  // 躯干：预蹲前倾、空中略微展开（骨盆必须先写，大腿 abs 依赖它）
  poseHips(w, { pitch: JUMP_TORSO_PITCH * crouch * a })

  // 腿：预蹲屈膝 → 空中收腿 → 落地缓冲
  const knee = (JUMP_CROUCH_KNEE * crouch + JUMP_TUCK_KNEE * tuck) * a
  const thigh = (JUMP_CROUCH_THIGH * crouch + JUMP_TUCK_THIGH * tuck) * a
  const footPitch = (deg(6) * crouch - deg(12) * tuck) * a
  poseLeg(w, 'L', { swing: thigh, knee, footPitch })
  poseLeg(w, 'R', { swing: thigh, knee, footPitch })

  poseSpine(w, { pitch: JUMP_TORSO_PITCH * 0.7 * crouch * a - deg(4) * flight * a })
  poseNeckHead(w, {
    neckPitch: -deg(4) * flight * a,
    headPitch: -deg(7) * flight * a + deg(4) * crouch * a,
  })

  // 手臂：预蹲向后摆，起跳向上摆，落地向下缓冲
  const armLift = Math.max(0, arm) * JUMP_ARM_LIFT * a
  const armSwing = arm * JUMP_ARM_SWING * a
  applyBasePose(w, {
    armLiftL: armLift,
    armLiftR: armLift,
    armSwingL: armSwing,
    armSwingR: armSwing,
    elbowL: ELBOW_RELAX + deg(18) * Math.max(0, arm) * a,
    elbowR: ELBOW_RELAX + deg(18) * Math.max(0, arm) * a,
    fingerCurlL: null,
    fingerCurlR: null,
  })
  // 空中张开手指，落地自然放松
  const openFingers = clamp01(flight)
  applyFingerCurl(w, FINGER_RELAX * (1 - openFingers) + 0.03 * openFingers)
  // 装饰链随弹跳摆动（幅度乘起跳/落地量）
  poseLocomotionFluff(w, 2, clamp01(crouch + tuck), deg(6), deg(6), deg(6))
}

/** 手指统一设定（两侧） */
function applyFingerCurl(w: PoseWriter, curl: number): void {
  poseFingerChains(w, w.ctx.semantics?.fingerChains?.L ?? [], curl)
  poseFingerChains(w, w.ctx.semantics?.fingerChains?.R ?? [], curl)
}

/** 欢呼：双臂上举 + 两次小跳，2.5s 一次 */
function poseCheer(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const env = window4(u, 0.04, 0.18, 0.78, 0.94) * a
  const e = clamp01(env)
  // 两次小跳（sin 的正半周），与抬臂包络同步
  const hop = Math.max(0, Math.sin(TAU * 2 * u)) * e

  addRoot(w, { up: CHEER_HOP * h * hop })
  // 双腿微屈配合弹跳
  const knee = CHEER_KNEE * e + deg(5) * hop
  poseLeg(w, 'L', { knee, footPitch: 0 })
  poseLeg(w, 'R', { knee, footPitch: 0 })
  // 躯干：双臂上举时略微后仰
  poseSpine(w, { pitch: -CHEER_ARCH * e })
  poseNeckHead(w, { headPitch: -CHEER_HEAD * e, neckPitch: -deg(2) * e })
  // 手臂上举 + 小幅摆动
  const pump = Math.sin(TAU * 2 * u) * e
  applyBasePose(w, {
    armLiftL: CHEER_LIFT * e + deg(6) * pump,
    armLiftR: CHEER_LIFT * e + deg(6) * pump,
    armSwingL: deg(8) * e,
    armSwingR: deg(8) * e,
    elbowL: ELBOW_RELAX + deg(10) * e,
    elbowR: ELBOW_RELAX + deg(10) * e,
    fingerCurlL: FINGER_RELAX * (1 - e) + 0.02 * e,
    fingerCurlR: FINGER_RELAX * (1 - e) + 0.02 * e,
  })
  poseLocomotionFluff(w, 2, e, deg(5), deg(4), deg(5))
}

/** 低落：含胸低头、肩膀下沉，循环动作 */
function poseSad(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const breath = osc(1, u)
  const sway = osc(2, u, 0.3)

  // 肩膀下沉（锁骨下压）
  poseClavicle(w, 'L', -SAD_SHOULDER * a)
  poseClavicle(w, 'R', -SAD_SHOULDER * a)
  // 含胸：骨盆微前倾 + 脊柱链前屈
  poseHips(w, { pitch: SAD_HIP_PITCH * a, roll: deg(1.0) * sway * a })
  poseSpine(w, { pitch: SAD_SPINE_PITCH * a + SAD_SPINE_WAVE * breath * a, roll: deg(0.8) * sway * a })
  // 低头
  poseNeckHead(w, {
    neckPitch: SAD_NECK_PITCH * a,
    neckYaw: deg(1.5) * sway * a,
    headPitch: SAD_HEAD_PITCH * a + SAD_HEAD_WAVE * breath * a,
    headYaw: SAD_HEAD_YAW * osc(2, u, 0.55) * a,
    headRoll: deg(1.5) * a,
  })
  // 手臂垂在身前、肘部弯曲（无力感）
  applyBasePose(w, {
    armSwingL: SAD_ARM_SWING * a,
    armSwingR: SAD_ARM_SWING * a,
    elbowL: ELBOW_RELAX + SAD_ELBOW * a,
    elbowR: ELBOW_RELAX + SAD_ELBOW * a,
  })
  // root：整个人矮一点 + 呼吸轻微起伏
  addRoot(w, { up: -SAD_DROP * h * a + 0.002 * h * breath * a })
  poseLocomotionFluff(w, 1, 0.6, deg(2.5), deg(2), deg(3))
}

// ─────────────────────────── 扩展动作（task-4） ───────────────────────────

/** 鞠躬：脊柱+胸前倾约 35°、头微低、双臂自然下垂，缓慢回正 */
function poseBow(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const env = window4(m.u, 0.08, 0.34, 0.62, 0.9) * a
  const e = clamp01(env)

  // 骨盆先写（大腿/手臂的 abs 都依赖它）
  poseHips(w, { pitch: BOW_HIP_PITCH * env })
  // 微屈膝保持平衡，root 补偿让双脚仍踩在原地
  const bowKnee = BOW_KNEE * env
  const bowFootRoot = kneeBounceRoot(w, bowKnee)
  poseLeg(w, 'L', { knee: bowKnee, footPitch: 0 })
  poseLeg(w, 'R', { knee: bowKnee, footPitch: 0 })
  // 脊柱链前屈 + 颈/头顺势低下
  poseSpine(w, { pitch: BOW_SPINE_PITCH * env })
  poseNeckHead(w, {
    neckPitch: BOW_NECK_PITCH * env,
    headPitch: BOW_HEAD_PITCH * env,
  })
  // 手臂自然下垂，随躯干略微前摆；身体略微下沉
  applyBasePose(w, {
    armSwingL: BOW_ARM_SWING * env,
    armSwingR: BOW_ARM_SWING * env,
  })
  addRoot(w, { up: bowFootRoot.up, fwd: bowFootRoot.fwd })
  // 耳朵 / 后发 / 尾巴随鞠躬前甩
  poseLocomotionFluff(w, 1, e, deg(6), deg(7), deg(6))
}

/** 点头：颈/头小幅点头两次（起停包络保证首尾回到中立站姿） */
function poseNod(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const env = window4(m.u, 0.06, 0.16, 0.84, 0.94) * a
  // 0 → 1 → 0 的两次点头波形
  const nod = env * (0.5 - 0.5 * Math.cos(TAU * NOD_CYCLES * m.u))

  poseHips(w, { pitch: NOD_SPINE * nod * 0.5 })
  poseSpine(w, { pitch: NOD_SPINE * nod })
  poseNeckHead(w, {
    neckPitch: NOD_NECK * nod,
    headPitch: NOD_HEAD * nod,
  })
  applyBasePose(w, {
    armSwingL: deg(1.2) * nod,
    armSwingR: deg(1.2) * nod,
    clavRaiseL: -CLAV_DROP - deg(1.5) * nod,
    clavRaiseR: -CLAV_DROP - deg(1.5) * nod,
  })
  poseLocomotionFluff(w, 2, clamp01(env), deg(2), deg(2), deg(2))
}

/** 摇头：头部左右 yaw ±18° 摆动两次，脖子轻微反相 */
function poseShakeHead(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const env = window4(m.u, 0.06, 0.16, 0.84, 0.94) * a
  const swing = env * Math.sin(TAU * SHAKE_CYCLES * m.u)

  poseHips(w, { yaw: deg(1.5) * swing })
  poseSpine(w, { yaw: deg(2.5) * swing })
  poseNeckHead(w, {
    neckYaw: -SHAKE_NECK_YAW * 0.5 * swing,
    headYaw: SHAKE_HEAD_YAW * swing,
    headRoll: SHAKE_HEAD_ROLL * swing,
  })
  applyBasePose(w, {
    armSwingL: deg(2) * swing,
    armSwingR: -deg(2) * swing,
  })
  poseLocomotionFluff(w, 2, clamp01(env), deg(4), deg(3), deg(3))
}

/** 鼓掌：双臂抬到胸前，双手靠拢再分开，手指微屈 + 轻微耸肩（循环无缝） */
function poseClap(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  // 每循环 4 次拍手：beat 0 = 合拢，1 = 张开
  const beat = 0.5 - 0.5 * Math.cos(TAU * CLAP_CYCLES * u)
  const bob = Math.max(0, Math.sin(TAU * CLAP_CYCLES * u))

  // 躯干：随拍手轻点头；膝盖轻弹，root 补偿保持双脚踩地
  poseHips(w, { pitch: deg(0.8) * bob * a })
  const clapKnee = (CLAP_KNEE + deg(3) * bob) * a
  const clapFootRoot = kneeBounceRoot(w, clapKnee)
  poseLeg(w, 'L', { knee: clapKnee, footPitch: 0 })
  poseLeg(w, 'R', { knee: clapKnee, footPitch: 0 })
  poseSpine(w, { pitch: deg(1.2) * bob * a })
  poseNeckHead(w, { headPitch: CLAP_NOD * bob * a })

  // 上臂：抬到胸前并略前摆（左右对称）
  applyBasePose(w, {
    armLiftL: CLAP_ARM_LIFT + deg(2) * beat,
    armLiftR: CLAP_ARM_LIFT + deg(2) * beat,
    armSwingL: CLAP_ARM_SWING,
    armSwingR: CLAP_ARM_SWING,
    clavRaiseL: -CLAV_DROP + CLAP_CLAV * bob,
    clavRaiseR: -CLAV_DROP + CLAP_CLAV * bob,
    fingerCurlL: null,
    fingerCurlR: null,
  })
  // 前臂朝前 + 朝内，靠拢/张开由 inward 分量控制；手掌跟随前臂
  for (const side of ['L', 'R'] as Side[]) {
    const forearm = w.ctx.roleBone(forearmRole(side))
    if (!forearm) continue
    const inward = CLAP_INWARD_CLOSED + (CLAP_INWARD_OPEN - CLAP_INWARD_CLOSED) * beat
    const dir = dirOf(w, forearm, CLAP_FWD, CLAP_UP, -inward)
    setForearmTarget(w, side, dir, 1)
    setHandTarget(w, side, dir, 1)
    poseFingersSide(w, side, CLAP_FINGER)
  }
  addRoot(w, { up: clapFootRoot.up, fwd: clapFootRoot.fwd })
  poseLocomotionFluff(w, CLAP_CYCLES, 1, deg(2), deg(2), deg(2))
}

/** 跳舞：重心左右摆 + 髋部转动 + 双臂交替上举 + 膝盖轻弹（循环无缝） */
function poseDance(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const sway = osc(2, u)
  const twist = osc(2, u, 0.25)
  const bounce = 0.5 - 0.5 * Math.cos(TAU * 4 * u) // 每循环 4 次弹动
  const armPhase = osc(2, u, 0.1)

  // 骨盆先写：左右摆 + 扭转 + 轻弹
  poseHips(w, {
    roll: DANCE_HIP_ROLL * sway * a,
    yaw: DANCE_HIP_YAW * twist * a,
    pitch: deg(2) * bounce * a,
  })
  // 腿：膝盖随节奏轻弹（root 补偿让双脚原地踩地）
  const knee = (DANCE_KNEE + DANCE_KNEE_AMP * bounce) * a
  const danceFootRoot = kneeBounceRoot(w, knee)
  poseLeg(w, 'L', { knee, footPitch: 0 })
  poseLeg(w, 'R', { knee, footPitch: 0 })
  // 躯干反向扭转 + 侧倾
  poseSpine(w, {
    yaw: -0.7 * DANCE_HIP_YAW * twist * a,
    roll: -0.4 * DANCE_HIP_ROLL * sway * a,
    pitch: -deg(1.5) * bounce * a,
  })
  poseNeckHead(w, {
    headYaw: DANCE_HEAD_YAW * twist * a,
    headRoll: DANCE_HEAD_ROLL * sway * a,
    headPitch: DANCE_HEAD_PITCH * (bounce - 0.5) * a,
  })
  // 双臂交替上举（一上一下）
  applyBasePose(w, {
    armLiftR: DANCE_ARM_LIFT + DANCE_ARM_AMP * armPhase * a,
    armLiftL: DANCE_ARM_LIFT - DANCE_ARM_AMP * armPhase * a,
    armSwingR: DANCE_ARM_SWING * a,
    armSwingL: DANCE_ARM_SWING * a,
    elbowR: ELBOW_RELAX + DANCE_ELBOW * a,
    elbowL: ELBOW_RELAX + DANCE_ELBOW * a,
    clavRaiseR: -CLAV_DROP + deg(2) * armPhase * a,
    clavRaiseL: -CLAV_DROP - deg(2) * armPhase * a,
  })
  // 重心左右移动 + 屈膝带来的起伏（上下/前后都已补偿，脚不会滑）
  addRoot(w, {
    right: DANCE_SWAY * h * sway * a,
    up: danceFootRoot.up,
    fwd: danceFootRoot.fwd,
  })
  poseLocomotionFluff(w, 2, 1, deg(6), deg(6), deg(7))
}

/** 伸懒腰：双臂上举过头（V 字避免夹头）、胸腔后仰、轻微踮脚拉长身体，再放松回位 */
function poseStretch(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const env = window4(m.u, 0.12, 0.4, 0.68, 0.92) * a
  const e = clamp01(env)

  // 先写骨盆 / 腿：轻微踮脚（身体抬高，脚转动让脚尖仍在地面附近）
  poseHips(w, { pitch: -STRETCH_HIP * env })
  poseLeg(w, 'L', { footPitch: STRETCH_FOOT * env, toe: STRETCH_TOE * env })
  poseLeg(w, 'R', { footPitch: STRETCH_FOOT * env, toe: STRETCH_TOE * env })
  addRoot(w, { up: STRETCH_ROOT * h * env })
  // 胸腔后仰 + 头微微后仰（看向斜上方）
  poseSpine(w, { pitch: -STRETCH_SPINE * env })
  poseNeckHead(w, {
    neckPitch: -STRETCH_NECK * env,
    headPitch: -STRETCH_HEAD * env,
  })
  // 双臂举过头顶，手指张开
  applyBasePose(w, {
    armLiftL: STRETCH_ARM_LIFT * env,
    armLiftR: STRETCH_ARM_LIFT * env,
    armSwingL: deg(4) * env,
    armSwingR: deg(4) * env,
    elbowL: ELBOW_RELAX - deg(3) * env,
    elbowR: ELBOW_RELAX - deg(3) * env,
    fingerCurlL: FINGER_RELAX + (0.02 - FINGER_RELAX) * e,
    fingerCurlR: FINGER_RELAX + (0.02 - FINGER_RELAX) * e,
  })
  poseLocomotionFluff(w, 1, e, deg(3), deg(2), deg(3))
}

/** 蹲下：自适应屈膝下蹲（骨盆 -0.22h、双脚原地踩地）、身体前倾、手臂前伸平衡，再起身 */
function poseCrouch(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const env = window4(m.u, 0.1, 0.38, 0.72, 0.94) * a
  const drop = CROUCH_DROP * h * env
  const hipPitch = CROUCH_HIP_PITCH * env
  // 精确解：脚踝保持原地，root 同时补偿竖直下沉与前后位移（不同腿长骨架都适用）
  const squat = plantedSquatPose(w, drop, CROUCH_SHIN_TILT * env)
  const rootOffset = squat.rootOffset.clone().sub(hipJointShift(w, hipPitch))

  // 骨盆先写
  poseHips(w, { pitch: hipPitch })
  poseLeg(w, 'L', { swing: squat.thigh, knee: squat.knee, footPitch: 0 })
  poseLeg(w, 'R', { swing: squat.thigh, knee: squat.knee, footPitch: 0 })
  addRoot(w, {
    up: rootOffset.dot(w.rig.up),
    right: rootOffset.dot(w.rig.right),
    fwd: rootOffset.dot(w.rig.forward),
  })
  // 躯干前倾、颈/头反向抬起看向前方
  poseSpine(w, { pitch: CROUCH_SPINE_PITCH * env })
  poseNeckHead(w, {
    neckPitch: CROUCH_NECK_PITCH * env,
    headPitch: CROUCH_HEAD_PITCH * env,
  })
  // 手臂前伸保持平衡
  applyBasePose(w, {
    armLiftL: CROUCH_ARM_LIFT * env,
    armLiftR: CROUCH_ARM_LIFT * env,
    armSwingL: CROUCH_ARM_SWING * env,
    armSwingR: CROUCH_ARM_SWING * env,
    elbowL: ELBOW_RELAX + CROUCH_ELBOW * env,
    elbowR: ELBOW_RELAX + CROUCH_ELBOW * env,
  })
  poseLocomotionFluff(w, 1, clamp01(env), deg(4), deg(5), deg(5))
}

/** 思考：右手抬到下巴/脸侧、头微低偏一侧，左臂抱在身前，轻微呼吸（循环） */
function poseThink(w: PoseWriter): void {
  const m = w.motion
  const u = m.u
  const a = m.amp
  const h = Math.max(w.rig.height, 0.001)
  const breath = osc(1, u) * a
  const minor = osc(2, u, 0.15) * a // 头部/手臂的轻微晃动

  // 骨盆先写：重心压在一条腿上
  poseHips(w, {
    roll: THINK_HIP_ROLL * a,
    pitch: deg(1) * a,
    yaw: deg(2) * a,
  })
  // 腿：放松微屈
  poseLeg(w, 'L', { knee: deg(4) * a, footPitch: 0 })
  poseLeg(w, 'R', { knee: deg(6) * a, footPitch: 0 })
  // 脊柱/头：微低头 + 偏向思考的手一侧
  poseSpine(w, { pitch: deg(3) * a + deg(0.8) * breath, roll: deg(1) * a })
  poseNeckHead(w, {
    neckPitch: deg(2) * a,
    neckYaw: deg(3) * a,
    headPitch: THINK_HEAD_PITCH * a + deg(1.2) * minor,
    headYaw: THINK_HEAD_YAW * a + deg(1.0) * minor,
    headRoll: THINK_HEAD_ROLL * a,
  })
  // 左臂先按中立放下（上臂），前臂稍后设置成“抱在身前”
  applyBasePose(w, {
    armSwingL: deg(14) * a,
    armLiftL: deg(4) * a,
    elbowL: ELBOW_RELAX + deg(48) * a,
    fingerCurlL: null,
    fingerCurlR: null,
  })
  // 右臂：上臂前抬，前臂竖起靠向面部，手朝上
  const uaRight = w.ctx.roleBone(armRole('R'))
  if (uaRight) {
    setUpperArmTarget(w, 'R', dirOf(w, uaRight, 1.0, 0.12 + 0.03 * minor, 0.12), 1)
  }
  const faRight = w.ctx.roleBone(forearmRole('R'))
  if (faRight) {
    const dir = dirOf(w, faRight, THINK_FOREARM_FWD, THINK_FOREARM_UP + 0.02 * minor, THINK_FOREARM_IN)
    setForearmTarget(w, 'R', dir, 1)
    setHandTarget(w, 'R', dir, 1)
  }
  poseFingersSide(w, 'R', 0.25)
  // 左臂：前臂横过身前（抱臂）
  const faLeft = w.ctx.roleBone(forearmRole('L'))
  if (faLeft) {
    const dir = dirOf(w, faLeft, THINK_LEFT_FWD, THINK_LEFT_UP + 0.02 * minor, THINK_LEFT_IN)
    setForearmTarget(w, 'L', dir, 1)
    setHandTarget(w, 'L', dir, 1)
  }
  poseFingersSide(w, 'L', FINGER_RELAX)
  // 轻微呼吸起伏 + 重心偏一侧
  addRoot(w, { up: 0.003 * h * breath, right: 0.006 * h * a })
  poseLocomotionFluff(w, 1, 0.6, deg(3), deg(2), deg(3))
}

/** 指向：单臂向前伸出、食指指出，身体轻微前倾，保持约 0.9s 后收回 */
function posePoint(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const env = window4(m.u, 0.08, 0.26, 0.74, 0.94) * a
  const e = clamp01(env)
  const sideSign = shoulderForwardYawSign(w, 'R')

  // 骨盆先写：轻微前倾 + 朝指向侧转一点；膝盖微屈并由 root 补偿让双脚踩地
  poseHips(w, { pitch: deg(2) * env, yaw: deg(3) * sideSign * env })
  const pointKnee = deg(3) * env
  const pointFootRoot = kneeBounceRoot(w, pointKnee)
  poseLeg(w, 'L', { knee: pointKnee, footPitch: 0 })
  poseLeg(w, 'R', { knee: pointKnee, footPitch: 0 })
  addRoot(w, { up: pointFootRoot.up, fwd: pointFootRoot.fwd })
  poseSpine(w, { pitch: POINT_LEAN * env, yaw: POINT_TWIST * sideSign * env })
  poseNeckHead(w, {
    headYaw: POINT_HEAD_YAW * sideSign * env,
    headPitch: -deg(2) * env,
  })
  // 左臂自然垂放；手指稍后统一写
  applyBasePose(w, { fingerCurlL: null, fingerCurlR: null })
  poseFingersSide(w, 'L', FINGER_RELAX)
  // 右臂向前伸（略偏外），食指指出、其余手指收起
  const ua = w.ctx.roleBone(armRole('R'))
  if (ua) setUpperArmTarget(w, 'R', dirOf(w, ua, 1.0, POINT_UA_UP, POINT_UA_OUT), env)
  const fa = w.ctx.roleBone(forearmRole('R'))
  if (fa) {
    const dir = dirOf(w, fa, 1.0, POINT_UA_UP, POINT_UA_OUT * 0.8)
    setForearmTarget(w, 'R', dir, env)
    setHandTarget(w, 'R', dir, env)
  }
  poseFingersSide(w, 'R', FINGER_RELAX + (POINT_FINGER_OTHER - FINGER_RELAX) * e, e)
  poseLocomotionFluff(w, 1, e, deg(3), deg(3), deg(3))
}

/** 出拳：收拳蓄力 → 单臂快速前伸（前臂伸直、肩前送、躯干扭转）→ 收回站姿 */
function posePunch(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const chamber = curve(PUNCH_CHAMBER, m.u) * a
  const extend = curve(PUNCH_EXTEND, m.u) * a
  const guard = clamp01(chamber + extend)
  const twist = (extend - chamber * 0.45) * a
  const sideSign = shoulderForwardYawSign(w, 'R')

  // 骨盆先写：出拳时同侧肩前送 = 躯干扭转；膝盖微屈并由 root 补偿保持双脚踩地
  poseHips(w, { yaw: PUNCH_HIP_YAW * sideSign * twist, pitch: deg(1.5) * extend })
  const punchKnee = deg(5) * guard
  const punchFootRoot = kneeBounceRoot(w, punchKnee)
  poseLeg(w, 'L', { knee: punchKnee, footPitch: 0 })
  poseLeg(w, 'R', { knee: punchKnee, footPitch: 0 })
  addRoot(w, { up: punchFootRoot.up, fwd: punchFootRoot.fwd })
  poseSpine(w, { yaw: PUNCH_BODY_TWIST * sideSign * twist, pitch: PUNCH_LEAN * extend })
  poseNeckHead(w, {
    headYaw: -deg(6) * sideSign * twist,
    headPitch: -deg(2) * extend,
  })
  // 左臂护在胸前（手指放松）
  applyBasePose(w, {
    armLiftL: PUNCH_GUARD_LIFT * guard,
    armSwingL: PUNCH_GUARD_SWING * guard,
    elbowL: ELBOW_RELAX + PUNCH_GUARD_ELBOW * guard,
    fingerCurlR: null,
  })
  // 右拳：先收到胸前，再向前打出（方向按 weight 混合，首尾回中立）
  const ua = w.ctx.roleBone(armRole('R'))
  if (ua) {
    const baseUa = armNeutralDir(w, ua, false)
    const chamberUa = dirOf(w, ua, 0.15, -0.92, 0.35)
    const punchUa = dirOf(w, ua, 1.0, 0.06, 0.12)
    const target = lerpDir(lerpDir(baseUa, chamberUa, chamber), punchUa, extend)
    w.abs(ua, aimQuat(restDirOf(w.rig, ua), target))
  }
  const fa = w.ctx.roleBone(forearmRole('R'))
  if (fa) {
    const baseFa = armNeutralDir(w, fa, true)
    const chamberFa = dirOf(w, fa, 0.62, 0.55, -0.35)
    const punchFa = dirOf(w, fa, 1.0, 0.06, 0.08)
    const target = lerpDir(lerpDir(baseFa, chamberFa, chamber), punchFa, extend)
    w.abs(fa, aimQuat(restDirOf(w.rig, fa), target))
  }
  // 出拳的手：拳心朝前，跟随前臂
  const punchFistDir = w.ctx.roleBone(handRole('R'))
  if (punchFistDir) {
    const fistDir = dirOf(w, punchFistDir, 1.0, 0.06, 0.08)
    setHandTarget(w, 'R', fistDir, clamp01(chamber * 0.5 + extend))
  }
  poseFingersSide(w, 'R', FINGER_RELAX + (PUNCH_FIST - FINGER_RELAX) * guard)
  poseLocomotionFluff(w, 2, guard * 0.6, deg(3), deg(3), deg(3))
}

/** 踢腿：右腿抬起前踢（髋前摆 + 膝先屈后伸 + 脚背绷直），支撑腿微屈，身体略后仰 */
function poseKick(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const raise = curve(KICK_RAISE, m.u) * a
  const flex = curve(KICK_FLEX, m.u) * a
  const kneeBend = KICK_KNEE * flex
  const footPitch = KICK_FOOT * raise * (1 - flex)

  // 骨盆先写：略后仰保持平衡
  poseHips(w, { pitch: -KICK_HIP_LEAN * raise })
  // 右腿：髋前摆 + 起腿屈膝 + 踢出时绷脚背
  poseLeg(w, 'R', { swing: KICK_THIGH * raise, knee: kneeBend, footPitch })
  // 支撑腿：微屈，root 补偿让支撑脚仍踩在原地
  const supportKnee = KICK_SUPPORT_KNEE * raise
  const kickFootRoot = kneeBounceRoot(w, supportKnee)
  poseLeg(w, 'L', { knee: supportKnee, footPitch: 0 })
  addRoot(w, { up: kickFootRoot.up, fwd: kickFootRoot.fwd })
  poseSpine(w, { pitch: -KICK_LEAN * raise })
  poseNeckHead(w, { headPitch: KICK_LEAN * 0.6 * raise })
  // 双臂向两侧展开保持平衡
  applyBasePose(w, {
    armLiftL: KICK_BALANCE_LIFT * raise,
    armLiftR: KICK_BALANCE_LIFT * raise,
    armSwingL: KICK_BALANCE_SWING * raise,
    armSwingR: KICK_BALANCE_SWING * raise,
    elbowL: ELBOW_RELAX + KICK_BALANCE_ELBOW * raise,
    elbowR: ELBOW_RELAX + KICK_BALANCE_ELBOW * raise,
  })
  poseLocomotionFluff(w, 2, clamp01(raise), deg(4), deg(4), deg(5))
}

/** 祈祷/拜托：双手在胸前合拢、肘部外张、头微低，轻微前后摇晃后回位 */
function posePray(w: PoseWriter): void {
  const m = w.motion
  const a = m.amp
  const env = window4(m.u, 0.1, 0.38, 0.7, 0.92) * a
  const e = clamp01(env)
  const rock = Math.sin(TAU * 2 * m.u) * e // 轻微前后摇

  // 骨盆先写；膝盖微屈并由 root 补偿保持双脚踩地
  poseHips(w, { pitch: deg(1.0) * e + deg(1.2) * rock })
  const prayKnee = PRAY_KNEE * e
  const prayFootRoot = kneeBounceRoot(w, prayKnee)
  poseLeg(w, 'L', { knee: prayKnee, footPitch: 0 })
  poseLeg(w, 'R', { knee: prayKnee, footPitch: 0 })
  addRoot(w, { up: prayFootRoot.up, fwd: prayFootRoot.fwd })
  poseSpine(w, { pitch: deg(4) * e + PRAY_ROCK * rock })
  poseNeckHead(w, {
    neckPitch: PRAY_NECK * e,
    headPitch: PRAY_HEAD * e + deg(1) * rock,
  })
  // 上臂：略前摆 + 外展（肘部外张）
  applyBasePose(w, {
    armLiftL: PRAY_ARM_LIFT * e,
    armLiftR: PRAY_ARM_LIFT * e,
    armSwingL: PRAY_ARM_SWING * e,
    armSwingR: PRAY_ARM_SWING * e,
    fingerCurlL: null,
    fingerCurlR: null,
  })
  // 前臂朝前上内，双手在胸前合拢；手掌跟随前臂
  for (const side of ['L', 'R'] as Side[]) {
    const forearm = w.ctx.roleBone(forearmRole(side))
    if (!forearm) continue
    const dir = dirOf(w, forearm, PRAY_FOREARM_FWD, PRAY_FOREARM_UP, -PRAY_INWARD)
    setForearmTarget(w, side, dir, env)
    setHandTarget(w, side, dir, env)
    poseFingersSide(w, side, FINGER_RELAX + (PRAY_FINGER - FINGER_RELAX) * e)
  }
  poseLocomotionFluff(w, 1, e, deg(3), deg(2), deg(3))
}

/** ActionKind → 姿态生成函数 */
const ACTION_POSES: Record<ActionKind, PoseFn> = {
  idle: poseIdle,
  breath: poseBreath,
  walk: poseWalk,
  run: poseRun,
  wave: poseWave,
  grip: poseGrip,
  sit: poseSit,
  pickup: posePickup,
  jump: poseJump,
  cheer: poseCheer,
  sad: poseSad,
  bow: poseBow,
  nod: poseNod,
  shake_head: poseShakeHead,
  clap: poseClap,
  dance: poseDance,
  stretch: poseStretch,
  crouch: poseCrouch,
  think: poseThink,
  point: posePoint,
  punch: posePunch,
  kick: poseKick,
  pray: posePray,
}

/** 不在 UI 动作库里、但 ActionKind 存在的动作（例如深呼吸） */
const EXTRA_DEFINITIONS: Partial<Record<ActionKind, ActionDefinition>> = {
  breath: {
    kind: 'breath',
    label: '深呼吸 Breath',
    description: '胸腔扩张 + 耸肩 + 轻微起伏的深呼吸循环',
    defaultDuration: 3,
    loop: true,
  },
}

// ─────────────────────────── 采样 / 输出 ───────────────────────────

/** 采样时间点：0, 1/fps, ... 保证首帧 0、末帧严格等于 duration */
function sampleTimes(duration: number, fps: number): number[] {
  const steps = Math.max(1, Math.round(duration * fps))
  const times: number[] = []
  for (let i = 0; i < steps; i++) times.push(i / fps)
  times.push(duration)
  return times
}

/**
 * Generate one clip.
 *
 * 采样 30fps，输出每根骨骼的绝对局部四元数轨道；rootTrack 记录骨盆/根骨骼的
 * 世界空间偏移（walk 起伏、sit 下沉、jump 起跳）。
 * 循环动作的末帧直接复用首帧姿态，保证无缝；非循环动作首尾回到中立站姿。
 */
export function generateAction(kind: ActionKind, ctx: ActionContext, params?: ActionParams): PoseClip {
  const definition = ACTION_LIBRARY.find((item) => item.kind === kind) ?? EXTRA_DEFINITIONS[kind]
  const speed = params?.speed && Number.isFinite(params.speed) && params.speed > 0 ? params.speed : 1
  const fallbackDuration = definition?.defaultDuration ?? 2
  const rawDuration =
    params?.duration !== undefined && Number.isFinite(params.duration)
      ? params.duration
      : fallbackDuration / speed
  const duration = clamp(rawDuration, 0.2, 30)
  const fps = ACTION_FPS
  const loop = params?.loop ?? definition?.loop ?? false
  const amp = clamp(params?.amplitude ?? 1, 0.1, 3)
  const poseFn = ACTION_POSES[kind] ?? poseIdle
  const times = sampleTimes(duration, fps)

  // 逐帧求姿态。注意：姿态函数会跳过角度为 0 的骨骼（例如脚趾/手指），
  // 所以不同帧写出的骨骼集合可能不完全一致，这里先按帧收集，最后统一补全。
  const frameLocals: Array<Map<string, THREE.Quaternion>> = []
  const boneOrder: string[] = []
  const seenBones = new Set<string>()
  const rootTimes: number[] = []
  const rootValues: THREE.Vector3[] = []
  let hasRootMotion = false

  for (let i = 0; i < times.length; i++) {
    const time = times[i]
    // 循环动作的末帧复用 u=0 的姿态（浮点上也完全一致，避免接缝抖动）
    const isLoopEnd = loop && i === times.length - 1
    const u = isLoopEnd ? 0 : duration > 0 ? clamp01(time / duration) : 0
    const writer = new PoseWriter(ctx, { u, duration, amp })
    poseFn(writer)
    const locals = writer.buildLocals()
    frameLocals.push(locals)
    for (const bone of locals.keys()) {
      if (!seenBones.has(bone)) {
        seenBones.add(bone)
        boneOrder.push(bone)
      }
    }
    const rootOffset = writer.root.clone()
    if (!hasRootMotion && rootOffset.lengthSq() > 1e-12) hasRootMotion = true
    rootTimes.push(time)
    rootValues.push(rootOffset)
  }

  // 某骨骼在个别帧没有写轨道时，用 rest 局部姿态补齐（等价于该帧局部 delta 为单位旋转），
  // 保证每条轨道的 times / quats 一一对应。
  const restFallback = new Map<string, THREE.Quaternion>()
  for (const bone of boneOrder) restFallback.set(bone, ctx.restLocalQuat(bone).clone())
  const tracks: PoseTrack[] = boneOrder.map((bone) => {
    const fallback = restFallback.get(bone) ?? new THREE.Quaternion()
    const quats = frameLocals.map((locals) => locals.get(bone) ?? fallback.clone())
    return makeTrack(bone, times, quats)
  })
  // 稳定排序：让 UI / 序列化结果可复现
  tracks.sort((a, b) => (a.bone < b.bone ? -1 : a.bone > b.bone ? 1 : 0))

  return {
    id: `builtin-${kind}`,
    name: definition?.label ?? kind,
    kind,
    duration,
    fps,
    tracks,
    rootTrack: hasRootMotion ? { times: rootTimes, values: rootValues } : undefined,
    loop,
    builtin: true,
  }
}

/** 单条轨道在 t 时刻的四元数（钳制 + 相邻关键帧 slerp） */
function sampleTrackAt(track: PoseTrack, time: number): THREE.Quaternion | null {
  const times = track.times
  const quats = track.quats
  const count = Math.min(times?.length ?? 0, quats?.length ?? 0)
  if (count === 0) return null
  if (count === 1) return quats[0].clone()
  if (time <= times[0]) return quats[0].clone()
  if (time >= times[count - 1]) return quats[count - 1].clone()
  // 二分查找所在区间
  let lo = 0
  let hi = count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= time) lo = mid
    else hi = mid
  }
  const span = times[hi] - times[lo]
  const alpha = span > 1e-12 ? (time - times[lo]) / span : 0
  return quats[lo].clone().slerp(quats[hi], alpha)
}

/** 单条轨道在 t 时刻的局部位移（钳制 + 相邻关键帧线性插值） */
function sampleTrackPointAt(track: PoseTrack, time: number): THREE.Vector3 | null {
  const times = track.times
  const points = track.points
  if (!times?.length || !points?.length) return null
  const count = Math.min(times.length, points.length)
  if (count === 0) return null
  if (count === 1) return points[0].clone()
  if (time <= times[0]) return points[0].clone()
  if (time >= times[count - 1]) return points[count - 1].clone()
  let lo = 0
  let hi = count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= time) lo = mid
    else hi = mid
  }
  const span = times[hi] - times[lo]
  const alpha = span > 1e-12 ? (time - times[lo]) / span : 0
  return new THREE.Vector3().lerpVectors(points[lo], points[hi], alpha)
}

/** Sample a clip at time t (seconds). Missing tracks fall back to rest pose in the editor. */
export function sampleClip(clip: PoseClip, time: number): SampledPose {
  const quats = new Map<string, THREE.Quaternion>()
  const points = new Map<string, THREE.Vector3>()
  const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 0
  let t = Number.isFinite(time) ? time : 0
  if (t < 0) t = 0
  if (t > duration) t = duration

  for (const track of clip.tracks ?? []) {
    if (!track?.bone) continue
    const quat = sampleTrackAt(track, t)
    if (quat) quats.set(track.bone, quat)
    if (track.points?.length) {
      const point = sampleTrackPointAt(track, t)
      if (point) points.set(track.bone, point)
    }
  }

  const rootOffset = new THREE.Vector3()
  const rootTrack = clip.rootTrack
  if (rootTrack && rootTrack.times?.length && rootTrack.values?.length) {
    const count = Math.min(rootTrack.times.length, rootTrack.values.length)
    if (count === 1) {
      rootOffset.copy(rootTrack.values[0])
    } else if (t <= rootTrack.times[0]) {
      rootOffset.copy(rootTrack.values[0])
    } else if (t >= rootTrack.times[count - 1]) {
      rootOffset.copy(rootTrack.values[count - 1])
    } else {
      let lo = 0
      let hi = count - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (rootTrack.times[mid] <= t) lo = mid
        else hi = mid
      }
      const span = rootTrack.times[hi] - rootTrack.times[lo]
      const alpha = span > 1e-12 ? (t - rootTrack.times[lo]) / span : 0
      rootOffset.lerpVectors(rootTrack.values[lo], rootTrack.values[hi], alpha)
    }
  }

  const sampled: SampledPose = { quats, rootOffset }
  if (points.size) sampled.points = points
  return sampled
}

/** 录制序号，保证同一会话里 clip id 不重复 */
let recordedSequence = 0

/**
 * Create a pose clip from recorded keyframes (frame -> per bone local quaternion).
 *
 * 手工录制：frame 可以是任意整数帧号（含负数/不从 0 开始），统一平移成 time=0 起始；
 * 每根骨骼只在“确实有关键帧”的帧上打点，缺失区间由 sampleClip 的 slerp 补齐。
 */
export function clipFromKeyframes(
  name: string,
  fps: number,
  frames: Map<number, Map<string, THREE.Quaternion>>,
  rootFrames?: Map<number, THREE.Vector3>,
): PoseClip {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : ACTION_FPS
  const frameNumbers = [...(frames?.keys() ?? [])].filter((frame) => Number.isFinite(frame)).sort((a, b) => a - b)
  const firstFrame = frameNumbers.length ? frameNumbers[0] : 0
  const lastFrame = frameNumbers.length ? frameNumbers[frameNumbers.length - 1] : 0
  const duration = frameNumbers.length > 1 ? (lastFrame - firstFrame) / safeFps : 1 / safeFps

  const perBone = new Map<string, { times: number[]; quats: THREE.Quaternion[] }>()
  if (frames) {
    for (const frame of frameNumbers) {
      const pose = frames.get(frame)
      if (!pose) continue
      const time = (frame - firstFrame) / safeFps
      for (const [bone, quat] of pose) {
        if (!bone || !quat) continue
        let record = perBone.get(bone)
        if (!record) {
          record = { times: [], quats: [] }
          perBone.set(bone, record)
        }
        // 防御：录制数据里偶尔会出现同一帧重复 key，忽略重复
        if (record.times.length && Math.abs(record.times[record.times.length - 1] - time) < 1e-9) continue
        record.times.push(time)
        record.quats.push(quat.clone())
      }
    }
  }

  const tracks: PoseTrack[] = []
  for (const [bone, record] of perBone) {
    // 契约：每条轨道首帧 time = 0（首次出现较晚时用首帧姿态向前补一个点）
    if (record.times[0] > 1e-9) {
      record.times.unshift(0)
      record.quats.unshift(record.quats[0].clone())
    }
    tracks.push(makeTrack(bone, record.times, record.quats))
  }
  tracks.sort((a, b) => (a.bone < b.bone ? -1 : a.bone > b.bone ? 1 : 0))

  let rootTrack: PoseClip['rootTrack']
  if (rootFrames && rootFrames.size) {
    const rootFrameNumbers = [...rootFrames.keys()].filter((frame) => Number.isFinite(frame)).sort((a, b) => a - b)
    if (rootFrameNumbers.length) {
      const times: number[] = []
      const values: THREE.Vector3[] = []
      for (const frame of rootFrameNumbers) {
        const value = rootFrames.get(frame)
        if (!value) continue
        const time = Math.max(0, (frame - firstFrame) / safeFps)
        // 去重 + 保证升序
        if (times.length && time <= times[times.length - 1] + 1e-9) continue
        times.push(time)
        values.push(value.clone())
      }
      if (times.length) {
        if (times[0] > 1e-9) {
          times.unshift(0)
          values.unshift(values[0].clone())
        }
        if (times[times.length - 1] < duration - 1e-9) {
          times.push(duration)
          values.push(values[values.length - 1].clone())
        }
        rootTrack = { times, values }
      }
    }
  }

  recordedSequence += 1
  return {
    id: `recorded-${recordedSequence}`,
    name: name || '录制动作',
    kind: 'custom',
    duration,
    fps: safeFps,
    tracks,
    rootTrack,
    loop: false,
    builtin: false,
  }
}

/** Utility used by the editor when building a track from sampled data. */
export function makeTrack(bone: string, times: number[], quats: THREE.Quaternion[]): PoseTrack {
  return { bone, times, quats }
}
