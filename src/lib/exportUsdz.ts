import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { PrismViewer } from './viewer';
import type { FaceTextureStore } from './faceTexture';
import type { Params } from './types';
import { withExtents } from './usdzExtent';

export function usdzFileName(sides: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `prism-${sides}-${ts}.usdz`;
}

/**
 * 导出的是 viewer.prism 这一个分组 —— 里面只有棱柱本体的 mesh，
 * 选中描边、网格地面、灯光都在分组外面，天然不会被带进文件。
 */
export async function exportUsdz(
  viewer: PrismViewer,
  store: FaceTextureStore,
  params: Params,
): Promise<{ blob: Blob; name: string }> {
  let maxTex = params.resolution as number;
  for (let i = 0; i < params.sides; i++) {
    const { w, h } = store.size(i);
    maxTex = Math.max(maxTex, w, h);
  }
  // 每次导出换一批全新的 texture 对象：three 的导出器按 texture.source.id 给文件命名，
  // 复用同一批对象会让每个 usdz 里的贴图都叫 Texture_17_true.png。万一 Keynote 按名字
  // 缓存资源，就会显示上一次的旧贴图 —— 实测遇到过这个现象，这里彻底断掉这种可能。
  const swapped: { mat: THREE.MeshStandardMaterial; map: THREE.Texture | null; emissiveMap: THREE.Texture | null }[] = [];
  const fresh: THREE.Texture[] = [];
  viewer.prism.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat.map) return;
    swapped.push({ mat, map: mat.map, emissiveMap: mat.emissiveMap });
    const tex = new THREE.CanvasTexture(mat.map.image as HTMLCanvasElement);
    tex.colorSpace = mat.map.colorSpace;
    tex.wrapS = mat.map.wrapS;
    tex.wrapT = mat.map.wrapT;
    tex.anisotropy = mat.map.anisotropy;
    fresh.push(tex);
    mat.map = tex;
    if (mat.emissiveMap) mat.emissiveMap = tex;
  });

  const exporter = new USDZExporter();
  // runCanonical：视口里的旋转只是给人看的，导出的模型要是正的
  // 没有「亮度增益」这回事：材质上写 inputs:scale > 1 实测被 Keynote 忽略，
  // 而贴图那边已经先除过一遍，净效果是白白变暗 30%。抬高亮度上限靠的是自发光。
  // 详见 KEYNOTE-COLOR.md 第四节「走过的死路」。
  const buffer = await viewer.runCanonical(() =>
    exporter.parseAsync(viewer.prism, {
      maxTextureSize: maxTex, // 默认值是 1024，会偷偷把 2048 的贴图降采样
      includeAnchoringProperties: true,
      quickLookCompatible: false,
    }),
  );
  for (const s of swapped) {
    s.mat.map = s.map;
    s.mat.emissiveMap = s.emissiveMap;
  }
  for (const t of fresh) t.dispose();

  // 补上每个 Mesh 的 extent —— USDZExporter 一个都不写，而渲染器拿不到包围盒
  // 就只能自己猜，猜出来的框可能把模型切掉一块。
  const patched = withExtents(buffer as unknown as ArrayBuffer);
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__lastUsdz = patched;
  }
  const blob = new Blob([patched as unknown as BlobPart], { type: 'model/vnd.usdz+zip' });
  return { blob, name: usdzFileName(params.sides) };
}

type SavePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** 用户在保存对话框里点了取消 */
export const CANCELLED = Symbol('cancelled');

/**
 * 在点击的手势里问「存哪儿」，并**立刻**把可写句柄拿到手。
 *
 * 这两步必须挨着做。上一版栽在这里：先弹对话框，等模型烘焙打包好几秒之后才调
 * `createWritable()`，那时手势早过期，直接报「not allowed by the user agent
 * in the current context」，导出整个失败。现在拿完句柄再去干耗时的活。
 *
 * 返回 null 表示这个浏览器没有这个 API（Safari 就没有），调用方回退到 <a download>；
 * 返回 CANCELLED 表示用户自己取消了，那就什么都别做。
 */
export async function openSaveTarget(
  name: string,
): Promise<FileSystemWritableFileStream | null | typeof CANCELLED> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName: name,
      types: [{ description: 'USDZ 模型', accept: { 'model/vnd.usdz+zip': ['.usdz'] } }],
    });
  } catch {
    return CANCELLED; // 用户取消
  }
  try {
    return await handle.createWritable();
  } catch {
    return null; // 拿不到写权限就退回下载，别把导出堵死
  }
}

/**
 * 触发浏览器下载（没有保存对话框时的退路）。
 *
 * 它的毛病是连着导出几次之后浏览器可能静默拦截，界面说「已导出」而文件夹里没有东西。
 * 所以调用方要把 blob 留着，让用户能在一次新的点击里重存。
 */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
