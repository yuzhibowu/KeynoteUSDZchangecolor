import { unzipSync } from 'fflate';
import { packUsdz } from './usdzExtent';
import { yieldToBrowser } from './yieldToBrowser';
import { fixUsda, resolveInPackage, type CheckReport, type TextureInfo } from './check';

/**
 * 体检的「导出」这一步：把能修的修掉、把贴图瘦下来、按 usdz 规范重新打包。
 *
 * 瘦身两件事：
 * - 超过上限的贴图等比缩小（幻灯片上一个模型占不到半屏，4K 贴图纯属浪费显存）；
 * - 不透明的 PNG 转成 JPEG。「不透明」要真解码看 alpha 通道，不能只看文件头 ——
 *   PNG 头里声明了 alpha 的图常常整张都是 255。用在 opacity 上的、法线贴图，一律不转。
 * 转格式要改扩展名，文本图层里的引用跟着改；二进制图层里的路径改不了（token 表是压缩的），
 * 所以只被二进制引用的贴图只缩不转。
 */

export type SlimOptions = {
  /** 贴图最长边上限，0 = 不限 */
  maxSize: number;
  /** 不透明 PNG 转 JPEG */
  jpegOpaque: boolean;
  /** JPEG 质量 0–1 */
  quality: number;
};

export const DEFAULT_SLIM: SlimOptions = { maxSize: 2048, jpegOpaque: true, quality: 0.92 };

export type SlimTexture = {
  name: string;
  newName: string;
  before: number;
  after: number;
  size: string;
  /** 做了什么：「缩到 2048 · 转 JPEG」/「没动」/ 为什么没动 */
  action: string;
};

export type SlimReport = {
  textures: SlimTexture[];
  /** finding id → 修了几处 */
  fixes: Record<string, number>;
  bytesBefore: number;
  bytesAfter: number;
};

const IMAGE = /\.(png|jpe?g)$/i;
const USD_TEXT = /\.usda$/i;

/**
 * 粗估导出后多大，给报告开头那句「能压到大约多少」用。
 * 缩小按面积比；转 JPEG 按每像素 0.4 字节（质量 0.9 上下的经验值）。声明了 alpha 的 PNG
 * 不知道是不是真透明，按不转算 —— 宁可估大。
 */
export function estimateSlim(check: CheckReport, opts: SlimOptions): number {
  let textures = 0;
  for (const t of check.textures) {
    const w = t.width ?? 0;
    const h = t.height ?? 0;
    const k = opts.maxSize > 0 && Math.max(w, h) > opts.maxSize ? opts.maxSize / Math.max(w, h) : 1;
    const toJpeg = opts.jpegOpaque && t.format === 'png' && !t.alphaChannel && !t.roles.includes('normal') && !t.roles.includes('opacity') && !t.binaryRef;
    const est = toJpeg ? w * h * k * k * 0.4 : t.bytes * k * k;
    textures += Math.min(t.bytes, est);
  }
  return check.totalBytes - check.textureBytes + textures;
}

async function decode(bytes: Uint8Array, format: string): Promise<ImageBitmap | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: format === 'png' ? 'image/png' : 'image/jpeg' });
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** 整张 alpha 是不是都满的：满的就是不透明，转 JPEG 不丢东西 */
function fullyOpaque(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

function encode(canvas: HTMLCanvasElement, mime: 'image/png' | 'image/jpeg', quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null),
      mime,
      mime === 'image/jpeg' ? quality : undefined,
    );
  });
}

async function slimTexture(
  bytes: Uint8Array,
  info: TextureInfo,
  opts: SlimOptions,
): Promise<{ bytes: Uint8Array; newName: string; action: string }> {
  const keep = (why: string) => ({ bytes, newName: info.name, action: why });
  if (info.format === 'other') return keep('不是 PNG / JPEG，没动');
  const w = info.width ?? 0;
  const h = info.height ?? 0;
  const needScale = opts.maxSize > 0 && Math.max(w, h) > opts.maxSize;
  const isNormal = info.roles.includes('normal');
  const usesOpacity = info.roles.includes('opacity');
  const wantJpeg = opts.jpegOpaque && info.format === 'png' && !isNormal && !usesOpacity && !info.binaryRef;
  if (!needScale && !wantJpeg) {
    if (opts.jpegOpaque && info.format === 'png') {
      if (isNormal) return keep('法线贴图，留 PNG');
      if (usesOpacity) return keep('用在透明度上，留 PNG');
      if (info.binaryRef) return keep('二进制图层引用的，换不了扩展名');
    }
    return keep('没动');
  }
  const bmp = await decode(bytes, info.format);
  if (!bmp) return keep('解码不了，没动');
  const k = needScale ? opts.maxSize / Math.max(bmp.width, bmp.height) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const toJpeg = wantJpeg && (!info.alphaChannel || fullyOpaque(ctx, canvas.width, canvas.height));
  const mime = toJpeg ? 'image/jpeg' : info.format === 'png' ? 'image/png' : 'image/jpeg';
  const out = await encode(canvas, mime, opts.quality);
  if (!out) return keep('编码失败，没动');
  const actions: string[] = [];
  if (needScale) actions.push(`缩到 ${Math.max(canvas.width, canvas.height)}`);
  if (toJpeg) actions.push('转 JPEG');
  else if (wantJpeg && info.alphaChannel) actions.push('有真透明，留 PNG');
  // 只是转格式却没变小，就别换了
  if (!needScale && out.length >= bytes.length) return keep('转了也不比原来小，没动');
  const newName = toJpeg ? info.name.replace(/\.png$/i, '.jpg') : info.name;
  return { bytes: out, newName, action: actions.join(' · ') };
}

/** 文本图层里对某张贴图的引用改成新名字 */
function renameRefs(layer: string, text: string, renames: Map<string, string>): string {
  if (renames.size === 0) return text;
  return text.replace(/@([^@\n]+)@/g, (whole, ref: string) => {
    const resolved = resolveInPackage(layer, ref);
    const to = renames.get(resolved);
    if (!to) return whole;
    // 只换扩展名那一截，前面怎么写的（./、相对目录）原样保留
    return `@${ref.replace(/\.png$/i, to.slice(to.lastIndexOf('.')))}@`;
  });
}

export async function slimUsdz(
  buf: ArrayBuffer,
  check: CheckReport,
  opts: SlimOptions,
  onProgress?: (msg: string) => void,
): Promise<{ bytes: Uint8Array; report: SlimReport }> {
  const src = new Uint8Array(buf);
  const entries = unzipSync(src);
  let names = Object.keys(entries);
  // 根图层不在第一位、又只有一个图层：挪到第一位
  const layers = names.filter((n) => /\.usd[ac]?$/i.test(n));
  if (layers.length === 1 && names[0] !== layers[0]) names = [layers[0], ...names.filter((n) => n !== layers[0])];
  const rootName = names[0];

  const out: Record<string, Uint8Array> = {};
  const fixes: Record<string, number> = {};
  const textures: SlimTexture[] = [];
  const renames = new Map<string, string>();
  const infoOf = new Map(check.textures.map((t) => [t.name, t]));

  // 先处理贴图，拿到改名表，再改文本图层里的引用
  const images = names.filter((n) => IMAGE.test(n));
  let done = 0;
  for (const name of images) {
    onProgress?.(`正在处理贴图 ${++done}/${images.length}…`);
    await yieldToBrowser();
    const data = entries[name];
    const info = infoOf.get(name);
    if (!info) {
      out[name] = data;
      continue;
    }
    const r = await slimTexture(data, info, opts);
    if (r.newName !== name) renames.set(name, r.newName);
    out[r.newName] = r.bytes;
    textures.push({
      name,
      newName: r.newName,
      before: data.length,
      after: r.bytes.length,
      size: info.width && info.height ? `${info.width}×${info.height}` : '?',
      action: r.action,
    });
  }

  onProgress?.('正在改写图层…');
  await yieldToBrowser();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  for (const name of names) {
    if (IMAGE.test(name)) continue;
    const data = entries[name];
    if (USD_TEXT.test(name)) {
      const f = fixUsda(dec.decode(data), name === rootName);
      for (const [k, v] of Object.entries(f.fixes)) fixes[k] = (fixes[k] ?? 0) + v;
      out[name] = enc.encode(renameRefs(name, f.text, renames));
      continue;
    }
    out[name] = data;
  }
  if (check.zip.compressed > 0) fixes['zip-compressed'] = check.zip.compressed;
  if (check.zip.misaligned > 0) fixes['zip-align'] = check.zip.misaligned;
  if (layers.length === 1 && Object.keys(entries)[0] !== layers[0]) fixes.root = 1;

  // 按原顺序打包（改了名的贴图占原来的位置）
  const ordered: Record<string, Uint8Array> = {};
  for (const name of names) {
    const key = renames.get(name) ?? name;
    if (out[key]) ordered[key] = out[key];
  }
  const bytes = packUsdz(ordered);
  return {
    bytes,
    report: {
      textures: textures.sort((a, b) => b.before - a.before),
      fixes,
      bytesBefore: src.length,
      bytesAfter: bytes.length,
    },
  };
}
