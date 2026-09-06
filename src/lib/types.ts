import { BLANK_COMP, DEFAULT_COMP, type ColorComp } from './color';
import { cardSection, prismSection, type Section } from './geometry';

export const MAX_SIDES = 12;

/**
 * 一个面有正反两张贴图，所以贴图槽位是面数的两倍：
 * 槽位 i 是第 i 个面的**外面**，槽位 MAX_SIDES + i 是同一个面的**内面**。
 *
 * 内面只在「没有端面」时看得见 —— 封了口就看不到里面，也就没必要贴。
 */
/**
 * 槽位排布：
 *   0 .. MAX_SIDES-1        侧面外面
 *   MAX_SIDES .. 2N-1       侧面内面（反面）
 *   CAP_RIGHT / CAP_LEFT    两个端面
 * 端面单独排在最后，别让 isInner / faceOfSlot 这种「按侧面算」的函数误伤它们。
 */
export const CAP_RIGHT = MAX_SIDES * 2;
export const CAP_LEFT = MAX_SIDES * 2 + 1;
export const MAX_SLOTS = MAX_SIDES * 2 + 2;
export const innerSlot = (face: number) => MAX_SIDES + face;
export const isCap = (slot: number) => slot >= CAP_RIGHT;
export const isInner = (slot: number) => slot >= MAX_SIDES && slot < CAP_RIGHT;
export const faceOfSlot = (slot: number) => slot % MAX_SIDES;
export const slotLabel = (slot: number) =>
  slot === CAP_RIGHT ? '右端' : slot === CAP_LEFT ? '左端' : String(faceOfSlot(slot));

/**
 * 当前真正会被渲染／导出的贴图槽位。
 *
 * 别拿 MAX_SLOTS 当循环上界 —— 那是 24 个槽，画 4 个面的时候会白白烘 20 张
 * 2K 画布（每张 ~9 MB），既拖慢每一次滑块拖动，也把显存顶爆，标签页直接黑掉。
 */
export function activeSlots(sides: number, withInner?: boolean, withCaps?: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < sides; i++) out.push(i);
  if (withInner) for (let i = 0; i < sides; i++) out.push(innerSlot(i));
  if (withCaps) out.push(CAP_RIGHT, CAP_LEFT);
  return out;
}
export const MIN_SIDES = 3;

/** 单个侧面的贴图状态。所有用户调整只影响烘焙参数，永远不改 UV。 */
export type FaceTransform = {
  offsetX: number; // 归一化偏移，单位 = 面在 u 方向的长度；正值 = 图片往右
  offsetY: number; // 归一化偏移，单位 = 面在 v 方向的长度；正值 = 图片往上
  scale: number; // 1 = cover 基准
  rotation: number; // 弧度，绕图片中心
};

export type FaceState = FaceTransform & {
  /** 这一面不渲染。USD 是单面渲染的，藏掉之后从这一侧看过去就是空的、能看穿 */
  hidden?: boolean;
  source: ImageBitmap | null;
  sourceKey: number; // 图片身份标识，用于烘焙缓存判定
  sourceName: string | null;
};

export type Resolution = 1280 | 1920 | 2560 | 3840;

/** 分辨率按视频档位给，比 512/1024/2048 好懂 */
export const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: 2560, label: '2K' },
  { value: 1280, label: '720P' },
  { value: 1920, label: '1080P' },
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

/** 面的宽高比，直接从菜单里选。默认 16:9 排第一 */
export const ASPECTS: { ratio: number; label: string }[] = [
  { ratio: 16 / 9, label: '16:9' },
  { ratio: 4 / 3, label: '4:3' },
  { ratio: 1, label: '1:1' },
  { ratio: 3 / 4, label: '3:4' },
  { ratio: 9 / 16, label: '9:16' },
  { ratio: 2, label: '2:1' },
  // 集换式卡牌（游戏王 / 宝可梦这一类）的实际尺寸是 59 × 86 mm
  { ratio: 59 / 86, label: '卡牌' },
];

/**
 * 由「面有多宽」和「什么比例」反推外接圆半径。
 *
 * 原来让用户直接调「粗细（外接圆半径）」，那是几何量，跟他手上的图对不上号 ——
 * 做图的人想的是「这个面多宽、什么比例」。所以现在宽度和比例是主控，半径是算出来的。
 */
export function radiusFor(width: number, aspect: number, sides: number): number {
  const chord = width / aspect;
  return chord / (2 * Math.sin(Math.PI / sides));
}

/** 模型类型：棱柱（N 个侧面 + 两个端面）或卡片（正反两面 + 四条窄边） */
export const MODEL_TYPES = [
  { id: 'prism', label: '棱柱' },
  { id: 'card', label: '卡片' },
] as const;
export type ModelType = (typeof MODEL_TYPES)[number]['id'];

/**
 * 左上角那个菜单：两件完全不同的事。
 * 「做一个模型」里面才分棱柱 / 卡片，那是模型类型，留在侧栏。
 * 颜色校正是另一条路 —— 拿现成的 usdz 来改，没有几何可言。
 */
export const MODES = [
  { id: 'model', title: 'USDZ 导出器' },
  { id: 'recolor', title: 'USDZ 颜色校正' },
] as const;
export type Mode = (typeof MODES)[number]['id'];

export type Params = {
  modelType: ModelType;
  /** 卡片厚度，米。棱柱模式下不用 */
  thickness: number;
  /** 卡片圆角半径，米。0 = 直角 */
  corner: number;
  sides: number;
  radius: number; // 外接圆半径，米。由 width 和 aspect 算出来，不直接调
  length: number; // 面的宽度 = 棱柱沿 X 轴的长度，米
  aspect: number; // 面的宽高比，从菜单里选
  capMode: CapMode; // 端面：实心 or 镂空
  /** 卡片侧边的颜色跟着正面贴图走（默认）；用户手动调过就变成 false */
  edgeAuto: boolean;
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
  /** 导出给哪个 App 用 —— 决定套哪份校准档 */
  target: TargetId;
  /** 每个目标 App 各一份校准档；color 是当前生效的那一份 */
  profiles: Record<TargetId, ColorComp>;
  color: ColorComp; // 导出时烘进贴图的颜色预补偿
};

export const DEFAULT_TRANSFORM: FaceTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotation: 0,
};

/**
 * 导出的模型要拿去哪个 App 里显示。
 *
 * 每个 App 对贴图的颜色处理都不一样，所以每个目标各存一份校准档 ——
 * 给无边记标定一次，不该把 Keynote 那份冲掉。
 */
export const TARGETS = [
  { id: 'keynote', label: 'Keynote' },
  { id: 'freeform', label: '无边记' },
] as const;
export type TargetId = (typeof TARGETS)[number]['id'];

export function targetLabel(id: TargetId): string {
  return TARGETS.find((t) => t.id === id)?.label ?? id;
}

export function defaultProfiles(): Record<TargetId, ColorComp> {
  // Keynote 有实测好的内置档；别的目标是空的，等用户自己校准
  return { keynote: DEFAULT_COMP, freeform: BLANK_COMP };
}

export const DEFAULT_PARAMS: Params = {
  modelType: 'prism',
  thickness: 0.006, // 6 mm，差不多一张厚卡片
  corner: 0,
  sides: 4,
  aspect: 16 / 9,
  radius: radiusFor(0.192, 16 / 9, 4),
  length: 0.192, // 1920 px —— 和 1080P 那一档对齐
  capMode: 'solid',
  edgeAuto: true,
  capColorRight: '#d9d9de',
  capColorLeft: '#d9d9de',
  separateCaps: false,
  resolution: 2560,
  bgColor: '#ffffff',
  bgTransparent: false,
  emissiveExport: false, // 内置校准档是在灯光开着的状态下测的，默认保持一致
  emissiveLift: 1, // 实测：拉满时颜色才对得上，内置校准也是按这个配的
  target: 'keynote',
  profiles: defaultProfiles(),
  color: DEFAULT_COMP,
};

export function createFaces(): FaceState[] {
  return Array.from({ length: MAX_SLOTS }, () => ({
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

/**
 * 当前参数对应的横截面。
 *
 * 棱柱是正多边形；卡片是矩形 —— 高度由「宽度 ÷ 画面比例」得到，厚度自己一个参数。
 * 有了这一层，几何、拾取、贴图尺寸全都不用管是哪种模型。
 */
export function sectionOf(p: Pick<Params, 'modelType' | 'sides' | 'radius' | 'length' | 'aspect' | 'thickness'>): Section {
  if (p.modelType === 'card') return cardSection(p.length / p.aspect, p.thickness);
  return prismSection(p.sides, p.radius);
}

/** 侧面宽高比 = 长度 / 弦长（u 方向 / v 方向），贴图画布就按这个比例来 */
export function faceAspect(radius: number, sides: number, length: number): number {
  return length / faceChord(radius, sides);
}

/**
 * 贴图画布的宽高比。
 * 卡片正反面就是画面比例本身；棱柱是「长度 ÷ 弦长」。
 */
export function textureAspect(p: Pick<Params, 'modelType' | 'sides' | 'radius' | 'length' | 'aspect'>): number {
  return p.modelType === 'card' ? p.aspect : faceAspect(p.radius, p.sides, p.length);
}

/** 卡片模式下真正能贴图的两个槽位：正面（面 0）和背面（面 2），中间隔着一条窄边 */
export const CARD_FRONT = 0;
export const CARD_BACK = 2;

/**
 * 需要烘贴图的槽位。
 *
 * 卡片只有正反两面能贴图 —— 四条窄边走纯色材质。要是也给它们发贴图，
 * 一张 2K 纯色 PNG 就是一百多 KB，四条边白白多出半兆。
 */
export function textureSlots(
  p: Pick<Params, 'modelType' | 'sides' | 'capMode' | 'separateCaps'>,
): number[] {
  if (p.modelType === 'card') return [CARD_FRONT, CARD_BACK];
  return activeSlots(p.sides, p.capMode === 'none', p.capMode !== 'none' && p.separateCaps);
}

/** 卡片的窄边（上下两条侧面 + 两个端面）—— 这些面不贴图，只上纯色 */
export function isCardEdge(p: Pick<Params, 'modelType'>, slot: number): boolean {
  return p.modelType === 'card' && slot !== CARD_FRONT && slot !== CARD_BACK;
}
