import { LOCAL_SIGMA, type ColorComp, type Triple } from './color';
import { pickCovering, type RGB } from './chart';

/**
 * 「这张图准不准」的诊断。
 *
 * 排查一次「蓝色系画面在 Keynote 里发黄」花掉了整整一轮来回：没人能回答
 * **为什么偏偏是这张图**。最后是手写探针算出来的 —— 那张图的主色离最近的锚点有 63 阶，
 * 而局部修正的作用半径只有 18 阶，等于整张图全靠全局公式外推。
 *
 * 这个判断本来三秒就能给出，所以把它做成工具的一部分：拖一张图进来，
 * 直接告诉你哪些颜色有实测支撑、哪些是纯外推。省下的不是一点时间，
 * 而是把「颜色不准」从玄学变成可自查的东西。
 */

/** 一个代表色的覆盖情况 */
export type ColorProbe = {
  /** 图里的代表色 */
  color: RGB;
  /** 这个颜色在图里占多少像素（用来排序，越大越值得关心） */
  weight: number;
  /** 到最近锚点的距离，单位是「阶」（0..441，三通道欧氏距离） */
  nearest: number;
  /** 落在局部修正作用半径里的锚点个数。> 0 表示有实测点直接兜底 */
  within: number;
  /** 够不够近 —— 判断可靠性用这个，不是 within */
  ok: boolean;
};

export type CoverageReport = {
  probes: ColorProbe[];
  /** 跑到样本分布之外（离最近实测点超过 NEAR_ENOUGH）的代表色占多少比重，0..1 */
  uncoveredShare: number;
  /** 有没有校准数据。没有的话谈覆盖没意义 */
  calibrated: boolean;
};

/** 局部修正的作用半径，换算成 0..255 的「阶」。落在这里面 = 有实测点直接兜底 */
export const COVER_RADIUS = LOCAL_SIGMA * 255;

/**
 * 「离实测点够近」的门槛，单位是阶。
 *
 * 别拿局部修正的半径（18 阶）当唯一标准 —— 那会把大量其实很准的颜色报成危险。
 * 色卡的色彩立方体是 85 阶间距，任意颜色到最近立方点的典型距离在 40 阶上下，
 * 全局模型在这个范围内是**插值**，可靠；真正危险的是跑到样本分布之外去**外推**。
 *
 * 这个数字是被实测校正过的：用户那张蓝图的代表色离锚点 25~36 阶，诊断一度报
 * 「最容易偏色」，而实拍确认颜色完全正确。判据太严，比不给判据更糟 ——
 * 它会催着人去做没必要的微调。
 */
export const NEAR_ENOUGH = 40;

const dist = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * 从像素里挑出覆盖明暗分布的代表色。
 *
 * 复用色卡那套加权最远点采样，理由和那边一样：只取「像素最多的前几个」会栽 ——
 * 照片里像素最多的永远是阴影和黑背景，采回来的全是又暗又接近的颜色，
 * 而真正看得见、误差也最大的中间调和亮部一个都测不到。
 */
export function probeColorsOf(data: Uint8ClampedArray, n = 12): { color: RGB; weight: number }[] {
  const hist = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue; // 透明像素不算
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const picked = pickCovering(hist, n);
  return picked.map((rgb) => {
    const k = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
    return { color: rgb, weight: hist.get(k) ?? 0 };
  });
}

/** 给一张图算覆盖报告 */
export function coverageOf(data: Uint8ClampedArray, comp: ColorComp, n = 12): CoverageReport {
  const samples = comp.samples ?? [];
  const calibrated = !!comp.matrix && samples.length > 0;
  const picked = probeColorsOf(data, n);
  const total = picked.reduce((s, p) => s + p.weight, 0) || 1;

  const probes: ColorProbe[] = picked.map(({ color, weight }) => {
    let nearest = Infinity;
    let within = 0;
    for (const s of samples) {
      const d = dist(color, s.ref as Triple);
      if (d < nearest) nearest = d;
      if (d < COVER_RADIUS) within++;
    }
    const near = Number.isFinite(nearest) ? nearest : 441;
    return { color, weight, nearest: near, within, ok: near <= NEAR_ENOUGH };
  });

  const uncovered = probes.filter((p) => !p.ok).reduce((s, p) => s + p.weight, 0);
  return { probes, uncoveredShare: uncovered / total, calibrated };
}

/** 一句话结论，直接显示给人看 */
export function coverageVerdict(r: CoverageReport): { level: 'good' | 'warn' | 'bad'; text: string } {
  if (!r.calibrated) {
    return { level: 'bad', text: '还没有校准数据，导出的就是原图，颜色不会被补偿' };
  }
  const bad = r.probes.filter((p) => !p.ok).length;
  const share = Math.round(r.uncoveredShare * 100);
  if (bad === 0) {
    const anchored = r.probes.filter((p) => p.within > 0).length;
    return {
      level: 'good',
      text:
        anchored === r.probes.length
          ? '这张图的颜色每一个都有实测点兜底，补偿最可靠'
          : '这张图的颜色都落在实测范围内，补偿是可靠的',
    };
  }
  if (share < 25) {
    return {
      level: 'warn',
      text: `${bad} 个代表色跑到了实测范围之外（约占画面 ${share}%），这几处靠外推，可能有几阶偏差`,
    };
  }
  return {
    level: 'bad',
    text: `画面里约 ${share}% 的颜色在实测范围之外，只能外推 —— 这类图最容易偏色。建议用它做一次「成品截图微调」，把这些颜色锚进校准`,
  };
}
