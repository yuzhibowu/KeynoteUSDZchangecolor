/**
 * 加动效模式的运动函数。**预览和导出都从这一个函数出数**：
 * 预览拿它逐帧实时算，导出拿它按固定帧率采样烘成关键帧 —— 网页上看到什么，
 * Keynote 里就是什么。别在别处再手写一份公式。
 *
 * 漂浮的写法整个搬自书籍项目（那个在 Keynote 里验证过能循环播）：
 * 三条互不成整数比的正弦叠在一起 —— Y 位移 1.25、X 倾 0.68、Z 倾 0.82 rad/s。
 * 三个频率永远对不齐，看起来像随机呼吸而不是钟摆。
 * 单一正弦、所有动作绑同一个周期的做法，几秒钟就能看出「它在循环」。
 */

import { customPathAt, type Pt } from './drawnPath';

export const FLOAT_LEVELS = [
  { id: 'off', label: '不动', scale: 0 },
  { id: 'light', label: '轻', scale: 0.5 },
  { id: 'medium', label: '中', scale: 1 },
  { id: 'heavy', label: '重', scale: 1.8 },
] as const;
export type FloatLevel = (typeof FLOAT_LEVELS)[number]['id'];

export const ENTRANCES = [
  { id: 'none', label: '无' },
  { id: 'rise', label: '浮起' },
  { id: 'grow', label: '长出' },
  { id: 'spin', label: '旋入' },
] as const;
export type Entrance = (typeof ENTRANCES)[number]['id'];

export const PATHS = [
  { id: 'none', label: '无' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'line', label: '往返' },
  { id: 'eight', label: '8 字' },
  { id: 'custom', label: '手绘' },
] as const;
export type PathKind = (typeof PATHS)[number]['id'];

export type MotionParams = {
  /** 漂浮强度档 */
  float: FloatLevel;
  /** 轨迹。都在屏幕平面（XY）里跑，和漂浮、入场叠加 */
  path: PathKind;
  /** 轨迹的水平半径，按模型包围球半径的倍数 */
  pathSize: number;
  /** 垂直半径 / 水平半径。往返用不到 */
  pathAspect: number;
  /** 跑一圈用多少秒。会吸附到能整除循环长度的值，接缝才闭合 */
  pathLap: number;
  /** 顺时针 */
  pathClockwise: boolean;
  /** 沿路径倾斜：模型跟着切线方向侧倾 */
  pathBank: boolean;
  /** 手绘的点（模型半径的倍数，重心已在原点）。空的话手绘等于没有轨迹 */
  customPath: Pt[];
  /** 手绘的一笔首尾接上了：绕圈走；否则来回走 */
  customClosed: boolean;
  /**
   * 入场方式。Keynote 是从第 0 帧开始播的，所以时间线开头那一段可以不是循环：
   * 先入场，再接进漂浮。循环结尾用同样的方式退场，回到第 0 帧时接缝才是平的。
   */
  entrance: Entrance;
  /** 入场用多少秒 */
  entranceSeconds: number;
  /** 节奏倍率：1 是书籍那套原速，0.5 慢一倍，2 快一倍 */
  speed: number;
  /**
   * 起始相位（秒）。同一页放几个模型时各给一个不同的值，
   * 免得它们完全同步地起伏 —— 那一眼就假。
   */
  phase: number;
  /**
   * 导出时烘多长的循环（秒）。文本关键帧不占体积，越长越看不出重复；
   * 预览是实时算的，用不到这个。
   */
  seconds: number;
};

export const LOOP_SECONDS = [10, 30, 60] as const;
export const DEFAULT_MOTION: MotionParams = {
  float: 'medium',
  path: 'none',
  pathSize: 1,
  pathAspect: 0.45,
  pathLap: 8,
  pathClockwise: true,
  pathBank: false,
  customPath: [],
  customClosed: false,
  entrance: 'none',
  entranceSeconds: 1.5,
  speed: 1,
  phase: 0,
  seconds: 30,
};

/** 一个瞬间的姿态。位移和 radius 同单位，旋转是度，缩放是倍数（1 = 原大） */
export type Pose = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
};

/** 浮起时从多深的地方升上来（包围球半径的倍数） */
const RISE_DEPTH = 1.2;
/** 长出时的起始缩放。不能是 0：零矩阵分解不出旋转，导出会算出 NaN */
const GROW_FROM = 0.001;
/** 缓出：开头快、落定慢 */
const easeOut = (u: number) => 1 - (1 - u) ** 3;

/**
 * 入场 / 退场的包络：0 = 还没出现，1 = 完全就位。
 * 时间按循环长度取模，开头 entranceSeconds 内入场，结尾同样长的时间内退场。
 */
export function envelopeAt(p: MotionParams, t: number): number {
  if (p.entrance === 'none') return 1;
  const dur = Math.max(0.05, Math.min(p.entranceSeconds, p.seconds / 2));
  const tl = ((t % p.seconds) + p.seconds) % p.seconds;
  const inn = Math.min(1, tl / dur);
  const out = Math.min(1, (p.seconds - tl) / dur);
  return easeOut(Math.min(inn, out));
}

/** 书籍项目的三条正弦：位移幅度按模型包围球半径的比例给，倾角直接是度 */
const FLOAT_RISE = 0.047; // 书里是 0.105 / 包围球半径 2.24
const FLOAT_TILT_X = (0.012 * 180) / Math.PI;
const FLOAT_TILT_Z = (0.014 * 180) / Math.PI;
const FLOAT_W_Y = 1.25;
const FLOAT_W_X = 0.68;
const FLOAT_W_Z = 0.82;

export function floatScale(level: FloatLevel): number {
  return FLOAT_LEVELS.find((l) => l.id === level)?.scale ?? 1;
}

/** 一圈实际用多少秒：吸附到能整除循环长度的值，一个循环里跑整数圈，接缝才闭合 */
export function effectiveLap(p: MotionParams): number {
  const laps = Math.max(1, Math.round(p.seconds / Math.max(0.5, p.pathLap)));
  return p.seconds / laps;
}

/**
 * 轨迹在 t 秒时的位置（XY 平面，和 radius 同单位）和切线方向（弧度，给侧倾用）。
 * 起点都在 θ = 0：椭圆在最右边，往返在中点往右走，8 字在中心。
 */
export function pathAt(p: MotionParams, t: number, radius: number): { x: number; y: number; heading: number } {
  if (p.path === 'none') return { x: 0, y: 0, heading: 0 };
  if (p.path === 'custom') {
    if (!p.customPath?.length) return { x: 0, y: 0, heading: 0 };
    // 手绘的点是按半径归一的，「大小」在这里还是倍数；方向按顺 / 逆时针翻
    const u = (p.pathClockwise ? -1 : 1) * (t / effectiveLap(p));
    const c = customPathAt(p.customPath, p.customClosed, u);
    const k = p.pathSize * radius;
    return { x: c.x * k, y: c.y * k, heading: p.pathClockwise ? c.heading + Math.PI : c.heading };
  }
  const A = p.pathSize * radius;
  const B = A * p.pathAspect;
  const dir = p.pathClockwise ? -1 : 1;
  const th = (dir * (t * 2 * Math.PI)) / effectiveLap(p);
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  if (p.path === 'ellipse') {
    x = A * Math.cos(th);
    y = B * Math.sin(th);
    dx = -A * Math.sin(th) * dir;
    dy = B * Math.cos(th) * dir;
  } else if (p.path === 'line') {
    x = A * Math.sin(th);
    dx = A * Math.cos(th) * dir;
    dy = 0;
  } else {
    // 8 字：横向一个周期，纵向两个
    x = A * Math.sin(th);
    y = B * Math.sin(2 * th);
    dx = A * Math.cos(th) * dir;
    dy = 2 * B * Math.cos(2 * th) * dir;
  }
  return { x, y, heading: Math.atan2(dy, dx) };
}

/** 侧倾角上限（度）：跟着切线全转会像在翻跟头，只取一部分 */
const BANK_MAX = 18;

/**
 * t 秒时的姿态。radius 是模型包围球半径 —— 位移幅度按它算，
 * 这样一米的模型和一厘米的模型看起来晃得一样多。
 *
 * 旋转以模型的**包围盒中心**为轴。第三方模型的原点经常在脚底或某个角上，
 * 直接绕原点转会整个甩出去；调用方要先把模型平移到中心再套这个姿态。
 */
export function poseAt(p: MotionParams, t: number, radius: number): Pose {
  const k = floatScale(p.float);
  const tt = (t + p.phase) * p.speed;
  // 「不动」档乘出来是 -0，写进 usda 会变成 "-0"，看着别扭，归成 0
  const z = (v: number) => (v === 0 ? 0 : v);
  let y = Math.sin(tt * FLOAT_W_Y) * FLOAT_RISE * radius * k;
  let ry = 0;
  let scale = 1;
  const e = envelopeAt(p, t);
  if (e < 1) {
    if (p.entrance === 'rise') y -= (1 - e) * RISE_DEPTH * radius;
    if (p.entrance === 'grow' || p.entrance === 'spin') scale = GROW_FROM + (1 - GROW_FROM) * e;
    if (p.entrance === 'spin') ry = (1 - e) * 360;
  }
  const path = pathAt(p, t, radius);
  // 侧倾：往右走时 heading = 0，往上拐时 heading > 0 → 模型往前倾（绕 Z 负转）
  const bank = p.path !== 'none' && p.pathBank ? -Math.sin(path.heading) * BANK_MAX : 0;
  return {
    position: [z(path.x), z(y + path.y), 0],
    rotation: [
      z(Math.cos(tt * FLOAT_W_X) * FLOAT_TILT_X * k),
      z(ry),
      z(Math.sin(tt * FLOAT_W_Z) * FLOAT_TILT_Z * k + bank),
    ],
    scale,
  };
}

/**
 * 把运动烘成逐帧关键帧，给导出用。
 *
 * 稀疏关键帧在 Keynote 里是直线插值的，到峰值会突然反向；所以按 fps 密集采样。
 * 三条正弦的周期对不齐，循环末尾和开头对不上 —— 最后 blendSeconds 秒用
 * 五次多项式（C2 连续）平滑地混回下一圈的开头，接缝看不出来。
 * 入场 / 退场的包络在 poseAt 里已经按循环长度取模了，两边的包络一样，混合不受影响。
 */
export function bakeMotion(
  p: MotionParams,
  radius: number,
  seconds: number,
  fps = 60,
  blendSeconds = 5,
): Pose[] {
  const frames = Math.round(seconds * fps);
  const blendFrom = seconds - Math.min(blendSeconds, seconds);
  const out: Pose[] = [];
  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    const a = poseAt(p, t, radius);
    const b = poseAt(p, t - seconds, radius);
    const u = seconds > blendFrom ? Math.max(0, (t - blendFrom) / (seconds - blendFrom)) : 0;
    const w = u * u * u * (10 + u * (-15 + 6 * u));
    const mix = (x: number, y: number) => x * (1 - w) + y * w;
    out.push({
      position: [mix(a.position[0], b.position[0]), mix(a.position[1], b.position[1]), mix(a.position[2], b.position[2])],
      rotation: [mix(a.rotation[0], b.rotation[0]), mix(a.rotation[1], b.rotation[1]), mix(a.rotation[2], b.rotation[2])],
      scale: mix(a.scale, b.scale),
    });
  }
  return out;
}

/** 运动最远能离开原位多少（和 radius 同单位），预览取景用 */
export function motionReach(p: MotionParams, radius: number): number {
  let reach = FLOAT_RISE * radius * floatScale(p.float) * 1.8;
  if (p.entrance === 'rise') reach = Math.max(reach, RISE_DEPTH * radius);
  if (p.path === 'custom') {
    let far = 0;
    for (const [x, y] of p.customPath ?? []) far = Math.max(far, Math.hypot(x, y));
    reach += far * p.pathSize * radius;
  } else if (p.path !== 'none') {
    const A = p.pathSize * radius;
    reach += p.path === 'line' ? A : Math.max(A, A * p.pathAspect);
  }
  return reach;
}

/** 参数存进浏览器，刷新不丢。键带版本号：结构变了旧档自然作废 */
const STORE_KEY = 'prism-usdz-exporter/motion/v1';

export function saveMotion(p: MotionParams) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式 / 配额满，忽略 */
  }
}

/** 读回来时和默认值合并：以后加了新字段，旧档也不会缺 */
export function loadMotion(): MotionParams {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_MOTION;
    const saved = JSON.parse(raw) as Partial<MotionParams>;
    return { ...DEFAULT_MOTION, ...saved, customPath: Array.isArray(saved.customPath) ? saved.customPath : [] };
  } catch {
    return DEFAULT_MOTION;
  }
}

/** 随机一个相位：在一圈的范围里挑，且离现在的值够远，点一下一定看得出变了 */
export function randomPhase(current: number, seconds: number): number {
  const span = Math.min(10, seconds);
  let v = Math.random() * span;
  if (Math.abs(v - current) < span * 0.25) v = (v + span / 2) % span;
  return Math.round(v * 10) / 10;
}
