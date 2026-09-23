import { describe, it, expect } from 'vitest';
import { fitChart, type Sample } from './chart';
import { solveWritten, type ColorComp, type Triple } from './color';
import { fakeKeynote255, fakeChartSamples, reachError } from './testing/fakeKeynote';

/**
 * 端到端：在一个「假 Keynote」上把整条链路跑一遍 ——
 * 标定 → 拟合 → 反解出该写的值 → 送进假 Keynote → 看显示出来对不对。
 *
 * 这是唯一能证明整条链路自洽的测试。前面那些单元测试各管一段，
 * 都通过了链路也可能是断的（今天就发生过：三条写入路径各自都"对"，但互相不一致）。
 */

/** 用假 Keynote 的实测数据标定出一份档 */
function calibrate(extra: Sample[] = []): ColorComp {
  const samples = [...fakeChartSamples(), ...extra];
  const fit = fitChart(samples)!;
  return {
    on: true,
    matrix: fit.matrix,
    offset: fit.offset,
    curve: fit.curve,
    calibratedAt: 'test',
    samples: samples.map((s) => ({ ref: s.ref as Triple, got: s.got as Triple })),
    calibratedUnlit: false,
    calibratedMaterial: 'paper',
    calibratedLift: 1,
  };
}

/** 走完整条路：想要 target → 解出该写什么 → 假 Keynote 显示出来是什么 */
function roundTrip(target: Triple, comp: ColorComp) {
  const written = solveWritten(target[0], target[1], target[2], comp);
  const shown = fakeKeynote255(written[0], written[1], written[2]);
  const err = Math.max(...[0, 1, 2].map((i) => Math.abs(shown[i] - target[i])));
  return { written, shown, err };
}

// 挑一批目标色：先算出它们在假 Keynote 上物理可达的极限，
// 不可达的颜色（比如需要"比纯白更白"）本来就补不出来，不该算在考核里
const CANDIDATES: Triple[] = [
  [200, 60, 60], [120, 180, 90], [90, 60, 120], [30, 30, 30],
  [180, 180, 180], [45, 160, 140], [150, 150, 90], [60, 60, 140],
  [190, 90, 120], [130, 130, 130], [100, 40, 140], [160, 120, 80],
];

describe('端到端：标定 → 补偿 → 验收', () => {
  const comp = calibrate();
  const reachable = CANDIDATES.filter((t) => reachError(t) <= 3);

  it('测试用的目标色里，大部分应该是物理可达的', () => {
    expect(reachable.length).toBeGreaterThanOrEqual(8);
  });

  it('补偿之后，显示出来的颜色明显比不补偿更接近目标', () => {
    let withComp = 0;
    let without = 0;
    for (const t of reachable) {
      withComp += roundTrip(t, comp).err;
      const raw = fakeKeynote255(t[0], t[1], t[2]);
      without += Math.max(...[0, 1, 2].map((i) => Math.abs(raw[i] - t[i])));
    }
    const a = withComp / reachable.length;
    const b = without / reachable.length;
    expect(a, `补偿后平均差 ${a.toFixed(1)}，不补偿平均差 ${b.toFixed(1)}`).toBeLessThan(b * 0.5);
  });

  it('每一个可达的颜色都不会补得离谱', () => {
    for (const t of reachable) {
      const { err, written, shown } = roundTrip(t, comp);
      expect(err, `目标 ${t} → 写 ${written} → 显示 ${shown}`).toBeLessThan(20);
    }
  });
});

describe('闭环微调必须真的收敛', () => {
  // 「导出 → 在 Keynote 里截图 → 拖回来微调 → 再导出」这个循环，
  // 每一轮都应该让误差下降。加权平均那版会卡在几阶下不去。
  it('打一轮锚点之后，误差显著下降', () => {
    const target: Triple = [200, 60, 60];
    let comp = calibrate();

    const before = roundTrip(target, comp);

    // 模拟用户把成品截图拖回来：量到实际显示值，和"打算写进去的值"配成锚点
    const anchor: Sample = { ref: before.written, got: before.shown };
    comp = calibrate([anchor]);

    const after = roundTrip(target, comp);
    expect(after.err, `第 0 轮差 ${before.err}，第 1 轮差 ${after.err}`)
      .toBeLessThanOrEqual(before.err);
    expect(after.err).toBeLessThanOrEqual(3);
  });

  it('连打三轮不会越打越糟', () => {
    const targets: Triple[] = [[200, 60, 60], [120, 180, 90], [90, 60, 120]];
    const anchors: Sample[] = [];
    const errs: number[] = [];
    for (let round = 0; round < 3; round++) {
      const comp = calibrate(anchors);
      let worst = 0;
      for (const t of targets) {
        const r = roundTrip(t, comp);
        worst = Math.max(worst, r.err);
        anchors.push({ ref: r.written, got: r.shown });
      }
      errs.push(worst);
    }
    // 锚点会越攒越扎堆 —— 加权平均在这里会开始互相干扰、误差反弹
    expect(errs[2], `三轮的最大误差：${errs.join(' → ')}`).toBeLessThanOrEqual(errs[0]);
  });
});

describe('标定数据可以累积', () => {
  // 换一张色调不同的图，新色卡测的是新颜色。旧的留着，标过的颜色才会越攒越多。
  it('把旧样本并进来不会破坏原有颜色的准确度', () => {
    const base = calibrate();
    const target: Triple = [120, 180, 90];
    const baseErr = roundTrip(target, base).err;

    const extra: Sample[] = [
      { ref: [88, 44, 22], got: fakeKeynote255(88, 44, 22) },
      { ref: [210, 190, 60], got: fakeKeynote255(210, 190, 60) },
      { ref: [40, 90, 130], got: fakeKeynote255(40, 90, 130) },
    ];
    const merged = calibrate(extra);
    const mergedErr = roundTrip(target, merged).err;

    expect(mergedErr, `合并前差 ${baseErr}，合并后差 ${mergedErr}`).toBeLessThanOrEqual(baseErr + 2);
  });
});
