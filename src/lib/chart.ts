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
/**
 * 13 × 9 = 117 格。比例 1.44，和棱柱侧面的 1.41 几乎一样，格子不会被拉扁。
 *
 * 原来是 10 × 7 = 70 格，色彩立方体只有 3×3×3 —— 相邻样本差 128 阶，
 * 高饱和区整段没有实测支撑。实测下来这是「蓝色系画面在 Keynote 里发黄」的根源：
 * 一张蓝图的主色离最近的锚点有 60 阶开外，而局部修正的作用半径只有 18 阶，
 * 等于整张图全靠 27 个参数的全局公式外推，而 Keynote 在蓝色区间的行为极陡且不一致
 * （0,0,128 被推成 29,45,230，红绿从 0 抬到 29/45；隔壁 0,128,255 的红反而被压到 0）。
 */
export const COLS = 13;
export const ROWS = 9;

/**
 * 前 BASE_COUNT 个是固定的基准色；剩下的格子是动态的 —— 导出色卡时会填入
 * 「你自己图片里的代表色经过补偿之后要写进贴图的实际值」。
 *
 * 这一行很关键：24 个通用色块在色彩空间里很稀疏，黄色系只有一个样本，
 * 它的蓝通道还被压到了 0，往上一个有蓝的样本直接跳到 160 —— 中间一大段全靠外推。
 * 而补偿值往往正好落在这种盲区里。把实际要用的值放进色卡，模型就能在真正
 * 需要精度的地方拿到真实数据。
 */
/**
 * 灰阶级数。**别在别处写死它的长度或某一格的下标。**
 *
 * 踩过一次：白点探测写的是 `samples[5]`，那是灰阶还只有 6 级
 * （0/51/102/153/204/255）时的写法，第 6 格正好是纯白。后来加密到 8 级，
 * 255 挪到了下标 7，而那句话没跟着改，于是它一直在报 182 那一格的读数，
 * 还附赠一句「想再高就把补光往上调」—— 补光调到 100% 那个数也不会动，
 * 因为它压根不是白点。查这个坑花了两轮。
 */
export const GRAYS: number[] = [0, 36, 73, 109, 146, 182, 219, 255];
/** 纯白那一格在 chartPatches() 里的下标 —— 灰阶排在最前面，所以就是最后一级 */
export const WHITE_INDEX = GRAYS.length - 1;

const BASE_PATCHES: RGB[] = (() => {
  const out: RGB[] = [];
  for (const v of GRAYS) out.push([v, v, v]);
  // 色彩立方体 4×4×4，去掉四个中性点（灰阶那行已有）。
  // 3×3×3 的 128 阶间距太粗，高饱和色全落在样本之间的空档里；85 阶密一档。
  const CUBE = [0, 85, 170, 255];
  for (const r of CUBE)
    for (const g of CUBE)
      for (const b of CUBE) {
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

/** 固定基准色块的个数 —— 别写死，立方体一加密它就变了 */
export const BASE_COUNT = BASE_PATCHES.length;

/** 除去固定基准色块和最后那个对齐校验格，剩下的都给动态探针 */
export const EXTRA_SLOTS = COLS * ROWS - BASE_COUNT - 1;

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
const ALIGN_REF_INDEX = 4; // 灰阶第 5 格
const ALIGN_CHECK: RGB = [GRAYS[ALIGN_REF_INDEX], GRAYS[ALIGN_REF_INDEX], GRAYS[ALIGN_REF_INDEX]];

export function chartPatches(): RGB[] {
  const extra = getChartExtra();
  const filled = [...extra];
  while (filled.length < EXTRA_SLOTS) filled.push(extra[filled.length % extra.length] ?? [128, 128, 128]);
  return [...BASE_PATCHES, ...filled.slice(0, EXTRA_SLOTS), ALIGN_CHECK];
}

/**
 * 从直方图里挑出**覆盖整张图明暗分布**的代表色，而不是「像素最多的前几个」。
 *
 * 只取 top-N 会栽得很惨：照片里像素最多的往往是阴影和黑背景，于是探针格全是
 * 又暗又接近的颜色（实测采到过 0,2,0 / 4,7,1 / 12,12,5 这种），而真正看得见、
 * 误差也最大的中间调和亮部一个都没测到 —— 标定完等于没标。
 *
 * 改成加权最远点采样：既要离已选的点足够远（保证铺开），又要足够常见（不去测噪点）。
 */
export function pickCovering(hist: Map<number, number>, n: number): RGB[] {
  const items = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 600) // 只在够常见的颜色里挑，避开孤立噪点
    .map(([k, w]) => ({
      rgb: [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4] as RGB,
      w,
    }));
  const picked: RGB[] = [];
  while (picked.length < n && items.length > 0) {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < items.length; i++) {
      let d2 = Infinity;
      for (const p of picked) {
        const e =
          (items[i].rgb[0] - p[0]) ** 2 + (items[i].rgb[1] - p[1]) ** 2 + (items[i].rgb[2] - p[2]) ** 2;
        if (e < d2) d2 = e;
      }
      // 第一个点直接按常见程度挑
      const far = picked.length === 0 ? 1 : Math.sqrt(d2);
      const score = far * Math.log1p(items[i].w);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    picked.push(items[best].rgb);
    items.splice(best, 1);
  }
  return picked;
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

type Pt = { x: number; y: number };

/**
 * 单位正方形 → 任意凸四边形的透视映射（Heckbert 的闭式解）。
 *
 * 为什么需要它：色卡是贴在 3D 棱柱上的，截图里那一面只要不是**严格**正对镜头就是个梯形。
 * 原来是拿品红像素的包围盒去均分格子，等于假设它永远是正矩形 —— 实测偏转超过 10°、
 * 俯仰超过 10° 就整体错位，直接报「取样对不上」。靠手转到 10° 以内基本靠运气，
 * 这就是标定反复失败的真正原因。改成从四个角解透视，几十度都不带歪的。
 *
 * 角点顺序：p[0]→(0,0)、p[1]→(1,0)、p[2]→(1,1)、p[3]→(0,1)。
 */
function perspective(p: Pt[]): (u: number, v: number) => Pt {
  const [p0, p1, p2, p3] = p;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(den) > 1e-9 && (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9)) {
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const dd = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (dd * u + e * v + f) / w };
  };
}

/** 从 Keynote 截图里找到品红外框，按已知版式量出每个色块的实际颜色 */
export function sampleChart(shot: ImageBitmap): SampleResult {
  const w = shot.width;
  const h = shot.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(shot, 0, 0);
  return sampleChartPixels(ctx.getImageData(0, 0, w, h).data, w, h);
}

/**
 * 取样的真身：只吃像素数组，不碰 DOM。
 *
 * 拆出来是为了能测 —— 这块（角点检测、透视校正、内区定位）是整个项目里返工最多的地方，
 * 却一直零测试覆盖，只能靠人在浏览器里手动转角度试。现在测试可以直接合成像素喂进来。
 */
export function sampleChartPixels(d: Uint8ClampedArray, w: number, h: number): SampleResult {

  // 品红像素的四个「极点」。取 x+y / x−y 的极值，等于沿着四条 45° 方向找最外面的点 ——
  // 对于一个被透视压成梯形的矩形，这四个点就是它的四个角。包围盒做不到这一点：
  // 梯形的外接矩形比梯形本身大，格子按它均分必然整体偏。
  let count = 0;
  let tl: Pt | null = null;
  let br: Pt | null = null;
  let tr: Pt | null = null;
  let bl: Pt | null = null;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDif = Infinity;
  let maxDif = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r > 90 && b > 90 && g < 0.62 * Math.min(r, b)) {
        count++;
        const sum = x + y;
        const dif = x - y;
        if (sum < minSum) { minSum = sum; tl = { x, y }; }
        if (sum > maxSum) { maxSum = sum; br = { x, y }; }
        if (dif > maxDif) { maxDif = dif; tr = { x, y }; }
        if (dif < minDif) { minDif = dif; bl = { x, y }; }
      }
    }
  }
  const x0 = tl && bl ? Math.min(tl.x, bl.x) : 0;
  const y0 = tl && tr ? Math.min(tl.y, tr.y) : 0;
  const x1 = tr && br ? Math.max(tr.x, br.x) : -1;
  const y1 = bl && br ? Math.max(bl.y, br.y) : -1;
  if (count < w * h * 0.005 || x1 <= x0 || y1 <= y0) {
    return { ok: false, reason: '没在截图里找到色卡的品红外框，确认截图里能看到完整的色卡', samples: [] };
  }

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (!tl || !tr || !br || !bl || bw < 40 || bh < 40) {
    return { ok: false, reason: '截图里的色卡太小了，放大一点再截', samples: [] };
  }

  /**
   * 内区（黑底那一块）的四个角。**不要**从外框往里按 FRAME_RATIO 推算 ——
   * 那假设了「外框厚度永远是整张卡的 5%」，而人截图时经常会把外框裁掉一部分，
   * 四边还裁得不一样多。实测一张真实截图：左框只剩 2.3%、上框 3.8%，
   * 按 5% 推进去整张网格偏了半个格子，直接报「取样对不上」。
   * 内区边界是品红和黑底的交界，肉眼和算法都看得见，跟外框留多宽无关。
   */
  const outer = [tl, tr, br, bl];
  const inside = (x: number, y: number) => {
    for (let i = 0; i < 4; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % 4];
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
    }
    return true;
  };
  let itl: Pt | null = null;
  let ibr: Pt | null = null;
  let itr: Pt | null = null;
  let ibl: Pt | null = null;
  let iMinSum = Infinity;
  let iMaxSum = -Infinity;
  let iMinDif = Infinity;
  let iMaxDif = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r > 90 && b > 90 && g < 0.62 * Math.min(r, b)) continue; // 还是外框
      if (!inside(x, y)) continue;
      const sum = x + y;
      const dif = x - y;
      if (sum < iMinSum) { iMinSum = sum; itl = { x, y }; }
      if (sum > iMaxSum) { iMaxSum = sum; ibr = { x, y }; }
      if (dif > iMaxDif) { iMaxDif = dif; itr = { x, y }; }
      if (dif < iMinDif) { iMinDif = dif; ibl = { x, y }; }
    }
  }
  if (!itl || !itr || !ibr || !ibl) {
    return { ok: false, reason: '色卡里面是空的，确认截图里色卡完整', samples: [] };
  }

  // 内区四角 → 单位正方形。之后所有位置都在「内区自己的坐标系」里算，再映射回截图，
  // 梯形、旋转、非等比拉伸、外框被裁，全都自动被吃掉。
  const map = perspective([itl, itr, ibr, ibl]);

  // 格缝相对**内区**的比例（drawChart 里 gx 是相对整张卡算的，这里要换算过来）
  const GU = GUTTER_RATIO / (1 - FRAME_RATIO * 2);
  const cw = (1 - GU * (COLS + 1)) / COLS;
  const ch = (1 - GU * (ROWS + 1)) / ROWS;
  // 一个格子在截图上大概占几个像素 —— 太小就别量了，噪声会淹掉信号
  if (cw * bw < 3 || ch * bh < 3) {
    return { ok: false, reason: '截图里的色卡太小了，放大一点再截', samples: [] };
  }

  const N = 5; // 每个格子取 5×5 个点，落在中间 50% 里
  const samples: Sample[] = chartPatches().map((ref, i) => {
    const c = i % COLS;
    const r = (i / COLS) | 0;
    const u0 = GU + c * (cw + GU);
    const v0 = GU + r * (ch + GU);
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let a = 0; a < N; a++) {
      for (let b2 = 0; b2 < N; b2++) {
        // 只取色块中间 50%，避开边缘的抗锯齿和压缩噪点
        const u = u0 + cw * (0.25 + (0.5 * (a + 0.5)) / N);
        const v = v0 + ch * (0.25 + (0.5 * (b2 + 0.5)) / N);
        const q = map(u, v);
        const x = Math.round(q.x);
        const y = Math.round(q.y);
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
  const grays = samples.slice(0, GRAYS.length).map((s) => (s.got[0] + s.got[1] + s.got[2]) / 3);
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
