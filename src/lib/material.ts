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
 * 一律用 MeshPhysicalMaterial，不用 Standard。
 * 清漆和折射率只有它才会被 USDZExporter 写进文件（导出器里那段是
 * isMeshPhysicalMaterial 才走的）。它是 Standard 的超集，默认值下渲染完全一样。
 */
export function makeFaceMaterial(map?: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: map ?? null,
    roughness: FACE_ROUGHNESS,
    metalness: METALNESS,
  });
}

export function makeCapMaterial(color: THREE.ColorRepresentation): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: CAP_ROUGHNESS,
    metalness: METALNESS,
  });
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
