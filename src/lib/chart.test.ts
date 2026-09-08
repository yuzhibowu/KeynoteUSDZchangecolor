import { describe, it, expect } from 'vitest';
import { chartPatches, fitChart, pickCovering, pwInvert, CURVE_K, COLS, ROWS, EXTRA_SLOTS, BASE_COUNT, GRAYS, WHITE_INDEX, type RGB } from './chart';
import { fakeKeynote255, fakeChartSamples } from './testing/fakeKeynote';

const lum = (c: RGB) => 0.3 * c[0] + 0.6 * c[1] + 0.1 * c[2];

describe('色卡版面', () => {
  it('格子数刚好排满，一个不多一个不少', () => {
    expect(chartPatches().length).toBe(COLS * ROWS);
  });

  it('固定色块 + 动态探针 + 对齐格 = 总格数', () => {
    expect(BASE_COUNT + EXTRA_SLOTS + 1).toBe(COLS * ROWS);
  });

  it('宽高比要贴近棱柱侧面，否则格子被拉扁、取样会偏', () => {
    const ratio = COLS / ROWS;
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.6);
  });

  it('灰阶那一行必须单调递增（截图自检就靠它）', () => {
    const grays = chartPatches().slice(0, 8);
    for (let i = 1; i < grays.length; i++) {
      expect(grays[i][0]).toBeGreaterThan(grays[i - 1][0]);
      expect(grays[i][0]).toBe(grays[i][1]);
      expect(grays[i][1]).toBe(grays[i][2]);
    }
  });

  it('最后一格必须和灰阶第 5 格同色 —— 首尾比对能抓出取样错位', () => {
    const p = chartPatches();
    expect(p[p.length - 1]).toEqual(p[4]);
  });

  it('必须有暗部补点，否则暗色只能靠外推', () => {
    // 曾经栽在这里：最暗的彩色样本是 128 级，往下直接跳到纯黑
    const dark = chartPatches().filter((c) => {
      const mx = Math.max(...c);
      return mx > 0 && mx <= 70 && !(c[0] === c[1] && c[1] === c[2]);
    });
    expect(dark.length).toBeGreaterThanOrEqual(4);
  });
});

describe('动态探针挑色：必须覆盖明暗，不能只挑出现最多的', () => {
  // 这是拿照片栽出来的坑：照片里像素最多的永远是阴影和黑背景，
  // 按 top-N 挑出来的全是暗色，中间调和亮部一个都测不到，标定完等于没标。

  /** 造一张「照片式」直方图：暗部像素极多，亮部像素少但很显眼 */
  function photoLikeHistogram(): Map<number, number> {
    const h = new Map<number, number>();
    const put = (r: number, g: number, b: number, n: number) => {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      h.set(k, (h.get(k) ?? 0) + n);
    };
    // 阴影 / 黑背景：像素巨多
    put(12, 12, 12, 50000); put(28, 24, 20, 42000); put(36, 30, 24, 38000);
    put(20, 18, 14, 35000); put(44, 38, 30, 30000);
    // 中间调：像素中等
    put(120, 108, 90, 9000); put(150, 130, 100, 7000); put(96, 100, 110, 6000);
    // 亮部：像素不多，但正是看得见的部分
    put(228, 172, 20, 3000); put(250, 240, 210, 2000); put(200, 190, 180, 2500);
    put(180, 140, 60, 1800);
    return h;
  }

  it('挑出来的颜色要横跨暗部到亮部', () => {
    // 只挑 5 个（候选有 12 个）—— 必须挑少于候选数，否则全选中，怎么挑都"覆盖"了
    const picked = pickCovering(photoLikeHistogram(), 5);
    const ls = picked.map(lum);
    expect(Math.min(...ls)).toBeLessThan(60);
    // 按「出现最多」挑，前 5 个全是阴影和黑背景，亮度上不过 60
    expect(Math.max(...ls), `挑中的亮度：${ls.map((v) => v.toFixed(0)).join(', ')}`)
      .toBeGreaterThan(150);
  });

  it('权重悬殊时也不会全挑暗部 —— 这正是照片翻车的那个场景', () => {
    // 暗部像素比亮部多一个数量级，top-N 会被它们完全占满
    const picked = pickCovering(photoLikeHistogram(), 6);
    const bright = picked.filter((c) => lum(c) > 120);
    expect(bright.length, `挑中 ${picked.length} 个，其中亮的只有 ${bright.length} 个`)
      .toBeGreaterThanOrEqual(2);
  });

  it('不会挤在一起 —— 任意两个挑中的颜色都得拉开距离', () => {
    const picked = pickCovering(photoLikeHistogram(), 8);
    for (let i = 0; i < picked.length; i++)
      for (let j = i + 1; j < picked.length; j++) {
        const d = Math.abs(picked[i][0] - picked[j][0]) +
                  Math.abs(picked[i][1] - picked[j][1]) +
                  Math.abs(picked[i][2] - picked[j][2]);
        expect(d).toBeGreaterThan(8);
      }
  });

  it('要多少给多少，不够就有多少给多少', () => {
    expect(pickCovering(photoLikeHistogram(), 5).length).toBe(5);
    expect(pickCovering(new Map(), 5).length).toBe(0);
  });

  it('第一个仍然挑最常见的色 —— 覆盖不等于不管权重', () => {
    const picked = pickCovering(photoLikeHistogram(), 3);
    expect(lum(picked[0])).toBeLessThan(60); // 最多的那个确实是暗色
  });
});

describe('拟合', () => {
  const samples = fakeChartSamples();

  it('能从实测数据里还原出模型', () => {
    const fit = fitChart(samples);
    expect(fit).not.toBeNull();
    expect(fit!.matrix).toHaveLength(9);
    expect(fit!.curve).toHaveLength(3);
    expect(fit!.curve[0]).toHaveLength(CURVE_K);
    expect(fit!.rms * 255).toBeLessThan(20);
  });

  it('曲线必须单调 —— 不单调就求不了逆', () => {
    const fit = fitChart(samples)!;
    for (const ch of fit.curve)
      for (let i = 1; i < ch.length; i++) expect(ch[i]).toBeGreaterThan(ch[i - 1]);
  });

  it('比不校正明显更准', () => {
    const fit = fitChart(samples)!;
    const pwEval = (t: number, y: number[]) => {
      if (t <= 0) return y[0];
      if (t >= 1) return y[y.length - 1];
      const s = t * (y.length - 1);
      const i = Math.min(y.length - 2, Math.floor(s));
      return y[i] * (1 - (s - i)) + y[i + 1] * (s - i);
    };
    let se = 0, seNone = 0, n = 0;
    for (const s of samples)
      for (let c = 0; c < 3; c++) {
        const p =
          fit.matrix[c * 3] * (s.ref[0] / 255) +
          fit.matrix[c * 3 + 1] * (s.ref[1] / 255) +
          fit.matrix[c * 3 + 2] * (s.ref[2] / 255) + fit.offset[c];
        const y = pwEval(Math.max(0, Math.min(1, p)), fit.curve[c]) * 255;
        se += (y - s.got[c]) ** 2;
        seNone += (s.ref[c] - s.got[c]) ** 2;
        n++;
      }
    expect(Math.sqrt(se / n)).toBeLessThan(Math.sqrt(seNone / n) * 0.6);
  });

  it('被夹到 0/255 的样本要参与拟合，不能丢', () => {
    // 「这个值被压到了 0」本身就是强信息 —— 说明压制力度比模型算的更狠。
    // 丢掉之后模型会低估压制，补偿量就永远不够。
    const fit = fitChart(samples)!;
    expect(fit.clipped).toBeGreaterThan(0); // 假 Keynote 确实会把一些通道夹到 0
    expect(fit.rms * 255).toBeLessThan(20); // 有夹断样本仍然拟合得住
  });

  it('样本太少时老实返回 null，不硬解', () => {
    expect(fitChart(samples.slice(0, 3))).toBeNull();
  });
});

describe('单调分段曲线求逆', () => {
  const ys = [0.05, 0.3, 0.6, 0.85, 0.98];

  it('端点外的值夹在 0..1', () => {
    expect(pwInvert(0.0, ys)).toBe(0);
    expect(pwInvert(1.0, ys)).toBe(1);
  });

  it('节点上正好落在等分点', () => {
    for (let i = 0; i < CURVE_K; i++)
      expect(pwInvert(ys[i], ys)).toBeCloseTo(i / (CURVE_K - 1), 6);
  });

  it('确实是单调的', () => {
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.02) {
      const x = pwInvert(v, ys);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });
});

describe('假 Keynote 本身要像真的', () => {
  it('黑被抬亮、白到不了白 —— 和真实测到的量级一致', () => {
    expect(fakeKeynote255(0, 0, 0)[0]).toBeGreaterThan(8);
    expect(fakeKeynote255(255, 255, 255)[0]).toBeLessThan(235);
  });

  it('会串色：绿的输入没变，但红一变，绿的输出就跟着变', () => {
    // 串色的本质是「通道不独立」，而不是某个固定的方向。
    // 有这个性质，逐通道曲线才会失效、才需要三通道一起算的模型。
    const a = fakeKeynote255(0, 128, 0);
    const b = fakeKeynote255(255, 128, 0);
    expect(a[1]).not.toBe(b[1]);
  });

  it('饱和色的某个通道会被夹到 0', () => {
    expect(fakeKeynote255(253, 190, 46)[2]).toBe(0);
  });
});

describe('版式常量不能被写死的下标绕过', () => {
  // 白点探测曾经写死 samples[5]，灰阶从 6 级加密到 8 级之后它就一直在报错误的格子，
  // 还附赠一句「把补光往上调」——调到 100% 那个数也不动，因为它压根不是白点。
  it('WHITE_INDEX 指向的确实是纯白', () => {
    expect(GRAYS[WHITE_INDEX]).toBe(255);
    expect(chartPatches()[WHITE_INDEX]).toEqual([255, 255, 255]);
  });

  it('灰阶排在色卡最前面，而且严格递增', () => {
    const p = chartPatches();
    GRAYS.forEach((v, i) => expect(p[i]).toEqual([v, v, v]));
    for (let i = 1; i < GRAYS.length; i++) expect(GRAYS[i]).toBeGreaterThan(GRAYS[i - 1]);
  });

  it('对齐校验格和它对应的那级灰同色 —— 一头一尾比对才能抓到错位', () => {
    const p = chartPatches();
    expect(p[p.length - 1]).toEqual(p[4]);
  });
});
