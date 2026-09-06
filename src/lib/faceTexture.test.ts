import { describe, it, expect } from 'vitest';
import { placeholderColor } from './faceTexture';
import { applyToHex, DEFAULT_COMP } from './color';

describe('占位色块也必须走颜色补偿', () => {
  it('返回的是 #rrggbb，不是 hsl()', () => {
    // applyToHex 只认十六进制；给它 hsl(...) 会被原样退回，整块颜色绕过补偿
    for (let i = 0; i < 12; i++) {
      expect(placeholderColor(i, 12)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('补偿函数确实认得这个格式（补过之后值会变）', () => {
    for (let i = 0; i < 6; i++) {
      const c = placeholderColor(i, 6);
      expect(applyToHex(c, DEFAULT_COMP)).not.toBe(c);
    }
  });

  it('每个面颜色不同，能分得清', () => {
    const set = new Set(Array.from({ length: 8 }, (_, i) => placeholderColor(i, 8)));
    expect(set.size).toBe(8);
  });
});
