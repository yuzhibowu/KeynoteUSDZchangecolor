import { DEFAULT_COMP, type ColorComp } from './color';

export const MAX_SIDES = 12;
export const MIN_SIDES = 3;

/** 单个侧面的贴图状态。所有用户调整只影响烘焙参数，永远不改 UV。 */
export type FaceTransform = {
  offsetX: number; // 归一化偏移，单位 = 面在 u 方向的长度；正值 = 图片往右
  offsetY: number; // 归一化偏移，单位 = 面在 v 方向的长度；正值 = 图片往上
  scale: number; // 1 = cover 基准
  rotation: number; // 弧度，绕图片中心
};

export type FaceState = FaceTransform & {
  source: ImageBitmap | null;
  sourceKey: number; // 图片身份标识，用于烘焙缓存判定
  sourceName: string | null;
};

export type Resolution = 1280 | 1920 | 2560 | 3840;

/** 分辨率按视频档位给，比 512/1024/2048 好懂 */
export const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: 1920, label: '1080P' },
  { value: 1280, label: '720P' },
  { value: 2560, label: '2K' },
  { value: 3840, label: '4K' },
];

/**
 * 界面上长度和粗细都用像素显示 —— 做演示的人对像素有直觉，对厘米没有。
 * 内部仍然是米（USD 的 metersPerUnit = 1），这里只是显示换算。
 */
export const PX_PER_METER = 10000;
export const toPx = (meters: number) => Math.round(meters * PX_PER_METER);
export const fromPx = (px: number) => px / PX_PER_METER;

/** 端面：实心色板，或者干脆不要（镂空成一根管子） */
export type CapMode = 'solid' | 'none';

/** 常见画面比例，长度滑块拖到附近会吸附过去 */
export const ASPECT_SNAPS: { ratio: number; label: string }[] = [
  { ratio: 9 / 16, label: '9:16' },
  { ratio: 3 / 4, label: '3:4' },
  { ratio: 1, label: '1:1' },
  { ratio: 4 / 3, label: '4:3' },
  { ratio: 16 / 9, label: '16:9' },
  { ratio: 2, label: '2:1' },
];

export type Params = {
  sides: number;
  radius: number; // 外接圆半径，米
  length: number; // 棱柱长度（沿 X 轴），米
  capMode: CapMode; // 端面：实心 or 镂空
  capColorRight: string; // +X 端面
  capColorLeft: string; // -X 端面
  separateCaps: boolean;
  resolution: Resolution;
  bgColor: string; // 贴图未覆盖区域的底色
  /**
   * 底色透明。Keynote 对带 alpha 的贴图渲染行为不好预测（这是实测踩过的），
   * 所以默认关着；需要镂空效果时可以打开，导出前最好自己在 Keynote 里核一眼。
   */
  bgTransparent: boolean;
  emissiveExport: boolean; // 完全关掉灯光：diffuse 压黑，全靠 emissive
  /**
   * 补光强度 0..1。在保留漫反射（立体明暗）的前提下，额外叠一层自发光。
   *
   * Keynote 算像素是「贴图 × 灯光 + 自发光」。乘法那一项有天花板：灯光系数 < 1，
   * 贴图再白也到不了纯白。加法那一项没有这个约束，而且同样可以挂贴图，
   * 所以叠自发光能把上限抬起来。代价是自发光不随角度变化，加得越多明暗对比越平。
   */
  emissiveLift: number;
  color: ColorComp; // 导出时烘进贴图的颜色预补偿
};

export const DEFAULT_TRANSFORM: FaceTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotation: 0,
};

export const DEFAULT_PARAMS: Params = {
  sides: 4,
  radius: 0.05,
  length: 0.1,
  capMode: 'solid',
  capColorRight: '#d9d9de',
  capColorLeft: '#d9d9de',
  separateCaps: false,
  resolution: 1920,
  bgColor: '#ffffff',
  bgTransparent: false,
  emissiveExport: false, // 内置校准档是在灯光开着的状态下测的，默认保持一致
  emissiveLift: 1, // 实测：拉满时颜色才对得上，内置校准也是按这个配的
  color: DEFAULT_COMP,
};

export function createFaces(): FaceState[] {
  return Array.from({ length: MAX_SIDES }, () => ({
    ...DEFAULT_TRANSFORM,
    source: null,
    sourceKey: 0,
    sourceName: null,
  }));
}

/**
 * 侧面在圆周方向上的弦长（米）—— 棱柱躺倒之后，这是侧面的「窄边」，
 * 长边是棱柱的长度。
 */
export function faceChord(radius: number, sides: number): number {
  return 2 * radius * Math.sin(Math.PI / sides);
}

/** 侧面宽高比 = 长度 / 弦长（u 方向 / v 方向），贴图画布就按这个比例来 */
export function faceAspect(radius: number, sides: number, length: number): number {
  return length / faceChord(radius, sides);
}
