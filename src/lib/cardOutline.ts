/** 卡片适应使用的归一化轮廓。x 向右、y 向上，范围 0..1。 */
export type OutlinePoint = [number, number];
export type CardIsland = { outer: OutlinePoint[]; holes: OutlinePoint[][] };
export type CardOutline = CardIsland[];

const ALPHA_EDGE = 128;

function area(points: OutlinePoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function inside(p: OutlinePoint, polygon: OutlinePoint[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** 闭合折线简化：去掉像素阶梯，同时不挪动明显的凹角。 */
function simplify(points: OutlinePoint[], tolerance: number): OutlinePoint[] {
  if (points.length <= 4) return points;
  const sq = tolerance * tolerance;
  const distance = (p: OutlinePoint, a: OutlinePoint, b: OutlinePoint) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = dx * dx + dy * dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  };
  // 从相距最远的两个点切开环，避免在起点附近留下不必要的锯齿。
  let far = 1;
  for (let i = 2; i < points.length; i++) {
    const d = (p: OutlinePoint) => (p[0] - points[0][0]) ** 2 + (p[1] - points[0][1]) ** 2;
    if (d(points[i]) > d(points[far])) far = i;
  }
  const keep = new Set([0, far]);
  const run = (lo: number, hi: number) => {
    let best = sq;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distance(points[i % points.length], points[lo % points.length], points[hi % points.length]);
      if (d > best) { best = d; at = i; }
    }
    if (at >= 0) { keep.add(at % points.length); run(lo, at); run(at, hi); }
  };
  run(0, far);
  run(far, points.length);
  return points.filter((_, i) => keep.has(i));
}

/**
 * 从正面 alpha 提取真实边界。小孤点过滤掉，明显分开的图形和内部透明洞保留。
 * 传入的像素应是已裁去透明留白的正面图，长边建议先缩到最多 512 像素。
 */
export function outlineFromAlpha(rgba: Uint8ClampedArray, w: number, h: number): CardOutline | null {
  if (!w || !h || rgba.length < w * h * 4) return null;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] >= ALPHA_EDGE ? 1 : 0;
  // 过滤压缩噪点。采用四邻域，斜角只碰到一个像素的两块不会被误接成一块。
  const seen = new Uint8Array(mask.length);
  const components: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start];
    seen[start] = 1;
    for (let q = 0; q < pixels.length; q++) {
      const i = pixels[q];
      const x = i % w;
      const y = Math.floor(i / w);
      const neighbors = [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1];
      for (const n of neighbors) if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; pixels.push(n); }
    }
    components.push(pixels);
  }
  if (!components.length) return null;
  const largest = components.reduce((n, c) => Math.max(n, c.length), 0);
  const kept = new Uint8Array(mask.length);
  for (const c of components) if (c.length >= Math.max(2, largest * 0.001)) for (const i of c) kept[i] = 1;
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && kept[y * w + x] === 1;
  type Edge = { from: number; to: number; dir: number; used: boolean };
  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number, dir: number) => {
    const e = edges.length;
    const from = key(x0, y0);
    edges.push({ from, to: key(x1, y1), dir, used: false });
    const list = outgoing.get(from) ?? [];
    list.push(e);
    outgoing.set(from, list);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!filled(x, y)) continue;
    if (!filled(x, y - 1)) add(x + 1, y, x, y, 2);       // 顶边向左
    if (!filled(x + 1, y)) add(x + 1, y + 1, x + 1, y, 3); // 右边向上
    if (!filled(x, y + 1)) add(x, y + 1, x + 1, y + 1, 0); // 底边向右
    if (!filled(x - 1, y)) add(x, y, x, y + 1, 1);         // 左边向下
  }
  const loops: OutlinePoint[][] = [];
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].used) continue;
    const pts: OutlinePoint[] = [];
    let current = start;
    let closed = false;
    for (let steps = 0; steps <= edges.length; steps++) {
      const e = edges[current];
      if (e.used) break;
      e.used = true;
      const x = e.from % (w + 1);
      const y = Math.floor(e.from / (w + 1));
      pts.push([x / w, 1 - y / h]);
      if (e.to === edges[start].from) { closed = true; break; }
      const candidates = (outgoing.get(e.to) ?? []).filter((i) => !edges[i].used);
      if (!candidates.length) break;
      // 交叉顶点优先向左转，使相切的轮廓各自闭合。
      candidates.sort((a, b) => {
        const rank = (i: number) => [1, 2, 3, 0][(edges[i].dir - e.dir + 4) % 4];
        return rank(b) - rank(a);
      });
      current = candidates[0];
    }
    if (closed && pts.length >= 4) {
      const reduced = simplify(pts, 0.65 / Math.max(w, h));
      if (reduced.length >= 3 && Math.abs(area(reduced)) > 2 / (w * h)) loops.push(reduced);
    }
  }
  const islands: CardOutline = loops.filter((l) => area(l) > 0).map((outer) => ({ outer, holes: [] }));
  for (const hole of loops.filter((l) => area(l) < 0)) {
    const host = islands.filter((island) => inside(hole[0], island.outer)).sort((a, b) => area(a.outer) - area(b.outer))[0];
    if (host) host.holes.push(hole);
  }
  // 整图不透明时沿用原来的矩形卡片，避免引入额外顶点。
  if (islands.length === 1 && islands[0].holes.length === 0 && kept.every((v) => v === 1)) return null;
  return islands.length ? islands : null;
}

export function outlineOfBitmap(bmp: ImageBitmap): CardOutline | null {
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  return outlineFromAlpha(ctx.getImageData(0, 0, w, h).data, w, h);
}
