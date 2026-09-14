import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION, bakeMotion, poseAt } from './motion';

describe('poseAt', () => {
  it('不动档全是零', () => {
    const p = poseAt({ ...DEFAULT_MOTION, float: 'off' }, 3.3, 1);
    expect(p.position).toEqual([0, 0, 0]);
    expect(p.rotation).toEqual([0, 0, 0]);
  });
  it('位移按包围球半径缩放，倾角不随大小变', () => {
    const a = poseAt(DEFAULT_MOTION, 0.7, 1);
    const b = poseAt(DEFAULT_MOTION, 0.7, 10);
    expect(b.position[1]).toBeCloseTo(a.position[1] * 10);
    expect(b.rotation).toEqual(a.rotation);
  });
  it('相位是时间平移', () => {
    const a = poseAt({ ...DEFAULT_MOTION, phase: 2 }, 1, 1);
    const b = poseAt(DEFAULT_MOTION, 3, 1);
    expect(a).toEqual(b);
  });
  it('倾角只有零点几度，不会把模型翻过去', () => {
    for (let t = 0; t < 30; t += 0.1) {
      const p = poseAt({ ...DEFAULT_MOTION, float: 'heavy' }, t, 1);
      expect(Math.abs(p.rotation[0])).toBeLessThan(2);
      expect(Math.abs(p.rotation[2])).toBeLessThan(2);
    }
  });
});

describe('bakeMotion', () => {
  it('帧数 = 秒 × fps + 1，首尾姿态一致（循环无缝）', () => {
    const s = bakeMotion(DEFAULT_MOTION, 1, 30, 60);
    expect(s.length).toBe(1801);
    expect(s[1800].position[1]).toBeCloseTo(s[0].position[1], 6);
    expect(s[1800].rotation[0]).toBeCloseTo(s[0].rotation[0], 6);
    expect(s[1800].rotation[2]).toBeCloseTo(s[0].rotation[2], 6);
  });
  it('混合区之前和实时公式一模一样', () => {
    const s = bakeMotion(DEFAULT_MOTION, 1, 30, 60);
    const live = poseAt(DEFAULT_MOTION, 10, 1);
    expect(s[600].position[1]).toBeCloseTo(live.position[1], 9);
  });
  it('接缝处相邻帧的跳变不比中间大', () => {
    const s = bakeMotion(DEFAULT_MOTION, 1, 30, 60);
    const step = (i: number) => Math.abs(s[i + 1].position[1] - s[i].position[1]);
    let maxMid = 0;
    for (let i = 0; i < 1500; i++) maxMid = Math.max(maxMid, step(i));
    for (let i = 1500; i < 1800; i++) expect(step(i)).toBeLessThan(maxMid * 1.5);
  });
});
