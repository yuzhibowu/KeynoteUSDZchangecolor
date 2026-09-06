import * as THREE from 'three';
import { applyToHex, applyToImageData, compSignature, isIdentity, type ColorComp } from './color';
import { yieldToBrowser } from './yieldToBrowser';
import { MAX_SLOTS, activeSlots, faceOfSlot, innerSlot, type FaceState, type FaceTransform, type Resolution } from './types';

export type BakeOptions = {
  aspect: number;
  resolution: Resolution;
  bgColor: string;
  /** 底色留透明（不填任何颜色）。Keynote 对带 alpha 的贴图行为不稳，默认关着 */
  bgTransparent?: boolean;
  /** 当前边数 —— 没贴图的面按它算占位色的色相 */
  sides: number;
  /** 有没有内面（「没有端面」时才有） */
  withInner?: boolean;
  comp: ColorComp;
  /** true = 把颜色预补偿烘进去（只有导出时才开） */
  compensate: boolean;
};

/** 预补偿后的源图最长边 —— 反正烘焙也用不到比这更大的像素 */
const CORRECTED_MAX = 2048;

/** usda 文本 + zip 头的固定开销（实测拟合，见 estimateBytes） */
const USDA_BASE_BYTES = 4063;
/** 每多一个侧面带来的 usda 开销：一份材质定义 + 一个几何文件 */
const USDA_PER_FACE_BYTES = 4241;

export type CanvasSize = { w: number; h: number };

/**
 * 长边固定为 resolution，短边按侧面宽高比算。
 * 短边低于 256 时整体等比放大、长边超过 2048 时整体等比缩小 —— 始终保持比例，
 * 因为 canvas 的宽高比一旦和面的宽高比不一致，贴图就会在面上被拉伸。
 * 尺寸取偶数，对 mipmap 友好。
 */
/**
 * 还没贴图的面，用一个彩色块占位。
 *
 * 之前是「首次打开时自动填一批测试图片」，但那依赖「有没有存档」来判断，
 * 而存档的写入和读取是两条异步路径 —— 谁先谁后不一定，一旦存档先写进去，
 * 填充就被跳过，打开就是一个白棱柱。改成渲染时直接上色就没有这个时序问题：
 * 没有图 = 彩色块，永远成立。
 */
export function placeholderColor(index: number, sides: number): string {
  // 必须返回 #rrggbb：颜色补偿那一路（applyToHex）只认十六进制，
  // 给它一个 hsl(...) 会被原样退回、整块颜色绕过补偿 ——
  // 结果就是别的面都补过了，占位块没补，进 Keynote 一看色差很扎眼。
  const h = ((index * 360) / Math.max(1, sides)) % 360;
  return hslToHex(h, 0.72, 0.56);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return (
    '#' +
    rgb
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function canvasSizeFor(aspect: number, resolution: Resolution): CanvasSize {
  let w: number;
  let h: number;
  if (aspect >= 1) {
    w = resolution;
    h = resolution / aspect;
  } else {
    h = resolution;
    w = resolution * aspect;
  }
  const short = Math.min(w, h);
  if (short < 256) {
    const k = 256 / short;
    w *= k;
    h *= k;
  }
  // 长边上限跟着所选档位走 —— 选了 4K 就得让它真的到 4K，
  // 但短边被放大到 256 之后可能把长边顶超，所以还是要收一下。
  const long = Math.max(w, h);
  const cap = Math.max(resolution, 512);
  if (long > cap) {
    const k = cap / long;
    w *= k;
    h *= k;
  }
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(w), h: even(h) };
}

/** 旋转后仍要盖满 canvas 所需的图片外接尺寸（单位：canvas 像素） */
function coverNeed(cw: number, ch: number, rotation: number) {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  return { needW: cw * c + ch * s, needH: cw * s + ch * c };
}

/** cover 基准缩放：scale = 1 时图片刚好盖满整张 canvas */
function coverBase(cw: number, ch: number, iw: number, ih: number, rotation: number) {
  const { needW, needH } = coverNeed(cw, ch, rotation);
  return Math.max(needW / iw, needH / ih);
}

/**
 * 把 offset 夹在「图片仍然完全盖住 canvas」的范围内，避免露出背景色。
 * 约束区域是一个被旋转的矩形，所以在图片自身坐标系里逐分量夹，再转回来。
 */
export function clampTransform(
  t: FaceTransform,
  cw: number,
  ch: number,
  iw: number,
  ih: number,
): FaceTransform {
  const scale = Math.min(8, Math.max(1, t.scale));
  const base = coverBase(cw, ch, iw, ih, t.rotation);
  const dw = iw * base * scale;
  const dh = ih * base * scale;
  const { needW, needH } = coverNeed(cw, ch, t.rotation);
  const slackX = Math.max(0, (dw - needW) / 2);
  const slackY = Math.max(0, (dh - needH) / 2);

  // canvas 像素坐标（y 向下）
  const px = t.offsetX * cw;
  const py = -t.offsetY * ch;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  let rx = px * cos - py * sin;
  let ry = px * sin + py * cos;
  rx = Math.max(-slackX, Math.min(slackX, rx));
  ry = Math.max(-slackY, Math.min(slackY, ry));
  const cos2 = Math.cos(t.rotation);
  const sin2 = Math.sin(t.rotation);
  const bx = rx * cos2 - ry * sin2;
  const by = rx * sin2 + ry * cos2;

  return { ...t, scale, offsetX: bx / cw, offsetY: -by / ch };
}

/**
 * 预览与导出共用同一张离屏 canvas：CanvasTexture 直接包这张 canvas，
 * USDZExporter 读的也是它。两条路径在物理上不可能不一致。
 */
export class FaceTextureStore {
  readonly canvases: HTMLCanvasElement[] = [];
  readonly textures: THREE.CanvasTexture[] = [];
  readonly versions: number[] = [];
  private sigs: string[] = [];
  /** 估体积用的离屏画布，复用一张就够 —— 逐个面画上去、编码、丢掉 */
  private estimateCanvas: HTMLCanvasElement | null = null;
  private corrected: (HTMLCanvasElement | null)[] = [];
  private correctedKey: string[] = [];
  private listeners = new Set<(index: number) => void>();

  constructor() {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 1024;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      tex.name = `face_${i}`;
      this.canvases.push(canvas);
      this.textures.push(tex);
      this.versions.push(0);
      this.sigs.push('');
      this.corrected.push(null);
      this.correctedKey.push('');
    }
  }

  subscribe(cb: (index: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  size(index: number): CanvasSize {
    const c = this.canvases[index];
    return { w: c.width, h: c.height };
  }

  /**
   * 预补偿是作用在「源图」上的（结果缓存起来），不是每帧在整张画布上跑像素循环，
   * 所以开了补偿也不会拖慢拖拽。
   */
  private correctedSource(index: number, face: FaceState, comp: ColorComp): CanvasImageSource {
    const src = face.source!;
    const key = `${face.sourceKey}|${compSignature(comp)}`;
    if (this.correctedKey[index] === key && this.corrected[index]) return this.corrected[index]!;

    const k = Math.min(1, CORRECTED_MAX / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k));
    const h = Math.max(1, Math.round(src.height * k));
    const canvas = this.corrected[index] ?? document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    applyToImageData(img.data, comp);
    ctx.putImageData(img, 0, 0);
    this.corrected[index] = canvas;
    this.correctedKey[index] = key;
    return canvas;
  }

  /**
   * 把一个面画到给定的画布上。
   *
   * 烘焙和体积预估共用这一段 —— 预估必须画的是**真正会导出的那张图**（补偿之后的），
   * 否则报出来的数字和实际文件对不上。曾经就是拿视口那张未补偿的去估，结果差了一截。
   */
  private paint(
    canvas: HTMLCanvasElement,
    index: number,
    face: FaceState,
    opts: BakeOptions,
    w: number,
    h: number,
    useComp: boolean,
  ) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 不留透明：Keynote 对带 alpha 的贴图渲染行为不好预测。
    // fillStyle 赋一个非法字符串时浏览器会「静默忽略」，保留上一次的值（默认是黑）——
    // 那样整张贴图会变黑，所以这里先校验。
    if (!face.source) {
      // 还没贴图：整面铺占位色，一眼能分清哪个面是哪个
      const c = placeholderColor(faceOfSlot(index), opts.sides);
      ctx.fillStyle = useComp ? applyToHex(c, opts.comp) : c;
      ctx.fillRect(0, 0, w, h);
    } else if (!opts.bgTransparent) {
      const safeBg = /^#[0-9a-f]{6}$/i.test(opts.bgColor.trim()) ? opts.bgColor.trim() : '#ffffff';
      ctx.fillStyle = useComp ? applyToHex(safeBg, opts.comp) : safeBg;
      ctx.fillRect(0, 0, w, h);
    }

    if (face.source) {
      const src: CanvasImageSource = useComp
        ? this.correctedSource(index, face, opts.comp)
        : face.source;
      const sw = face.source.width;
      const sh = face.source.height;
      const base = coverBase(w, h, sw, sh, face.rotation);
      const s = base * face.scale;
      const dw = sw * s;
      const dh = sh * s;
      const cx = w / 2 + face.offsetX * w;
      const cy = h / 2 - face.offsetY * h;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(face.rotation);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
  }

  /** 返回是否真的重烘焙过 */
  bake(index: number, face: FaceState, opts: BakeOptions, force = false): boolean {
    const { w, h } = canvasSizeFor(opts.aspect, opts.resolution);
    const useComp = opts.compensate && !isIdentity(opts.comp);
    const compSig = useComp ? compSignature(opts.comp) : 'off';
    const sig = [
      face.sourceKey,
      face.offsetX.toFixed(5),
      face.offsetY.toFixed(5),
      face.scale.toFixed(5),
      face.rotation.toFixed(5),
      w,
      h,
      opts.bgColor,
      opts.bgTransparent ? 'alpha' : 'opaque',
      opts.sides,
      compSig,
    ].join('|');
    if (!force && sig === this.sigs[index]) return false;
    this.sigs[index] = sig;

    this.paint(this.canvases[index], index, face, opts, w, h, useComp);

    this.textures[index].needsUpdate = true;
    this.versions[index]++;
    this.listeners.forEach((cb) => cb(index));
    return true;
  }

  /**
   * 烘焙当前用得上的每一个面。
   *
   * 只烘 activeSlots —— 从前这里是 `i < MAX_SLOTS`，画 4 个面也要烘满 24 张 2K 画布，
   * 每次拖滑块都白干 20 张，导出时还要来回两遍，标签页卡死甚至黑屏就是这么来的。
   */
  bakeAll(faces: FaceState[], opts: BakeOptions, force = false): number {
    const slots = activeSlots(opts.sides, opts.withInner);
    let n = 0;
    for (const i of slots) {
      if (this.bake(i, faces[i], opts, force)) n++;
    }
    this.releaseUnused(slots);
    return n;
  }

  /**
   * 同上，但每烘一张就把主线程让出去一次。
   *
   * 导出要在一次点击里烘十几张 2K 画布，同步跑就是几秒钟的整页假死（画面会黑）。
   * 让出去之后浏览器能把「导出中…」画出来，用户看得到进度。
   */
  async bakeAllAsync(
    faces: FaceState[],
    opts: BakeOptions,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const slots = activeSlots(opts.sides, opts.withInner);
    let n = 0;
    for (let k = 0; k < slots.length; k++) {
      if (this.bake(slots[k], faces[slots[k]], opts)) n++;
      onProgress?.(k + 1, slots.length);
      await yieldToBrowser();
    }
    this.releaseUnused(slots);
    return n;
  }

  /**
   * 把用不到的槽位缩成 1×1，把那几十兆画布和显存还回去。
   * 同时清掉签名，等它重新变成活动面时会照常重烘。
   */
  private releaseUnused(active: number[]) {
    const live = new Set(active);
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (live.has(i)) continue;
      const c = this.canvases[i];
      if (c.width === 1 && c.height === 1) continue;
      c.width = 1;
      c.height = 1;
      this.sigs[i] = '';
      this.corrected[i] = null;
      this.correctedKey[i] = '';
      this.textures[i].needsUpdate = true;
    }
  }

  /**
   * 用 PNG 实际编码体积估算导出文件大小（USDZ 里贴图就是 PNG，且不再压缩）。
   *
   * 一张 4K 图编码要一秒上下，十几个面就是十几秒。所以必须能中途叫停：
   * 参数一变就该丢掉旧的这一轮，否则用户拖一次滑块就多压一叠任务在队列里，
   * 导出的时候更是每烘一张就触发一轮，整个页面被自己压死。
   */
  async estimateBytes(
    faces: FaceState[],
    sides: number,
    opts: BakeOptions,
    token?: { aborted: boolean },
  ): Promise<number> {
    // 关键：按**导出口径**估，也就是补偿之后的像素。
    // 视口里那张是不带补偿的，颜色被推开之后 PNG 压缩率会变，两者体积对不上。
    const useComp = opts.compensate && !isIdentity(opts.comp);
    const { w, h } = canvasSizeFor(opts.aspect, opts.resolution);
    const probe = this.estimateCanvas ?? (this.estimateCanvas = document.createElement('canvas'));

    // 非贴图开销：usda 文本 + zip 头 + 64 字节对齐。
    // 实测是漂亮的线性：4 面时 21028 字节、12 面时 54958 字节 —— 每多一个面约 4.2 KB
    // （每个面各有一份材质定义和一个几何文件），基础约 4 KB。
    // 原来这里拍了个 4096 的常数，12 面时会少估 50 KB。
    // 没有端面时每个面有正反两张贴图，都要算进去
    const slots: number[] = [];
    for (let i = 0; i < sides; i++) slots.push(i);
    if (opts.withInner) for (let i = 0; i < sides; i++) slots.push(innerSlot(i));

    let total = USDA_BASE_BYTES + slots.length * USDA_PER_FACE_BYTES;
    for (const i of slots) {
      if (token?.aborted) return -1;
      this.paint(probe, i, faces[i], opts, w, h, useComp);
      total += await new Promise<number>((resolve) => {
        probe.toBlob((b) => resolve(b ? b.size : 0), 'image/png', 1);
      });
    }
    if (token?.aborted) return -1;
    return total;
  }
}
