import * as THREE from 'three';
import { applyLift, makeCapMaterial, makeFaceMaterial } from './material';
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

  /**
   * 每个面都贴同一张色卡，材质参数和 viewer 里那份**逐字一致**。
   *
   * 曾经改成「只贴第 0 面、其余纯黑」，想借此避开旁边面的品红边框干扰角点检测。
   * 那是白改：实测两种做法都在偏转 14° 崩掉，真正的解法是识别端的透视校正。
   * 而它带来了一个真实的回归 —— Keynote 渲染 3D 是带环境反射的，周围面从
   * 「明亮的色卡」变成纯黑之后，中间那一面跟着变暗，实测白点从 244 掉到 222。
   * 标定是在这个偏暗的条件下做的，补偿量整体算歪，成品看着就发闷发黄。
   *
   * 教训写在这里：色卡棱柱的**一切**都必须和实际导出的模型一样 —— 几何、材质类型、
   * 粗糙度、补光，还有周围有什么。测量条件和使用条件之间任何一点差异都会被当成偏色。
   */
  const unlit = params.emissiveExport;
  const lift = unlit ? 1 : Math.max(0, Math.min(1, params.emissiveLift ?? 0));

  for (let i = 0; i < sides; i++) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    const mat = makeFaceMaterial(tex);
    applyLift(mat, tex, lift, unlit);
    const geo = sideGeometry(i, prismSection(sides, radius), length);
    group.add(new THREE.Mesh(geo, mat));
    disposables.push(tex, mat, geo);
  }

  // 端面：颜色和「要不要端面」都跟着实际参数走。
  // 原来这里写死深灰 0x202020、而且永远带端面 —— 但用户的模型端面默认是浅灰、
  // 还可以整个镂空。端面是深是浅、在不在，都会改变棱柱内部的反射环境，
  // 进而改变色卡那一面量到的亮度，于是把「我自己造的差异」当成 Keynote 的偏色测了进去。
  if (params.capMode !== 'none') {
    for (const right of [true, false]) {
      const hex = right ? params.capColorRight : params.separateCaps ? params.capColorLeft : params.capColorRight;
      const mat = makeCapMaterial(hex);
      applyLift(mat, null, lift, unlit);
      if (unlit) mat.emissive.set(hex);
      const geo = capGeometry(prismSection(sides, radius), length, right);
      group.add(new THREE.Mesh(geo, mat));
      disposables.push(mat, geo);
    }
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
