import { describe, it, expect } from 'vitest';
import { pairClusters, type Cluster } from '../components/ColorPanel';

const C = (c: [number, number, number], n: number): Cluster => ({ c, n });

/**
 * 闭环微调的配对逻辑。
 *
 * 核心场景：颜色已经被 Keynote 大幅改过了，所以**不能按颜色近似去配**——
 * 一块被推成亮青的蓝，看着比它自己更像原图里另一块本来就偏青的颜色。
 * 用面积占比配：Keynote 改颜色但不改几何。
 */
describe('闭环微调的颜色配对', () => {
  it('颜色被推得面目全非，仍然按面积占比配对上', () => {
    const want = [C([26, 86, 216], 5000), C([10, 26, 60], 3000), C([168, 212, 255], 1000)];
    // Keynote 把蓝推成青、把暗部抬亮 —— 颜色全变了，但每块的面积没变
    const shot = [C([0, 150, 255], 5100), C([20, 45, 90], 2900), C([200, 235, 255], 980)];
    const pairs = pairClusters(want, shot);
    expect(pairs.length).toBe(3);
    expect(pairs[0].want.c).toEqual([26, 86, 216]);
    expect(pairs[0].got.c).toEqual([0, 150, 255]);
    expect(pairs[1].want.c).toEqual([10, 26, 60]);
    expect(pairs[2].want.c).toEqual([168, 212, 255]);
  });

  it('两边数量不等时，取能配上的那部分', () => {
    const want = [C([200, 0, 0], 900), C([0, 200, 0], 500)];
    const shot = [C([255, 30, 0], 880), C([0, 240, 20], 520), C([9, 9, 9], 100)];
    expect(pairClusters(want, shot).length).toBe(2);
  });

  it('亮度排名严重倒挂的配对会被丢掉，不把错数据喂进校准', () => {
    // 四对里故意让最亮和最暗错位：占比顺序和亮度顺序完全相反
    const want = [C([250, 250, 250], 400), C([10, 10, 10], 300), C([200, 200, 200], 200), C([60, 60, 60], 100)];
    const shot = [C([12, 12, 12], 400), C([255, 255, 255], 300), C([70, 70, 70], 200), C([210, 210, 210], 100)];
    const pairs = pairClusters(want, shot);
    expect(pairs.length).toBeLessThan(4);
  });

  it('一边为空就返回空，不抛错', () => {
    expect(pairClusters([], [C([1, 2, 3], 10)])).toEqual([]);
    expect(pairClusters([C([1, 2, 3], 10)], [])).toEqual([]);
  });

  it('只有一两块时不做一致性过滤 —— 样本太少，排名没有意义', () => {
    const want = [C([255, 255, 255], 500), C([0, 0, 0], 400)];
    const shot = [C([10, 10, 10], 500), C([250, 250, 250], 400)];
    expect(pairClusters(want, shot).length).toBe(2);
  });
});
