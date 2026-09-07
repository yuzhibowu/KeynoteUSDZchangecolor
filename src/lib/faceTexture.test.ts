import { describe, it, expect } from 'vitest';
import { FACE_FILL } from './faceTexture';
import { applyToHex, DEFAULT_COMP } from './color';

describe('没贴图的面：一块纯色，而且照样走颜色补偿', () => {
  it('是 #rrggbb，不是 hsl()', () => {
    // applyToHex 只认十六进制；给它 hsl(...) 会被原样退回，整块颜色绕过补偿
    expect(FACE_FILL).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('补偿函数确实认得这个格式（补过之后值会变）', () => {
    expect(applyToHex(FACE_FILL, DEFAULT_COMP)).not.toBe(FACE_FILL);
  });
});
