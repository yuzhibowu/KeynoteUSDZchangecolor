/**
 * 色卡标定。
 *
 * 逐通道曲线修不了色域错位（那是通道之间的混合），靠肉眼猜更是不可能。
 * 所以：导一张已知颜色的色卡进 Keynote，截图传回来，直接量出
 * 「送进去什么颜色 → 出来什么颜色」这 24 组对应关系，再解一个线性光下的仿射模型
 *   y = M · x + b      （M 是 3×3，x、y 是线性光 RGB）
 * 这个模型能同时吃下色域错位（M 的非对角项）、曝光（M 的对角项）和环境光抬升（b）。
 */

export type RGB = [number, number, number];

/** 色卡外框用品红：R 高、B 高、G 低，偏色之后这个特征依然成立，好认 */
const FRAME: RGB = [255, 0, 255];
const FRAME_RATIO = 0.05; // 外框厚度占整张卡宽度的比例
const GUTTER_RATIO = 0.012; // 色块之间的黑缝
export const COLS = 10;
export const ROWS = 7;

/**
 * 前 50 个是固定的基准色；剩下的格子是动态的 —— 导出色卡时会填入
 * 「你自己图片里的代表色经过补偿之后要写进贴图的实际值」。
 *
 * 这一行很关键：24 个通用色块在色彩空间里很稀疏，黄色系只有一个样本，
 * 它的蓝通道还被压到了 0，往上一个有蓝的样本直接跳到 160 —— 中间一大段全靠外推。
 * 而补偿值往往正好落在这种盲区里。把实际要用的值放进色卡，模型就能在真正
 * 需要精度的地方拿到真实数据。
 */
const BASE_PATCHES: RGB[] = (() => {
  const out: RGB[] = [];
  // 灰阶 8 级
  for (const v of [0, 36, 73, 109, 146, 182, 219, 255]) out.push([v, v, v]);
  // 色彩立方体 3×3×3，去掉三个中性点（灰阶那行已有）
  for (const r of [0, 128, 255])
    for (const g of [0, 128, 255])
      for (const b of [0, 128, 255]) {
        if (r === g && g === b) continue;
        out.push([r, g, b]);
      }
  // 记忆色 + 常见素材色
  const memory: RGB[] = [
    [230, 180, 160], [200, 150, 130], [253, 190, 46], [240, 120, 40],
    [163, 21, 3], [120, 30, 20], [70, 130, 180], [100, 170, 220],
    [120, 180, 90], [60, 120, 50], [150, 80, 180], [90, 60, 120],
  ];
  out.push(...memory);
  // 暗部补点 —— 之前栽在这里：最暗的彩色样本是 128 级，再往下直接跳到纯黑，
  // 中间一大段全靠插值，暗红暗蓝这类颜色就补歪了
  out.push([200, 60, 60], [64, 0, 0], [0, 64, 0], [0, 0, 64], [192, 64, 0], [64, 32, 16]);
  return out;
})();

const DEFAULT_EXTRA: RGB[] = [
  [255, 200, 70], [250, 170, 90], [200, 150, 200], [150, 200, 220], [110, 110, 110],
  [180, 160, 130], [140, 120, 95], [100, 90, 75], [70, 62, 52], [45, 40, 34],
  [210, 195, 165], [165, 150, 120], [125, 108, 85], [88, 76, 60], [55, 48, 38],
  [190, 175, 200], [130, 145, 160], [95, 105, 115], [60, 68, 76],
];

/** 除去 50 个固定基准色块和最后那个对齐校验格，剩下的都给动态探针 */
export const EXTRA_SLOTS = COLS * ROWS - 50 - 1;

const EXTRA_KEY = 'prism-usdz-exporter/chart-extra';

/** 导出色卡时记下动态那一行，上传截图时要用同一份基准值来比对 */
export function setChartExtra(extra: RGB[]) {
  try {
    localStorage.setItem(EXTRA_KEY, JSON.stringify(extra.slice(0, EXTRA_SLOTS)));
  } catch {
    /* 忽略 */
  }
}

function getChartExtra(): RGB[] {
  try {
    const raw = localStorage.getItem(EXTRA_KEY);
    if (!raw) return DEFAULT_EXTRA;
    const v = JSON.parse(raw) as RGB[];
    if (!Array.isArray(v) || v.length === 0) return DEFAULT_EXTRA;
    return v;
  } catch {
    return DEFAULT_EXTRA;
  }
}

/**
 * 最后一格永远放一个和第 4 格相同的灰 —— 一头一尾放同一个颜色，
 * 量出来对不上就说明取样错位了。灰阶自检只覆盖第一行，最后一行的错位得靠它抓。
 */
const ALIGN_CHECK: RGB = [146, 146, 146];
const ALIGN_REF_INDEX = 4; // 灰阶第 5 格 = 146

export function chartPatches(): RGB[] {
  const extra = getChartExtra();
  const filled = [...extra];
  while (filled.length < EXTRA_SLOTS) filled.push(extra[filled.length % extra.length] ?? [128, 128, 128]);
  return [...BASE_PATCHES, ...filled.slice(0, EXTRA_SLOTS), ALIGN_CHECK];
}

export function drawChart(canvas: HTMLCanvasElement, size = 1024) {
  const w = size;
  const h = Math.round((size * ROWS) / COLS);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `rgb(${FRAME.join(',')})`;
  ctx.fillRect(0, 0, w, h);
  const fx = w * FRAME_RATIO;
  const fy = h * FRAME_RATIO;
  const iw = w - fx * 2;
  const ih = h - fy * 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(fx, fy, iw, ih);
  // 横缝按宽度算、竖缝按高度算 —— 色卡贴到不同宽高比的面上会被非等比拉伸，
  // 两个方向必须各用各的维度，否则取样位置会整体偏移（踩过这个坑）
  const gx = w * GUTTER_RATIO;
  const gy = h * GUTTER_RATIO;
  const cw = (iw - gx * (COLS + 1)) / COLS;
  const ch = (ih - gy * (ROWS + 1)) / ROWS;
  chartPatches().forEach((p, i) => {
    const c = i % COLS;
    const r = (i / COLS) | 0;
    ctx.fillStyle = `rgb(${p.join(',')})`;
    ctx.fillRect(fx + gx + c * (cw + gx), fy + gy + r * (ch + gy), cw, ch);
  });
}

const MISALIGNED =
  '色卡取样对不上。请重新点「导出色卡棱柱」拿一张新色卡（排版更新过，旧色卡不能用），正对着重截一张图';

export type Sample = { ref: RGB; got: RGB };
export type SampleResult = { ok: boolean; reason?: string; samples: Sample[] };

/** 从 Keynote 截图里找到品红外框，按已知版式量出每个色块的实际颜色 */
export function sampleChart(shot: ImageBitmap): SampleResult {
  const w = shot.width;
  const h = shot.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(shot, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r > 90 && b > 90 && g < 0.62 * Math.min(r, b)) {
        count++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count < w * h * 0.005 || x1 <= x0 || y1 <= y0) {
    return { ok: false, reason: '没在截图里找到色卡的品红外框，确认截图里能看到完整的色卡', samples: [] };
  }

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const fx = bw * FRAME_RATIO;
  const fy = bh * FRAME_RATIO;
  const iw = bw - fx * 2;
  const ih = bh - fy * 2;
  const gx = bw * GUTTER_RATIO;
  const gy = bh * GUTTER_RATIO;
  const cw = (iw - gx * (COLS + 1)) / COLS;
  const ch = (ih - gy * (ROWS + 1)) / ROWS;
  if (cw < 3 || ch < 3) {
    return { ok: false, reason: '截图里的色卡太小了，放大一点再截', samples: [] };
  }

  const samples: Sample[] = chartPatches().map((ref, i) => {
    const c = i % COLS;
    const r = (i / COLS) | 0;
    const px = x0 + fx + gx + c * (cw + gx);
    const py = y0 + fy + gy + r * (ch + gy);
    // 只取色块中间 50%，避开边缘的抗锯齿和压缩噪点
    const sx = Math.round(px + cw * 0.25);
    const sy = Math.round(py + ch * 0.25);
    const sw = Math.max(1, Math.round(cw * 0.5));
    const sh = Math.max(1, Math.round(ch * 0.5));
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i2 = (y * w + x) * 4;
        sr += d[i2];
        sg += d[i2 + 1];
        sb += d[i2 + 2];
        n++;
      }
    }
    return { ref, got: (n ? [sr / n, sg / n, sb / n] : [0, 0, 0]) as RGB };
  });

  // 自检一：灰阶那一行必须单调递增，不单调说明第一行就错位了
  const grays = samples.slice(0, 8).map((s) => (s.got[0] + s.got[1] + s.got[2]) / 3);
  for (let i = 1; i < grays.length; i++) {
    if (grays[i] < grays[i - 1] - 12) {
      return { ok: false, reason: MISALIGNED, samples: [] };
    }
  }

  // 自检二：一头一尾那两个相同的灰必须量出相同的值。灰阶自检只管第一行，
  // 最后一行的错位（色卡被非等比拉伸时最容易出）只有靠这个才能抓到。
  const a = samples[ALIGN_REF_INDEX].got;
  const b = samples[samples.length - 1].got;
  if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 18) {
    return { ok: false, reason: MISALIGNED, samples: [] };
  }

  return { ok: true, samples };
}

// ---- 解模型 ----

/**
 * 模型建在 sRGB 编码空间，不是线性光空间。
 * 拿真实测量数据验过：线性空间拟合的残差 27.2 阶，比不校正的 23.8 阶还差
 * （线性空间里亮样本权重过大，暗部编码回来误差被放大）；编码空间是 12.4 阶。
 */
const dec = (v: number) => v / 255;

/** 解 n 元线性方程组（高斯消元，带部分主元） */
function solve(A: number[][], y: number[]): number[] | null {
  const n = y.length;
  const m = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = m[i][n] / m[i][i];
  return out;
}

/** 曲线节点数。5 个是交叉验证选出来的：更多节点在这 24 个色块上会过拟合。 */
export const CURVE_K = 5;

export type ChartFit = {
  matrix: number[];
  offset: RGB;
  /** 矩阵之后的每通道单调分段线性曲线，CURVE_K 个节点均匀分布在 0..1 */
  curve: number[][];
  rms: number;
  clipped: number;
};

const pwEval = (t: number, y: number[]) => {
  if (t <= 0) return y[0];
  if (t >= 1) return y[CURVE_K - 1];
  const s = t * (CURVE_K - 1);
  const i = Math.min(CURVE_K - 2, Math.floor(s));
  return y[i] * (1 - (s - i)) + y[i + 1] * (s - i);
};

const pwBasis = (t: number) => {
  const r = new Array(CURVE_K).fill(0);
  if (t <= 0) {
    r[0] = 1;
    return r;
  }
  if (t >= 1) {
    r[CURVE_K - 1] = 1;
    return r;
  }
  const s = t * (CURVE_K - 1);
  const i = Math.min(CURVE_K - 2, Math.floor(s));
  r[i] = 1 - (s - i);
  r[i + 1] = s - i;
  return r;
};

/** 单调分段线性求逆 */
export function pwInvert(y: number, ys: number[]): number {
  if (y <= ys[0]) return 0;
  if (y >= ys[CURVE_K - 1]) return 1;
  for (let i = 0; i < CURVE_K - 1; i++) {
    if (y <= ys[i + 1]) {
      const d = ys[i + 1] - ys[i];
      return (i + (d > 1e-9 ? (y - ys[i]) / d : 0)) / (CURVE_K - 1);
    }
  }
  return 1;
}

function ridge(rows: number[][], ys: number[], reg: number, ws?: number[]): number[] | null {
  const n = rows[0].length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Aty = new Array(n).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const w = ws ? ws[i] : 1;
    if (w <= 0) continue;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) AtA[a][b] += w * rows[i][a] * rows[i][b];
      Aty[a] += w * rows[i][a] * ys[i];
    }
  }
  for (let a = 0; a < n; a++) AtA[a][a] += reg;
  return solve(AtA, Aty);
}

/**
 * 模型：先过 3×3 矩阵（吃色域错位和通道混合），再过每通道一条单调曲线（吃 Keynote 的 S 型明暗曲线）。
 * 两级交替迭代拟合。被夹到 0 / 255 的样本对该通道没有信息量，剔掉。
 *
 * 为什么是这个结构、为什么曲线只用 5 个节点，是拿真实测量数据交叉验证选出来的：
 *   不校正 23.8 阶 / 纯矩阵 17.9 / 二次多项式 38.0（过拟合）/ 矩阵+曲线 13.9
 */
export function fitChart(samples: Sample[]): ChartFit | null {
  const usable = (s: Sample, c: number) => s.got[c] > 1.5 && s.got[c] < 253.5;
  let clipped = 0;
  for (const s of samples) for (let c = 0; c < 3; c++) if (!usable(s, c)) clipped++;

  const matrix = new Array(9).fill(0);
  const offset: RGB = [0, 0, 0];
  const rows3 = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  const curve = [0, 1, 2].map(() => Array.from({ length: CURVE_K }, (_, i) => i / (CURVE_K - 1)));

  // 被夹到 0 / 255 的样本不能扔 —— 「这个值被压到了 0」本身就是强信息，
  // 扔掉会让模型低估压制力度。改成单边约束参与迭代。
  for (let iter = 0; iter < 25; iter++) {
    for (let c = 0; c < 3; c++) {
      const rows: number[][] = [];
      const ys: number[] = [];
      const ws: number[] = [];
      for (const s of samples) {
        const row = [dec(s.ref[0]), dec(s.ref[1]), dec(s.ref[2]), 1];
        const m = rows3[c];
        const pred = pwEval(
          Math.max(0, Math.min(1, m[0] * row[0] + m[1] * row[1] + m[2] * row[2] + m[3])),
          curve[c],
        );
        rows.push(row);
        if (usable(s, c)) {
          ys.push(pwInvert(dec(s.got[c]), curve[c]));
          ws.push(1);
        } else if (s.got[c] <= 1.5) {
          // 被压到 0：只有当模型预测「没压到 0」时才施加约束（单边）
          ys.push(pwInvert(dec(0.5), curve[c]));
          ws.push(pred > 0.004 ? 1 : 0);
        } else {
          ys.push(pwInvert(dec(254.5), curve[c]));
          ws.push(pred < 0.996 ? 1 : 0);
        }
      }
      if (ws.filter((w) => w > 0).length < 6) return null;
      const p = ridge(rows, ys, 1e-7, ws);
      if (!p) return null;
      rows3[c] = p;
    }
    for (let c = 0; c < 3; c++) {
      const rows: number[][] = [];
      const ys: number[] = [];
      for (const s of samples) {
        const m = rows3[c];
        const p = m[0] * dec(s.ref[0]) + m[1] * dec(s.ref[1]) + m[2] * dec(s.ref[2]) + m[3];
        rows.push(pwBasis(Math.max(0, Math.min(1, p))));
        ys.push(usable(s, c) ? dec(s.got[c]) : s.got[c] <= 1.5 ? 0.002 : 0.998);
      }
      const y = ridge(rows, ys, 1e-3);
      if (!y) return null;
      for (let i = 1; i < CURVE_K; i++) y[i] = Math.max(y[i], y[i - 1] + 2e-3); // 强制单调，才能求逆
      curve[c] = y;
    }
  }

  let se = 0;
  let n = 0;
  for (let c = 0; c < 3; c++) {
    const m = rows3[c];
    matrix[c * 3] = m[0];
    matrix[c * 3 + 1] = m[1];
    matrix[c * 3 + 2] = m[2];
    offset[c] = m[3];
    for (const s of samples) {
      if (!usable(s, c)) continue;
      const p = m[0] * dec(s.ref[0]) + m[1] * dec(s.ref[1]) + m[2] * dec(s.ref[2]) + m[3];
      se += (pwEval(Math.max(0, Math.min(1, p)), curve[c]) - dec(s.got[c])) ** 2;
      n++;
    }
  }
  return { matrix, offset, curve, rms: Math.sqrt(se / Math.max(1, n)), clipped };
}
