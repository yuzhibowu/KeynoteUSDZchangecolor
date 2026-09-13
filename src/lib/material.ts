import * as THREE from 'three';

/**
 * 模型材质的**唯一来源**。预览、导出、色卡棱柱都必须从这里拿。
 *
 * 为什么要单独立一个文件：色卡棱柱是用来测「Keynote 把颜色改成了什么样」的，
 * 它和实际导出的模型之间任何一点差异，都会被当成 Keynote 的偏色测进校准档里，
 * 然后反过来污染每一次导出。这类 bug 的症状是「颜色莫名其妙不准」，几乎无法定位。
 *
 * 实际踩过的：色卡用 MeshStandardMaterial、成品用 MeshPhysicalMaterial，
 * 两份材质各写各的，谁也没发现它们不是同一个东西。还有色卡端面写死深灰
 * （成品默认是浅灰）、色卡总是带端面（成品可以镂空）—— 每一条都在悄悄改变
 * 反射环境，进而改变量到的亮度。
 *
 * 所以：**参数只在这里写一次**，两边都调同一个函数。要改粗糙度就改这里，
 * 不可能只改到一半。
 */

/** 侧面：高粗糙度，压制高光对贴图颜色的干扰 */
export const FACE_ROUGHNESS = 0.9;
/** 端面：纯色板，比侧面略光一点 */
export const CAP_ROUGHNESS = 0.85;
export const METALNESS = 0;

/**
 * 材质预设。**「纸张」就是校准档标定时用的那一套**（粗糙 0.9 / 0.85、金属度 0、无清漆），
 * 是默认值，颜色校准只对它精确。
 *
 * 之前砍掉过材质（见 git 632301e）：补光是靠自发光抬亮度上限的，自发光的面不受光，
 * 金属和光泽出不来；关掉补光才看得到质感，颜色精度就没了。用户明确要求恢复，
 * 所以恢复，但两条底线：纸张 = 校准条件不动；别的材质在界面上明说「颜色会偏，
 * 想精确就在这个材质下重做密集标定」。
 *
 * 玻璃靠 opacity + 低粗糙 + 清漆近似 —— USDZExporter 只写 opacity / ior / clearcoat，
 * 不写 transmission，Keynote 也认不了 transmission。
 */
export type MaterialId = 'paper' | 'plastic' | 'metal' | 'glass';

export type MaterialPreset = {
  id: MaterialId;
  label: string;
  roughness: number;
  capRoughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  opacity: number;
  ior: number;
};

export const MATERIALS: MaterialPreset[] = [
  { id: 'paper', label: '纸张', roughness: 0.9, capRoughness: 0.85, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, opacity: 1, ior: 1.5 },
  { id: 'plastic', label: '塑料', roughness: 0.4, capRoughness: 0.4, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15, opacity: 1, ior: 1.5 },
  { id: 'metal', label: '金属', roughness: 0.3, capRoughness: 0.3, metalness: 1, clearcoat: 0, clearcoatRoughness: 0, opacity: 1, ior: 1.5 },
  { id: 'glass', label: '玻璃', roughness: 0.05, capRoughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, opacity: 0.6, ior: 1.5 },
];

export const DEFAULT_MATERIAL: MaterialId = 'paper';

export function materialPreset(id: MaterialId | undefined): MaterialPreset {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}

/** 把预设写到一个现成的材质上（视口里材质对象是复用的，参数变了就地改） */
/**
 * `preview`：视口里要看到玻璃的半透明，得开 transparent；导出时必须关 ——
 * USDZExporter 看到 transparent 就把 opacity 接到贴图的 alpha 上（不透明 PNG 就是 1，
 * 玻璃感全没了），关掉它才会老老实实写 inputs:opacity = 0.6 这个常数。
 */
export function applyMaterialPreset(
  mat: THREE.MeshPhysicalMaterial,
  id: MaterialId | undefined,
  cap = false,
  preview = false,
) {
  const m = materialPreset(id);
  const roughness = cap ? m.capRoughness : m.roughness;
  const transparent = preview && m.opacity < 1;
  if (
    mat.roughness === roughness &&
    mat.metalness === m.metalness &&
    mat.clearcoat === m.clearcoat &&
    mat.clearcoatRoughness === m.clearcoatRoughness &&
    mat.opacity === m.opacity &&
    mat.ior === m.ior &&
    mat.transparent === transparent
  ) {
    return;
  }
  mat.roughness = roughness;
  mat.metalness = m.metalness;
  mat.clearcoat = m.clearcoat;
  mat.clearcoatRoughness = m.clearcoatRoughness;
  mat.opacity = m.opacity;
  mat.ior = m.ior;
  mat.transparent = transparent;
  mat.needsUpdate = true;
}

/**
 * 一律用 MeshPhysicalMaterial，不用 Standard。
 * 清漆和折射率只有它才会被 USDZExporter 写进文件（导出器里那段是
 * isMeshPhysicalMaterial 才走的）。它是 Standard 的超集，默认值下渲染完全一样。
 */
export function makeFaceMaterial(map?: THREE.Texture | null, material?: MaterialId): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    map: map ?? null,
    roughness: FACE_ROUGHNESS,
    metalness: METALNESS,
  });
  applyMaterialPreset(mat, material, false);
  return mat;
}

export function makeCapMaterial(color: THREE.ColorRepresentation, material?: MaterialId): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    roughness: CAP_ROUGHNESS,
    metalness: METALNESS,
  });
  applyMaterialPreset(mat, material, true);
  return mat;
}

/**
 * 把补光（自发光）按同一套规则加到材质上。
 *
 * Keynote 算像素是「贴图 × 灯光 + 自发光」。乘法那项有天花板，加法那项没有，
 * 所以补光是靠自发光把颜色上限抬起来的。补光 > 0 时必须**同时挂 emissiveMap**，
 * 加法那一项才能逐像素跟着贴图走；只设 emissive 不挂图，等于整面均匀加一层灰。
 *
 * `unlit` 是「完全关掉灯光」：diffuse 压黑，画面全部由自发光贡献。
 */
export function applyLift(
  mat: THREE.MeshPhysicalMaterial,
  map: THREE.Texture | null,
  lift: number,
  unlit: boolean,
) {
  const v = unlit ? 1 : Math.max(0, Math.min(1, lift));
  const wantMap = v > 0 ? map : null;
  if (mat.emissiveMap !== wantMap) {
    mat.emissiveMap = wantMap;
    mat.needsUpdate = true;
  }
  mat.emissive.setRGB(v, v, v);
  mat.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
}
