import { useEffect, useRef, useState } from 'react';
import { applyToHex, applyToImageData, type ColorComp } from '../lib/color';

/** 累积的实测样本上限 —— 局部修正建表是 n³ 的，攒太多会拖慢导出 */
const MAX_SAMPLES = 400;
import { COLS, WHITE_INDEX, fitChart, sampleChart, type Sample } from '../lib/chart';
import { Slider } from './Slider';
import { parseProfile, profileFileName, serializeProfile } from '../lib/profile';
import type { FaceTextureStore } from '../lib/faceTexture';
import { defaultProfiles, TARGETS, targetLabel, type TargetId } from '../lib/types';

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
  onExportChart: () => void;
  unlit: boolean;
  setUnlit: (v: boolean) => void;
  lift: number;
  setLift: (v: number) => void;
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
  if (pairs.length < 3) return pairs;
  // 亮度排名一致性：两边各自按亮度排名，名次差得太离谱的丢掉
  const rank = (pick: (p: { want: Cluster; got: Cluster }) => Cluster) => {
    const sorted = [...pairs].sort((p, q) => lum(pick(p).c) - lum(pick(q).c));
    return new Map(sorted.map((p, i) => [p, i]));
  };
  const rw = rank((p) => p.want);
  const rg = rank((p) => p.got);
  const limit = Math.max(1, Math.floor(pairs.length / 2));
  return pairs.filter((p) => Math.abs((rw.get(p) ?? 0) - (rg.get(p) ?? 0)) <= limit);
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
  unlit,
  setUnlit,
  lift,
  setLift,
}: Props) {
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const onChartShot = async (file: File) => {
    setMsg('正在识别色卡…');
    setSamples(null);
    try {
      const r = sampleChart(await decode(file));
      if (!r.ok) return setMsg(r.reason ?? '识别失败');
      const fit = fitChart(r.samples);
      if (!fit) return setMsg('可用色块太少，解不出来。确认截图里色卡完整。');
      setSamples(r.samples);
      const fresh = r.samples.map((s) => ({
        ref: s.ref as [number, number, number],
        got: s.got.map((v) => Math.round(v)) as [number, number, number],
      }));
      // 标定结果是**累积**的，不是覆盖。色卡每次只有 19 个动态格跟着当前图片走，
      // 换一张色调不同的图，新格子测的是新颜色 —— 把上次测过的留着，标过的颜色就越攒越多，
      // 不用每换一张图就从头标一次。
      // 但补光/灯光开关一变，整条响应曲线就变了，旧数据全部作废，必须重来。
      const sameCond = comp.calibratedLift === lift && comp.calibratedUnlit === unlit;
      const kept = sameCond
        ? (comp.samples ?? []).filter((o) =>
            fresh.every(
              (n) =>
                Math.abs(n.ref[0] - o.ref[0]) +
                  Math.abs(n.ref[1] - o.ref[1]) +
                  Math.abs(n.ref[2] - o.ref[2]) >
                12,
            ),
          )
        : [];
      // 留个上限：局部修正建表是 n³ 的，攒太多会拖慢导出
      const merged = [...kept, ...fresh].slice(-MAX_SAMPLES);
      patch({
        on: true,
        matrix: fit.matrix,
        offset: fit.offset,
        curve: fit.curve,
        samples: merged,
        calibratedAt: new Date().toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }),
        calibratedUnlit: unlit,
        calibratedLift: lift,
      });
      // 纯白能到多少决定了颜色上限。但上限未必能靠补光一直抬 —— Keynote 的色调曲线
      // 有个硬顶，到了之后再加补光白点也不动，只会白白压平立体感。所以要和上一次比。
      // 白点按 ref 找，下标只当兜底 —— 写死下标正是上一个 bug 的根源（见 chart.ts 的 GRAYS）
      const whiteSample =
        r.samples.find((x) => x.ref[0] === 255 && x.ref[1] === 255 && x.ref[2] === 255) ??
        r.samples[WHITE_INDEX];
      const white = Math.round(Math.max(...whiteSample.got));
      const prevRaw = localStorage.getItem('prism-usdz-exporter/white-probe');
      const prev = prevRaw ? (JSON.parse(prevRaw) as { lift: number; white: number }) : null;
      try {
        localStorage.setItem('prism-usdz-exporter/white-probe', JSON.stringify({ lift, white }));
      } catch {
        /* 忽略 */
      }
      let advice: string;
      if (prev && lift > prev.lift + 0.02 && white <= prev.white + 2) {
        advice = `纯白 ${white}，补光从 ${Math.round(prev.lift * 100)}% 加到 ${Math.round(lift * 100)}% 也没抬起来 —— 到硬顶了。把补光调回 ${Math.round(prev.lift * 100)}% 或更低再校一次，能少损失一些立体感`;
      } else if (white >= 252) {
        advice = `纯白能到 ${white}，上限够用`;
      } else if (prev && lift > prev.lift && white > prev.white + 2) {
        advice = `纯白 ${white}（上次 ${prev.white}），还在涨，可以再往上调试试`;
      } else {
        advice = `纯白能到 ${white}。想再高就把补光往上调再校一次；如果调了不涨就是到顶了`;
      }
      const grew = merged.length - fresh.length;
      setMsg(
        `校准完成 · 残差 ${(fit.rms * 255).toFixed(1)} 阶 · 已标定 ${merged.length} 个颜色` +
          (grew > 0 ? `（含上次留下的 ${grew} 个）` : '') +
          ` · ${advice}`,
      );
    } catch (e) {
      setMsg(`识别失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 把当前校准档存成文件 —— 标定是有成本的，成果不该锁在一个浏览器里 */
  const onExportProfile = () => {
    if (!comp.matrix) return setMsg('现在没有校准数据可以导出');
    const blob = new Blob([JSON.stringify(serializeProfile(comp), null, 1)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = profileFileName(comp);
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
      const K = 8; // 一次最多锚这么多个颜色
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
            <button className="btn" onClick={onExportChart}>
              导出色卡棱柱
            </button>
            <span>
              和你实际用的同款棱柱，只是贴了色卡。拖进 {label}，转到正对着你的那个面截图，
              要能看到完整的粉色边框。
            </span>
          </li>
          <li>
            <ChartDrop onPick={onChartShot} label="上传色卡截图" />
            <span>把截图拖进来，自动量出偏色。</span>
          </li>
        </ol>
        {/* 结果紧跟在两个步骤下面。原来排在「成品截图微调」后面，隔了一整块，
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
        {/* 两个目标都有出厂档了：无边记沿用的是 Keynote 那份实测数据 */}
        <button className="btn" onClick={() => patch(defaultProfiles()[target])}>
          恢复内置校准
        </button>
      </details>
    </section>
  );
}
