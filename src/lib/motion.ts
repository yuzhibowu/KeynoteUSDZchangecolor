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

export const FLOAT_LEVELS = [
  { id: 'off', label: '不动', scale: 0 },
  { id: 'light', label: '轻', scale: 0.5 },
  { id: 'medium', label: '中', scale: 1 },
  { id: 'heavy', label: '重', scale: 1.8 },
] as const;
export type FloatLevel = (typeof FLOAT_LEVELS)[number]['id'];

export type MotionParams = {
  /** 漂浮强度档 */
  float: FloatLevel;
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
export const DEFAULT_MOTION: MotionParams = { float: 'medium', speed: 1, phase: 0, seconds: 30 };

/** 一个瞬间的姿态。位移是「相对模型自身大小」的倍数（见 poseAt 的 radius），旋转是度 */
export type Pose = {
  position: [number, number, number];
  rotation: [number, number, number];
};

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
  return {
    position: [0, z(Math.sin(tt * FLOAT_W_Y) * FLOAT_RISE * radius * k), 0],
    rotation: [
      z(Math.cos(tt * FLOAT_W_X) * FLOAT_TILT_X * k),
      0,
      z(Math.sin(tt * FLOAT_W_Z) * FLOAT_TILT_Z * k),
    ],
  };
}

/**
 * 把运动烘成逐帧关键帧，给导出用。
 *
 * 稀疏关键帧在 Keynote 里是直线插值的，到峰值会突然反向；所以按 fps 密集采样。
 * 三条正弦的周期对不齐，循环末尾和开头对不上 —— 最后 blendSeconds 秒用
 * 五次多项式（C2 连续）平滑地混回下一圈的开头，接缝看不出来。
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
    });
  }
  return out;
}
