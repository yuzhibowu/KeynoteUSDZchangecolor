/**
 * 手绘轨迹：用户在视口里拖的一笔 → 一条能循环走的曲线。
 *
 * 点的单位是「模型包围球半径的倍数」，换个模型形状还在。
 * 首尾离得近就当闭环，模型绕着走；离得远就来回走（到头原路返回）。
 */

export type Pt = [number, number];

/** 重采样成 n 个等弧长的点，顺手做一次三点平滑。手抖的锯齿就是这样磨掉的 */
export function resample(raw: Pt[], n = 96): Pt[] {
  const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 1e-6);
  if (pts.length < 2) return pts.slice();
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = seg[seg.length - 1];
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < pts.length - 2 && seg[j + 1] < d) j++;
    const span = seg[j + 1] - seg[j] || 1;
    const u = Math.min(1, Math.max(0, (d - seg[j]) / span));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u]);
  }
  // 三点平滑两遍，端点不动
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      out[i] = [(out[i - 1][0] + out[i][0] * 2 + out[i + 1][0]) / 4, (out[i - 1][1] + out[i][1] * 2 + out[i + 1][1]) / 4];
    }
  }
  return out;
}

/** 首尾距离小于整条路径跨度的 18% 就算闭环 */
export function isClosed(pts: Pt[]): boolean {
  if (pts.length < 3) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < span * 0.18;
}

/** 把整条路径平移到重心在原点：模型的「原位」应该在路径中间，不然它整体偏到一边 */
export function centerPath(pts: Pt[]): Pt[] {
  if (pts.length === 0) return pts;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map(([x, y]) => [x - cx, y - cy]);
}

/**
 * u ∈ [0, 1) 走到哪。闭环：Catmull-Rom 绕一圈；开路：0→0.5 去、0.5→1 原路回。
 * 返回位置和切线方向。
 */
export function customPathAt(pts: Pt[], closed: boolean, u: number): { x: number; y: number; heading: number } {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0, heading: 0 };
  if (n === 1) return { x: pts[0][0], y: pts[0][1], heading: 0 };
  let s: number; // 沿点列的连续下标
  let forward = 1;
  u = ((u % 1) + 1) % 1;
  if (closed) {
    s = u * n;
  } else {
    const w = u < 0.5 ? u * 2 : (1 - u) * 2;
    forward = u < 0.5 ? 1 : -1;
    s = w * (n - 1);
  }
  const at = (i: number): Pt => (closed ? pts[((i % n) + n) % n] : pts[Math.min(n - 1, Math.max(0, i))]);
  const i = Math.floor(s);
  const f = s - i;
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const cr = (a: number, b: number, c: number, d: number, t: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const dcr = (a: number, b: number, c: number, d: number, t: number) =>
    0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t);
  const x = cr(p0[0], p1[0], p2[0], p3[0], f);
  const y = cr(p0[1], p1[1], p2[1], p3[1], f);
  const dx = dcr(p0[0], p1[0], p2[0], p3[0], f) * forward;
  const dy = dcr(p0[1], p1[1], p2[1], p3[1], f) * forward;
  return { x, y, heading: Math.atan2(dy, dx) };
}
