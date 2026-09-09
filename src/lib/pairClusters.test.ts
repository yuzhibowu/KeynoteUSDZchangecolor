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

  it('能配上的不足三对时，只锚主色 —— 宁可少而准', () => {
    // 两对看着都对得上，但样本太少，亮度排名一致性校验形同虚设，
    // 等于没有任何保护就把点喂进校准。局部修正是**精确穿过**每个锚点的，
    // 一个错点就能在修正场里拽出一个陡坑，平滑渐变经过它会断成一块块
    // （用户实际遇到过：微调完背景全是马赛克）。所以这种情况退回旧的保守行为。
    const want = [C([200, 0, 0], 900), C([0, 200, 0], 500)];
    const shot = [C([255, 30, 0], 880), C([0, 240, 20], 520), C([9, 9, 9], 100)];
    expect(pairClusters(want, shot).length).toBe(1);
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

  it('只有两块而且明显配反时，绝不能原样喂进校准', () => {
    // 白对黑、黑对白 —— 这是配错的典型。旧逻辑「样本太少就不过滤」会把它原样收下，
    // 那是最危险的一条路径：两个方向完全相反的锚点会把修正场撕开。
    const want = [C([255, 255, 255], 500), C([0, 0, 0], 400)];
    const shot = [C([10, 10, 10], 500), C([250, 250, 250], 400)];
    expect(pairClusters(want, shot).length).toBe(1);
  });

  it('六对里混进一个偏差离群的，会被剔掉', () => {
    // 前五对都是「稍微变亮一点」，第六对却差出天际 —— 那多半是配到别的区域去了
    const mk = (v: number, n: number) => C([v, v, v], n);
    const want = [mk(200, 600), mk(170, 500), mk(140, 400), mk(110, 300), mk(80, 200), mk(50, 100)];
    const shot = [mk(210, 600), mk(180, 500), mk(150, 400), mk(120, 300), mk(90, 200), mk(240, 100)];
    const pairs = pairClusters(want, shot);
    expect(pairs.length).toBe(5);
    expect(pairs.some((p) => p.got.c[0] === 240)).toBe(false);
  });
});
