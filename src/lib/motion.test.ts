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

describe('入场 / 退场', () => {
  const p = { ...DEFAULT_MOTION, entrance: 'rise' as const, entranceSeconds: 1.5, seconds: 10 };
  it('没有入场时包络恒为 1、缩放恒为 1', () => {
    expect(poseAt(DEFAULT_MOTION, 0, 1).scale).toBe(1);
    expect(poseAt(DEFAULT_MOTION, 0.3, 1).position[1]).toBeCloseTo(Math.sin(0.3 * 1.25) * 0.047, 9);
  });
  it('第 0 帧在下方，入场结束后回到漂浮位置', () => {
    expect(poseAt(p, 0, 1).position[1]).toBeLessThan(-1);
    const settled = poseAt(p, 2, 1).position[1];
    const floating = poseAt(DEFAULT_MOTION, 2, 1).position[1];
    expect(settled).toBeCloseTo(floating, 9);
  });
  it('循环结尾退场，首尾姿态一致', () => {
    const s = bakeMotion(p, 1, 10, 60);
    expect(s[600].position[1]).toBeCloseTo(s[0].position[1], 6);
    expect(s[600].scale).toBeCloseTo(s[0].scale, 6);
    // 中段是纯漂浮
    expect(s[300].position[1]).toBeCloseTo(poseAt(DEFAULT_MOTION, 5, 1).position[1], 9);
  });
  it('长出：缩放从接近 0 到 1，不会是 0', () => {
    const g = { ...p, entrance: 'grow' as const };
    expect(poseAt(g, 0, 1).scale).toBeGreaterThan(0);
    expect(poseAt(g, 0, 1).scale).toBeLessThan(0.01);
    expect(poseAt(g, 3, 1).scale).toBe(1);
  });
  it('旋入：第 0 帧转了一整圈，就位后是 0', () => {
    const g = { ...p, entrance: 'spin' as const };
    expect(poseAt(g, 0, 1).rotation[1]).toBeCloseTo(360, 9);
    expect(poseAt(g, 3, 1).rotation[1]).toBe(0);
  });
});

