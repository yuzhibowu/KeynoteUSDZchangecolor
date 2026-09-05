import * as THREE from 'three';
import {
  applyToHex,
  applyToImageData,
  compSignature,
  compensateWithGain,
  isIdentity,
  requiredGain,
  type ColorComp,
} from './color';
import { MAX_SIDES, type FaceState, type FaceTransform, type Resolution } from './types';

export type BakeOptions = {
  aspect: number;
  resolution: Resolution;
  bgColor: string;
  comp: ColorComp;
  /** true = 把颜色预补偿烘进去（只有导出时才开） */
  compensate: boolean;
  /** 线性光增益：贴图里存 L/gain，导出时材质上写回 gain，用来突破 8 位天花板 */
  gain?: number;
};

/** 预补偿后的源图最长边 —— 反正烘焙也用不到比这更大的像素 */
const CORRECTED_MAX = 2048;

export type CanvasSize = { w: number; h: number };

/**
 * 长边固定为 resolution，短边按侧面宽高比算。
 * 短边低于 256 时整体等比放大、长边超过 2048 时整体等比缩小 —— 始终保持比例，
 * 因为 canvas 的宽高比一旦和面的宽高比不一致，贴图就会在面上被拉伸。
 * 尺寸取偶数，对 mipmap 友好。
 */
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
  const long = Math.max(w, h);
  if (long > 2048) {
    const k = 2048 / long;
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
  private corrected: (HTMLCanvasElement | null)[] = [];
  private correctedKey: string[] = [];
  private listeners = new Set<(index: number) => void>();

  constructor() {
    for (let i = 0; i < MAX_SIDES; i++) {
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
  private correctedSource(index: number, face: FaceState, comp: ColorComp, gain: number): CanvasImageSource {
    const src = face.source!;
    const key = `${face.sourceKey}|${compSignature(comp)}|${gain.toFixed(4)}`;
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
    if (gain > 1.0001) {
      const map = compensateWithGain(comp, gain);
      if (map) {
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = map(d[i], d[i + 1], d[i + 2]);
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
        }
      }
    } else {
      applyToImageData(img.data, comp);
    }
    ctx.putImageData(img, 0, 0);
    this.corrected[index] = canvas;
    this.correctedKey[index] = key;
    return canvas;
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
      compSig,
      (opts.gain ?? 1).toFixed(4),
    ].join('|');
    if (!force && sig === this.sigs[index]) return false;
    this.sigs[index] = sig;

    const canvas = this.canvases[index];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 不留透明：Keynote 对带 alpha 的贴图渲染行为不好预测。
    // fillStyle 赋一个非法字符串时浏览器会「静默忽略」，保留上一次的值（默认是黑）——
    // 那样整张贴图会变黑，所以这里先校验。
    const safeBg = /^#[0-9a-f]{6}$/i.test(opts.bgColor.trim()) ? opts.bgColor.trim() : '#ffffff';
    ctx.fillStyle = useComp ? applyToHex(safeBg, opts.comp) : safeBg;
    ctx.fillRect(0, 0, w, h);

    if (face.source) {
      const src: CanvasImageSource = useComp
        ? this.correctedSource(index, face, opts.comp, opts.gain ?? 1)
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

    this.textures[index].needsUpdate = true;
    this.versions[index]++;
    this.listeners.forEach((cb) => cb(index));
    return true;
  }

  /**
   * 导出前算一遍需要多大增益：扫一遍每张源图，看补偿之后有没有颜色顶到天花板。
   * 没有就返回 1，一切照旧、零风险；有才启用增益。
   */
  measureGain(faces: FaceState[], sides: number, comp: ColorComp, bgColor: string): number {
    if (isIdentity(comp)) return 1;
    const probe = document.createElement('canvas');
    const ctx = probe.getContext('2d', { willReadFrequently: true })!;
    let gain = 1;
    for (let i = 0; i < sides; i++) {
      const src = faces[i].source;
      if (!src) continue;
      const k = Math.min(1, 512 / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * k));
      const h = Math.max(1, Math.round(src.height * k));
      probe.width = w;
      probe.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      gain = Math.max(
        gain,
        requiredGain(comp, (cb) => {
          for (let p = 0; p < d.length; p += 4) cb(d[p], d[p + 1], d[p + 2]);
        }),
      );
    }
    const bg = /^#?([0-9a-f]{6})$/i.exec(bgColor.trim());
    if (bg) {
      const n = parseInt(bg[1], 16);
      gain = Math.max(gain, requiredGain(comp, (cb) => cb((n >> 16) & 255, (n >> 8) & 255, n & 255)));
    }
    return gain;
  }

  bakeAll(faces: FaceState[], opts: BakeOptions, force = false): number {
    let n = 0;
    for (let i = 0; i < MAX_SIDES; i++) {
      if (this.bake(i, faces[i], opts, force)) n++;
    }
    return n;
  }

  /** 用 PNG 实际编码体积估算导出文件大小（USDZ 里贴图就是 PNG，且不再压缩） */
  async estimateBytes(sides: number): Promise<number> {
    let total = 4096; // usda 文本 + zip 头的粗略量级
    const jobs: Promise<number>[] = [];
    for (let i = 0; i < sides; i++) {
      const canvas = this.canvases[i];
      jobs.push(
        new Promise<number>((resolve) => {
          canvas.toBlob((b) => resolve(b ? b.size : 0), 'image/png', 1);
        }),
      );
    }
    const sizes = await Promise.all(jobs);
    for (const s of sizes) total += s;
    return total;
  }
}
