import { describe, expect, it } from 'vitest';
import { measureAlpha } from './fitImage';

/** 画一张「透明留白 + 圆角矩形」的 RGBA 像素 */
function roundedCard(w: number, h: number, x0: number, y0: number, cw: number, ch: number, r: number) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      let inside = px >= 0 && py >= 0 && px <= cw && py <= ch;
      if (inside && r > 0) {
        const cx = px < r ? r : px > cw - r ? cw - r : px;
        const cy = py < r ? r : py > ch - r ? ch - r : py;
        inside = (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
      }
      if (inside) {
        const i = (y * w + x) * 4;
        d[i] = 200; d[i + 1] = 150; d[i + 2] = 120; d[i + 3] = 255;
      }
    }
  }
  return d;
}

describe('卡片适应：从 PNG 里量比例和圆角', () => {
  it('裁掉透明留白，宽高按不透明区域算', () => {
    const d = roundedCard(1000, 700, 100, 80, 800, 500, 0);
    const m = measureAlpha(d, 1000, 700)!;
    expect(m.bounds).toEqual({ x0: 100, y0: 80, x1: 900, y1: 580 });
    expect(m.width / m.height).toBeCloseTo(1.6, 3);
    expect(m.cornerPx).toBe(0);
  });

  it('圆角半径量得准（±3 px）', () => {
    for (const r of [20, 60, 120]) {
      const d = roundedCard(1000, 700, 50, 50, 800, 500, r);
      const m = measureAlpha(d, 1000, 700)!;
      expect(Math.abs(m.cornerPx - r), `r=${r} 量到 ${m.cornerPx}`).toBeLessThanOrEqual(3);
    }
  });

  it('一个角被污染（比如水印）不影响结果 —— 取中位数', () => {
    const d = roundedCard(1000, 700, 50, 50, 800, 500, 60);
    // 左上角贴一块不透明的东西
    for (let y = 50; y < 70; y++) for (let x = 50; x < 70; x++) d[(y * 1000 + x) * 4 + 3] = 255;
    const m = measureAlpha(d, 1000, 700)!;
    expect(Math.abs(m.cornerPx - 60)).toBeLessThanOrEqual(3);
  });

  it('全透明返回 null', () => {
    expect(measureAlpha(new Uint8ClampedArray(16 * 16 * 4), 16, 16)).toBeNull();
  });
});
