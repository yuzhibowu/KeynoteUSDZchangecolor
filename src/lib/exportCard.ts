import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { drawChart, setChartExtra, pickCovering, EXTRA_SLOTS, type RGB } from './chart';
import { isIdentity, solveWritten } from './color';
import { capGeometry, prismSection, sideGeometry } from './geometry';
import { MAX_SIDES, type Params } from './types';

/**
 * 标定色卡直接做成「和你实际用的一模一样的棱柱」，而不是一张平板。
 *
 * 平板和棱柱在 Keynote 里的受光、姿态可能不同，校准数据就传不过去 —— 实测踩过这个坑。
 * 用同样的几何、同样的材质设置（尤其是灯光开关），测出来的偏色才和实际使用时一致。
 * 色卡本身当然不做任何补偿，它是基准。
 *
 * 色卡是 4:3，贴到别的宽高比的面上会被拉伸，但识别用的是品红外框的相对比例，
 * 横竖各自等比缩放不影响定位。
 */
/**
 * 从用户自己的贴图里挑出最主要的几个颜色，再算出补偿之后要写进贴图的实际值 —— 
 * 把这些值放进色卡，就能直接测出「我打算写的这个值，Keynote 会显示成什么」，
 * 模型也就能在真正用得上的地方拿到真实数据，而不是靠外推。
 */
function probeColorsFrom(canvases: HTMLCanvasElement[], sides: number, params: Params): RGB[] {
  const hist = new Map<number, number>();
  const tmp = document.createElement('canvas');
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  for (let i = 0; i < Math.min(sides, MAX_SIDES); i++) {
    const src = canvases[i];
    if (!src) continue;
    const w = Math.max(1, Math.min(160, src.width));
    const h = Math.max(1, Math.round((w * src.height) / src.width));
    tmp.width = w;
    tmp.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let p = 0; p < d.length; p += 4) {
      const k = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  const top = pickCovering(hist, EXTRA_SLOTS);

  if (isIdentity(params.color)) return pad(top);
  // 必须和导出时真正写进贴图的值完全一致 —— 探针格的全部意义就是
  // 「我打算写这个值，Keynote 会显示成什么」，走别的路径量出来的就不是那件事了
  return pad(top.map((c) => solveWritten(c[0], c[1], c[2], params.color) as RGB));
}

/**
 * 不足额就用主色的变体补齐 —— 顺带在主色周围铺开一小片采样，
 * 模型在这一带才有真实数据可用，不用外推。
 */
/**
 * 大跨度扫蓝色。饱和暖色的蓝通道在 Keynote 里会被压死，但蓝色够高时又能存活，
 * 中间的过渡区必须有实测数据，否则模型只能外推 —— 之前就是栽在这里：
 * 模型算「写 80 能剩 39」，实际是 0。
 */
const VARIANTS: RGB[] = [
  [0, 0, 40], [0, 0, 80], [0, 0, 120], [0, 0, 160], [0, 0, -35], [-30, 0, 60],
];

function pad(list: RGB[]): RGB[] {
  const out = list.slice(0, EXTRA_SLOTS);
  if (out.length === 0) return DEFAULT_PROBE;
  let k = 0;
  while (out.length < EXTRA_SLOTS) {
    const base = out[k % list.length];
    const v = VARIANTS[k % VARIANTS.length];
    out.push([
      Math.max(0, Math.min(255, base[0] + v[0])),
      Math.max(0, Math.min(255, base[1] + v[1])),
      Math.max(0, Math.min(255, base[2] + v[2])),
    ]);
    k++;
  }
  return out;
}

const DEFAULT_PROBE: RGB[] = [
  [255, 200, 70], [250, 170, 90], [200, 150, 200], [150, 200, 220], [110, 110, 110],
];

export async function exportChartCard(
  params: Params,
  canvases?: HTMLCanvasElement[],
): Promise<{ blob: Blob; name: string }> {
  if (canvases) setChartExtra(probeColorsFrom(canvases, params.sides, params));
  const canvas = document.createElement('canvas');
  drawChart(canvas, 1024);

  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const { sides, radius, length } = params;

  // 只有第 0 面贴色卡，其余面纯黑。
  //
  // 原来每个面都贴同一张色卡，看着更「完整」，但识别那一步是取截图里**所有**品红像素的
  // 包围盒来定位色卡的 —— 只要没有严格正对，旁边那个面就会露出一条，它的品红边框
  // 一并进了包围盒，整张取样网格横向撑歪，最后报「色卡取样对不上」。
  // 面越少这个问题越狠：三棱柱稍微偏一点，旁边的面就露出一大片。
  // 只留一个框，怎么转都不会有第二个框来干扰。
  for (let i = 0; i < sides; i++) {
    const unlit = params.emissiveExport;
    const lift = unlit ? 1 : Math.max(0, Math.min(1, params.emissiveLift ?? 0));
    let mat: THREE.MeshStandardMaterial;
    if (i === 0) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
      if (lift > 0) {
        mat.emissiveMap = tex;
        mat.emissive.setRGB(lift, lift, lift);
      }
      if (unlit) mat.color.setRGB(0, 0, 0);
      disposables.push(tex);
    } else {
      // 陪衬面：纯黑，不能带一点品红，否则又会被当成色卡边框
      mat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.9, metalness: 0 });
      if (unlit) mat.color.setRGB(0, 0, 0);
    }
    const geo = sideGeometry(i, prismSection(sides, radius), length);
    group.add(new THREE.Mesh(geo, mat));
    disposables.push(mat, geo);
  }

  for (const right of [true, false]) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.85, metalness: 0 });
    if (params.emissiveExport) {
      mat.emissive.set(0x202020);
      mat.color.setRGB(0, 0, 0);
    }
    const geo = capGeometry(prismSection(sides, radius), length, right);
    group.add(new THREE.Mesh(geo, mat));
    disposables.push(mat, geo);
  }

  group.updateMatrixWorld(true);
  const buffer = await new USDZExporter().parseAsync(group, {
    maxTextureSize: 1024,
    includeAnchoringProperties: true,
    quickLookCompatible: false,
  });
  for (const d of disposables) d.dispose();

  return {
    blob: new Blob([buffer as unknown as BlobPart], { type: 'model/vnd.usdz+zip' }),
    name: `keynote-color-chart-${Date.now().toString(36)}.usdz`,
  };
}
