import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { FaceDock } from './components/FaceDock';
import { RecolorPane } from './components/RecolorPane';
import { MotionPane, PHASE_STEP, type FrameRenderer } from './components/MotionPane';
import { loadMotion, saveMotion, type MotionParams } from './lib/motion';
import { addMotionToUsdz, type ModelSpace } from './lib/motionExport';
import { measureUsdz } from './lib/usdzScene';
import { normalizeUsdzForLoader } from './lib/recolor';
import { zipSync } from 'fflate';
import { VIDEO_SIZES, encodeMov, packPngSequence, safeBaseName, validateExport, type VideoFormat, type VideoSizeId } from './lib/videoExport';
import { centerPath, isClosed, resample, type Pt } from './lib/drawnPath';
import { recolorUsdz, type RecolorReport } from './lib/recolor';
import { Viewport } from './components/Viewport';
import { FaceTextureStore, canvasSizeFor, clampTransform } from './lib/faceTexture';
import { download, exportUsdz, formatBytes } from './lib/exportUsdz';
import { yieldToBrowser } from './lib/yieldToBrowser';
import { applyTheme, isDark, loadTheme, type Theme } from './lib/theme';
import { exportChartCard } from './lib/exportCard';
import { trimToAlpha } from './lib/fitImage';
import { isIdentity, type ColorComp } from './lib/color';
import { load, save } from './lib/storage';
import { clearAllFaces, clearFace, loadFaces, saveFace } from './lib/imageStore';
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
  profileKey,
  MODES,
  type Mode,
  type TargetId,
  radiusFor,
  CARD_FRONT,
  CARD_BACK,
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

/**
 * 每个面一张纯色图 —— 用来验证 Keynote 对多 mesh 多材质的支持。
 *
 * 只有底色，不写编号也不描边：要的是干净的纯色背景，面上多一个数字就没法直接拿去用了。
 * 面与面之间仍然换色相，不然「每个面是不是真的各有各的材质」根本看不出来。
 */
async function makeTestImages(count: number): Promise<{ bmp: ImageBitmap; blob: Blob }[]> {
  const out: { bmp: ImageBitmap; blob: Blob }[] = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = `hsl(${(i * 360) / count}, 72%, 56%)`;
    ctx.fillRect(0, 0, 512, 512);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
    out.push({ bmp: await createImageBitmap(c), blob });
  }
  return out;
}


/**
 * 把当前这份档收进它的槽位，再把 next 对应槽位的那份取出来生效。
 * 补光和「关掉灯光」跟着档一起走 —— 它们是校准的前提条件，不是偏好。
 */
function switchProfile(next: Params, prev: Params): Params {
  const profiles = { ...prev.profiles, [profileKey(prev.target, prev.modelType)]: prev.color };
  const color = profiles[profileKey(next.target, next.modelType)];
  return {
    ...next,
    profiles,
    color,
    emissiveLift: color.calibratedLift ?? next.emissiveLift,
    emissiveExport: color.calibratedUnlit ?? next.emissiveExport,
  };
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
  // 加动效：模型和参数分开放，改参数不重新加载模型。拖进来几个就几块预览，一起导出
  const [motionFiles, setMotionFiles] = useState<{ name: string; buf: ArrayBuffer }[]>([]);
  const [motion, setMotion] = useState<MotionParams>(loadMotion);
  useEffect(() => saveMotion(motion), [motion]);
  // 每块预览量出来的空间（加载器的变换 + 包围盒），导出要用；没量出来的是 null
  const [motionSpaces, setMotionSpaces] = useState<(ModelSpace | null)[]>([]);
  const motionSrc = motionFiles[0] ?? null;
  const motionSpace = motionSpaces[0] ?? null;
  const [motionBusy, setMotionBusy] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  // 导视频：帧从视口抓，编码在浏览器里跑
  const frameRef = useRef<FrameRenderer | null>(null);
  const [videoSize, setVideoSize] = useState<VideoSizeId>('1080p');
  const [videoFps, setVideoFps] = useState(30);
  const [videoBusy, setVideoBusy] = useState<string | null>(null);
  const videoAbort = useRef<AbortController | null>(null);
  // 预览背景：'dark' | 'slide' | 自定义颜色。只影响预览
  const [motionBg, setMotionBg] = useState('dark');
  const [motionZoom, setMotionZoom] = useState(1.2);
  const motionBgColor = motionBg === 'dark' ? '#111111' : motionBg === 'slide' ? '#ffffff' : motionBg;
  // 自动旋转的开关放在这儿：按钮在侧栏、动画在预览区，两边都要用
  const [spin, setSpin] = useState(true);
  const [compareReady, setCompareReady] = useState(false);
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

  const patch = useCallback(
    (p: Partial<Params>) =>
      setParams((prev) => {
        const next = { ...prev, ...p };
        // 换模型类型 = 换校准档：卡片和棱柱各一份（见 types 里的 profileKey）
        if (p.modelType !== undefined && p.modelType !== prev.modelType) {
          return switchProfile(next, prev);
        }
        return next;
      }),
    [],
  );
  // 改校准要同时写进「当前生效的那份」和「当前目标的存档」，两边不能走散
  const patchColor = useCallback(
    (c: Partial<ColorComp>) =>
      setParams((prev) => {
        const color = { ...prev.color, ...c };
        return { ...prev, color, profiles: { ...prev.profiles, [profileKey(prev.target, prev.modelType)]: color } };
      }),
    [],
  );
  // 换目标 App：把当前这份收好，把那份取出来生效
  /**
   * 切换目标 App。
   *
   * 补光和「关掉灯光」要跟着档一起走。这两个不是偏好，是**校准的前提条件** ——
   * 档里的每个数字都是在某个补光下测出来的，条件一变整条响应曲线就变了。
   * 两个目标的最佳补光本来就不一样：Keynote 的色调曲线有天花板，纯白顶死在 244，
   * 必须靠自发光顶上去，所以拉满；无边记没这个天花板，50% 时纯白就有 247，
   * 拉满只多 8 阶却把明暗压平了 —— 实测残差反而从 5.9 阶劣化到 8.8 阶。
   *
   * 不跟着走的话，每切一次目标都会撞上「当前设置和校准条件对不上」的警告，
   * 而用户根本不知道该把补光调到多少。
   */
  const setTarget = useCallback((target: TargetId) => {
    setParams((prev) => (prev.target === target ? prev : switchProfile({ ...prev, target }, prev)));
  }, []);

  // 刷新之后把上次的贴图捞回来（图片存在 IndexedDB 里，localStorage 塞不下）
  useEffect(() => {
    let alive = true;
    loadFaces().then(async (stored) => {
      if (!alive || stored.length === 0) return;
      const decoded: { index: number; bmp: ImageBitmap; name: string; trimmed: boolean; cornerPx?: number }[] = [];
      for (const s of stored) {
        try {
          const fit = await prepareSource(await decode(s.blob as File), s.index);
          decoded.push({ index: s.index, bmp: fit.bmp, name: s.name, trimmed: fit.trimmed, cornerPx: fit.cornerPx });
        } catch {
          /* 坏数据跳过 */
        }
      }
      if (!alive || decoded.length === 0) return;
      setFaces((prev) => {
        const next = prev.slice();
        for (const d of decoded) {
          if (d.index < 0 || d.index >= MAX_SLOTS) continue;
          next[d.index] = {
            ...next[d.index],
            source: d.bmp,
            sourceKey: sourceKey.current++,
            sourceName: d.name,
            trimmed: d.trimmed,
            cornerPx: d.cornerPx,
          };
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

  // 回调里要看「最新」的参数，不能闭包住旧的 —— 拖图和读档都是异步的
  const paramsRef = useRef(params);
  paramsRef.current = params;

  /**
   * 卡片「适应」：正反两面的图先把透明留白裁掉，再顺手量出圆角。
   * 别的模式、别的槽位原样返回。裁过的图记上 trimmed，切换开关时不重复裁。
   */
  const prepareSource = useCallback(
    async (bmp: ImageBitmap, idx: number): Promise<{ bmp: ImageBitmap; trimmed: boolean; cornerPx?: number }> => {
      const p = paramsRef.current;
      const wants = p.modelType === 'card' && p.fitFront && (idx === CARD_FRONT || idx === CARD_BACK);
      if (!wants) return { bmp, trimmed: false };
      const r = await trimToAlpha(bmp);
      return { bmp: r.bmp, trimmed: true, cornerPx: r.info?.cornerPx };
    },
    [],
  );

  // 「适应」打开时，已经贴上去但还没裁过的正反面补裁一次
  const frontKey = faces[CARD_FRONT]?.sourceKey;
  const backKey = faces[CARD_BACK]?.sourceKey;
  useEffect(() => {
    if (params.modelType !== 'card' || !params.fitFront) return;
    let alive = true;
    (async () => {
      const updates: { idx: number; bmp: ImageBitmap; cornerPx?: number }[] = [];
      for (const idx of [CARD_FRONT, CARD_BACK]) {
        const f = faces[idx];
        if (!f?.source || f.trimmed) continue;
        const r = await trimToAlpha(f.source);
        updates.push({ idx, bmp: r.bmp, cornerPx: r.info?.cornerPx });
      }
      if (!alive || updates.length === 0) return;
      setFaces((prev) => {
        const next = prev.slice();
        for (const u of updates) {
          next[u.idx] = { ...next[u.idx], source: u.bmp, sourceKey: sourceKey.current++, trimmed: true, cornerPx: u.cornerPx };
        }
        return next;
      });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.modelType, params.fitFront, frontKey, backKey]);

  // 「适应」：卡片的比例和圆角跟着正面那张图走（以正面为准）
  useEffect(() => {
    if (params.modelType !== 'card' || !params.fitFront) return;
    const f = faces[CARD_FRONT];
    if (!f?.source || !f.trimmed) return;
    const aspect = f.source.width / f.source.height;
    // 圆角：图片像素 → 模型米。卡片宽 = params.length 米，对应图片宽 source.width 像素
    const corner = ((f.cornerPx ?? 0) * params.length) / f.source.width;
    if (Math.abs(aspect - params.aspect) < 1e-4 && Math.abs(corner - params.corner) < 1e-6) return;
    setParams((prev) => ({
      ...prev,
      aspect,
      aspectW: undefined,
      aspectH: undefined,
      corner,
      radius: radiusFor(prev.length, aspect, prev.sides),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.modelType, params.fitFront, params.length, frontKey, faces[CARD_FRONT]?.trimmed]);

  const assignFiles = useCallback(async (files: File[], startIndex: number) => {
    const sorted = [...files].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    const loaded: { name: string; bmp: ImageBitmap; file: File; trimmed: boolean; cornerPx?: number }[] = [];
    for (const [k, f] of sorted.entries()) {
      try {
        const raw = await decode(f);
        const fit = await prepareSource(raw, startIndex + k);
        loaded.push({ name: f.name, bmp: fit.bmp, file: f, trimmed: fit.trimmed, cornerPx: fit.cornerPx });
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
          trimmed: it.trimmed,
          cornerPx: it.cornerPx,
        };
      });
      return next;
    });
    const limit = spreadLimit(startIndex);
    setSelected(Math.min(startIndex, limit - 1));
    const overflow = startIndex + loaded.length - limit;
    setStatus(overflow > 0 ? `有 ${overflow} 张图没地方放，已忽略` : null);
  }, [prepareSource]);

  // ⌘V / Ctrl+V：剪贴板里的图片直接贴到当前选中的那一面。
  // 焦点在输入框里时不抢（那是在粘贴文字）。没选中面就贴到第 0 面。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of items) {
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (files.length === 0) return;
      e.preventDefault();
      const idx = selected ?? 0;
      // 剪贴板里的文件通常叫 image.png，给它一个能区分的名字
      const named = files.map((f, i) => new File([f], f.name || `剪贴板-${Date.now().toString(36)}-${i}.png`, { type: f.type }));
      const where = paramsRef.current.modelType === 'card' ? (idx === CARD_BACK ? '背面' : '正面') : `第 ${idx + 1} 面`;
      void assignFiles(named, idx).then(() => setStatus(`已把剪贴板里的图贴到${where}`));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [assignFiles, selected]);

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
    setCompareReady(false);
    setRecolorSrc({ name: f.name, buf: await f.arrayBuffer() });
  }, []);

  const pickMotionFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const all = await Promise.all(files.map(async (f) => ({ name: f.name, buf: await f.arrayBuffer() })));
    setMotionSpaces(all.map(() => null));
    setMotionFiles(all);
  }, []);
  const onMotionLoaded = useCallback((index: number, space: ModelSpace | null, error: string | null) => {
    setMotionSpaces((prev) => {
      const next = prev.slice();
      next[index] = space;
      return next;
    });
    if (error) setStatus(`第 ${index + 1} 个文件渲染不了：${error}`);
  }, []);
  const patchMotion = useCallback((p: Partial<MotionParams>) => setMotion((m) => ({ ...m, ...p })), []);
  const onDrawn = useCallback((raw: Pt[]) => {
    const pts = centerPath(resample(raw));
    setMotion((m) => ({ ...m, path: 'custom', customPath: pts, customClosed: isClosed(pts) }));
    setDrawing(false);
  }, []);
  const exportMotion = useCallback(async () => {
    if (!motionSrc || !motionSpace) return;
    setMotionBusy('正在写入动画…');
    await yieldToBrowser();
    try {
      const outName = (n: string) => n.replace(/\.usdz$/i, '') + '-加动效.usdz';
      if (motionFiles.length === 1) {
        const { bytes, report } = addMotionToUsdz(motionSrc.buf, motion, motionSpace, motion.seconds);
        const name = outName(motionSrc.name);
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'model/vnd.usdz+zip' });
        download(blob, name);
        setLastFile({ blob, name });
        const notes = [
          `${report.seconds} 秒 ${report.frames} 帧`,
          report.binaryRoot ? '原文件是二进制场景，已另写一层文本图层把它引用进来' : null,
          report.replacedAnimation ? '原文件自带的动画已替换' : null,
          report.nestedAnimation ? `原文件深处还有 ${report.nestedAnimation} 段动画会叠加` : null,
        ].filter(Boolean);
        setStatus(`已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)} · ${notes.join(' · ')}`);
        return;
      }
      // 批量：空间用各块预览量好的（还没量出来的补量一次），相位按预览里看到的错开，最后打成一个 zip
      const all = motionFiles;
      const files: Record<string, Uint8Array> = {};
      const failed: string[] = [];
      for (let i = 0; i < all.length; i++) {
        setMotionBusy(`正在处理 ${i + 1}/${all.length}…`);
        await yieldToBrowser();
        try {
          const space = motionSpaces[i] ?? (await measureUsdz(normalizeUsdzForLoader(all[i].buf.slice(0))));
          const params = { ...motion, phase: motion.phase + i * PHASE_STEP };
          files[outName(all[i].name)] = addMotionToUsdz(all[i].buf, params, space, motion.seconds).bytes;
        } catch (e) {
          failed.push(`${all[i].name}（${e instanceof Error ? e.message : String(e)}）`);
        }
      }
      if (Object.keys(files).length === 0) throw new Error(`一个都没成：${failed.join('；')}`);
      const zipped = zipSync(files, { level: 0 });
      const name = `加动效-${Object.keys(files).length}个.zip`;
      const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
      download(blob, name);
      setLastFile({ blob, name });
      setStatus(
        `已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)}` +
          (failed.length ? ` · 没成功的：${failed.join('；')}` : ''),
      );
    } catch (e) {
      setStatus(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMotionBusy(null);
    }
  }, [motionSrc, motionFiles, motionSpaces, motionSpace, motion]);

  const exportVideo = useCallback(
    async (format: VideoFormat) => {
      const fr = frameRef.current;
      if (!motionSrc || !motionSpace || !fr) return;
      const size = VIDEO_SIZES.find((v) => v.id === videoSize)!;
      const controller = new AbortController();
      videoAbort.current = controller;
      const base = safeBaseName(motionSrc.name.replace(/\.usdz$/i, '') + '-加动效');
      try {
        const total = validateExport({ width: size.width, height: size.height, fps: videoFps, seconds: motion.seconds }, fr.maxTextureSize);
        setVideoBusy(`正在渲染 0 / ${total} 帧`);
        setDrawing(false);
        const frames = await fr.render({
          width: size.width,
          height: size.height,
          fps: videoFps,
          seconds: motion.seconds,
          signal: controller.signal,
          onProgress: (done, all) => setVideoBusy(`正在渲染 ${done} / ${all} 帧`),
        });
        let blob: Blob;
        let name: string;
        if (format === 'mov') {
          setVideoBusy('正在加载编码器…');
          const r = await encodeMov(frames, videoFps, base, controller.signal, (text) => setVideoBusy(text));
          blob = r.blob;
          name = r.filename;
        } else {
          setVideoBusy('正在打包 PNG 序列…');
          await yieldToBrowser();
          const bytes = await Promise.all(frames.map(async (f) => new Uint8Array(await f.arrayBuffer())));
          blob = packPngSequence(bytes, base);
          name = `${base}_png序列.zip`;
        }
        download(blob, name);
        setLastFile({ blob, name });
        setStatus(`已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)} · ${total} 帧 ${videoFps} fps 透明背景`);
      } catch (e) {
        const aborted = controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
        setStatus(aborted ? '已取消导出' : `导出视频失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setVideoBusy(null);
        videoAbort.current = null;
      }
    },
    [motionSrc, motionSpace, motion.seconds, videoSize, videoFps],
  );

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

  /**
   * 一次清掉所有面的图。
   *
   * 「移除图片」只清当前这一面 —— 但拖一批图进来会依次铺到好几个面上，
   * 只清一面之后剩下的从别的角度还看得见，像擦不掉的残留，而且刷新也还在。
   */
  const handleClearAll = useCallback(() => {
    void clearAllFaces();
    setFaces((prev) =>
      prev.map((f) => ({
        ...f,
        ...DEFAULT_TRANSFORM,
        source: null,
        sourceName: null,
        sourceKey: sourceKey.current++,
      })),
    );
    setStatus('所有面的图片都清掉了');
  }, []);

  const handleExportChart = useCallback(async (densePage?: number) => {
    try {
      const { blob, name } = await exportChartCard(params, store.canvases, densePage);
      download(blob, name);
      setStatus(
        densePage === undefined
          ? `色卡已导出：拖进${targetLabel(params.target)}，正对着截一张图，再回来上传`
          : `密集色卡第 ${densePage + 1} 张已导出：拖进${targetLabel(params.target)}，正对着截图，拖回「上传色卡截图」`,
      );
    } catch (err) {
      setStatus(`色卡导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [params]);

  const handleExport = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    // 不再弹保存框，直接存进「下载」文件夹（用户要求：每次导出都要选位置太烦）。
    // 保存框那套（exportUsdz.ts 里的 openSaveTarget）留着没删，想改回去照它的注释接回来。
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
      // 校正关着的时候必须明说。原来关着就什么都不提，用户以为照常补偿了，
      // 导进 Keynote 一看整张偏色，回头查了半天模型 —— 其实是勾没打上。
      const note = isIdentity(params.color)
        ? ' · 未套用颜色补偿（「偏色抵消」是关的）'
        : ' · 已套用颜色补偿';
      // 一定要说清楚文件去哪了 —— 只说「已导出」，用户会满世界找文件。
      // 浏览器有时还会静默拦掉连续下载，所以把这一份留着，
      // 点「再存一次」就是一次全新的手势，通常就放行了。
      download(blob, name);
      setLastFile({ blob, name });
      setStatus(`已存到「下载」文件夹 · ${name} · ${formatBytes(blob.size)}${note}`);
      // 烘回不带补偿的版本，视口继续显示「Keynote 里应有的样子」
      await store.bakeAllAsync(faces, { ...base, compensate: false });
    } catch (err) {
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
            {/* 只留构建号 —— 那句英文没人看，构建号是用来核对版本的 */}
            <span className="tool-en">build {__BUILD_ID__}</span>
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
        {mode === 'motion' ? (
          <MotionPane
            sources={motionFiles}
            motion={motion}
            onFiles={pickMotionFiles}
            onLoaded={onMotionLoaded}
            background={motionBgColor}
            slide={motionBg !== 'dark'}
            zoom={motionZoom}
            frameRef={frameRef}
            drawing={drawing}
            onDrawn={onDrawn}
          />
        ) : mode === 'recolor' ? (
          <RecolorPane
            fileName={recolorSrc?.name ?? null}
            busy={recolorBusy}
            error={recolorError}
            report={recolorOut?.report ?? null}
            targetName={targetLabel(params.target)}
            source={recolorSrc?.buf ?? null}
            corrected={recolorOut?.bytes ?? null}
            comp={params.color}
            spin={spin}
            onReady={setCompareReady}
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
          onClearAll={handleClearAll}
          onTestFill={onTestFill}
        />
        )}
        {mode === 'model' && (
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
        motion={{
          fileName: motionSrc?.name ?? null,
          extraNames: motionFiles.slice(1).map((x) => x.name),
          loaded: !!motionSpace,
          motion,
          patch: patchMotion,
          drawing,
          setDrawing,
          background: motionBg,
          setBackground: setMotionBg,
          zoom: motionZoom,
          setZoom: setMotionZoom,
          onPick: pickMotionFiles,
          onExport: exportMotion,
          exportBusy: motionBusy,
          video: {
            size: videoSize,
            fps: videoFps,
            setSize: setVideoSize,
            setFps: setVideoFps,
            busy: videoBusy,
            onExport: exportVideo,
            onCancel: () => videoAbort.current?.abort(),
          },
        }}
        onPickRecolor={pickRecolorFile}
        onExportRecolor={exportRecolor}
        spin={spin}
        onToggleSpin={() => setSpin((v) => !v)}
        canSpin={mode === 'recolor' && compareReady}
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
