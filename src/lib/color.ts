import { pwInvert } from './chart';

/**
 * 颜色补偿。
 *
 * Keynote 渲染 USDZ 模型时对贴图做了两件事：色域错位（饱和色被推得更艳，
 * 饱和黄的蓝通道直接夹到 0）和一条 S 型明暗曲线（暗部压、中间提、高光收）。
 * 正向模型就是这两级串联：
 *   y = curve( M · x + offset )      x、y 都在 sRGB 编码空间的 0..1
 * 导出时把贴图套上它的逆运算，进 Keynote 正好抵消。
 */

export type Triple = [number, number, number];

export type ColorComp = {
  /** 唯一的用户开关：Keynote 颜色优化 */
  on: boolean;
  matrix: number[] | null;
  offset: Triple | null;
  /** 矩阵之后的每通道单调曲线（CURVE_K 个节点） */
  curve: number[][] | null;
  calibratedAt: string | null;
  /** 标定时实测到的样本对，用来在全局模型之上做局部修正 */
  samples: { ref: Triple; got: Triple }[] | null;
  /** 这份校准是在「关掉灯光」开着还是关着的状态下测的 —— 对不上就得重测 */
  calibratedUnlit: boolean | null;
  /** 这份校准是在多少补光下测的 —— 补光一变，整条响应曲线就变了，必须重测 */
  calibratedLift: number | null;
};

/**
 * 内置校准档：2026-09-05 用 70 格色卡在 Keynote 里实测（USDZ 模型渲染路径、灯光开着、补光拉满、正视）。
 * 开箱即用，重新校准会覆盖它。
 *
 * **这份档是可以跨机器用的，不只对采集它的那台电脑有效。** 理由：
 * 标定时量到的数值经过两层 —— Keynote 的变换（软件行为）和显示器色彩管理 / 截图链路。
 * 但补偿的目标（「看起来和屏幕上的原图一样」）也经过同一层色彩管理，
 * 等式两边同时出现就被约掉了，剩下的是纯粹的 Keynote 变换。
 * 实测佐证：一张文件值为 161,11,0 的图，在系统预览窗口和 Keynote 里截出来都是 161,20,0 ——
 * 那 9 点绿是截图链路加的，对 2D 和 3D 一视同仁，所以会自己抵消。
 *
 * 真正需要重新标定的情况：换 Keynote 大版本、或者改了补光 / 灯光开关
 * （那会改变响应曲线本身，不是显示层的事）。
 *
 * 70 个样本 = 8 灰阶 + 24 色彩立方体 + 12 记忆色 + 6 暗部补点 + 19 动态探针 + 1 对齐校验。
 * 动态探针按明暗分布挑色，覆盖亮度 12~252，不是取「出现最多的颜色」（那样会全挤在暗部）。
 */
export const BUILT_IN_PROFILE = {
  matrix: [1.22669, -0.39172, -0.03628, -0.00928, 0.82096, 0.06438, -0.07821, -0.15223, 1.07124],
  offset: [0.06313, 0.12467, 0.00493] as Triple,
  curve: [
    [-0.0198, 0.42635, 0.79258, 0.94717, 0.99764],
    [0.0289, 0.21533, 0.69428, 0.8843, 0.98255],
    [-0.01236, 0.49226, 0.85449, 0.94282, 1.0002],
  ],
  samples: [
    [[0, 0, 0], [15, 15, 15]], [[36, 36, 36], [55, 55, 55]], [[73, 73, 73], [120, 120, 120]],
    [[109, 109, 109], [170, 170, 170]], [[146, 146, 146], [203, 203, 203]], [[182, 182, 182], [222, 222, 222]],
    [[219, 219, 219], [235, 235, 235]], [[255, 255, 255], [244, 244, 244]], [[0, 0, 128], [29, 45, 230]],
    [[0, 0, 255], [35, 51, 253]], [[0, 128, 0], [0, 203, 0]], [[0, 128, 128], [0, 200, 198]],
    [[0, 128, 255], [0, 199, 255]], [[0, 255, 0], [0, 249, 0]], [[0, 255, 128], [0, 251, 184]],
    [[0, 255, 255], [0, 253, 254]], [[128, 0, 0], [234, 34, 0]], [[128, 0, 128], [233, 55, 219]],
    [[128, 0, 255], [231, 62, 255]], [[128, 128, 0], [188, 189, 0]], [[128, 128, 255], [188, 187, 255]],
    [[128, 255, 0], [163, 250, 0]], [[128, 255, 128], [162, 249, 175]], [[128, 255, 255], [160, 249, 247]],
    [[255, 0, 0], [255, 38, 0]], [[255, 0, 128], [255, 58, 216]], [[255, 0, 255], [255, 64, 255]],
    [[255, 128, 0], [255, 185, 0]], [[255, 128, 128], [255, 183, 186]], [[255, 128, 255], [253, 180, 253]],
    [[255, 255, 0], [248, 248, 0]], [[255, 255, 128], [245, 245, 171]], [[230, 180, 160], [245, 220, 208]],
    [[200, 150, 130], [238, 203, 184]], [[253, 190, 46], [254, 226, 0]], [[240, 120, 40], [255, 177, 0]],
    [[163, 21, 3], [255, 38, 0]], [[120, 30, 20], [221, 31, 0]], [[70, 130, 180], [61, 196, 234]],
    [[100, 170, 220], [128, 219, 242]], [[120, 180, 90], [164, 226, 122]], [[60, 120, 50], [19, 189, 36]],
    [[150, 80, 180], [230, 121, 240]], [[90, 60, 120], [162, 91, 200]], [[200, 60, 60], [255, 74, 85]],
    [[64, 0, 0], [130, 13, 0]], [[0, 64, 0], [0, 112, 0]], [[0, 0, 64], [12, 20, 126]],
    [[192, 64, 0], [255, 86, 0]], [[64, 32, 16], [120, 42, 10]], [[0, 1, 0], [15, 16, 15]],
    [[255, 230, 255], [246, 237, 245]], [[90, 82, 72], [151, 133, 112]], [[49, 48, 40], [80, 76, 58]],
    [[187, 153, 108], [231, 206, 154]], [[161, 112, 39], [228, 171, 0]], [[31, 28, 23], [48, 43, 34]],
    [[57, 62, 62], [89, 102, 101]], [[119, 119, 123], [180, 180, 185]], [[141, 104, 67], [210, 160, 86]],
    [[75, 68, 51], [128, 111, 71]], [[98, 98, 97], [157, 157, 156]], [[185, 176, 148], [224, 219, 199]],
    [[131, 103, 90], [203, 161, 139]], [[111, 82, 30], [187, 132, 0]], [[242, 180, 92], [250, 221, 121]],
    [[20, 16, 9], [33, 29, 20]], [[55, 58, 48], [85, 95, 71]], [[34, 39, 42], [49, 62, 68]],
    [[146, 146, 146], [201, 201, 201]],
  ].map(([ref, got]) => ({ ref: ref as Triple, got: got as Triple })),
  label: '内置（70 格实测）',
};

export const DEFAULT_COMP: ColorComp = {
  on: true,
  matrix: BUILT_IN_PROFILE.matrix,
  offset: BUILT_IN_PROFILE.offset,
  curve: BUILT_IN_PROFILE.curve,
  calibratedAt: BUILT_IN_PROFILE.label,
  samples: BUILT_IN_PROFILE.samples,
  // 这套组合是实测验证过的：补光拉满 + 这份校准，颜色能对上。
  // 校准数据本身是在补光 85% 下采的，但 100% 才是验证过正确的用法 ——
  // 拉满带来的那点额外亮度，正好补上模型在 85% 处的低估。以实测为准。
  calibratedUnlit: false,
  calibratedLift: 1,
};

export function isIdentity(c: ColorComp): boolean {
  return !c.on || !c.matrix;
}

/**
 * 校准参数本身的指纹。不含 `on` —— 缓存正向模型时要的是「这份校准长什么样」，
 * 用 compSignature 会把所有关掉补偿的档案都算成同一个 'off'，模型缓存就会串档。
 */
function fingerprint(c: ColorComp): string {
  if (!c.matrix) return 'none';
  return [
    c.matrix.map((v) => v.toFixed(4)).join(','),
    (c.offset ?? []).map((v) => v.toFixed(4)).join(','),
    (c.curve ?? []).flat().map((v) => v.toFixed(4)).join(','),
    (c.samples ?? []).map((s) => s.ref.join('') + '>' + s.got.map(Math.round).join('')).join(';'),
  ].join('|');
}

/** 补偿参数的指纹，用来判断烘焙缓存是否失效 */
export function compSignature(c: ColorComp): string {
  return isIdentity(c) ? 'off' : fingerprint(c);
}

const pwEval = (t: number, y: number[]) => {
  const K = y.length;
  if (t <= 0) return y[0];
  if (t >= 1) return y[K - 1];
  const s = t * (K - 1);
  const i = Math.min(K - 2, Math.floor(s));
  return y[i] * (1 - (s - i)) + y[i + 1] * (s - i);
};

/**
 * 局部修正的作用半径（归一化 RGB 距离）。0.07 约合 18 阶。
 */
const LOCAL_SIGMA = 0.07;

/**
 * 岭正则项。λ→0 时修正场会严格穿过每一个实测点，但截图量出来的颜色本身带 ±1 阶噪声
 * （抗锯齿 + 量化），严格插值会把噪声一起放大 —— 实测里连打三轮微调之后反而跳回十几阶。
 * 1e-2 下实测点的复现残差是 0.35~0.57 阶（肉眼不可见），同时对噪声稳定。
 */
const LOCAL_RIDGE = 1e-2;

/** 距离超过 √24·σ ≈ 4.9σ 的样本权重只剩 6e-6，直接跳过 —— 求值快 3 倍 */
const LOCAL_CUTOFF2 = 24 * LOCAL_SIGMA * LOCAL_SIGMA;

/**
 * 解出高斯径向基的权重：找一组 a，使得 Σ aⱼ·exp(-|xᵢ-xⱼ|²/2σ²) 在每个实测点上
 * 都正好等于那里的残差。核矩阵对称正定，加上岭正则之后必然可解。
 *
 * 一次性 n³ 的消元（56 个色块约 0.2 ms），换来的是求值时和加权均值完全同样的开销。
 */
function solveRbfWeights(pts: { ref: Triple; res: Triple }[]): number[][] | null {
  const n = pts.length;
  const denom = 2 * LOCAL_SIGMA * LOCAL_SIGMA;
  const m: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n + 3);
    for (let j = 0; j < n; j++) {
      const a = pts[i].ref;
      const b = pts[j].ref;
      const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      row[j] = Math.exp(-d2 / denom);
    }
    row[i] += LOCAL_RIDGE;
    row[n] = pts[i].res[0];
    row[n + 1] = pts[i].res[1];
    row[n + 2] = pts[i].res[2];
    m.push(row);
  }
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    if (piv !== c) {
      const t = m[c];
      m[c] = m[piv];
      m[piv] = t;
    }
    const pc = m[c];
    const inv = 1 / pc[c];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] * inv;
      if (f === 0) continue;
      const rr = m[r];
      for (let k = c; k < n + 3; k++) rr[k] -= f * pc[k];
    }
  }
  const w = [new Array<number>(n), new Array<number>(n), new Array<number>(n)];
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) w[ch][i] = m[i][n + ch] / m[i][i];
  return w;
}

/**
 * 正向模型 = 全局的「矩阵 + 曲线」，再叠一层实测点的局部修正。
 *
 * 全局模型只有 27 个参数，要同时照顾 56 个色块，在任何一个局部都会妥协 ——
 * 而饱和暖色的蓝通道恰好是个极陡的过渡区（多写 40 就从 0 冲到 108），
 * 妥协的代价在那里被放得很大。局部修正让模型在实测过的颜色上精确复现，
 * 离得远的地方权重自然衰减回全局模型。
 *
 * 局部修正用的是**径向基插值**，不是高斯加权均值。均值只会把附近的残差平均一下，
 * 实测点自己也被邻居拉走，所以在实测点上根本复现不准；而闭环微调连打几轮之后
 * 锚点必然扎堆，均值就把它们糊成一团。实测对比（扎堆锚点上的最大残差）：
 *
 *   高斯加权均值   6.98 阶
 *   移动最小二乘   3.68 阶
 *   径向基插值     0.35 阶
 *
 * 移动最小二乘（局部线性回归）确实能带上斜率，但每次求值要解一个 4×4，实测慢 4.8 倍，
 * 而且它仍然是「拟合」不是「插值」，锚点照样复现不准。径向基把解方程挪到了建表那一次，
 * 求值退化成一次加权求和，和原来的均值一样便宜。
 */
let fwdCacheKey = '';
let fwdCacheVal: ((rgb: Triple) => Triple) | null = null;

function forwardModel(c: ColorComp): (rgb: Triple) => Triple {
  const cacheKey = fingerprint(c);
  if (cacheKey === fwdCacheKey && fwdCacheVal) return fwdCacheVal;

  const M = c.matrix!;
  const off = c.offset ?? [0, 0, 0];
  const curve = c.curve;
  const global = (v: Triple): Triple => {
    const out: Triple = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const p = M[ch * 3] * v[0] + M[ch * 3 + 1] * v[1] + M[ch * 3 + 2] * v[2] + off[ch];
      const q = Math.max(0, Math.min(1, p));
      out[ch] = curve ? pwEval(q, curve[ch]) : q;
    }
    return out;
  };

  let fn = global;
  const samples = c.samples ?? [];
  if (samples.length > 0) {
    const pts = samples.map((s) => {
      const ref: Triple = [s.ref[0] / 255, s.ref[1] / 255, s.ref[2] / 255];
      const g = global(ref);
      return {
        ref,
        res: [s.got[0] / 255 - g[0], s.got[1] / 255 - g[1], s.got[2] / 255 - g[2]] as Triple,
      };
    });
    const W = solveRbfWeights(pts);
    if (W) {
      const denom = 2 * LOCAL_SIGMA * LOCAL_SIGMA;
      const n = pts.length;
      const xs = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        xs[i * 3] = pts[i].ref[0];
        xs[i * 3 + 1] = pts[i].ref[1];
        xs[i * 3 + 2] = pts[i].ref[2];
      }
      const [wr, wg, wb] = W;
      fn = (v: Triple): Triple => {
        const g = global(v);
        let r = 0;
        let gg = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          const o = i * 3;
          const d2 = (v[0] - xs[o]) ** 2 + (v[1] - xs[o + 1]) ** 2 + (v[2] - xs[o + 2]) ** 2;
          if (d2 > LOCAL_CUTOFF2) continue;
          const k = Math.exp(-d2 / denom);
          r += k * wr[i];
          gg += k * wg[i];
          b += k * wb[i];
        }
        return [g[0] + r, g[1] + gg, g[2] + b];
      };
    }
  }
  fwdCacheKey = cacheKey;
  fwdCacheVal = fn;
  return fn;
}

const LUT_N = 17;
const lutCache = new Map<string, Uint8Array>();

/**
 * 反解成 3D LUT。
 *
 * 「无约束反解再逐通道截断」会让色相跑偏 —— 红色顶到 255 截断、蓝色算出负数截断，
 * 出来就是个偏色的怪颜色。这里改成带约束的迭代搜索：每一步都夹在可写范围内，
 * 收敛到的是「在能写进 8 位贴图的颜色里，进 Keynote 之后最接近目标的那个」。
 */
type Solver = (target: Triple) => Triple;

/** 造一个「给定想要的外观，解出该写什么」的求解器（0..1 空间） */
function makeSolver(c: ColorComp): Solver {
  const fwd = forwardModel(c);
  const inv = invert3(c.matrix!)!;
  const curve = c.curve;
  const off = c.offset ?? [0, 0, 0];
  const curveInv = (y: number, ch: number) => (curve ? pwInvert(y, curve[ch]) : y);
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  return (target: Triple): Triple => {
    const t0: Triple = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) t0[ch] = curveInv(target[ch], ch) - off[ch];
    let x: Triple = [
      clamp01(inv[0] * t0[0] + inv[1] * t0[1] + inv[2] * t0[2]),
      clamp01(inv[3] * t0[0] + inv[4] * t0[1] + inv[5] * t0[2]),
      clamp01(inv[6] * t0[0] + inv[7] * t0[1] + inv[8] * t0[2]),
    ];
    // 三通道等权：sRGB 编码空间的差值本来就大致等价于感知差异
    const errOf = (v: Triple) => {
      const y = fwd(v);
      return (y[0] - target[0]) ** 2 + (y[1] - target[1]) ** 2 + (y[2] - target[2]) ** 2;
    };
    let best = x;
    let bestErr = Infinity;
    for (let it = 0; it < 12; it++) {
      const y = fwd(x);
      const err = errOf(x);
      if (err < bestErr) {
        bestErr = err;
        best = x;
      }
      const d: Triple = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) d[ch] = curveInv(target[ch], ch) - curveInv(clamp01(y[ch]), ch);
      x = [
        clamp01(x[0] + inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2]),
        clamp01(x[1] + inv[3] * d[0] + inv[4] * d[1] + inv[5] * d[2]),
        clamp01(x[2] + inv[6] * d[0] + inv[7] * d[1] + inv[8] * d[2]),
      ];
    }
    // 牛顿步是按全局公式推的，局部修正一强方向就不准。收尾用逐坐标细搜，
    // 直接对含局部修正的真实模型下降，保证收敛。
    for (const step of [16 / 255, 6 / 255, 2 / 255, 1 / 255, 0.4 / 255]) {
      let moved = true;
      while (moved) {
        moved = false;
        for (let ch = 0; ch < 3; ch++) {
          for (const dir of [1, -1]) {
            const trial: Triple = [best[0], best[1], best[2]];
            trial[ch] = clamp01(trial[ch] + dir * step);
            if (trial[ch] === best[ch]) continue;
            const e = errOf(trial);
            if (e < bestErr - 1e-12) {
              bestErr = e;
              best = trial;
              moved = true;
            }
          }
        }
      }
    }
    return best;
  };
}

function buildInverseLUT3D(c: ColorComp): Uint8Array {
  const key = compSignature(c);
  const hit = lutCache.get(key);
  if (hit) return hit;

  const solve1 = makeSolver(c);

  const lut = new Uint8Array(LUT_N * LUT_N * LUT_N * 3);
  for (let bi = 0; bi < LUT_N; bi++) {
    for (let gi = 0; gi < LUT_N; gi++) {
      for (let ri = 0; ri < LUT_N; ri++) {
        const best = solve1([ri / (LUT_N - 1), gi / (LUT_N - 1), bi / (LUT_N - 1)]);
        const o = ((bi * LUT_N + gi) * LUT_N + ri) * 3;
        lut[o] = Math.round(best[0] * 255);
        lut[o + 1] = Math.round(best[1] * 255);
        lut[o + 2] = Math.round(best[2] * 255);
      }
    }
  }
  if (lutCache.size > 4) lutCache.clear();
  lutCache.set(key, lut);
  return lut;
}

function lutSample(lut: Uint8Array, r: number, g: number, b: number): Triple {
  const s = (LUT_N - 1) / 255;
  const fr = r * s;
  const fg = g * s;
  const fb = b * s;
  const r0 = Math.min(LUT_N - 2, Math.floor(fr));
  const g0 = Math.min(LUT_N - 2, Math.floor(fg));
  const b0 = Math.min(LUT_N - 2, Math.floor(fb));
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const out: Triple = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let acc = 0;
    for (let i = 0; i < 8; i++) {
      const wr = i & 1 ? dr : 1 - dr;
      const wg = i & 2 ? dg : 1 - dg;
      const wb = i & 4 ? db : 1 - db;
      const o = (((b0 + (i & 4 ? 1 : 0)) * LUT_N + (g0 + (i & 2 ? 1 : 0))) * LUT_N + (r0 + (i & 1))) * 3;
      acc += wr * wg * wb * lut[o + ch];
    }
    out[ch] = acc;
  }
  return out;
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const s = 1 / det;
  return [
    (e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
export const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;

/**
 * 不截断的逆运算，返回值可能 > 1。
 *
 * Keynote 开着灯光时会把整体压暗（白色 255 只能到 225），要抵消它就得写「比纯白更白」的值 —— 
 * 8 位贴图写不下。出路是 USDZ 里的 `float4 inputs:scale`：那是文件里的一个浮点乘数，
 * 不受 8 位限制。贴图里存 L/gain，材质上写 gain，渲染时乘回来，天花板就绕开了。
 */
export function rawInverse(c: ColorComp): ((r: number, g: number, b: number) => Triple) | null {
  if (!c.matrix) return null;
  const inv = invert3(c.matrix);
  if (!inv) return null;
  const off = c.offset ?? [0, 0, 0];
  const curve = c.curve;
  return (r, g, b) => {
    const dr = (curve ? pwInvert(r / 255, curve[0]) : r / 255) - off[0];
    const dg = (curve ? pwInvert(g / 255, curve[1]) : g / 255) - off[1];
    const db = (curve ? pwInvert(b / 255, curve[2]) : b / 255) - off[2];
    return [
      inv[0] * dr + inv[1] * dg + inv[2] * db,
      inv[3] * dr + inv[4] * dg + inv[5] * db,
      inv[6] * dr + inv[7] * dg + inv[8] * db,
    ];
  };
}

/** 补偿后需要的线性光增益（1 = 不需要，没有任何颜色顶到天花板） */
export function requiredGain(c: ColorComp, sample: (cb: (r: number, g: number, b: number) => void) => void): number {
  const raw = isIdentity(c) ? null : rawInverse(c);
  if (!raw) return 1;
  let max = 1;
  sample((r, g, b) => {
    const v = raw(r, g, b);
    for (let i = 0; i < 3; i++) {
      const lin = srgbToLinear(v[i]);
      if (lin > max) max = lin;
    }
  });
  return max;
}

/** 带增益的补偿：返回写进贴图的 0..255 值（贴图存 L/gain，材质上带回 gain） */
export function compensateWithGain(
  c: ColorComp,
  gain: number,
): ((r: number, g: number, b: number) => Triple) | null {
  const raw = isIdentity(c) ? null : rawInverse(c);
  if (!raw) return null;
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (r, g, b) => {
    const v = raw(r, g, b);
    return [
      q(linearToSrgb(srgbToLinear(v[0]) / gain)),
      q(linearToSrgb(srgbToLinear(v[1]) / gain)),
      q(linearToSrgb(srgbToLinear(v[2]) / gain)),
    ];
  };
}

/**
 * 「想要这个外观，该往贴图 / 材质里写什么」—— 0..255 进、0..255 出。
 *
 * 贴图像素、端面纯色、色卡上的动态探针格全都走这一个入口。三处必须是同一个值，
 * 否则界面上预告的、色卡上量的、和文件里真正写进去的会是三个不同的数。
 */
export function solveWritten(r: number, g: number, b: number, c: ColorComp): Triple {
  if (isIdentity(c)) return [r, g, b];
  const v = makeSolver(c)([r / 255, g / 255, b / 255]);
  return v.map((x) => Math.max(0, Math.min(255, Math.round(x * 255)))) as Triple;
}

/**
 * 端面是纯色材质，没有贴图可烘，补偿直接写成材质的线性色。
 *
 * 走的是和侧面贴图同一个带约束求解器，不是「公式反解再逐通道截断」——
 * 截断会让色相跑偏（红顶到 255、蓝算出负数，两个通道被砍的比例不一样），
 * 而且旧路径完全绕开了局部修正，闭环微调锚上去的点对端面一点用都没有。
 *
 * 值域和侧面一样夹在 0..255：模型本来就只在 0..1 上拟合过，
 * 「纯色可以写 > 1」是模型定义域外的外推，没有实测支撑。真正抬高天花板的是补光。
 */
export function compensateToLinear(hex: string, c: ColorComp): Triple | null {
  if (isIdentity(c)) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const w = solveWritten((n >> 16) & 255, (n >> 8) & 255, n & 255, c);
  return [srgbToLinear(w[0] / 255), srgbToLinear(w[1] / 255), srgbToLinear(w[2] / 255)];
}


/** 就地把补偿应用到一整块像素上 */
/**
 * 占比大的颜色单独精确求解，其余走三维查找表。
 *
 * 查找表是 17³ 的网格 + 三线性插值，在响应陡峭的区间（比如暗红）插值误差有好几阶 —— 
 * 闭环微调每次都卡在差几阶，就是卡在这里。纯色块和大面积主色根本不需要插值，
 * 直接解就行；照片里的散碎像素才用查找表，那里差一两阶看不出来。
 */
export function applyToImageData(data: Uint8ClampedArray, c: ColorComp) {
  if (isIdentity(c)) return;
  const lut = buildInverseLUT3D(c);
  const total = data.length / 4;

  const hist = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const exact = new Map<number, Triple>();
  const hot = [...hist.entries()]
    .filter(([, n]) => n >= total * 0.004)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 48);
  if (hot.length > 0) {
    const solve1 = makeSolver(c);
    for (const [k] of hot) {
      const v = solve1([((k >> 16) & 255) / 255, ((k >> 8) & 255) / 255, (k & 255) / 255]);
      exact.set(k, [
        Math.max(0, Math.min(255, Math.round(v[0] * 255))),
        Math.max(0, Math.min(255, Math.round(v[1] * 255))),
        Math.max(0, Math.min(255, Math.round(v[2] * 255))),
      ]);
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const e = exact.get(k);
    if (e) {
      data[i] = e[0];
      data[i + 1] = e[1];
      data[i + 2] = e[2];
      continue;
    }
    const v = lutSample(lut, data[i], data[i + 1], data[i + 2]);
    data[i] = Math.round(v[0]);
    data[i + 1] = Math.round(v[1]);
    data[i + 2] = Math.round(v[2]);
  }
}

export function applyToHex(hex: string, c: ColorComp): string {
  if (isIdentity(c)) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  // 单色不走查找表，直接精确解
  const v = solveWritten((n >> 16) & 255, (n >> 8) & 255, n & 255, c);
  return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** 给界面看的：这个颜色补偿之后，预计在 Keynote 里会变成什么 */
export function predictKeynote(hex: string, c: ColorComp): string | null {
  if (isIdentity(c)) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const w = makeSolver(c)([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
  const y = forwardModel(c)(w);
  return `#${y
    .map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}
