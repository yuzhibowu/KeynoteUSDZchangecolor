/**
 * 测试用的「假 Keynote」。
 *
 * 结构故意和我们的拟合模型**不一样**：色域变换放在线性光里、带夹断，色调曲线在编码空间。
 * 拟合模型是「编码空间 3×3 + 5 节点曲线」，两者结构不匹配 —— 这正是真实情况的样子，
 * 也正是局部修正要吃掉的那部分残差。如果假 Keynote 和模型同构，测试就变成了自说自话。
 *
 * **它不是真实 Keynote 的复刻**，串色的方向和真机就不一样（真机是红把绿往上拽，
 * 这里是往下压）。它只需要具备三个真实性质：黑位被抬高、白到不了白、通道之间互相耦合。
 * 拿它测的是「拟合 → 反解 → 补偿」这条链路能不能自洽地跑通，不是数值本身。
 */
import { srgbToLinear, linearToSrgb, type Triple } from '../color';
import type { RGB, Sample } from '../chart';

/** 色域泵：P3→sRGB 的矩阵，非对角项会让饱和色越界、某个通道被夹到 0 */
const PUMP = [
  1.2249, -0.2247, 0.0,
  -0.042, 1.0419, 0.0,
  -0.0197, -0.0786, 1.0983,
];

/**
 * 环境光：**加在色域变换之前**，这一点很关键。
 * 真实 Keynote 里灰阶 0 会被抬到 15，但饱和黄的蓝通道是实打实的 0 ——
 * 说明黑位抬升发生在夹断之前，被夹掉的通道抬不回来。
 * 要是把抬升做在最后一步，被夹断的通道也会跟着变亮，那就模拟不出真实行为了。
 */
const AMBIENT = 0.021;

/** S 型色调曲线：白只能到 0.88 —— 和真实测到的 225 是一个量级 */
const tone = (v: number) => 0.88 * (3 * v * v - 2 * v * v * v);

/** 送一个颜色进去，返回它「显示出来」会是什么（0..1） */
export function fakeKeynote(x: Triple): Triple {
  const l = [
    srgbToLinear(x[0]) + AMBIENT,
    srgbToLinear(x[1]) + AMBIENT,
    srgbToLinear(x[2]) + AMBIENT,
  ];
  const out: Triple = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = PUMP[c * 3] * l[0] + PUMP[c * 3 + 1] * l[1] + PUMP[c * 3 + 2] * l[2];
    // 色域变换会把饱和色推出界，负的部分在这里被夹掉 —— 夹掉就再也回不来了
    out[c] = tone(linearToSrgb(Math.max(0, Math.min(1, p))));
  }
  return out;
}

/** 0..255 进、0..255 出 */
export function fakeKeynote255(r: number, g: number, b: number): RGB {
  return fakeKeynote([r / 255, g / 255, b / 255]).map((v) => Math.round(v * 255)) as RGB;
}

/** 一张颜色够散的「色卡」，用来喂给 fitChart */
export function fakeChartSamples(): Sample[] {
  const patches: RGB[] = [];
  for (const v of [0, 36, 73, 109, 146, 182, 219, 255]) patches.push([v, v, v]);
  for (const r of [0, 128, 255])
    for (const g of [0, 128, 255])
      for (const b of [0, 128, 255]) {
        if (r === g && g === b) continue;
        patches.push([r, g, b]);
      }
  patches.push(
    [230, 180, 160], [200, 150, 130], [253, 190, 46], [240, 120, 40],
    [163, 21, 3], [120, 30, 20], [70, 130, 180], [100, 170, 220],
    [120, 180, 90], [60, 120, 50], [150, 80, 180], [90, 60, 120],
  );
  patches.push([200, 60, 60], [64, 0, 0], [0, 64, 0], [0, 0, 64], [192, 64, 0], [64, 32, 16]);
  return patches.map((p) => ({ ref: p, got: fakeKeynote255(p[0], p[1], p[2]) }));
}

/** 某个目标色在假 Keynote 里到底做不做得出来（有些颜色物理上不可达） */
export function reachError(target: RGB, step = 5): number {
  let best = Infinity;
  for (let r = 0; r <= 255; r += step)
    for (let g = 0; g <= 255; g += step)
      for (let b = 0; b <= 255; b += step) {
        const y = fakeKeynote255(r, g, b);
        const e = Math.max(
          Math.abs(y[0] - target[0]),
          Math.abs(y[1] - target[1]),
          Math.abs(y[2] - target[2]),
        );
        if (e < best) best = e;
      }
  return best;
}
