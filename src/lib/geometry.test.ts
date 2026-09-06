import { describe, it, expect } from 'vitest';
import { sideGeometry } from './geometry';

/** 取一个面的四个顶点 */
function corners(i: number, sides: number, r: number, len: number, face: 'outer' | 'inner') {
  const p = sideGeometry(i, sides, r, len, face).getAttribute('position').array as ArrayLike<number>;
  return Array.from({ length: 4 }, (_, k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]] as const);
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 面 i 和面 i+1 在棱上共用的那两个顶点，取彼此最近的一对 */
function seam(i: number, sides: number, r: number, face: 'outer' | 'inner') {
  const a = corners(i, sides, r, 0.1, face);
  const b = corners((i + 1) % sides, sides, r, 0.1, face);
  let min = Infinity;
  for (const p of a) for (const q of b) min = Math.min(min, dist(p, q));
  return min;
}

describe('侧面几何', () => {
  it('相邻外面在棱上顶点完全重合', () => {
    for (const sides of [3, 4, 6, 12]) {
      expect(seam(0, sides, 0.05, 'outer')).toBeLessThan(1e-6);
    }
  });

  // 曾经的 bug：内面是把四边形整块沿自己的法线平移，相邻两个面法线不同，
  // 棱上就裂开一条缝，没有端面时透过缝看见内壁 —— 每条边一道浅色虚线。
  it('相邻内面在棱上也不能裂缝', () => {
    for (const sides of [3, 4, 6, 12]) {
      expect(seam(0, sides, 0.05, 'inner')).toBeLessThan(1e-6);
    }
  });

  // 这才是「边上一道浅色虚线」的真凶：老做法把内面整块沿自己的法线平移，
  // 角点相对相邻外面的有符号距离是 -gap·cos(2π/n)。
  // 三棱柱时是 +0.5·gap（内面直接穿出外壳），四棱柱时正好是 0 ——
  // 和外壳共面，谁在前面看深度精度，渲染出来就是每条棱上一道虚线。
  it('内面的每个顶点都要严格躲在外壳所有面的里侧', () => {
    const r = 0.05;
    for (const sides of [3, 4, 5, 6, 12]) {
      const gap = r * 0.002;
      for (let i = 0; i < sides; i++) {
        for (const p of corners(i, sides, r, 0.1, 'inner')) {
          for (let j = 0; j < sides; j++) {
            const a = (2 * Math.PI * j) / sides;
            const plane = r * Math.cos(Math.PI / sides); // 外面 j 到轴的距离
            const d = p[1] * Math.sin(a) + p[2] * Math.cos(a) - plane; // 有符号，正=在外壳外
            expect(d).toBeLessThan(1e-9);
            // 正对着的那个面还得让开足量，否则和外面自己 z-fighting
            if (i === j) expect(plane - (d + plane)).toBeCloseTo(gap, 7);
          }
        }
      }
    }
  });

  it('内面比外面往里让开半径的千分之二', () => {
    const r = 0.05;
    const sides = 4;
    const half = Math.PI / sides;
    // 面 0 正对 +Z，面到轴的距离就是顶点的 z（两个顶点的 z 相同）
    const planeOut = corners(0, sides, r, 0.1, 'outer')[0][2];
    const planeIn = corners(0, sides, r, 0.1, 'inner')[0][2];
    expect(planeOut).toBeCloseTo(r * Math.cos(half), 7);
    expect(planeOut - planeIn).toBeCloseTo(r * 0.002, 7);
  });
});
