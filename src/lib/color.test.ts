import { describe, it, expect } from 'vitest';
import { defaultProfiles } from './types';
import {
  DEFAULT_COMP,
  FREEFORM_COMP,
  BUILT_IN_PROFILE,
  solveWritten,
  applyToHex,
  applyToImageData,
  compensateToLinear,
  predictKeynote,
  compSignature,
  forwardOf,
  isIdentity,
  linearToSrgb,
  type ColorComp,
  type Triple,
} from './color';

const hex = (t: number[]) =>
  '#' + t.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('三条写入路径必须完全一致', () => {
  // 贴图像素、端面纯色、色卡探针格问的是同一个问题：「该往文件里写什么值」。
  // 曾经它们走三条不同的算法，只有贴图那条是对的 —— 于是界面预告的、色卡量的、
  // 文件里写的是三个数，闭环微调永远收敛不了。这个测试守住它们不再分叉。
  it('solveWritten 和 applyToHex 给出同一个值', () => {
    for (const s of BUILT_IN_PROFILE.samples) {
      const a = solveWritten(s.ref[0], s.ref[1], s.ref[2], DEFAULT_COMP);
      const b = unhex(applyToHex(hex(s.ref), DEFAULT_COMP));
      expect(b).toEqual(a);
    }
  });

  it('端面纯色（compensateToLinear）也是同一个值', () => {
    for (const s of BUILT_IN_PROFILE.samples) {
      const want = solveWritten(s.ref[0], s.ref[1], s.ref[2], DEFAULT_COMP);
      const lin = compensateToLinear(hex(s.ref), DEFAULT_COMP)!;
      const got = lin.map((x) => Math.round(linearToSrgb(x) * 255));
      expect(got).toEqual(want);
    }
  });
});

describe('求解器的输出必须是能写进文件的值', () => {
  // 「算完再逐通道截断」会让色相跑偏（红顶到 255、蓝算出负数，两边被砍的比例不一样）。
  // 所以求解器必须从源头就只在可写范围里搜索，下游不该再补截断。
  it('永远落在 0..255，不会有负数或溢出', () => {
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51) {
          const w = solveWritten(r, g, b, DEFAULT_COMP);
          for (const v of w) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(255);
          }
        }
  });

  it('端面线性值不为负（USD 里负的 diffuseColor 非法）', () => {
    for (const h of ['#000000', '#101010', '#202020', '#0a0500', '#ffffff']) {
      const lin = compensateToLinear(h, DEFAULT_COMP)!;
      for (const v of lin) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('局部修正必须是插值，不能退回加权平均', () => {
  // 加权平均在实测点上也复现不准（点自己会被邻居拉走），闭环微调打的锚点又必然扎堆，
  // 于是被糊成一团 —— 这就是「锚了还是不准」。径向基插值让修正场穿过每个实测点。
  const global = DEFAULT_COMP;

  it('实测点本身要被高精度复现', () => {
    let worst = 0;
    for (const s of BUILT_IN_PROFILE.samples) {
      const p = predictKeynote(hex(s.got), global);
      if (!p) continue;
      const g = unhex(p);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(g[c] - s.got[c]));
    }
    // 加权平均那版这里是 6~7 阶；插值版应当远小于此
    expect(worst).toBeLessThan(6);
  });

  it('实测点上必须精确复现 —— 加权平均做不到这件事', () => {
    // 这是插值和加权平均的分水岭：加权平均下，每个点都会被邻居拉走；
    // 插值则保证修正场正好穿过每一个点。
    const pts: { ref: Triple; got: Triple }[] = [
      { ref: [90, 40, 20], got: [148, 61, 9] },
      { ref: [130, 200, 70], got: [171, 238, 96] },
      { ref: [30, 60, 150], got: [44, 92, 214] },
    ];
    // 这条测的是插值这个性质本身，所以用只有这几个锚点的稀疏档。
    // 内置档现在是密集的（相邻 28 阶），叠在它上面的话，新锚点 18 阶半径里本来就有
    // 实测点，岭正则会在两者之间折中（实测 2~3 阶）—— 那是另一回事，不该混在这里。
    const tuned: ColorComp = { ...DEFAULT_COMP, samples: pts };
    for (const a of pts) {
      const y = forwardOf(a.ref[0], a.ref[1], a.ref[2], tuned);
      const d = Math.max(...[0, 1, 2].map((i) => Math.abs(y[i] - a.got[i])));
      expect(d, `写 ${a.ref} 应显示 ${a.got}，模型说 ${y}`).toBeLessThanOrEqual(1);
    }
  });

  it('扎堆的锚点不会互相糊掉', () => {
    // 连打几轮闭环微调，锚点必然挤在一小片区域里 —— 加权平均会把它们摊成一团
    const cluster: { ref: Triple; got: Triple }[] = [
      { ref: [210, 95, 40], got: [248, 140, 12] },
      { ref: [204, 99, 44], got: [240, 150, 30] },
      { ref: [199, 102, 47], got: [232, 160, 48] },
    ];
    const tuned: ColorComp = { ...DEFAULT_COMP, samples: cluster };
    for (const a of cluster) {
      const y = forwardOf(a.ref[0], a.ref[1], a.ref[2], tuned);
      const d = Math.max(...[0, 1, 2].map((i) => Math.abs(y[i] - a.got[i])));
      expect(d, `三个锚点相距不到 12 阶，写 ${a.ref} 应显示 ${a.got}，模型说 ${y}`).toBeLessThanOrEqual(1);
    }
  });

  it('打一个锚点不会污染远处的颜色', () => {
    const far: Triple[] = [
      [255, 255, 255], [128, 128, 128], [253, 190, 46], [70, 130, 180], [0, 0, 0],
    ];
    const before = far.map((c) => solveWritten(c[0], c[1], c[2], DEFAULT_COMP));
    const tuned: ColorComp = {
      ...DEFAULT_COMP,
      samples: [...(DEFAULT_COMP.samples ?? []), { ref: [77, 0, 2], got: [157, 19, 0] }],
    };
    const after = far.map((c) => solveWritten(c[0], c[1], c[2], tuned));
    expect(after).toEqual(before);
  });
});

describe('内置校准档的质量', () => {
  it('是密集 1130 格那一份，不是早期 117 / 70 / 24 格的', () => {
    // 24 格那份暗部整段空白，深红开箱即用会差 33 阶；117 格相邻 85 阶，格点之间靠外推
    expect(BUILT_IN_PROFILE.samples.length).toBe(1130);
    expect(DEFAULT_COMP.calibratedLift).toBe(0.5);
    expect(DEFAULT_COMP.calibratedUnlit).toBe(false);
  });

  it('常见颜色开箱即用就该准', () => {
    const cases: [Triple, number][] = [
      [[161, 20, 0], 1],      // 曾经差 33 的那个深红
      [[128, 128, 128], 1],
      [[255, 198, 39], 2],
      [[60, 60, 60], 3],
    ];
    for (const [target, tol] of cases) {
      const p = unhex(predictKeynote(hex(target), DEFAULT_COMP)!);
      const d = Math.max(...[0, 1, 2].map((i) => Math.abs(p[i] - target[i])));
      expect(d, `目标 ${target}，预计显示 ${p}`).toBeLessThanOrEqual(tol);
    }
  });

  it('纯白到不了纯白 —— 这是亮度天花板，不是 bug', () => {
    const p = unhex(predictKeynote('#ffffff', DEFAULT_COMP)!);
    expect(p[0]).toBeLessThan(255);
    expect(p[0]).toBeGreaterThan(230);
  });
});

describe('缓存不能串档', () => {
  // compSignature 对所有「关掉补偿」的档都返回 'off'。正向模型的缓存要是拿它当键，
  // 两个不同的校准档就会互相串。
  it('两个不同的校准档，关掉补偿后指纹相同但模型不能混用', () => {
    const a: ColorComp = { ...DEFAULT_COMP, on: false };
    const b: ColorComp = { ...DEFAULT_COMP, on: false, offset: [0.5, 0.5, 0.5] };
    expect(compSignature(a)).toBe(compSignature(b)); // 都是 'off'
    expect(isIdentity(a)).toBe(true);
    // 关掉补偿时必须原样返回，不受另一个档影响
    expect(solveWritten(200, 100, 50, a)).toEqual([200, 100, 50]);
    expect(solveWritten(200, 100, 50, b)).toEqual([200, 100, 50]);
  });

  it('改了 samples，指纹就得变（否则烘焙缓存不失效）', () => {
    const a = DEFAULT_COMP;
    const b: ColorComp = {
      ...DEFAULT_COMP,
      samples: [...(DEFAULT_COMP.samples ?? []), { ref: [1, 2, 3], got: [4, 5, 6] }],
    };
    expect(compSignature(a)).not.toBe(compSignature(b));
  });
});

describe('整图补偿', () => {
  it('关掉补偿时一个像素都不动', () => {
    const off: ColorComp = { ...DEFAULT_COMP, on: false };
    const px = new Uint8ClampedArray([10, 20, 30, 255, 200, 150, 100, 255]);
    const copy = px.slice();
    applyToImageData(px, off);
    expect(Array.from(px)).toEqual(Array.from(copy));
  });

  it('大面积主色走精确解，和单色路径结果一致', () => {
    // 照片里的散碎像素走查表，但占比大的颜色必须精确求解 —— 否则纯色块也会带上插值误差
    const n = 64;
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      px[i * 4] = 161; px[i * 4 + 1] = 20; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255;
    }
    applyToImageData(px, DEFAULT_COMP);
    const exact = solveWritten(161, 20, 0, DEFAULT_COMP);
    expect([px[0], px[1], px[2]]).toEqual(exact);
  });

  it('alpha 通道不动', () => {
    const px = new Uint8ClampedArray([161, 20, 0, 128]);
    applyToImageData(px, DEFAULT_COMP);
    expect(px[3]).toBe(128);
  });
});


describe('无边记的内置档', () => {
  it('是真正实测的那一份，不再沿用 Keynote', () => {
    expect(FREEFORM_COMP.matrix).not.toEqual(DEFAULT_COMP.matrix);
    expect(FREEFORM_COMP.samples?.length).toBe(1130);
  });

  it('两份档各带各的补光条件，切目标时必须跟着走', () => {
    // 2026-09-23 起两边不一样了：Keynote 的纯白顶死在 244，得靠自发光顶上去；
    // 无边记纸张下漫反射就有 226，补光 0 反而最准，立体感也完整保留。
    expect(FREEFORM_COMP.calibratedLift).toBe(0);
    expect(DEFAULT_COMP.calibratedLift).toBe(0.5);
  });

  it('两份档都记了自己是在哪种材质下标的 —— 补光越低材质越是决定性的', () => {
    expect(FREEFORM_COMP.calibratedMaterial).toBe('paper');
    expect(DEFAULT_COMP.calibratedMaterial).toBe('paper');
  });

  it('比 Keynote 准：无边记的档几乎是对角阵，没有通道之间的混合', () => {
    const m = FREEFORM_COMP.matrix!;
    for (const i of [1, 2, 3, 5, 6, 7]) expect(Math.abs(m[i])).toBeLessThan(0.06);
    for (const i of [0, 4, 8]) expect(m[i]).toBeGreaterThan(0.7);
  });

  it('色域错配比 Keynote 温和：矩阵接近单位阵', () => {
    const m = FREEFORM_COMP.matrix!;
    // 非对角项（通道之间的混合）都很小
    for (const i of [1, 2, 3, 5, 6, 7]) expect(Math.abs(m[i])).toBeLessThan(0.06);
    // Keynote 那份不是这样 —— 它有个 -0.4 量级的项
    expect(Math.max(...DEFAULT_COMP.matrix!.map(Math.abs))).toBeGreaterThan(1);
  });

  it('两个目标各是各的档，defaultProfiles 不再让它们共用', () => {
    const p = defaultProfiles();
    expect(p.keynote.samples).not.toBe(p.freeform.samples);
    expect(p.freeform.calibratedAt).not.toContain('沿用');
  });
});
