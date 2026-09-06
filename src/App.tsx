import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { FaceDock } from './components/FaceDock';
import { RecolorPane } from './components/RecolorPane';
import { recolorUsdz, type RecolorReport } from './lib/recolor';
import { Viewport } from './components/Viewport';
import { FaceTextureStore, canvasSizeFor, clampTransform } from './lib/faceTexture';
import { CANCELLED, download, exportUsdz, formatBytes, openSaveTarget, usdzFileName } from './lib/exportUsdz';
import { yieldToBrowser } from './lib/yieldToBrowser';
import { applyTheme, isDark, loadTheme, type Theme } from './lib/theme';
import { exportChartCard } from './lib/exportCard';
import { isIdentity, type ColorComp } from './lib/color';
import { load, save } from './lib/storage';
import { clearFace, loadFaces, saveFace } from './lib/imageStore';
import type { PrismViewer } from './lib/viewer';
import {
  DEFAULT_PARAMS,
  DEFAULT_TRANSFORM,
  MAX_SIDES,
  MAX_SLOTS,
  faceOfSlot,
  innerSlot,
  isCap,
  isInner,
  CAP_RIGHT,
  createFaces,
  textureAspect,
  textureSlots,
  type FaceState,
  type FaceTransform,
  type Params,
  targetLabel,
  MODES,
  type Mode,
  type TargetId,
} from './lib/types';

/** 一次拖进多张图时，最多能排到哪个槽位（正面、反面、端面各是独立的一组） */
function spreadLimit(startIndex: number): number {
  if (isCap(startIndex)) return MAX_SLOTS;
  if (isInner(startIndex)) return CAP_RIGHT;
  return MAX_SIDES;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

/** 每个面一张带编号的纯色图 —— 用来在阶段 1 就验证 Keynote 对多 mesh 多材质的支持 */
async function makeTestImages(count: number): Promise<{ bmp: ImageBitmap; blob: Blob }[]> {
  const out: { bmp: ImageBitmap; blob: Blob }[] = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = `hsl(${(i * 360) / count}, 72%, 56%)`;
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.font = 'bold 260px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 256, 268); // 编号和 dock 上一致，从 1 起
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 16;
    ctx.strokeRect(8, 8, 496, 496);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
    out.push({ bmp: await createImageBitmap(c), blob });
  }
  return out;
}

export default function App() {
  const storeRef = useRef<FaceTextureStore | null>(null);
  if (!storeRef.current) storeRef.current = new FaceTextureStore();
  const store = storeRef.current;
  const viewerRef = useRef<PrismViewer | null>(null);
  const sourceKey = useRef(1);

  const [params, setParams] = useState<Params>(() => load()?.params ?? DEFAULT_PARAMS);
  const [faces, setFaces] = useState<FaceState[]>(() => {
    const f = createFaces();
    const saved = load();
    if (saved) saved.transforms.forEach((t, i) => Object.assign(f[i], t));
    return f;
  });
  const [selected, setSelected] = useState<number | null>(0);
  const [tick, setTick] = useState(0);
  const [sizeText, setSizeText] = useState('—');
  const [busy, setBusy] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  // 顶部菜单的三档。前两档改的是几何，第三档走完全另一条路（拿现成的 usdz 来改），
  // 所以单独一个 state —— 塞进 modelType 会把几何那边全污染。
  const [mode, setMode] = useState<Mode>('model');
  // 颜色校正：导入之后先算好放着给人看，导出要自己再点一下
  const [recolorSrc, setRecolorSrc] = useState<{ name: string; buf: ArrayBuffer } | null>(null);
  const [recolorOut, setRecolorOut] = useState<{ bytes: Uint8Array; report: RecolorReport } | null>(null);
  const [recolorBusy, setRecolorBusy] = useState<string | null>(null);
  const [recolorError, setRecolorError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<{ blob: Blob; name: string } | null>(null);

  // 状态提示自己退场 —— 停在那儿挡着画面，还得手动点掉，很烦。
  // 失败信息留久一点，够看清出了什么事。
  useEffect(() => {
    if (!status) return;
    const fail = /失败|错误|没|不/.test(status);
    const id = setTimeout(() => setStatus(null), fail ? 9000 : 4000);
    return () => clearTimeout(id);
  }, [status]);

  const patch = useCallback((p: Partial<Params>) => setParams((prev) => ({ ...prev, ...p })), []);
  // 改校准要同时写进「当前生效的那份」和「当前目标的存档」，两边不能走散
  const patchColor = useCallback(
    (c: Partial<ColorComp>) =>
      setParams((prev) => {
        const color = { ...prev.color, ...c };
        return { ...prev, color, profiles: { ...prev.profiles, [prev.target]: color } };
      }),
    [],
  );
  // 换目标 App：把当前这份收好，把那份取出来生效
  const setTarget = useCallback((target: TargetId) => {
    setParams((prev) => {
      if (prev.target === target) return prev;
      const profiles = { ...prev.profiles, [prev.target]: prev.color };
      return { ...prev, target, profiles, color: profiles[target] };
    });
  }, []);

  // 刷新之后把上次的贴图捞回来（图片存在 IndexedDB 里，localStorage 塞不下）
  useEffect(() => {
    let alive = true;
    loadFaces().then(async (stored) => {
      if (!alive || stored.length === 0) return;
      const decoded: { index: number; bmp: ImageBitmap; name: string }[] = [];
      for (const s of stored) {
        try {
          decoded.push({ index: s.index, bmp: await decode(s.blob as File), name: s.name });
        } catch {
          /* 坏数据跳过 */
        }
      }
      if (!alive || decoded.length === 0) return;
      setFaces((prev) => {
        const next = prev.slice();
        for (const d of decoded) {
          if (d.index < 0 || d.index >= MAX_SLOTS) continue;
          next[d.index] = { ...next[d.index], source: d.bmp, sourceKey: sourceKey.current++, sourceName: d.name };
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  // 选中的面消失了（边数砍掉了它、或者它所在的那一类被关掉了），把选中挪回来。
  //
  // 原来这里只写了 `selected >= params.sides`，那是把槽位当成面序号了 ——
  // 反面（MAX_SIDES 起）和端面（CAP_RIGHT 起）一律 ≥ sides，
  // 结果点一下反面或端面，立刻被弹回正面，根本选不中。
  useEffect(() => {
    if (selected === null) return;
    if (isCap(selected)) {
      if (params.capMode === 'none' || !params.separateCaps) setSelected(0);
      return;
    }
    const face = faceOfSlot(selected);
    if (face >= params.sides) {
      setSelected(isInner(selected) ? innerSlot(params.sides - 1) : params.sides - 1);
      return;
    }
    // 内面只有「没有端面」时才存在
    if (isInner(selected) && params.capMode !== 'none') setSelected(face);
  }, [params.sides, params.capMode, params.separateCaps, selected]);

  // 烘焙：面的宽高比一变，画布尺寸跟着变，旧的 offset 可能已经盖不满，先重新夹一遍
  useEffect(() => {
    const aspect = textureAspect(params);
    const side = canvasSizeFor(aspect, params.resolution);
    const cap = canvasSizeFor(1, params.resolution); // 端面画布是正方形
    let changed = false;
    const next = faces.map((f, i) => {
      if (!f.source) return f;
      const { w, h } = isCap(i) ? cap : side;
      const c = clampTransform(f, w, h, f.source.width, f.source.height);
      if (
        Math.abs(c.offsetX - f.offsetX) > 1e-6 ||
        Math.abs(c.offsetY - f.offsetY) > 1e-6 ||
        Math.abs(c.scale - f.scale) > 1e-6
      ) {
        changed = true;
        return { ...f, ...c };
      }
      return f;
    });
    const opts = {
      aspect,
      resolution: params.resolution,
      bgColor: params.bgColor,
      bgTransparent: params.bgTransparent,
      sides: params.sides,
      slots: textureSlots(params),
      capColorRight: params.capColorRight,
      capColorLeft: params.capColorLeft,
      comp: params.color,
      compensate: false,
    };
    store.bakeAll(next, opts);
    if (changed) setFaces(next);
  }, [faces, params.radius, params.sides, params.length, params.resolution, params.bgColor, params.bgTransparent, params.capMode, params.separateCaps, params.capColorRight, params.capColorLeft, params.color, store]);

  // 主题：写到 <html> 上，顺便把视口底色也换掉（它是 WebGL 画的，管不到 CSS）
  useEffect(() => {
    applyTheme(theme);
    viewerRef.current?.syncBackground();
    if (theme !== 'auto') return;
    // 跟随系统时，系统切换也要跟着动
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => viewerRef.current?.syncBackground();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  // 开发时把内部状态挂到 window 上，方便在控制台里量各段耗时
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    Object.assign(window as unknown as Record<string, unknown>, { __store: store, __faces: faces, __params: params });
  });

  // 烘焙完通知缩略图重画，用 rAF 压一下频率。
  // 导出期间不重画：那会儿贴图里装的是补偿过的像素，比眼睛该看到的暗一截，
  // 缩略图跟着变暗又变回来，看着就像整个界面闪了一下。
  const busyRef = useRef(false);
  useEffect(() => {
    let pending = false;
    return store.subscribe(() => {
      if (pending || busyRef.current) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setTick((t) => t + 1);
      });
    });
  }, [store]);

  // 体积预估：拖拽时不算，停下来 500ms 再算。
  // 按导出口径估（补偿之后的像素），否则和实际文件对不上。
  useEffect(() => {
    // 导出期间一律不估：那会儿正在烘贴图，每烘一张就把这个 effect 重跑一遍，
    // 一叠 4K 编码任务同时挤在队列里，页面就是那样被自己压黑的。
    if (busy) return;
    const token = { aborted: false };
    const id = setTimeout(() => {
      store
        .estimateBytes(faces, params.sides, {
          aspect: textureAspect(params),
          resolution: params.resolution,
          bgColor: params.bgColor,
          bgTransparent: params.bgTransparent,
          sides: params.sides,
          slots: textureSlots(params),
          capColorRight: params.capColorRight,
          capColorLeft: params.capColorLeft,
          comp: params.color,
          compensate: true,
        }, token)
        .then((b) => {
          if (b >= 0) setSizeText(formatBytes(b));
        });
    }, 500);
    return () => {
      clearTimeout(id);
      token.aborted = true; // 换参数了，上一轮编码到一半也别再算下去
    };
  }, [
    busy,
    tick,
    faces,
    params.sides,
    params.resolution,
    params.radius,
    params.length,
    params.bgColor,
    params.bgTransparent,
    params.capMode,
    params.separateCaps,
    params.capColorRight,
    params.capColorLeft,
    params.color,
    store,
  ]);

  // 持久化：参数 + face transform，图片本体不存
  useEffect(() => {
    const id = setTimeout(() => {
      save(
        params,
        faces.map((f) => ({
          offsetX: f.offsetX,
          offsetY: f.offsetY,
          scale: f.scale,
          rotation: f.rotation,
          hidden: !!f.hidden,
        })),
      );
    }, 400);
    return () => clearTimeout(id);
  }, [params, faces]);

  const onTransform = useCallback((i: number, t: FaceTransform, _commit: boolean) => {
    setFaces((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...t };
      return next;
    });
  }, []);

  const patchFace = useCallback(
    (t: Partial<FaceState>) => {
      if (selected === null) return;
      setFaces((prev) => {
        const next = prev.slice();
        next[selected] = { ...next[selected], ...t };
        return next;
      });
    },
    [selected],
  );

  const assignFiles = useCallback(async (files: File[], startIndex: number) => {
    const sorted = [...files].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    const loaded: { name: string; bmp: ImageBitmap; file: File }[] = [];
    for (const f of sorted) {
      try {
        loaded.push({ name: f.name, bmp: await decode(f), file: f });
      } catch {
        setStatus(`${f.name} 解码失败，跳过`);
      }
    }
    if (loaded.length === 0) return;
    setFaces((prev) => {
      const next = prev.slice();
      // 多张图依次往后排时，只在同一组里排，不跨组：正面、反面、端面各是一组。
      // 从前这里写的是 isInner ? MAX_SLOTS : MAX_SIDES，加了端面槽位之后
      // 往端面上拖图会因为 startIndex >= MAX_SIDES 而**一张都放不进去**。
      const limit = spreadLimit(startIndex);
      loaded.forEach((it, k) => {
        const idx = startIndex + k;
        if (idx >= limit) return;
        void saveFace(idx, it.file, it.name);
        next[idx] = {
          ...next[idx],
          ...DEFAULT_TRANSFORM,
          source: it.bmp,
          sourceKey: sourceKey.current++,
          sourceName: it.name,
        };
      });
      return next;
    });
    const limit = spreadLimit(startIndex);
    setSelected(Math.min(startIndex, limit - 1));
    const overflow = startIndex + loaded.length - limit;
    setStatus(overflow > 0 ? `有 ${overflow} 张图没地方放，已忽略` : null);
  }, []);

  const fillTestBlocks = useCallback(async () => {
    const imgs = await makeTestImages(params.sides);
    setFaces((prev) => {
      const next = prev.slice();
      imgs.forEach((img, i) => {
        void saveFace(i, img.blob, `test-${i}`);
        next[i] = {
          ...next[i],
          ...DEFAULT_TRANSFORM,
          source: img.bmp,
          sourceKey: sourceKey.current++,
          sourceName: `test-${i}`,
        };
      });
      return next;
    });
  }, [params.sides]);

  const onTestFill = useCallback(async () => {
    await fillTestBlocks();
    setStatus('已填入测试色块：导出后核对每个面的颜色和编号是否对得上');
  }, [fillTestBlocks]);

  /** dock 缩略图上的转 90° —— 转的是那一格，不需要先选中它 */
  const rotateFace = useCallback((slot: number, dir: 1 | -1) => {
    setFaces((prev) => {
      const next = prev.slice();
      const step = (dir * Math.PI) / 2;
      // 归一化到 (-π, π]，否则一直转下去会累成很大的数，滑块也拉不回来
      let r = next[slot].rotation + step;
      r = Math.atan2(Math.sin(r), Math.cos(r));
      next[slot] = { ...next[slot], rotation: r };
      return next;
    });
  }, []);

  // 换了文件、或者换了校准目标，就重算一遍 —— 左边看到的对比必须和当前设置一致
  useEffect(() => {
    if (!recolorSrc) return;
    let alive = true;
    setRecolorError(null);
    setRecolorOut(null);
    setRecolorBusy('正在校正…');
    (async () => {
      try {
        const r = await recolorUsdz(recolorSrc.buf, params.color, (n, all) =>
          setRecolorBusy(`正在校正贴图 ${n}/${all}…`),
        );
        if (alive) setRecolorOut(r);
      } catch (e) {
        if (alive) setRecolorError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setRecolorBusy(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [recolorSrc, params.color]);

  const pickRecolorFile = useCallback(async (f: File) => {
    setRecolorSrc({ name: f.name, buf: await f.arrayBuffer() });
  }, []);

  const exportRecolor = useCallback(() => {
    if (!recolorOut || !recolorSrc) return;
    const name = recolorSrc.name.replace(/\.usdz$/i, '') + `-${targetLabel(params.target)}校正.usdz`;
    const blob = new Blob([recolorOut.bytes as unknown as BlobPart], { type: 'model/vnd.usdz+zip' });
    download(blob, name);
    setStatus(`已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)}`);
  }, [recolorOut, recolorSrc, params.target]);

  /** 侧栏取景框里的拖动：只改选中面的偏移，视口那边不再有这个手势 */
  const onPan = useCallback(
    (dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return;
      setFaces((prev) => {
        if (selected === null) return prev;
        const next = prev.slice();
        const f = next[selected];
        next[selected] = { ...f, offsetX: f.offsetX + dx, offsetY: f.offsetY + dy };
        return next;
      });
    },
    [selected],
  );

  const handleResetFace = useCallback(() => patchFace(DEFAULT_TRANSFORM), [patchFace]);
  const handleClearFace = useCallback(() => {
    if (selected !== null) void clearFace(selected);
    patchFace({ ...DEFAULT_TRANSFORM, source: null, sourceName: null, sourceKey: sourceKey.current++ });
  }, [patchFace, selected]);

  const handleExportChart = useCallback(async () => {
    try {
      const { blob, name } = await exportChartCard(params, store.canvases);
      download(blob, name);
      setStatus(`色卡已导出：拖进${targetLabel(params.target)}，正对着截一张图，再回来上传`);
    } catch (err) {
      setStatus(`色卡导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [params]);

  const handleExport = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // 先问存哪儿，并在同一个手势里就把可写句柄拿到 —— 拖到烘焙打包之后再拿，手势就过期了。
    // 这样点一下就弹保存框，选完位置才开始干活，最后提示「已保存」。
    const target = await openSaveTarget(usdzFileName(params.sides));
    if (target === CANCELLED) return;
    setBusy('导出中…');
    setStatus(null);
    // 烘补偿贴图会让预览和缩略图整体变暗 —— 那是「Keynote 里才该出现」的像素，
    // 不该让用户看见。先把当前画面拍下来盖上去，再停掉渲染和缩略图刷新。
    busyRef.current = true;
    setFrozen(viewer.snapshot());
    await yieldToBrowser(); // 等这张静止图真的铺上去，再停渲染，否则会闪一下白
    viewer.setPaused(true);
    try {
      // 导出前跑一次全量烘焙，把颜色预补偿烘进去（视口里那份是不带补偿的）
      const base = {
        aspect: textureAspect(params),
        resolution: params.resolution,
        bgColor: params.bgColor,
        bgTransparent: params.bgTransparent,
        sides: params.sides,
        slots: textureSlots(params),
        capColorRight: params.capColorRight,
        capColorLeft: params.capColorLeft,
        comp: params.color,
      };
      await store.bakeAllAsync(faces, { ...base, compensate: true }, (done, total) =>
        setBusy(`烘焙贴图 ${done}/${total}…`),
      );
      // 打包这一段是 three 在逐张编码 PNG，一张 4K 大约要一秒，中途插不进进度，
      // 所以先把话说在前面，免得用户以为卡死了。
      setBusy('打包中…（面多、分辨率高会慢一点）');
      await yieldToBrowser();
      const { blob, name } = await exportUsdz(viewer, store, params);
      const note = isIdentity(params.color) ? '' : ' · 已套用颜色补偿';
      if (target) {
        await target.write(blob);
        await target.close();
        setLastFile(null);
        setStatus(`已保存 ${name} · ${formatBytes(blob.size)}${note}`);
      } else {
        // 没有保存对话框的浏览器（Safari 就没有）：退回下载。
        // 一定要说清楚文件去哪了 —— 只说「已导出」，用户会以为能自己选位置，
        // 结果满世界找不到文件。浏览器有时还会静默拦掉连续下载，
        // 所以把这一份留着，点「再存一次」就是一次全新的手势，通常就放行了。
        download(blob, name);
        setLastFile({ blob, name });
        setStatus(`已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)}${note}`);
      }
      // 烘回不带补偿的版本，视口继续显示「Keynote 里应有的样子」
      await store.bakeAllAsync(faces, { ...base, compensate: false });
    } catch (err) {
      if (target) await target.abort().catch(() => undefined);
      setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      viewer.setPaused(false);
      busyRef.current = false;
      setFrozen(null);
      setBusy(null);
      setTick((t) => t + 1); // 导出期间压住了缩略图刷新，这里补一次
    }
  }, [faces, params, store]);

  const face = selected === null ? null : faces[selected];
  void faceOfSlot;

  return (
    <div className="app">
      <main className="stage">
        <div className="titlebar">
          {/* 工具名本身就是模式菜单 —— 换模式是「先决定做什么」，该在最显眼的地方 */}
          <select
            className="tool-name"
            aria-label="模式"
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          <span className="titlebar-right">
            <span className="tool-en">Prism to USDZ · color-matched · build {__BUILD_ID__}</span>
            <button
              type="button"
              className="theme-toggle"
              title={theme === 'auto' ? '跟随系统' : theme === 'dark' ? '暗色' : '亮色'}
              aria-label="切换深浅"
              onClick={() => setTheme(isDark(theme) ? 'light' : 'dark')}
            >
              {isDark(theme) ? '☾' : '☀'}
            </button>
          </span>
        </div>
        {mode === 'recolor' ? (
          <RecolorPane
            fileName={recolorSrc?.name ?? null}
            busy={recolorBusy}
            error={recolorError}
            report={recolorOut?.report ?? null}
            targetName={targetLabel(params.target)}
            source={recolorSrc?.buf ?? null}
            corrected={recolorOut?.bytes ?? null}
            comp={params.color}
            onFile={pickRecolorFile}
          />
        ) : (
        <Viewport
          store={store}
          params={params}
          faces={faces}
          selected={selected}
          onSelect={setSelected}
          onTransform={onTransform}
          onDropFiles={(files, faceIndex) => assignFiles(files, faceIndex ?? 0)}
          viewerRef={viewerRef}
          frozen={frozen}
          onResetFace={handleResetFace}
          onClearFace={handleClearFace}
          onTestFill={onTestFill}
        />
        )}
        {mode !== 'recolor' && (
        <FaceDock
          store={store}
          faces={faces}
          sides={params.sides}
          selected={selected}
          tick={tick}
          showInner={params.modelType === 'prism' && params.capMode === 'none'}
          showCaps={params.modelType === 'prism' && params.capMode !== 'none' && params.separateCaps}
          card={params.modelType === 'card'}
          onSelect={(i) => {
            setSelected(i);
            // 从底部选面就顺手转到正对着它 —— 否则改缩放、旋转在预览里根本看不见
            viewerRef.current?.faceOn(i);
          }}
          onFiles={(files, i) => assignFiles(files, i)}
          onRotate={rotateFace}
        />
        )}
      </main>

      <ControlPanel
        params={params}
        patch={patch}
        mode={mode}
        recolorName={recolorSrc?.name ?? null}
        recolorReady={!!recolorOut}
        recolorBusy={recolorBusy}
        onPickRecolor={pickRecolorFile}
        onExportRecolor={exportRecolor}
        selected={selected}
        face={face}
        patchFace={patchFace}
        onPan={onPan}
        patchColor={patchColor}
        setTarget={setTarget}
        store={store}
        tick={tick}
        onExportChart={handleExportChart}
        onExport={handleExport}
        sizeText={sizeText}
        busy={busy}
      />

      {status && (
        <div className="status">
          <span>{status}</span>
          {lastFile && (
            <button
              type="button"
              className="status-act"
              onClick={() => {
                download(lastFile.blob, lastFile.name);
                setStatus('又存了一次');
              }}
            >
              没收到文件？再存一次
            </button>
          )}
          <button type="button" className="status-x" aria-label="关掉" onClick={() => setStatus(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
