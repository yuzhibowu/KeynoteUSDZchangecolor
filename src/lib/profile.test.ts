import { describe, it, expect } from 'vitest';
import { serializeProfile, parseProfile, profileFileName } from './profile';
import { DEFAULT_COMP, solveWritten, type ColorComp, type Triple } from './color';

const json = (c: ColorComp) => JSON.stringify(serializeProfile(c));

describe('导出再导入，必须一模一样', () => {
  it('存下来再装回去，补偿结果完全不变', () => {
    // 这是这个功能的全部意义：换台电脑装回去，颜色得是同一个颜色。
    // 只要有一位小数在序列化时丢了，补偿值就可能差一阶。
    const back = parseProfile(json(DEFAULT_COMP));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const restored = { ...DEFAULT_COMP, ...back.comp } as ColorComp;

    for (let r = 0; r <= 255; r += 37)
      for (let g = 0; g <= 255; g += 37)
        for (let b = 0; b <= 255; b += 37) {
          expect(solveWritten(r, g, b, restored)).toEqual(solveWritten(r, g, b, DEFAULT_COMP));
        }
  });

  it('样本一个不少，数值一个不差', () => {
    const back = parseProfile(json(DEFAULT_COMP));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.sampleCount).toBe(DEFAULT_COMP.samples!.length);
    expect(back.comp.samples).toEqual(DEFAULT_COMP.samples);
  });

  it('补光和灯光开关跟着档一起走', () => {
    // 校准档和这两个设置是绑定的：补光一变，整条响应曲线就变了。
    // 装回去时必须一起还原，否则档是对的、设置是错的，照样不准。
    const c: ColorComp = { ...DEFAULT_COMP, calibratedLift: 0.6, calibratedUnlit: true };
    const back = parseProfile(json(c));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.lift).toBe(0.6);
    expect(back.unlit).toBe(true);
    expect(back.comp.calibratedLift).toBe(0.6);
    expect(back.comp.calibratedUnlit).toBe(true);
  });
});

describe('拖进来一个不对的文件时，要说清楚哪里不对', () => {
  const bad = (text: string) => {
    const r = parseProfile(text);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.reason;
  };

  it('不是 JSON', () => {
    expect(bad('这是一张截图，不是校准档')).toContain('JSON');
  });

  it('是别的 JSON', () => {
    expect(bad('{"hello":"world"}')).toContain('校准档');
  });

  it('版本比工具新', () => {
    const d = serializeProfile(DEFAULT_COMP);
    expect(bad(JSON.stringify({ ...d, version: 99 }))).toContain('99');
  });

  it('矩阵缺了几个数', () => {
    const d = serializeProfile(DEFAULT_COMP);
    expect(bad(JSON.stringify({ ...d, matrix: [1, 2, 3] }))).toContain('矩阵');
  });

  it('曲线节点数不对', () => {
    const d = serializeProfile(DEFAULT_COMP);
    expect(bad(JSON.stringify({ ...d, curve: [[0, 1], [0, 1], [0, 1]] }))).toContain('曲线');
  });

  it('曲线不单调 —— 这种档反算会算出乱值', () => {
    const d = serializeProfile(DEFAULT_COMP);
    const broken = d.curve.map((ch) => [...ch]);
    broken[0][2] = broken[0][1] - 0.1;
    expect(bad(JSON.stringify({ ...d, curve: broken }))).toContain('单调');
  });

  it('样本数量不是 6 的倍数', () => {
    const d = serializeProfile(DEFAULT_COMP);
    expect(bad(JSON.stringify({ ...d, samples: [1, 2, 3, 4, 5] }))).toContain('样本');
  });

  it('样本里有越界的值', () => {
    const d = serializeProfile(DEFAULT_COMP);
    expect(bad(JSON.stringify({ ...d, samples: [0, 0, 0, 0, 0, 300] }))).toContain('0–255');
  });

  it('NaN 混进来', () => {
    const d = serializeProfile(DEFAULT_COMP);
    const m = [...d.matrix];
    m[0] = NaN;
    // JSON.stringify 会把 NaN 写成 null，正好也该被拦下
    expect(bad(JSON.stringify({ ...d, matrix: m }))).toContain('矩阵');
  });
});

describe('空档也要能存能读', () => {
  it('没有样本的档不会崩', () => {
    const empty: ColorComp = { ...DEFAULT_COMP, samples: [] };
    const back = parseProfile(json(empty));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.sampleCount).toBe(0);
  });
});

describe('文件名', () => {
  it('带上标定时间和格数，方便存好几份对照', () => {
    const name = profileFileName(DEFAULT_COMP);
    expect(name).toMatch(/\.json$/);
    expect(name).toContain(String(DEFAULT_COMP.samples!.length));
  });

  it('标定时间是中文标签时，不要从里面抠数字当时间戳', () => {
    // 「内置（117 格实测）」里的 117 是格数不是日期，抠出来会拼成 -117-175格 这种怪名字
    const c: ColorComp = { ...DEFAULT_COMP, calibratedAt: '内置（117 格实测）' };
    const name = profileFileName(c);
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name).toBe('keynote-color-profile-1130格.json');
  });

  it('标定时间是日期时，拼成规整的时间戳', () => {
    const c: ColorComp = { ...DEFAULT_COMP, calibratedAt: '2026/9/5 13:41' };
    expect(profileFileName(c)).toBe('keynote-color-profile-20260905-1341-1130格.json');
  });
});

describe('导入的档必须真的能用', () => {
  it('装回去之后，实测点仍然被精确复现', () => {
    const back = parseProfile(json(DEFAULT_COMP));
    if (!back.ok) throw new Error('should parse');
    const restored = { ...DEFAULT_COMP, ...back.comp } as ColorComp;
    // 抽几个实测点，走一遍反解，应当和原档给出同样的写入值
    for (const s of DEFAULT_COMP.samples!.slice(0, 12)) {
      const a = solveWritten(s.ref[0], s.ref[1], s.ref[2], DEFAULT_COMP);
      const b = solveWritten(s.ref[0], s.ref[1], s.ref[2], restored);
      expect(b).toEqual(a);
    }
  });

  it('导入的档能继续往上打锚点（累积不受影响）', () => {
    const back = parseProfile(json(DEFAULT_COMP));
    if (!back.ok) throw new Error('should parse');
    const restored = { ...DEFAULT_COMP, ...back.comp } as ColorComp;
    const anchor = { ref: [77, 0, 2] as Triple, got: [157, 19, 0] as Triple };
    const tuned: ColorComp = { ...restored, samples: [...(restored.samples ?? []), anchor] };
    expect(tuned.samples!.length).toBe(DEFAULT_COMP.samples!.length + 1);
    // 加了锚点之后，那个点附近的解应该变了
    expect(solveWritten(157, 19, 0, tuned)).not.toEqual(solveWritten(157, 19, 0, restored));
  });
});

describe('校准档要记住自己属于哪个目标', () => {
  // 装错目标是最难查的一类问题：数据完全合法，只是测的不是这个渲染器，
  // 颜色会莫名其妙全偏。所以档里必须记下来，文件名也要带上。
  const round = (target?: string) =>
    parseProfile(JSON.stringify(serializeProfile(DEFAULT_COMP, target)));

  it('导出时写进去，解析时读回来', () => {
    const r = round('freeform');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe('freeform');
  });

  it('没写目标的老档（v1）不报错，按「不知道」处理', () => {
    const raw = JSON.parse(JSON.stringify(serializeProfile(DEFAULT_COMP)));
    delete raw.target;
    raw.version = 1;
    const r = parseProfile(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe(null);
  });

  it('材质要进档，也要读得回来 —— 2026-09-23 在金属下量了三轮补光才发现档里没记这个', () => {
    const c = { ...DEFAULT_COMP, calibratedMaterial: 'metal' };
    const r = parseProfile(JSON.stringify(serializeProfile(c, 'freeform', 'prism')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material).toBe('metal');
    expect(r.comp.calibratedMaterial).toBe('metal');
  });

  it('老档没记材质：按「不知道」处理，不许猜一个出来', () => {
    const raw = JSON.parse(JSON.stringify(serializeProfile(DEFAULT_COMP, 'keynote', 'prism')));
    delete raw.material;
    raw.version = 2;
    const r = parseProfile(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material).toBe(null);
    expect(r.comp.calibratedMaterial).toBe(null);
  });

  it('文件名带上目标 —— 一份无边记的档不该叫 keynote-', () => {
    expect(profileFileName(DEFAULT_COMP, 'freeform').startsWith('freeform-')).toBe(true);
    expect(profileFileName(DEFAULT_COMP, 'keynote').startsWith('keynote-')).toBe(true);
  });
});
