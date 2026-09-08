import { describe, it, expect } from 'vitest';
import { COVER_RADIUS, NEAR_ENOUGH, coverageOf, coverageVerdict, probeColorsOf } from './coverage';
import { BLANK_COMP, DEFAULT_COMP, type ColorComp, type Triple } from './color';

/** 造一张纯色图的像素 */
function solid(color: [number, number, number], n = 400): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255;
  }
  return d;
}

/** 造一张双色图，两色像素数按 ratio 分配 */
function twoTone(a: [number, number, number], b: [number, number, number], ratio: number, n = 800) {
  const d = new Uint8ClampedArray(n * 4);
  const cut = Math.round(n * ratio);
  for (let i = 0; i < n; i++) {
    const c = i < cut ? a : b;
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  return d;
}

describe('代表色采样', () => {
  it('挑的是覆盖明暗的代表色，不是「像素最多的前几个」', () => {
    // 大片暗背景 + 一小块亮色。按 top-N 会只采到暗的，亮部一个都测不到。
    const d = twoTone([8, 8, 10], [240, 240, 245], 0.9, 2000);
    const picked = probeColorsOf(d, 4).map((p) => p.color);
    const lum = (c: number[]) => (c[0] + c[1] + c[2]) / 3;
    expect(Math.max(...picked.map(lum))).toBeGreaterThan(200);
    expect(Math.min(...picked.map(lum))).toBeLessThan(40);
  });

  it('透明像素不参与统计', () => {
    const d = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < 4 * 4; i += 4) { d[i] = 200; d[i + 3] = 255; }
    // 后 4 个像素 alpha=0，颜色是红的，不该被采进去
    for (let i = 4 * 4; i < 8 * 4; i += 4) { d[i] = 255; d[i + 3] = 0; }
    const picked = probeColorsOf(d, 3);
    expect(picked.every((p) => p.weight > 0)).toBe(true);
  });
});

describe('覆盖诊断', () => {
  it('没有校准数据时直说，别谈什么覆盖', () => {
    const r = coverageOf(solid([26, 86, 216]), BLANK_COMP);
    expect(r.calibrated).toBe(false);
    expect(coverageVerdict(r).level).toBe('bad');
    expect(coverageVerdict(r).text).toContain('还没有校准');
  });

  it('颜色正好落在锚点上：判为可靠', () => {
    const anchor = DEFAULT_COMP.samples![0].ref as Triple;
    const r = coverageOf(solid([anchor[0], anchor[1], anchor[2]]), DEFAULT_COMP);
    expect(r.probes[0].nearest).toBeLessThan(COVER_RADIUS);
    expect(r.probes[0].within).toBeGreaterThan(0);
    expect(coverageVerdict(r).level).toBe('good');
  });

  it('颜色远离所有锚点：判为纯外推，并建议去做微调', () => {
    // 故意造一份只有一个锚点的档，再拿一个离它很远的颜色去问
    const lonely: ColorComp = { ...DEFAULT_COMP, samples: [{ ref: [0, 0, 0], got: [15, 15, 15] }] };
    const r = coverageOf(solid([250, 120, 200]), lonely);
    expect(r.probes[0].within).toBe(0);
    expect(r.uncoveredShare).toBe(1);
    const v = coverageVerdict(r);
    expect(v.level).toBe('bad');
    expect(v.text).toContain('微调');
  });

  it('只有一小部分颜色没覆盖时，是提醒而不是报警', () => {
    const anchor = DEFAULT_COMP.samples![0].ref as Triple;
    // 九成像素落在锚点上，一成是没覆盖的怪色
    const d = twoTone([anchor[0], anchor[1], anchor[2]], [250, 120, 200], 0.9, 2000);
    const r = coverageOf(d, DEFAULT_COMP, 6);
    expect(r.uncoveredShare).toBeLessThan(0.25);
    expect(coverageVerdict(r).level).toBe('warn');
  });

  it('那张出问题的蓝图，现在判为可靠 —— 判据不能比实拍结果还悲观', () => {
    // 这几个色就是当初发黄那张图的代表色。换成 117 格档之后用户实拍确认颜色正确，
    // 所以诊断也必须说它可靠。一度用 18 阶的局部修正半径当判据，把它报成
    // 「最容易偏色」，那是假警报 —— 判据太严比不给判据更糟，它会催人做没必要的微调。
    for (const c of [[10, 26, 60], [18, 58, 143], [26, 86, 216]] as [number, number, number][]) {
      const r = coverageOf(solid(c), DEFAULT_COMP);
      expect(r.probes[0].nearest).toBeLessThanOrEqual(NEAR_ENOUGH);
      expect(r.probes[0].ok).toBe(true);
      expect(coverageVerdict(r).level).toBe('good');
    }
  });

  it('局部修正半径比「够近」的门槛更严 —— 两者不是一回事', () => {
    expect(COVER_RADIUS).toBeLessThan(NEAR_ENOUGH);
  });
});
