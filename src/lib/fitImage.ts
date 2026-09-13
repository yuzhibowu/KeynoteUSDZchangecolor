/**
 * 卡片「适应」：让卡片的比例和圆角跟着正面那张图走。
 *
 * 设计稿导出的 PNG 通常是「一张圆角卡片 + 四周透明留白」。要让它在 Keynote 里
 * 看起来就是那张卡，得做三件事：把透明留白裁掉、卡片比例按裁完的宽高来、
 * 圆角按图里的圆角来。这里只负责从像素里量出这三样，怎么用是 App 的事。
 */

export type AlphaBounds = { x0: number; y0: number; x1: number; y1: number };

export type FitInfo = {
  /** 不透明区域的包围盒（原图像素坐标，x1/y1 是开区间） */
  bounds: AlphaBounds;
  /** 裁完之后的宽高 */
  width: number;
  height: number;
  /** 圆角半径，单位是裁完之后的像素；直角图是 0 */
  cornerPx: number;
};

const OPAQUE = 128;

/**
 * 从一张 RGBA 像素数组里量：不透明包围盒 + 圆角半径。
 *
 * 圆角是沿四个角的**对角线**往里走量出来的：半径为 r 的圆角，从角点沿 45° 走到
 * 第一个不透明像素的距离 d = r·(1 − 1/√2)，反过来 r = d / (1 − 1/√2) ≈ 3.414·d。
 * 四个角取中位数 —— 抗一个角被阴影或水印污染。走到 0 就是直角。
 */
export function measureAlpha(d: Uint8ClampedArray, w: number, h: number): FitInfo | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < OPAQUE) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null; // 整张全透明
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const alpha = (x: number, y: number) => d[((y0 + y) * w + (x0 + x)) * 4 + 3];
  const maxWalk = Math.floor(Math.min(bw, bh) / 2);
  const walk = (sx: number, sy: number, dx: number, dy: number) => {
    for (let k = 0; k < maxWalk; k++) {
      if (alpha(sx + dx * k, sy + dy * k) >= OPAQUE) return k;
    }
    return maxWalk;
  };
  const ds = [
    walk(0, 0, 1, 1),
    walk(bw - 1, 0, -1, 1),
    walk(0, bh - 1, 1, -1),
    walk(bw - 1, bh - 1, -1, -1),
  ].sort((a, b) => a - b);
  const dMedian = (ds[1] + ds[2]) / 2;
  const r = dMedian / (1 - Math.SQRT1_2);
  return {
    bounds: { x0, y0, x1: x1 + 1, y1: y1 + 1 },
    width: bw,
    height: bh,
    cornerPx: Math.min(r, Math.min(bw, bh) / 2),
  };
}

/**
 * 量一张位图。大图先缩到 1024 宽再量（只是量包围盒和圆角，够用），结果按比例放回原图像素。
 */
export function measureBitmap(bmp: ImageBitmap): FitInfo | null {
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const m = measureAlpha(ctx.getImageData(0, 0, w, h).data, w, h);
  if (!m) return null;
  const up = (v: number) => v / k;
  const bounds = {
    x0: Math.max(0, Math.floor(up(m.bounds.x0))),
    y0: Math.max(0, Math.floor(up(m.bounds.y0))),
    x1: Math.min(bmp.width, Math.ceil(up(m.bounds.x1))),
    y1: Math.min(bmp.height, Math.ceil(up(m.bounds.y1))),
  };
  return {
    bounds,
    width: bounds.x1 - bounds.x0,
    height: bounds.y1 - bounds.y0,
    cornerPx: up(m.cornerPx),
  };
}

/** 按包围盒裁掉透明留白。整张都不透明就原样返回，不多复制一份 */
export async function trimToAlpha(bmp: ImageBitmap): Promise<{ bmp: ImageBitmap; info: FitInfo | null }> {
  const info = measureBitmap(bmp);
  if (!info) return { bmp, info: null };
  const { x0, y0, x1, y1 } = info.bounds;
  if (x0 === 0 && y0 === 0 && x1 === bmp.width && y1 === bmp.height) return { bmp, info };
  const cut = await createImageBitmap(bmp, x0, y0, x1 - x0, y1 - y0);
  return { bmp: cut, info };
}
