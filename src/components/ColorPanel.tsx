import { useEffect, useRef, useState } from 'react';
import { applyToHex, applyToImageData, type ColorComp } from '../lib/color';

/**
 * 实测样本上限 —— 局部修正建表是 n³ 的。密集标定一次就是 1100 多个点，
 * 实测建表约 0.7 s（只在校准变了之后算一次），2000 以内都扛得住。
 */
const MAX_SAMPLES = 2000;
import { COLS, DENSE_PAGES, DENSE_TOTAL, WHITE_INDEX, fitChart, sampleChart, type Sample } from '../lib/chart';
import { Slider } from './Slider';
import { parseProfile, profileFileName, serializeProfile } from '../lib/profile';
import type { FaceTextureStore } from '../lib/faceTexture';
import { defaultProfiles, profileKey, TARGETS, targetLabel, type ModelType, type TargetId } from '../lib/types';
import { COVER_RADIUS, NEAR_ENOUGH, coverageOf, coverageVerdict, type CoverageReport } from '../lib/coverage';
import { materialPreset, type MaterialId } from '../lib/material';

type Props = {
  comp: ColorComp;
  patch: (c: Partial<ColorComp>) => void;
  /** 导出给哪个 App 用 —— 每个目标各有一份校准档 */
  target: TargetId;
  setTarget: (t: TargetId) => void;
  store: FaceTextureStore;
  selected: number | null;
  hasImage: boolean;
  tick: number;
  onExportChart: (densePage?: number) => void;
  /** 色卡跟着当前模型走：卡片模式导出的是卡片形状的色卡 */
  shapeLabel: string;
  /** 当前模型类型 —— 档按「目标 × 模型类型」分槽，导入时也要核对 */
  modelType: ModelType;
  unlit: boolean;
  setUnlit: (v: boolean) => void;
  lift: number;
  setLift: (v: number) => void;
  /** 当前材质 —— 也是校准条件之一，补光低的时候它对亮度是压倒性的 */
  material: MaterialId;
};

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

/**
 * 左边是视口里那张（= Keynote 里应该长成的样子），右边是真正写进 usdz 的那张。
 * 顺便报一个「平均改了多少阶」—— 这是判断补偿到底有没有生效最直接的数字。
 */
/**
 * 当前这张贴图的颜色，有没有实测支撑。
 *
 * 排查「蓝色系画面发黄」花掉了一整轮来回，卡点就是没人能回答**为什么偏偏是这张图**。
 * 答案其实是死的：那张图的主色离最近的锚点 63 阶，而局部修正的作用半径只有 18 阶，
 * 整张图全靠全局公式外推。这个判断三秒就该给出来，所以把它摆在界面上。
 */
function Coverage({
  store,
  index,
  tick,
  comp,
}: {
  store: FaceTextureStore;
  index: number;
  tick: number;
  comp: ColorComp;
}) {
  const [report, setReport] = useState<CoverageReport | null>(null);

  useEffect(() => {
    const src = store.canvases[index];
    if (!src.width || !src.height) return setReport(null);
    // 缩到小图再统计：代表色只关心分布，不需要逐个原始像素，2K 全量会卡住拖动
    const N = 160;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = Math.max(1, Math.round((N * src.height) / src.width));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return setReport(null);
    try {
      ctx.drawImage(src, 0, 0, c.width, c.height);
      setReport(coverageOf(ctx.getImageData(0, 0, c.width, c.height).data, comp));
    } catch {
      setReport(null);
    }
  }, [store, index, tick, comp]);

  if (!report) return null;
  const v = coverageVerdict(report);
  // 按「离锚点最远」排，最该关心的排前面
  const worst = [...report.probes].sort((a, b) => b.nearest - a.nearest).slice(0, 6);
  return (
    <div className="coverage">
      <span className="slider-head">
        <span>这张图的颜色覆盖</span>
      </span>
      <p className={`cover-verdict ${v.level}`}>{v.text}</p>
      <div className="cover-list">
        {worst.map((p, i) => (
          <div className="cover-item" key={i}>
            <i style={{ background: `rgb(${p.color.join(',')})` }} />
            <b className={p.ok ? '' : 'far'}>{Math.round(p.nearest)} 阶</b>
          </div>
        ))}
      </div>
      <p className="hint tight">
        每格是画面里的一个代表色，数字是它到最近实测点的距离。
        {Math.round(COVER_RADIUS)} 阶以内有实测点直接兜底；超过 {NEAR_ENOUGH} 阶就跑出了
        实测范围，只能靠外推，是最容易偏色的地方（标红）。
      </p>
    </div>
  );
}

function BeforeAfter({
  store,
  index,
  tick,
  comp,
}: {
  store: FaceTextureStore;
  index: number;
  tick: number;
  comp: ColorComp;
}) {
  const left = useRef<HTMLCanvasElement>(null);
  const right = useRef<HTMLCanvasElement>(null);
  const [delta, setDelta] = useState(0);

  useEffect(() => {
    const a = left.current;
    const b = right.current;
    if (!a || !b) return;
    const src = store.canvases[index];
    const W = 108;
    const H = Math.max(8, Math.round((W * src.height) / src.width));
    const dpr = Math.min(2, window.devicePixelRatio);
    for (const el of [a, b]) {
      el.width = W * dpr;
      el.height = H * dpr;
      el.style.width = `${W}px`;
      el.style.height = `${H}px`;
    }
    const ca = a.getContext('2d')!;
    ca.setTransform(dpr, 0, 0, dpr, 0, 0);
    ca.drawImage(src, 0, 0, W, H);

    const cb = b.getContext('2d', { willReadFrequently: true })!;
    cb.setTransform(dpr, 0, 0, dpr, 0, 0);
    cb.drawImage(src, 0, 0, W, H);
    const img = cb.getImageData(0, 0, W * dpr, H * dpr);
    const before = Uint8ClampedArray.from(img.data);
    applyToImageData(img.data, comp);
    cb.setTransform(1, 0, 0, 1, 0, 0);
    cb.putImageData(img, 0, 0);

    let sum = 0;
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      sum += Math.abs(img.data[i] - before[i]);
      sum += Math.abs(img.data[i + 1] - before[i + 1]);
      sum += Math.abs(img.data[i + 2] - before[i + 2]);
      n += 3;
    }
    setDelta(n ? sum / n : 0);
  }, [store, index, tick, comp]);

  return (
    <div className="ba">
      <div className="ba-pair">
        <div>
          <canvas ref={left} />
          <span>现在看到的</span>
        </div>
        <div>
          <canvas ref={right} />
          <span>写进文件的</span>
        </div>
      </div>
      <div className={`ba-delta${delta < 0.5 ? ' zero' : ''}`}>
        {delta < 0.5 ? '没有生效：两张一模一样' : `已生效：像素平均改了 ${delta.toFixed(1)} 阶`}
      </div>
    </div>
  );
}

/** 24 个色块的「送进去 / 量回来」对照：上半格是基准色，下半格是 Keynote 里量到的 */
function Swatches({ samples }: { samples: Sample[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cell = 42;
    const rows = Math.ceil(samples.length / COLS);
    const dpr = Math.min(2, window.devicePixelRatio);
    el.width = COLS * cell * dpr;
    el.height = rows * cell * dpr;
    el.style.width = `${COLS * cell}px`;
    el.style.height = `${rows * cell}px`;
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    samples.forEach((s, i) => {
      const x = (i % COLS) * cell;
      const y = ((i / COLS) | 0) * cell;
      ctx.fillStyle = `rgb(${s.ref.join(',')})`;
      ctx.fillRect(x + 1, y + 1, cell - 2, cell / 2 - 1);
      ctx.fillStyle = `rgb(${s.got.map((v) => Math.round(v)).join(',')})`;
      ctx.fillRect(x + 1, y + cell / 2, cell - 2, cell / 2 - 1);
    });
  }, [samples]);
  return <canvas ref={ref} style={{ borderRadius: 4 }} />;
}

/**
 * 找出画面里占比最大的那块实色，忽略接近黑的背景。
 * 用 5 bit 量化聚类，再在簇内取精确均值 —— 直接按 8 bit 计数会被抗锯齿和压缩噪点打散。
 */
function colorClusters(bmp: ImageBitmap, max = 5): { c: [number, number, number]; n: number }[] {
  const w = Math.min(900, bmp.width);
  const h = Math.max(1, Math.round((w * bmp.height) / bmp.width));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const bins = new Map<number, number>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] < 60) continue;
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  const min = (w * h) / 50;
  const keys = [...bins.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, max);
  return keys.map(([key, n]) => {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      if (k !== key) continue;
      sr += d[i];
      sg += d[i + 1];
      sb += d[i + 2];
      cnt++;
    }
    return { c: [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)] as [number, number, number], n };
  });
}

const dist = (a: number[], b: number[]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export type Cluster = { c: [number, number, number]; n: number };

/**
 * 把贴图里的代表色和截图里的色块配对。
 *
 * 难点在于「颜色本身已经被 Keynote 改过了」，所以不能按颜色近似去匹配 ——
 * 一块被推成亮青的蓝，和原图里另一块本来就偏青的颜色，看着比它自己更像。
 *
 * 可靠的不变量是**面积占比**：Keynote 改颜色但不改几何，贴图里占三成的那个颜色，
 * 在成品截图里还是占约三成。所以两边各按占比降序排，一一对上。
 * 再用亮度做一次一致性校验：Keynote 的响应是单调的（亮的还是亮），配对之后
 * 两边的亮度排名不该发生大幅倒挂，倒挂的那几对多半是配错了，宁可丢掉。
 *
 * 为什么非要多点：局部修正的作用半径只有 18 阶，而一张渐变图的颜色跨度轻松上 200 阶。
 * 只锚主色一个点，顶多修好其中一小段，剩下的照旧走全局公式 —— 这就是「微调完还是偏」
 * 的原因。
 */
export function pairClusters(want: Cluster[], shot: Cluster[]): { want: Cluster; got: Cluster }[] {
  const k = Math.min(want.length, shot.length);
  if (k === 0) return [];
  const a = [...want].sort((x, y) => y.n - x.n).slice(0, k);
  const b = [...shot].sort((x, y) => y.n - x.n).slice(0, k);
  const pairs = a.map((w, i) => ({ want: w, got: b[i] }));
  const onlyMain = pairs.slice(0, 1); // 配不出可信的多点时，退回「只锚主色」这个保守行为
  if (pairs.length < 3) return onlyMain;

  // 校验一：先剔掉偏差离群的那几对。
  // 配错的那一对往往是「这块的颜色」被对到了「另一块的颜色」上，偏差显著大于其他对。
  // 它必须**第一个**被拿掉 —— 名次校验对离群点极其脆弱：一个错点会把其余所有点的
  // 亮度名次整体推移一位，于是「名次必须一致」会把好的点也一起误杀（实测过）。
  const devOf = (p: { want: Cluster; got: Cluster }) => dist(p.want.c, p.got.c);
  const devs = pairs.map(devOf).sort((x, y) => x - y);
  const mid = devs[Math.floor(devs.length / 2)];
  let kept = pairs.filter((p) => devOf(p) <= Math.max(60, mid * 2.5));
  if (kept.length < 3) return onlyMain;

  // 校验二：在剩下的里，亮度名次必须**严格**一致。
  // 目标渲染器的响应是单调的（亮的还是亮），名次一旦错位就说明配错了。
  // 这里原来容许名次差到一半，等于没过滤 —— 8 个点时容许差 4 名，几乎什么都拦不住，
  // 错点进了校准，局部修正（它是精确穿过每个锚点的）就被拽出陡坑，
  // 平滑渐变经过它断成一块块 —— 用户实际遇到过：微调完背景全是马赛克。
  const rank = (pick: (p: { want: Cluster; got: Cluster }) => Cluster) => {
    const sorted = [...kept].sort((p, q) => lum(pick(p).c) - lum(pick(q).c));
    return new Map(sorted.map((p, i) => [p, i]));
  };
  const rw = rank((p) => p.want);
  const rg = rank((p) => p.got);
  kept = kept.filter((p) => rw.get(p) === rg.get(p));

  return kept.length >= 3 ? kept : onlyMain;
}

/**
 * 可以点、也可以把文件拖上去的按钮。
 * `accept` 既给文件选择框用，也用来筛拖进来的文件 —— 拖错类型的文件应当直接忽略，
 * 而不是交给下游去报一个看不懂的错。
 */
function ChartDrop({
  onPick,
  label,
  accept = 'image/*',
}: {
  onPick: (f: File) => void;
  label: string;
  accept?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const wanted = (f: File) =>
    accept === 'image/*'
      ? f.type.startsWith('image/')
      : f.type === 'application/json' || f.name.toLowerCase().endsWith('.json');
  return (
    <button
      className="chart-drop"
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        e.currentTarget.classList.add('drag-over');
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
      onDrop={(e) => {
        e.currentTarget.classList.remove('drag-over');
        const f = [...e.dataTransfer.files].find(wanted);
        if (!f) return;
        e.preventDefault();
        onPick(f);
      }}
    >
      {label}
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onPick(f);
        }}
      />
    </button>
  );
}

export function ColorPanel({
  comp,
  patch,
  target,
  setTarget,
  store,
  selected,
  hasImage,
  tick,
  onExportChart,
  shapeLabel,
  modelType,
  unlit,
  setUnlit,
  lift,
  setLift,
  material,
}: Props) {
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  /**
   * 密集标定的进度：三张色卡各自的实测，收齐才合成。存在 localStorage 里，
   * 关掉页面再回来还在；按「目标 × 模型类型」分开，补光/灯光/材质一变就作废 ——
   * 三张色卡必须是同一条件下截的，中途换了任何一项，攒着的就不能再和新的混在一起。
   */
  const denseKey = `prism-usdz-exporter/dense/${profileKey(target, modelType)}`;
  type DenseSession = { lift: number; unlit: boolean; material?: string; pages: Record<string, Sample[]> };
  const readDense = (): DenseSession | null => {
    try {
      const raw = localStorage.getItem(denseKey);
      if (!raw) return null;
      const d = JSON.parse(raw) as DenseSession;
      return d && d.pages ? d : null;
    } catch {
      return null;
    }
  };
  const [denseDone, setDenseDone] = useState<number[]>(() => {
    const d = readDense();
    return d ? Object.keys(d.pages).map(Number) : [];
  });
  const writeDense = (d: DenseSession | null) => {
    try {
      if (d) localStorage.setItem(denseKey, JSON.stringify(d));
      else localStorage.removeItem(denseKey);
    } catch {
      /* 忽略 */
    }
    setDenseDone(d ? Object.keys(d.pages).map(Number) : []);
  };
  // 切了目标或模型类型，进度显示要跟着换那一份
  useEffect(() => {
    const d = readDense();
    setDenseDone(d ? Object.keys(d.pages).map(Number) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denseKey]);

  /** 一批实测 → 拟合 → 写进档。普通色卡和密集色卡最后都走这里 */
  const applyCalibration = (measured: Sample[], label: string, uneven?: number) => {
    const fit = fitChart(measured);
    if (!fit) return setMsg('可用色块太少，解不出来。确认截图里色卡完整。');
    setSamples(measured);
    const fresh = measured.map((s) => ({
      ref: s.ref as [number, number, number],
      got: s.got.map((v) => Math.round(v)) as [number, number, number],
    }));
    // 整张色卡重标 = 一轮新的、完整的基准，**不沿用上一份档里的锚点**。
    // 曾经是累积的（想把历次动态探针攒起来），结果 2026-09-13 栽了：上一份档是量错的
    // （说 178,178,218 → 185,178,218 几乎不变），48 个旧锚点原样带进新档，和同一轮色卡
    // 182,182,182 → 222,222,222 自相矛盾，浅灰一带被旧点拉歪。旧锚点到底是不是同一条件下
    // 测的，代码判不出来（补光、灯光开关一样也可能是错的），只有清空才稳。
    // 想攒点：标完之后用「成品截图微调」往这份新档上加。
    const merged = fresh.slice(-MAX_SAMPLES);
    patch({
      on: true,
      matrix: fit.matrix,
      offset: fit.offset,
      curve: fit.curve,
      samples: merged,
      calibratedAt: label,
      calibratedUnlit: unlit,
      calibratedLift: lift,
      calibratedMaterial: material,
    });
    // 纯白能到多少决定了颜色上限。但上限未必能靠补光一直抬 —— Keynote 的色调曲线
    // 有个硬顶，到了之后再加补光白点也不动，只会白白压平立体感。所以要和上一次比。
    // 白点按 ref 找，下标只当兜底 —— 写死下标正是上一个 bug 的根源（见 chart.ts 的 GRAYS）
    const whiteSample =
      measured.find((x) => x.ref[0] === 255 && x.ref[1] === 255 && x.ref[2] === 255) ??
      measured[WHITE_INDEX];
    const white = Math.round(Math.max(...whiteSample.got));
    // 白点记录**必须按目标分开存**。原来是一个全局键，于是在无边记标一次
    // （补光 50%、纯白 247）就会把 Keynote 的记录冲掉，下次在 Keynote 标定时
    // 拿它做对比，会得出「补光从 50% 加到 75%」这种前提错误的结论。
    // 材质也要进键名 —— 2026-09-23 踩过：在金属下量的 195 和纸张下量的 226 被当成
    // 「同一条曲线上的两点」比较，得出的「降补光白点也没掉」纯属巧合。
    const probeKey = `prism-usdz-exporter/white-probe/${target}/${material}`;
    const prevRaw = localStorage.getItem(probeKey);
    const prev = prevRaw ? (JSON.parse(prevRaw) as { lift: number; white: number }) : null;
    try {
      localStorage.setItem(probeKey, JSON.stringify({ lift, white }));
    } catch {
      /* 忽略 */
    }
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const up = prev && lift > prev.lift + 0.02;
    const down = prev && lift < prev.lift - 0.02;
    let advice: string;
    if (up && white <= prev.white + 2) {
      advice = `纯白 ${white}，补光从 ${pct(prev.lift)} 加到 ${pct(lift)} 也没抬起来 —— 到硬顶了。把补光调回 ${pct(prev.lift)} 或更低再校一次，能少损失一些立体感`;
    } else if (down && white >= prev.white - 2) {
      // 降补光而白点没掉 —— 纯赚：自发光不随角度变化，加得越多明暗越平
      advice =
        `纯白 ${white}，补光从 ${pct(prev.lift)} 降到 ${pct(lift)} 白点也没掉 —— 这一档更划算，立体感更好。` +
        (lift <= 0.02 ? '已经是 0 了，不能再降，就用这一档' : '还可以再往下试');
    } else if (down) {
      advice = `纯白 ${white}（上次 ${pct(prev!.lift)} 时是 ${prev!.white}），降补光掉了 ${prev!.white - white} 阶。够用就留着，觉得暗就调回去`;
    } else if (white >= 252) {
      advice = `纯白能到 ${white}，上限够用`;
    } else if (up && white > prev.white + 2) {
      advice = `纯白 ${white}（上次 ${prev.white}），还在涨，可以再往上调试试`;
    } else {
      advice = `纯白能到 ${white}。想再高就把补光往上调再校一次；如果调了不涨就是到顶了`;
    }
    // 光照不均单独报一行：它和残差、白点是三个不同的指标，选补光那一档时三个都要看。
    // 同一个颜色在模型左上和右下差这么多，校准只能校到平均值 —— 这就是精度的天花板。
    const light =
      uneven === undefined
        ? ''
        : uneven >= 10
          ? ` · 光照不均 ${Math.round(uneven)} 阶（补光越低越明显，立体感的代价；超过 15 阶就别再往下降了）`
          : ` · 光照不均 ${Math.round(uneven)} 阶（很均匀）`;
    setMsg(
      `校准完成 · 残差 ${(fit.rms * 255).toFixed(1)} 阶 · 已标定 ${merged.length} 个颜色${light} · ${advice}`,
    );
  };

  const onChartShot = async (file: File) => {
    setMsg('正在识别色卡…');
    setSamples(null);
    try {
      const r = sampleChart(await decode(file));
      if (!r.ok) return setMsg(r.reason ?? '识别失败');
      const stamp = new Date().toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

      if (r.densePage === undefined) return applyCalibration(r.samples, stamp, r.uneven);

      // 密集色卡：先攒，三张收齐再合成
      const prev = readDense();
      // 补光/灯光开关和之前收的那几张不一样 —— 那几张作废，从这一张重新开始
      const same =
        prev &&
        Math.abs(prev.lift - lift) < 0.001 &&
        prev.unlit === unlit &&
        (prev.material ?? material) === material;
      const pages: Record<string, Sample[]> = { ...(same ? prev!.pages : {}), [r.densePage]: r.samples };
      const session: DenseSession = { lift, unlit, material, pages };
      const have = Object.keys(pages).map(Number).sort();
      if (have.length < DENSE_PAGES) {
        writeDense(session);
        const missing = Array.from({ length: DENSE_PAGES }, (_, i) => i).filter((i) => !pages[i]);
        return setMsg(
          `密集色卡第 ${r.densePage + 1} 张已收 · 已收 ${have.length}/${DENSE_PAGES}` +
            (prev && !same ? '（补光、灯光或材质和之前收的不一样，之前收的已作废）' : '') +
            ` · 还差第 ${missing.map((i) => i + 1).join('、')} 张：导出、拖进 ${label}、截图、传回来`,
        );
      }
      // 收齐：按 ref 去重（灰阶每张都有），同一个 ref 取平均
      const acc = new Map<string, { ref: Sample['ref']; sum: [number, number, number]; n: number }>();
      for (const i of have) {
        for (const s of pages[i]) {
          const k = s.ref.join(',');
          const e = acc.get(k) ?? { ref: s.ref, sum: [0, 0, 0], n: 0 };
          e.sum[0] += s.got[0];
          e.sum[1] += s.got[1];
          e.sum[2] += s.got[2];
          e.n++;
          acc.set(k, e);
        }
      }
      const all: Sample[] = [...acc.values()].map((e) => ({
        ref: e.ref,
        got: [e.sum[0] / e.n, e.sum[1] / e.n, e.sum[2] / e.n] as Sample['got'],
      }));
      writeDense(null);
      applyCalibration(all, `密集 ${all.length} 格 · ${stamp}`);
    } catch (e) {
      setMsg(`识别失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 把当前校准档存成文件 —— 标定是有成本的，成果不该锁在一个浏览器里 */
  const onExportProfile = () => {
    if (!comp.matrix) return setMsg('现在没有校准数据可以导出');
    const blob = new Blob([JSON.stringify(serializeProfile(comp, target, modelType), null, 1)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = profileFileName(comp, target, modelType);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg(`已导出校准档 · ${(comp.samples ?? []).length} 个实测点`);
  };

  /** 装回一份校准档。补光 / 灯光开关跟着档走 —— 它们和校准数据是绑定的 */
  const onImportProfile = async (file: File) => {
    const res = parseProfile(await file.text());
    if (!res.ok) return setMsg(`导入失败：${res.reason}`);
    // 档里记着它是给哪个目标标的。装错目标是最难查的一类问题 —— 数据本身完全合法，
    // 只是测的不是这个渲染器，颜色会莫名其妙全偏。所以对不上就直接拦住，不给它装进去。
    if (res.target && res.target !== target) {
      return setMsg(
        `这份档是给「${targetLabel(res.target as TargetId)}」标的，当前目标是「${label}」，没有导入。` +
          `先切到对应的目标再导，或者确认你真的要把它用在这里`,
      );
    }
    // 模型类型同理：卡片档和棱柱档差 20~40 阶，装错了颜色整体偏。老档没记这一项，只提示不拦。
    if (res.shape && res.shape !== modelType) {
      return setMsg(
        `这份档是按「${res.shape === 'card' ? '卡片' : '棱柱'}」标的，当前是「${shapeLabel}」，没有导入。` +
          `先切到对应的模型类型再导`,
      );
    }
    patch(res.comp);
    const notes: string[] = [];
    if (res.unlit !== null && res.unlit !== unlit) {
      setUnlit(res.unlit);
      notes.push(`灯光开关已跟着改成「${res.unlit ? '关掉' : '开着'}」`);
    }
    if (res.lift !== null && Math.abs(res.lift - lift) > 0.001) {
      setLift(res.lift);
      notes.push(`补光已跟着调到 ${Math.round(res.lift * 100)}%`);
    }
    setSamples(null);
    setMsg(
      `已导入校准档 · ${res.sampleCount} 个实测点` +
        (res.target ? '' : '（这份档没记目标，请自行确认是给这个 App 标的）') +
        (res.shape ? '' : '（这份档没记模型类型，请自行确认是按当前形状标的）') +
        (res.comp.calibratedAt ? ` · 标定于 ${res.comp.calibratedAt}` : '') +
        (notes.length ? ` · ${notes.join('，')}` : ''),
    );
  };

  /**
   * 闭环微调：拿成品在 Keynote 里的截图，量出实际颜色，和「打算写进去的值」配成一对
   * 锚点塞回校准里。局部修正会让模型在这个点上精确复现，下次导出就命中。
   * 模型再准也有插值误差，这一步是拿实测把误差直接抹掉。
   */
  const onVerifyShot = async (file: File) => {
    setMsg('正在量成品截图…');
    try {
      if (selected === null || !hasImage) return setMsg('先选中一个贴了图的面');
      const K = 6; // 一次最多锚这么多个颜色（宁可少而准）
      const wantList = colorClusters(await createImageBitmap(store.canvases[selected]), K);
      if (wantList.length === 0) return setMsg('当前面的贴图里找不到主色');
      let shots = colorClusters(await decode(file), K + 2);
      if (shots.length === 0) return setMsg('截图里找不到成片的实色区域，把模型截大一点');

      // 截图里可能同时有「参考原图」和「成品模型」。参考那块的颜色等于目标色，
      // 它没有测量价值（它没经过 Keynote 的 3D 渲染），先把这类剔掉。
      const refLike = shots.filter((sh) => wantList.some((wv) => dist(sh.c, wv.c) < 8));
      if (refLike.length && shots.length - refLike.length >= 2) {
        shots = shots.filter((sh) => !refLike.includes(sh));
      }

      const pairs = pairClusters(wantList, shots);
      if (pairs.length === 0) return setMsg('配不上颜色。把截图裁成只剩模型那一块再试');

      // 每一对：目标色 → 按当前校准该写进贴图的值（ref），以及成品实测（got）
      const fresh = pairs.map((p) => {
        const hex = `#${p.want.c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        const wm = /^#([0-9a-f]{6})$/i.exec(applyToHex(hex, comp))!;
        const n = parseInt(wm[1], 16);
        return {
          ref: [(n >> 16) & 255, (n >> 8) & 255, n & 255] as [number, number, number],
          got: p.got.c,
        };
      });
      // 只替换几乎重合的旧锚点。历史锚点要留着 —— 单个点只能告诉模型「这里偏多少」，
      // 附近有两三个点它才学得到局部斜率，否则每轮都会停在差几阶的地方。
      const rest = (comp.samples ?? []).filter(
        (s) => !fresh.some((f) => dist(s.ref, f.ref) <= 2),
      );
      patch({ samples: [...rest, ...fresh] });

      const worst = fresh.reduce(
        (m, f, i) => Math.max(m, dist(pairs[i].want.c, f.got) / 3),
        0,
      );
      setMsg(
        `已锚定 ${fresh.length} 个颜色（这张图的明暗都覆盖到了）· 最大偏差约 ${worst.toFixed(0)} 阶` +
          (refLike.length ? ' · 已排除截图里的参考图那一块' : '') +
          '。现在重新导出一次',
      );
    } catch (e) {
      setMsg(`量取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const mismatch =
    (comp.calibratedUnlit !== null && comp.calibratedUnlit !== unlit) ||
    (comp.calibratedLift !== null && Math.abs(comp.calibratedLift - lift) > 0.02);
  /**
   * 材质对不上单独提示。2026-09-23 的教训：在金属材质下量了三轮补光，
   * 得出「补光不能降」的结论，其实量的是金属的账 —— 金属漫反射几乎为零，
   * 补光 0 时纯白只有 124，纸张高得多。补光越低这条越要命，所以要说出来。
   */
  const matMismatch = comp.calibratedMaterial !== null && comp.calibratedMaterial !== material;

  const label = targetLabel(target);

  return (
    <section>
      <h2>颜色</h2>

      {/* 每个 App 对贴图的颜色处理都不一样，各存各的校准档 */}
      <div className="opts" role="group" aria-label="导出给哪个 App 用">
        {TARGETS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="opt"
            aria-pressed={target === t.id}
            onClick={() => setTarget(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <label className="check switch after-opts">
        <input type="checkbox" checked={comp.on} onChange={(e) => patch({ on: e.target.checked })} />
        <span>{label} 偏色抵消</span>
      </label>
      {/* 勾选项下面不再解释 —— 怎么校准展开「校准」那一栏里说 */}
      {comp.on && !comp.matrix && (
        <p className="hint warn tight">
          没有校准数据，现在开着也不起作用 —— 展开下面点「恢复内置校准」。
        </p>
      )}

      <details className="tweaks">
        <summary>{comp.matrix ? '重新校准（一般不用）' : `校准 ${label}`}</summary>
        {selected !== null && hasImage && (
          <BeforeAfter store={store} index={selected} tick={tick} comp={comp} />
        )}
        {selected !== null && hasImage && (
          <Coverage store={store} index={selected} tick={tick} comp={comp} />
        )}
      <Slider
          label="补光（换取更亮的颜色上限）"
          reset={1}
          value={Math.round(lift * 100)}
          min={0}
          max={100}
          step={5}
          suffix="%"
          disabled={unlit}
          onChange={(v) => setLift(v / 100)}
        />
      <p className="hint tight">
        {label} 算像素是「贴图 × 灯光 + 自发光」。乘法那项有天花板（灯光系数小于 1，贴图再白也到不了纯白），
        加法那项没有。往上加自发光能把上限抬起来，代价是自发光不随角度变化，加得越多明暗越平。
        <b>改了这个必须重新校准。</b>
      </p>

      <label className="check">
        <input type="checkbox" checked={unlit} onChange={(e) => setUnlit(e.target.checked)} />
        <span>完全关掉灯光（补光拉满）</span>
      </label>
      {matMismatch && (
        <p className="hint warn tight">
          当前校准是在「{materialPreset(comp.calibratedMaterial as MaterialId).label}」下测的，现在的材质是「
          {materialPreset(material).label}」—— 材质变了亮度就变了，补光越低差得越多
          （实测金属在补光 0 时纯白只有 124，纸张高得多）。要标定就先把材质调回去。
        </p>
      )}
      {mismatch && (
        <p className="hint warn tight">
          当前校准是在「补光 {Math.round((comp.calibratedLift ?? 0) * 100)}%、灯光
          {comp.calibratedUnlit ? '关着' : '开着'}」下测的，和现在的设置对不上 —— 颜色会偏。
          要么把设置调回去，要么展开下面重新校准一次。
        </p>
      )}


        <p className="hint tight">
          当前：{comp.matrix ? comp.calibratedAt ?? '已校准' : '无'}。换了 {label} 版本、换了显示器，
          或者上面那个灯光开关改了，才需要重测。
        </p>
        <ol className="steps">
          <li>
            <button className="btn" onClick={() => onExportChart()}>
              导出色卡{shapeLabel}
            </button>
            <span>
              和你实际用的同款{shapeLabel}，只是贴了色卡。拖进 {label}，转到正对着你的那个面截图，
              要能看到完整的粉色边框。
            </span>
          </li>
          <li>
            <ChartDrop onPick={onChartShot} label="上传色卡截图" />
            <span>把截图拖进来，自动量出偏色。</span>
          </li>
        </ol>
        <div className="dense">
          <span className="hint tight">
            <b>密集标定（一次到位）。</b>把整个色域量透：{DENSE_TOTAL} 个颜色、相邻只差 28 阶，
            分 {DENSE_PAGES} 张色卡。每张都走上面两步（导出 → 拖进 {label} → 截图 → 传回「上传色卡截图」），
            三张收齐自动合成一份档。之后换任何图都直接导，不用再标。
          </span>
          <div className="profile-btns">
            {Array.from({ length: DENSE_PAGES }, (_, i) => (
              <button
                key={i}
                className={`btn${denseDone.includes(i) ? ' done' : ''}`}
                onClick={() => onExportChart(i)}
                title={denseDone.includes(i) ? '这一张已经收到截图了' : undefined}
              >
                {denseDone.includes(i) ? '✓ ' : ''}导出第 {i + 1} 张
              </button>
            ))}
            {denseDone.length > 0 && (
              <button className="btn" onClick={() => writeDense(null)}>
                清空进度（{denseDone.length}/{DENSE_PAGES}）
              </button>
            )}
          </div>
        </div>
        {/* 结果紧跟在步骤下面。原来排在「成品截图微调」后面，隔了一整块，
            上传完色卡截图的人根本翻不到，只会以为「传了没反应」 */}
        {msg && <p className={`chart-msg${comp.matrix ? '' : ' warn'}`}>{msg}</p>}

        <div className="verify">
          <ChartDrop onPick={onVerifyShot} label="上传成品截图微调" />
          <span className="hint tight">
            微调：把<b>成品</b>在 {label} 里的截图拖进来（不是色卡），工具会量出这张图里
            一批覆盖明暗的颜色，全部锚死进校准。再导一次就精确命中。
            截图尽量<b>只留模型那一块</b>，配对靠的是各块颜色的面积占比。
          </span>
        </div>
        {samples && <Swatches samples={samples} />}
        <div className="profile-io">
          <span className="hint tight">
            <b>校准档存取。</b>标定结果只存在这个浏览器里 —— 换电脑、换浏览器、清一次数据就没了。
            存成文件就能带走，也能发给别人直接用。
          </span>
          <div className="profile-btns">
            <button className="btn" onClick={onExportProfile}>
              导出校准档
            </button>
            <ChartDrop onPick={onImportProfile} label="导入校准档" accept="application/json,.json" />
          </div>
        </div>
        {/* 出厂档按「目标 × 模型类型」分，卡片和棱柱不是同一份 */}
        <button className="btn" onClick={() => patch(defaultProfiles()[profileKey(target, modelType)])}>
          恢复内置校准
        </button>
      </details>
    </section>
  );
}
