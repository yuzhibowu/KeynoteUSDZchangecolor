import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION, bakeMotion, effectiveLap, effectiveSpinLap, pathAt, poseAt, randomPhase, spinAt } from './motion';

describe('poseAt', () => {
  it('幅度 0 全是零', () => {
    const p = poseAt({ ...DEFAULT_MOTION, floatAmount: 0 }, 3.3, 1);
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
      const p = poseAt({ ...DEFAULT_MOTION, floatAmount: 1.8 }, t, 1);
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
  it('不退场（播放一次）：结尾包络是 1，最后一帧是原大的纯漂浮，不会取模回隐藏姿态', () => {
    const h = { ...p, entrance: 'grow' as const, exit: false };
    expect(poseAt(h, 9.9, 1).scale).toBe(1);
    const s = bakeMotion(h, 1, 10, 60);
    expect(s[0].scale).toBeLessThan(0.01);
    expect(s[600].scale).toBeCloseTo(1, 9);
    expect(s[600].position[1]).toBeCloseTo(poseAt(DEFAULT_MOTION, 0, 1).position[1], 6);
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


describe('轨迹', () => {
  const e = { ...DEFAULT_MOTION, floatAmount: 0, path: 'ellipse' as const, pathSize: 1, pathAspect: 0.5, pathLap: 8, seconds: 30 };
  it('一圈用时吸附到能整除循环长度：30 秒里 8 秒一圈 → 4 圈、7.5 秒', () => {
    expect(effectiveLap(e)).toBe(7.5);
    expect(effectiveLap({ ...e, pathLap: 20 })).toBe(15);
    expect(effectiveLap({ ...e, pathLap: 100 })).toBe(30);
  });
  it('椭圆：起点在右边，半圈后在左边，纵向按扁度', () => {
    const a = pathAt(e, 0, 2);
    expect(a.x).toBeCloseTo(2);
    expect(a.y).toBeCloseTo(0);
    const b = pathAt(e, 3.75, 2);
    expect(b.x).toBeCloseTo(-2);
    const c = pathAt({ ...e, pathClockwise: false }, 7.5 / 4, 2);
    expect(c.y).toBeCloseTo(1); // 逆时针四分之一圈在上面
    expect(pathAt(e, 7.5 / 4, 2).y).toBeCloseTo(-1); // 顺时针在下面
  });
  it('往返只有横向，8 字纵向两倍频', () => {
    expect(pathAt({ ...e, path: 'line' }, 1, 1).y).toBe(0);
    const f = { ...e, path: 'eight' as const };
    expect(pathAt(f, 7.5 / 4, 1).y).toBeCloseTo(0); // 四分之一圈时 sin(2θ)=0
    expect(Math.abs(pathAt(f, 7.5 / 8, 1).y)).toBeCloseTo(0.5);
  });
  it('轨迹叠在漂浮上，循环首尾仍然闭合', () => {
    const p = { ...DEFAULT_MOTION, path: 'eight' as const, pathLap: 8, seconds: 30 };
    const s = bakeMotion(p, 1, 30, 60);
    expect(s[1800].position[0]).toBeCloseTo(s[0].position[0], 6);
    expect(s[1800].position[1]).toBeCloseTo(s[0].position[1], 6);
    expect(s[1800].rotation[2]).toBeCloseTo(s[0].rotation[2], 6);
  });
  it('侧倾只在开了的时候有，且不超过上限', () => {
    expect(poseAt(e, 1, 1).rotation[2]).toBe(0);
    for (let t = 0; t < 8; t += 0.25) {
      expect(Math.abs(poseAt({ ...e, pathBank: true }, t, 1).rotation[2])).toBeLessThanOrEqual(18.0001);
    }
  });
});

describe('手绘轨迹', () => {
  const sq = { ...DEFAULT_MOTION, floatAmount: 0, path: 'custom' as const, pathSize: 1, pathLap: 10, seconds: 30,
    customPath: [[1, 0], [0, 1], [-1, 0], [0, -1]] as [number, number][], customClosed: true };
  it('没画的时候等于没有轨迹', () => {
    expect(pathAt({ ...sq, customPath: [] }, 3, 2)).toEqual({ x: 0, y: 0, heading: 0 });
  });
  it('点按模型半径放大，一圈回到起点', () => {
    const a = pathAt(sq, 0, 2);
    expect(a.x).toBeCloseTo(2);
    const b = pathAt(sq, 10, 2);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });
  it('顺 / 逆时针走的方向相反', () => {
    const cw = pathAt(sq, 1, 1);
    const ccw = pathAt({ ...sq, pathClockwise: false }, 1, 1);
    expect(cw.y * ccw.y).toBeLessThan(0);
  });
});

describe('randomPhase', () => {
  it('在范围内，且离现在的值够远', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomPhase(3, 30);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
      expect(Math.abs(v - 3)).toBeGreaterThanOrEqual(2.4);
    }
  });
});

describe('自转', () => {
  const y = { ...DEFAULT_MOTION, floatAmount: 0, spin: 'y' as const, spinLap: 12, seconds: 30 };
  it('一圈用时吸附：30 秒里 12 秒一圈 → 3 圈 10 秒', () => {
    expect(effectiveSpinLap(y)).toBe(10);
  });
  it('线性累加，一圈 360°，方向可反', () => {
    expect(spinAt(y, 5)).toBeCloseTo(-180);
    expect(spinAt(y, 10)).toBeCloseTo(-360);
    expect(spinAt({ ...y, spinClockwise: false }, 5)).toBeCloseTo(180);
  });
  it('落在选的那根轴上', () => {
    expect(poseAt(y, 2.5, 1).rotation[1]).toBeCloseTo(-90);
    expect(poseAt({ ...y, spin: 'x' }, 2.5, 1).rotation[0]).toBeCloseTo(-90);
    expect(poseAt({ ...y, spin: 'z' }, 2.5, 1).rotation[2]).toBeCloseTo(-90);
    expect(poseAt({ ...y, spin: 'none' }, 2.5, 1).rotation[1]).toBe(0);
  });
  it('烘出来的循环末尾不会倒着转回去：每帧转的角度恒定', () => {
    const s = bakeMotion(y, 1, 30, 60);
    const step = 360 / 10 / 60;
    for (let i = 1; i < s.length; i++) {
      expect(s[i].rotation[1] - s[i - 1].rotation[1]).toBeCloseTo(-step, 6);
    }
    expect(s[1800].rotation[1]).toBeCloseTo(-1080, 6);
  });
});
