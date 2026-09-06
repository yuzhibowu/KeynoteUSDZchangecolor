import * as THREE from 'three';

/**
 * 程序化生成纸纹的法线贴图。
 *
 * 为什么要它：纸和纸的区别，除了颜色就是纹理。只调粗糙度的话，
 * A4、卡纸、牛皮纸看上去几乎是同一种东西。法线贴图是 UsdPreviewSurface 的标准输入，
 * three 的导出器也会写 `inputs:normal`，所以纹理能真的跟着模型进 Keynote。
 *
 * 三个约束：
 * 1. **必须可平铺**。噪声用环形晶格插值生成，左右上下自然接得上，
 *    否则贴图重复的地方会出现明显的接缝。
 * 2. **必须小**。噪声是 PNG 的天敌 —— 压不动。所以尺寸压到 128，
 *    再把法线量化成 16 级：肉眼看不出差别，PNG 体积能小一个数量级。
 * 3. **强度要弱**。纸纹是「摸得出来、看不太出来」的东西，
 *    过强会盖过贴图本身的颜色，也会干扰颜色校准。
 */
export type GrainKind = 'fine' | 'medium' | 'coarse' | 'subtle';

const SIZE = 128;
/** 法线量化级数 —— 越少 PNG 越小 */
const LEVELS = 16;

const cache = new Map<GrainKind, THREE.CanvasTexture>();

type Recipe = { lattice: number[]; weight: number[]; strength: number };

const RECIPES: Record<GrainKind, Recipe> = {
  // 复印纸：细密均匀
  fine: { lattice: [64, 32], weight: [1, 0.5], strength: 1.1 },
  // 卡纸：粗一点，带点起伏
  medium: { lattice: [32, 16], weight: [1, 0.6], strength: 1.8 },
  // 牛皮纸：明显的纤维感，低频起伏 + 高频颗粒
  coarse: { lattice: [16, 48], weight: [1, 0.55], strength: 2.8 },
  // 铜版纸：几乎是平的，只留一点点
  subtle: { lattice: [64], weight: [1], strength: 0.45 },
};

/** 可平铺的值噪声：在 n×n 的环形晶格上取随机值，再做平滑插值 */
function tileNoise(n: number, seed: number): Float32Array {
  const grid = new Float32Array(n * n);
  let s = seed >>> 0;
  const rnd = () => {
    // xorshift，固定种子 —— 每次生成的纹理都一样，不然刷新一次纹理就变了
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();

  const out = new Float32Array(SIZE * SIZE);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < SIZE; y++) {
    const gy = (y / SIZE) * n;
    const y0 = Math.floor(gy) % n;
    const y1 = (y0 + 1) % n;
    const fy = smooth(gy - Math.floor(gy));
    for (let x = 0; x < SIZE; x++) {
      const gx = (x / SIZE) * n;
      const x0 = Math.floor(gx) % n;
      const x1 = (x0 + 1) % n;
      const fx = smooth(gx - Math.floor(gx));
      const a = grid[y0 * n + x0] * (1 - fx) + grid[y0 * n + x1] * fx;
      const b = grid[y1 * n + x0] * (1 - fx) + grid[y1 * n + x1] * fx;
      out[y * SIZE + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

export function paperGrain(kind: GrainKind): THREE.CanvasTexture {
  const hit = cache.get(kind);
  if (hit) return hit;

  const { lattice, weight, strength } = RECIPES[kind];
  const height = new Float32Array(SIZE * SIZE);
  lattice.forEach((n, k) => {
    const layer = tileNoise(n, 0x9e3779b9 + n * 7919 + k * 104729);
    for (let i = 0; i < height.length; i++) height[i] += layer[i] * weight[k];
  });

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const at = (x: number, y: number) => height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
  const q = (v: number) => {
    // 量化到 LEVELS 级，PNG 才压得动
    const step = 255 / (LEVELS - 1);
    return Math.round(Math.round(v * 255 / step) * step);
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 中心差分求梯度 → 切线空间法线
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * SIZE + x) * 4;
      img.data[o] = q((-dx / len) * 0.5 + 0.5);
      img.data[o + 1] = q((-dy / len) * 0.5 + 0.5);
      img.data[o + 2] = q(1 / len * 0.5 + 0.5);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // 法线是数据，不是颜色，不能走 sRGB
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.name = `grain_${kind}`;
  cache.set(kind, tex);
  return tex;
}
