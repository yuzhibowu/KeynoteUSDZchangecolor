import { describe, expect, it } from 'vitest';
import { reviveComp } from './storage';
import { DEFAULT_COMP } from './color';

describe('reviveComp：存档里的校准档怎么补全', () => {
  it('旧版内置档（标签写「内置」但矩阵对不上）要换成当前内置档，开关状态保留', () => {
    const stale = {
      ...DEFAULT_COMP,
      on: false,
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      calibratedAt: '内置（70 格实测）',
      samples: [{ ref: [0, 0, 0] as [number, number, number], got: [1, 1, 1] as [number, number, number] }],
    };
    const r = reviveComp('keynote', stale);
    expect(r.matrix).toEqual(DEFAULT_COMP.matrix);
    expect(r.samples).toEqual(DEFAULT_COMP.samples);
    expect(r.calibratedAt).toBe(DEFAULT_COMP.calibratedAt);
    expect(r.on).toBe(false);
  });

  it('在当前内置档上做过闭环微调（标签没变、只多了锚点）的，锚点原样保留', () => {
    const tuned = {
      ...DEFAULT_COMP,
      samples: [...DEFAULT_COMP.samples!, { ref: [10, 20, 30] as [number, number, number], got: [11, 22, 33] as [number, number, number] }],
    };
    const r = reviveComp('keynote', tuned);
    expect(r.samples).toHaveLength(DEFAULT_COMP.samples!.length + 1);
  });

  it('用户自己标定的档（标签是日期）一律不动', () => {
    const mine = { ...DEFAULT_COMP, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], calibratedAt: '2026/9/1 10:00' };
    expect(reviveComp('keynote', mine).matrix).toEqual(mine.matrix);
  });

  it('没有矩阵的存档回退到内置档', () => {
    expect(reviveComp('keynote', { on: true, matrix: null }).matrix).toEqual(DEFAULT_COMP.matrix);
  });
});

describe('档按目标 × 模型类型分槽', () => {
  it('卡片槽位的出厂档是卡片那份，和棱柱不是同一份', async () => {
    const { CARD_COMP } = await import('./color');
    expect(reviveComp('keynote:card', undefined).matrix).toEqual(CARD_COMP.matrix);
    expect(reviveComp('keynote', undefined).matrix).not.toEqual(CARD_COMP.matrix);
  });
});
