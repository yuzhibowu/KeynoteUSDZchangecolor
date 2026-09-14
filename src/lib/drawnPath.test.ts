import { describe, expect, it } from 'vitest';
import { centerPath, customPathAt, isClosed, resample, type Pt } from './drawnPath';

const circle = (n: number, r = 1): Pt[] =>
  Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]);

describe('resample', () => {
  it('重采样成 n 个点，首尾不动', () => {
    const raw: Pt[] = [[0, 0], [1, 0], [1, 1], [3, 1]];
    const r = resample(raw, 10);
    expect(r).toHaveLength(10);
    expect(r[0]).toEqual([0, 0]);
    expect(r[9]).toEqual([3, 1]);
  });
  it('重复点不会让它除零', () => {
    const r = resample([[0, 0], [0, 0], [1, 0]], 5);
    expect(r).toHaveLength(5);
    expect(r.every((p) => Number.isFinite(p[0]))).toBe(true);
  });
});

describe('isClosed', () => {
  it('画个圈算闭环，画条线不算', () => {
    expect(isClosed(circle(40))).toBe(true);
    expect(isClosed([[0, 0], [1, 0], [2, 0]])).toBe(false);
  });
});

describe('centerPath', () => {
  it('重心挪到原点', () => {
    const c = centerPath([[1, 1], [3, 1], [3, 3], [1, 3]]);
    expect(c).toEqual([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
  });
});

describe('customPathAt', () => {
  it('闭环：u=0 在起点，u=0.5 在对面，回到 u=1 等于 u=0', () => {
    const pts = circle(64);
    const a = customPathAt(pts, true, 0);
    expect(a.x).toBeCloseTo(1, 2);
    const b = customPathAt(pts, true, 0.5);
    expect(b.x).toBeCloseTo(-1, 2);
    const c = customPathAt(pts, true, 1);
    expect(c.x).toBeCloseTo(a.x, 9);
    // 逆时针走，起点处切线朝上
    expect(a.heading).toBeCloseTo(Math.PI / 2, 1);
  });
  it('开路：去到头再原路回，方向反过来', () => {
    const pts: Pt[] = Array.from({ length: 11 }, (_, i) => [i / 10, 0]);
    expect(customPathAt(pts, false, 0).x).toBeCloseTo(0);
    expect(customPathAt(pts, false, 0.5).x).toBeCloseTo(1);
    expect(customPathAt(pts, false, 0.25).x).toBeCloseTo(0.5, 1);
    expect(customPathAt(pts, false, 0.75).x).toBeCloseTo(0.5, 1);
    expect(Math.cos(customPathAt(pts, false, 0.25).heading)).toBeGreaterThan(0);
    expect(Math.cos(customPathAt(pts, false, 0.75).heading)).toBeLessThan(0);
  });
  it('没有点就在原点', () => {
    expect(customPathAt([], true, 0.3)).toEqual({ x: 0, y: 0, heading: 0 });
  });
});
