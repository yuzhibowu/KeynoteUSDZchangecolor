import { describe, it, expect } from 'vitest';
import { COLS, ROWS, DENSE_COLS, DENSE_ROWS, DENSE_PAGES, GRAYS, chartPatches, densePatches, sampleChartPixels, type RGB } from './chart';

/**
 * 色卡识别的回归测试。
 *
 * 这块是整个项目里返工最多的地方，而且每次返工都要用户重新导一次色卡、重新截一次图
 * 才能发现改坏了没有 —— 前后白跑了四轮。这里把踩过的每一个坑都固化成用例：
 *
 *  1. 正对（基准）
 *  2. 梯形：色卡贴在 3D 棱柱上，没有严格正对镜头时就是这样。
 *     原来拿包围盒均分格子，等于假设它永远是正矩形，偏转超过 10° 就整体错位。
 *  3. 外框被裁：人截图时会把品红边框裁掉一部分，四边还裁得不一样多。
 *     原来从外框外沿按 FRAME_RATIO(5%) 往里推，实际只剩 2.3%，网格偏了半个格子。
 *  4. 非等比拉伸：色卡贴到不同宽高比的面上会被拉扁。
 *
 * 合成像素而不是真的渲染，所以不需要 canvas，也不依赖浏览器。
 */

const FRAME: RGB = [255, 0, 255];
const FRAME_RATIO = 0.05;
const GUTTER_RATIO = 0.012;

type Pt = { x: number; y: number };

/** 单位正方形 → 四边形（和 chart.ts 里那份同一个公式，测试独立实现一遍以免自证） */
function mapTo(p: Pt[]) {
  const [p0, p1, p2, p3] = p;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, hh = 0;
  if (Math.abs(den) > 1e-9 && (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9)) {
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const dd = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  return (u: number, v: number) => {
    const wq = g * u + hh * v + 1;
    return { x: (a * u + b * v + c) / wq, y: (dd * u + e * v + f) / wq };
  };
}

/**
 * 把一张色卡「画」进像素数组。corners 是整张卡四个角在画面里的位置，
 * 想要梯形、旋转、拉伸，改这四个点即可。
 * `crop` 表示外框被裁掉的比例（0 = 完整，0.5 = 外框只剩一半）。
 */
function render(
  w: number,
  h: number,
  corners: Pt[],
  patches: RGB[],
  opts: {
    crop?: number;
    cols?: number;
    rows?: number;
    /** 明暗梯度：按整张卡的坐标返回一个亮度系数，模拟「模型左上亮、右下暗」 */
    shade?: (U: number, V: number) => number;
    /** 行距漂移：画的时候行距比版式大一点，下面几行会一路漂，模拟非等比拉伸导致的错位 */
    pitch?: number;
  } = {},
): Uint8ClampedArray {
  const COLS = opts.cols ?? 13;
  const ROWS = opts.rows ?? 9;
  const d = new Uint8ClampedArray(w * h * 4);
  const map = mapTo(corners);
  // 外框被裁掉多少：crop=0 画面里是整张卡，crop=0.6 表示外框被裁掉 60%
  const cut = FRAME_RATIO * (opts.crop ?? 0);
  const put = (x: number, y: number, c: RGB) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const i = (yi * w + xi) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  };
  const inner = 1 - FRAME_RATIO * 2;
  const cw = (inner - GUTTER_RATIO * (COLS + 1)) / COLS;
  const ch = ((inner - GUTTER_RATIO * (ROWS + 1)) / ROWS) * (opts.pitch ?? 1);
  const steps = Math.max(w, h) * 3;
  for (let a = 0; a <= steps; a++) {
    for (let b = 0; b <= steps; b++) {
      const t = a / steps;
      const s2 = b / steps;
      // 画面参数 (t,s2) → 整张卡的坐标 (U,V)。被裁掉的那圈外框不在画面里。
      const U = cut + t * (1 - 2 * cut);
      const V = cut + s2 * (1 - 2 * cut);
      let col: RGB = FRAME;
      if (U >= FRAME_RATIO && U <= 1 - FRAME_RATIO && V >= FRAME_RATIO && V <= 1 - FRAME_RATIO) {
        col = [0, 0, 0]; // 内区底色 = 格缝
        const iu = U - FRAME_RATIO;
        const iv = V - FRAME_RATIO;
        const c = Math.floor((iu - GUTTER_RATIO) / (cw + GUTTER_RATIO));
        const r = Math.floor((iv - GUTTER_RATIO) / (ch + GUTTER_RATIO));
        if (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
          const x0 = GUTTER_RATIO + c * (cw + GUTTER_RATIO);
          const y0 = GUTTER_RATIO + r * (ch + GUTTER_RATIO);
          if (iu >= x0 && iu <= x0 + cw && iv >= y0 && iv <= y0 + ch) {
            col = patches[r * COLS + c];
          }
        }
      }
      const q = map(t, s2);
      const k = opts.shade ? opts.shade(U, V) : 1;
      put(q.x, q.y, k === 1 ? col : (col.map((v) => Math.round(v * k)) as RGB));
    }
  }
  return d;
}

/** 整张卡铺满画面时的四个角 */
const full = (w: number, h: number): Pt[] => [
  { x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 },
];

function maxErr(got: { ref: RGB; got: RGB }[], patches: RGB[]): number {
  let m = 0;
  got.forEach((s, i) => {
    for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(s.got[k] - patches[i][k]));
  });
  return m;
}

describe('色卡识别', () => {
  const patches = chartPatches();
  const W = 1300;
  const H = Math.round((W * ROWS) / COLS);

  it('正对：117 格全部量准', () => {
    const res = sampleChartPixels(render(W, H, full(W, H), patches), W, H);
    expect(res.ok).toBe(true);
    expect(res.samples.length).toBe(COLS * ROWS);
    expect(maxErr(res.samples, patches)).toBeLessThanOrEqual(2);
  });

  it('梯形（没有正对镜头）：仍然量准', () => {
    // 右边比左边窄 —— 典型的「面绕竖轴转了一个角度」
    const corners: Pt[] = [
      { x: 0, y: 0 }, { x: W - 1, y: H * 0.16 },
      { x: W - 1, y: H * 0.84 }, { x: 0, y: H - 1 },
    ];
    const res = sampleChartPixels(render(W, H, corners, patches), W, H);
    expect(res.ok).toBe(true);
    expect(maxErr(res.samples, patches)).toBeLessThanOrEqual(3);
  });

  it('外框被裁掉一大半：不再按固定比例往里推', () => {
    const res = sampleChartPixels(render(W, H, full(W, H), patches, { crop: 0.6 }), W, H);
    expect(res.ok).toBe(true);
    expect(maxErr(res.samples, patches)).toBeLessThanOrEqual(3);
  });

  it('非等比拉伸（贴到别的宽高比的面上）：仍然量准', () => {
    const w2 = Math.round(H * 2.1);
    const res = sampleChartPixels(render(w2, H, full(w2, H), patches), w2, H);
    expect(res.ok).toBe(true);
    expect(maxErr(res.samples, patches)).toBeLessThanOrEqual(3);
  });

  it('画面里没有色卡：给出「找不到外框」而不是崩掉', () => {
    const d = new Uint8ClampedArray(W * H * 4).fill(20);
    const res = sampleChartPixels(d, W, H);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('外框');
  });

  it('色卡太小：明确提示放大，而不是给出一堆噪声', () => {
    const w3 = 30, h3 = 20;
    const res = sampleChartPixels(render(w3, h3, full(w3, h3), patches), w3, h3);
    expect(res.ok).toBe(false);
  });

  /**
   * 2026-09-23 在无边记上抓到的误杀。
   *
   * 旧的自检二是「一头一尾两个同色灰格差超过 18 阶 = 错位」。可那两格分别在左上和右下，
   * 模型只要有明暗梯度，同一个颜色在两处本来就不一样。Keynote 一直没暴露是因为补光开得高，
   * 自发光把面压平了；补光一往下调（无边记不需要靠补光顶亮度，正该这么干），
   * 一张取样完全正确的截图就被判成错位，而且提示还让人「重新导一张色卡」—— 越导越错。
   *
   * 现在改用格内极差：真错位时取样窗会吃到黑缝，格子内部炸开上百阶；
   * 光照不均只是整格一起偏移，格内还是纯色。
   */
  it('模型左上亮右下暗：不许再误判成错位，而且要把光照不均量出来', () => {
    // 实拍那张的梯度：同一级灰左上量到 104、右下量到 83，约 0.8 倍
    const shade = (U: number, V: number) => 1 - 0.2 * ((U + V) / 2);
    const res = sampleChartPixels(render(W, H, full(W, H), patches, { shade }), W, H);
    expect(res.ok).toBe(true);
    expect(res.samples.length).toBe(COLS * ROWS);
    // 同色两格的差要如实报出来 —— 补光选档时拿它当指标
    expect(res.uneven).toBeGreaterThan(10);
  });

  it('光照均匀时，光照不均报出来接近 0', () => {
    const res = sampleChartPixels(render(W, H, full(W, H), patches), W, H);
    expect(res.ok).toBe(true);
    expect(res.uneven ?? 99).toBeLessThanOrEqual(2);
  });

  it('行距一路漂（非等比拉伸）：灰阶那一行还是对的，也必须抓住', () => {
    // 第一行完全正常，所以灰阶单调自检抓不到 —— 这正是当初要那条「一头一尾」检查的场景，
    // 换成格内极差之后必须照样抓住，否则就是把误杀改成了漏杀
    const res = sampleChartPixels(render(W, H, full(W, H), patches, { pitch: 1.07 }), W, H);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('没套准');
  });

  it('取样错位时自检要抓住 —— 灰阶乱序就必须报错', () => {
    // 把灰阶那一行打乱，模拟「网格偏了一格」
    const bad = [...patches];
    bad[0] = patches[7];
    bad[7] = patches[0];
    const res = sampleChartPixels(render(W, H, full(W, H), bad), W, H);
    expect(res.ok).toBe(false);
  });
});

describe('密集色卡', () => {
  const W = 1800;
  const H = Math.round((W * DENSE_ROWS) / DENSE_COLS);
  const keynote = (c: RGB): RGB => [
    Math.min(255, Math.round(c[0] * 1.1 + 10)),
    Math.round(c[1] * 0.9 + 12),
    Math.min(255, Math.round(c[2] * 1.05 + 5)),
  ];

  it('三张都能认出是第几页，颜色量准，灰阶/标记/校验格不进档', () => {
    for (let page = 0; page < DENSE_PAGES; page++) {
      const patches = densePatches(page);
      const shown = patches.map(keynote);
      const res = sampleChartPixels(render(W, H, full(W, H), shown, { cols: DENSE_COLS, rows: DENSE_ROWS }), W, H);
      expect(res.ok).toBe(true);
      expect(res.densePage).toBe(page);
      expect(res.samples.length).toBe(DENSE_COLS * DENSE_ROWS - 2);
      const body = patches.filter((_, i) => i !== GRAYS.length && i !== patches.length - 1);
      res.samples.forEach((s, i) => {
        expect(s.ref).toEqual(body[i]);
        const want = keynote(body[i]);
        for (let k = 0; k < 3; k++) expect(Math.abs(s.got[k] - want[k])).toBeLessThanOrEqual(2);
      });
    }
  });

  it('梯形也认得出页码', () => {
    const corners: Pt[] = [
      { x: 0, y: 0 }, { x: W - 1, y: H * 0.12 },
      { x: W - 1, y: H * 0.88 }, { x: 0, y: H - 1 },
    ];
    const patches = densePatches(2);
    const res = sampleChartPixels(render(W, H, corners, patches.map(keynote), { cols: DENSE_COLS, rows: DENSE_ROWS }), W, H);
    expect(res.ok).toBe(true);
    expect(res.densePage).toBe(2);
  });

  it('普通色卡不会被误认成密集页', () => {
    const patches = chartPatches();
    const Wn = 1300;
    const Hn = Math.round((Wn * ROWS) / COLS);
    const res = sampleChartPixels(render(Wn, Hn, full(Wn, Hn), patches.map(keynote)), Wn, Hn);
    expect(res.ok).toBe(true);
    expect(res.densePage).toBeUndefined();
    expect(res.samples.length).toBe(COLS * ROWS);
  });
});
