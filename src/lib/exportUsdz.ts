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

/**
 * 先问用户存哪儿（在点击的同一个手势里问，否则浏览器会拒绝）。
 *
 * 为什么不直接用 `<a download>`：连续导出几次之后，浏览器会**静默拦掉**后续下载 ——
 * 界面上提示「已导出」，可下载文件夹里什么都没有，人完全不知道发生了什么。
 * 保存对话框是用户自己点的，存没存下、存到哪，一目了然。
 *
 * Safari 还不支持这个 API，那边回退到 `<a download>`。
 */
export async function askWhereToSave(name: string): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  try {
    return await picker({
      suggestedName: name,
      types: [{ description: 'USDZ 模型', accept: { 'model/vnd.usdz+zip': ['.usdz'] } }],
    });
  } catch {
    return null; // 用户取消，或者这个环境不让用
  }
}

/** 把文件写到用户选好的位置；没有 handle 就退回浏览器下载 */
export async function save(blob: Blob, name: string, handle: FileSystemFileHandle | null) {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function download(blob: Blob, name: string) {
  void save(blob, name, null);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
