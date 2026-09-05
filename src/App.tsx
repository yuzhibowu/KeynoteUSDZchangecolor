import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { FaceStrip } from './components/FaceStrip';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/Viewport';
import { FaceTextureStore, canvasSizeFor, clampTransform } from './lib/faceTexture';
import { download, exportUsdz, formatBytes } from './lib/exportUsdz';
import { exportChartCard } from './lib/exportCard';
import { isIdentity, type ColorComp } from './lib/color';
import { load, save } from './lib/storage';
import { clearFace, loadFaces, saveFace } from './lib/imageStore';
import type { PrismViewer } from './lib/viewer';
import {
  DEFAULT_PARAMS,
  DEFAULT_TRANSFORM,
  MAX_SIDES,
  createFaces,
  faceAspect,
  type FaceState,
  type FaceTransform,
  type Params,
} from './lib/types';

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
    ctx.fillText(String(i), 256, 268);
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
  const [status, setStatus] = useState<string | null>(null);

  const patch = useCallback((p: Partial<Params>) => setParams((prev) => ({ ...prev, ...p })), []);
  const patchColor = useCallback(
    (c: Partial<ColorComp>) => setParams((prev) => ({ ...prev, color: { ...prev.color, ...c } })),
    [],
  );

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
          if (d.index < 0 || d.index >= MAX_SIDES) continue;
          next[d.index] = { ...next[d.index], source: d.bmp, sourceKey: sourceKey.current++, sourceName: d.name };
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  // 选中的面被边数砍掉时，把选中挪回来
  useEffect(() => {
    if (selected !== null && selected >= params.sides) setSelected(params.sides - 1);
  }, [params.sides, selected]);

  // 烘焙：面的宽高比一变，画布尺寸跟着变，旧的 offset 可能已经盖不满，先重新夹一遍
  useEffect(() => {
    const aspect = faceAspect(params.radius, params.sides, params.length);
    const { w, h } = canvasSizeFor(aspect, params.resolution);
    let changed = false;
    const next = faces.map((f) => {
      if (!f.source) return f;
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
      comp: params.color,
      compensate: false,
    };
    for (let i = 0; i < MAX_SIDES; i++) store.bake(i, next[i], opts);
    if (changed) setFaces(next);
  }, [faces, params.radius, params.sides, params.length, params.resolution, params.bgColor, params.color, store]);

  // 烘焙完通知缩略图重画，用 rAF 压一下频率
  useEffect(() => {
    let pending = false;
    return store.subscribe(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setTick((t) => t + 1);
      });
    });
  }, [store]);

  // 体积预估：拖拽时不算，停下来 500ms 再算
  useEffect(() => {
    const id = setTimeout(() => {
      store.estimateBytes(params.sides).then((b) => setSizeText(formatBytes(b)));
    }, 500);
    return () => clearTimeout(id);
  }, [tick, params.sides, params.resolution, store]);

  // 持久化：参数 + face transform，图片本体不存
  useEffect(() => {
    const id = setTimeout(() => {
      save(
        params,
        faces.map((f) => ({ offsetX: f.offsetX, offsetY: f.offsetY, scale: f.scale, rotation: f.rotation })),
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
      loaded.forEach((it, k) => {
        const idx = startIndex + k;
        if (idx >= MAX_SIDES) return;
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
    setSelected(Math.min(startIndex, MAX_SIDES - 1));
    const overflow = startIndex + loaded.length - MAX_SIDES;
    setStatus(overflow > 0 ? `有 ${overflow} 张图超出 12 个面，已忽略` : null);
  }, []);

  const onTestFill = useCallback(async () => {
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
    setStatus('已填入测试色块：导出后在 Keynote 里核对每个面的颜色和编号是否对得上');
  }, [params.sides]);

  const handleExportChart = useCallback(async () => {
    try {
      const { blob, name } = await exportChartCard(params, store.canvases);
      download(blob, name);
      setStatus('色卡已导出：拖进 Keynote，正对着截一张图，再回来上传');
    } catch (err) {
      setStatus(`色卡导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [params]);

  const handleExport = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setBusy('导出中…');
    setStatus(null);
    try {
      // 导出前跑一次全量烘焙，把颜色预补偿烘进去（视口里那份是不带补偿的）
      const base = {
        aspect: faceAspect(params.radius, params.sides, params.length),
        resolution: params.resolution,
        bgColor: params.bgColor,
        comp: params.color,
      };
      store.bakeAll(faces, { ...base, compensate: true });
      const { blob, name } = await exportUsdz(viewer, store, params);
      download(blob, name);
      const note = isIdentity(params.color)
        ? ''
        : ' · 已套用颜色补偿';
      setStatus(`已导出 ${name} · ${formatBytes(blob.size)}${note}`);
      // 烘回不带补偿的版本，视口继续显示「Keynote 里应有的样子」
      store.bakeAll(faces, { ...base, compensate: false });
    } catch (err) {
      setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [faces, params, store]);

  const face = selected === null ? null : faces[selected];

  return (
    <div className="app">
      <ControlPanel
        params={params}
        patch={patch}
        selected={selected}
        face={face}
        patchFace={patchFace}
        onResetRotation={() => viewerRef.current?.resetRotation()}
        onFaceOn={() => selected !== null && viewerRef.current?.faceOn(selected)}
        patchColor={patchColor}
        store={store}
        tick={tick}
        onExportChart={handleExportChart}
      />
      <Viewport
        store={store}
        params={params}
        faces={faces}
        selected={selected}
        onSelect={setSelected}
        onTransform={onTransform}
        onDropFiles={(files, faceIndex) => assignFiles(files, faceIndex ?? 0)}
        viewerRef={viewerRef}
      />
      <FaceStrip
        store={store}
        faces={faces}
        sides={params.sides}
        selected={selected}
        tick={tick}
        onSelect={setSelected}
        onDropFiles={(files, i) => assignFiles(files, i)}
      />
      <Toolbar
        selected={selected}
        hasImage={!!face?.source}
        sizeText={sizeText}
        busy={busy}
        onFiles={(files) => assignFiles(files, files.length > 1 ? 0 : (selected ?? 0))}
        onResetFace={() => patchFace(DEFAULT_TRANSFORM)}
        onClearFace={() => {
          if (selected !== null) void clearFace(selected);
          patchFace({ ...DEFAULT_TRANSFORM, source: null, sourceName: null, sourceKey: sourceKey.current++ });
        }}
        onTestFill={onTestFill}
        onExport={handleExport}
      />
      {status && (
        <div className="status" onClick={() => setStatus(null)}>
          {status}
        </div>
      )}
    </div>
  );
}
