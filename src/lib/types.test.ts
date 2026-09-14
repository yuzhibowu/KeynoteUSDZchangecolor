import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, RESOLUTIONS } from './types';

describe('贴图分辨率档位', () => {
  it('按 720P 到 4K 从小到大排列，并默认 1080P', () => {
    expect(RESOLUTIONS.map((item) => item.label)).toEqual(['720P', '1080P', '2K', '4K']);
    expect(DEFAULT_PARAMS.resolution).toBe(1920);
  });
});
