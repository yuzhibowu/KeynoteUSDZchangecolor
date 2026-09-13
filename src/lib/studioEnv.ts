import * as THREE from 'three';

/**
 * 预览布光（只影响视口里非纸张材质，不进文件）。用 11 张 Keynote 截图拟合出来的
 * （2026-09-13，金属卡片，X/Y 各扫一遍）：每张找四个角映射回卡片坐标，用原图反照率
 * 除掉贴图自身明暗，按已知旋转角和相机距离（梯形比例算出 d/W ≈ 1.15）求每点反射方向，
 * 4000 多个点一起拟合。主光在镜头轴线上方 21.8°、左侧 16.0°，角半径约 14°，幅度 0.61；
 * 底光几乎均匀 0.8 —— 金属永远不会黑、整体柔和就是它。
 * 再把视口自己的渲染用同样方法量一遍、逐点和 Keynote 比（rmse 0.139 → 0.105），
 * 定下强度 1.3、横 15° / 纵 12°。拟合出的 14° 是「光的大小 ⊗ 粗糙度 0.3 的模糊」，
 * 视口的 PMREM 模糊和 Keynote 不一样，所以以逐点比对为准。用户实拍确认「非常好」。
 */
export const ENV_BASE = 0.8;
export const ENV_LOBE = 0.61;
export const ENV_TILT_DEG = -12;
export const ENV_ELEV_DEG = 22;
export const ENV_AZIM_DEG = -16;
export const ENV_SIZE_W_DEG = 15;
export const ENV_SIZE_H_DEG = 12;
export const ENV_INTENSITY = 1.3;
/** 贴图编码用的缩放：存 r^2.2 / K，envMapIntensity 乘回 K，峰值才能超过 1 */
export const ENV_SCALE = 2.2;

/** 挂到材质上时用的 envMapIntensity：拟合出的强度 × 贴图编码缩放 */
export const STUDIO_ENV_INTENSITY = ENV_INTENSITY * ENV_SCALE;

/**
 * 预览用的「软影棚」环境：自己画的等距柱状图 —— 均匀底光 + 一块可定位的椭圆柔光。
 * 形状和位置是用 11 张 Keynote 截图拟合出来的，见 DEFAULT_PREVIEW_TUNE 的注释。
 *
 * 数值的口径：拟合出来的是「截图亮度 / 贴图反照率」这个 sRGB 域的倍率 r
 * （底光 0.8，光斑中心 1.4）。渲染是在线性域相乘，所以贴图里存的是 r^2.2 / K，
 * envMapIntensity 再乘回 K（K = ENV_SCALE），峰值才能超过 1 而不被 8 位贴图截掉。
 *
 * 视口相机固定在 +Z 看向原点，所以「相对镜头」= 相对世界 +Z。three 的等距柱状图：
 * u = atan2(z, x) / 2π + 0.5，v = asin(y) / π + 0.5，+Z 落在 u = 0.75。
 */
export function makeStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const elevDeg = ENV_ELEV_DEG;
  const azimDeg = ENV_AZIM_DEG;
  const wDeg = ENV_SIZE_W_DEG;
  const hDeg = ENV_SIZE_H_DEG;
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const el = (elevDeg * Math.PI) / 180;
  const az = (azimDeg * Math.PI) / 180;
  // 主光中心方向：从 +Z（镜头那边）抬 el、向 +X 转 az
  const L = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  // 主光是椭圆的：在它自己的局部坐标里量横向 / 纵向偏角，各用各的宽度；整体带一点倾斜
  const up0 = new THREE.Vector3(0, 1, 0);
  const right0 = new THREE.Vector3().crossVectors(up0, L).normalize();
  const up1 = new THREE.Vector3().crossVectors(L, right0).normalize();
  const tilt = (ENV_TILT_DEG * Math.PI) / 180;
  const right = right0.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(up1, Math.sin(tilt));
  const up = right0.clone().multiplyScalar(-Math.sin(tilt)).addScaledVector(up1, Math.cos(tilt));
  const sw = (wDeg * Math.PI) / 180;
  const sh = (hDeg * Math.PI) / 180;
  const dir = new THREE.Vector3();
  const toSrgb = (lin: number) => (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1); // three 的 v：0 = 地面，1 = 天顶
    const phi = (v - 0.5) * Math.PI; // 仰角
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const theta = (u - 0.5) * 2 * Math.PI; // atan2(z, x)
      dir.set(Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi));
      const dAz = Math.atan2(dir.dot(right), Math.max(1e-6, dir.dot(L)));
      const dEl = Math.asin(Math.max(-1, Math.min(1, dir.dot(up))));
      const behind = dir.dot(L) < 0 ? 0 : 1; // 背面半球不发光
      const ratio = ENV_BASE + ENV_LOBE * behind * Math.exp(-((dAz * dAz) / (2 * sw * sw) + (dEl * dEl) / (2 * sh * sh)));
      const val = Math.round(255 * Math.min(1, toSrgb(Math.pow(ratio, 2.2) / ENV_SCALE)));
      const i = ((H - 1 - y) * W + x) * 4; // 画布 y 向下，贴图 v 向上
      img.data[i] = val;
      img.data[i + 1] = val;
      img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
