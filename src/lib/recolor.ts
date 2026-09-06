import { unzipSync } from 'fflate';
import { applyForwardToImageData, applyToImageData, compensateToLinear, isIdentity, linearToSrgb, type ColorComp } from './color';
import { packUsdz } from './usdzExtent';
import { yieldToBrowser } from './yieldToBrowser';
import { normalizeUsda } from './usdaNormalize';

/**
 * 给一个**已有的** usdz 做颜色校正。
 *
 * 和「生成模型」那条路走的是同一套补偿，只是对象换成了别人做好的文件：
 * 拆开包 → 每张贴图逐像素反向补偿 → 材质里写死的纯色也补一遍 →
 * 按我们标定时的条件补上自发光 → 原样打回去。
 */

/**
 * 一张贴图的三联对照（缩略图 dataURL）。
 *
 * 比的不是「原图 vs 补偿后的半成品」—— 那个半成品本来就不是给人看的，
 * 看着又暗又怪，对不上任何直觉。比的是**你在 Keynote 里会看到什么**：
 * 不校正会变成什么样、校正之后又会是什么样。
 */
export type TexturePreview = {
  name: string;
  /** 你的原图 */
  source: string;
  /** 不校正：Keynote 会把它显示成这样 */
  before: string;
  /** 校正之后：Keynote 会把它显示成这样，应该和原图基本一致 */
  after: string;
};

export type RecolorReport = {
  /** 贴图的前后对照，给界面拿去并排显示 */
  previews: TexturePreview[];
  /** 写死的纯色的前后对照，十六进制 */
  swatches: { before: string; after: string }[];
  /** 改了几张贴图 */
  textures: number;
  /** 改了几处写死的纯色 */
  colors: number;
  /** 补了几处自发光 */
  emissive: number;
  /** 包里有二进制的 .usdc —— 材质那部分动不了，只能改贴图 */
  binary: string[];
  /** 认不出、原样带过的文件 */
  skipped: string[];
};

const IMAGE = /\.(png|jpe?g)$/i;

/** 数字格式和 USD 里常见的写法保持一致，别把 1 写成 1.0000000 那种噪声 */
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** 缩略图最长边，够看颜色就行，别把几兆的 dataURL 塞进内存 */
const PREVIEW_MAX = 320;

/**
 * 把「Keynote 会怎么显示它」算出来 —— 正向模型，和反解用的是同一份校准。
 * 只在缩略图上跑（十万来个像素），全尺寸图上逐像素跑没必要也太慢。
 */
function predictOnThumb(dataUrl: string, comp: ColorComp): Promise<string> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.width;
      c.height = im.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      // 走 LUT，别逐像素跑 RBF —— 一张缩略图五万多像素，
      // 每个都过一遍 70 个高斯基的话要一两秒，四张图来回八次就是十几秒
      applyForwardToImageData(d.data, comp);
      ctx.putImageData(d, 0, 0);
      resolve(c.toDataURL('image/png'));
    };
    im.onerror = () => resolve(dataUrl);
    im.src = dataUrl;
  });
}

function thumb(canvas: HTMLCanvasElement): string {
  const k = Math.min(1, PREVIEW_MAX / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * k));
  c.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function linearToHex(r: number, g: number, b: number): string {
  const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255)));
  return '#' + [to255(r), to255(g), to255(b)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

async function recolorImage(
  bytes: Uint8Array,
  name: string,
  comp: ColorComp,
): Promise<{ bytes: Uint8Array; preview: TexturePreview }> {
  const mime = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const source = thumb(canvas);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyToImageData(img.data, comp);
  ctx.putImageData(img, 0, 0);
  const written = thumb(canvas);
  const preview: TexturePreview = {
    name,
    source,
    // 不校正 = Keynote 直接拿原图去显示
    before: await predictOnThumb(source, comp),
    // 校正后 = Keynote 拿补偿过的那张去显示，应该正好落回原图
    after: await predictOnThumb(written, comp),
  };
  // **原样保留扩展名对应的格式**：usda 里是按文件名引用的，
  // 把 .jpg 换成 PNG 字节，有些读取器会按扩展名挑解码器，直接读不出来。
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, mime === 'image/jpeg' ? 0.95 : 1));
  if (!out) return { bytes, preview };
  return { bytes: new Uint8Array(await out.arrayBuffer()), preview };
}

/**
 * 处理一份 usda 文本：补偿写死的纯色，并按标定条件补上自发光。
 *
 * 为什么一定要补自发光：那份校准档是在「灯光开着 + 补光拉满」下标出来的，
 * 只改像素、不补自发光，等于换了一套响应条件，补偿量就对不上了。
 */
export function recolorUsda(
  usda: string,
  comp: ColorComp,
): { text: string; colors: number; emissive: number; swatches: { before: string; after: string }[] } {
  let colors = 0;
  let emissive = 0;
  const swatches: { before: string; after: string }[] = [];

  // 1) 写死的漫反射色。USD 里存的是线性值，先转回 sRGB 才能进补偿
  let text = usda.replace(
    /color3f inputs:diffuseColor = \(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)/g,
    (whole, r: string, g: string, b: string) => {
      const before = linearToHex(+r, +g, +b);
      const lin = compensateToLinear(before, comp);
      if (!lin) return whole;
      colors++;
      const after = linearToHex(lin[0], lin[1], lin[2]);
      // 同一个颜色可能在文件里出现很多次，只留不重复的，最多 24 个
      if (swatches.length < 24 && !swatches.some((s) => s.before === before)) {
        swatches.push({ before, after });
      }
      return `color3f inputs:diffuseColor = (${num(lin[0])}, ${num(lin[1])}, ${num(lin[2])})`;
    },
  );

  // 2) 每个 PreviewSurface 补自发光：接了贴图的就连同一张，纯色的就写同一个值。
  //    已经有 emissiveColor 的不动 —— 那是作者自己要的效果。
  text = text.replace(/def Shader "[^"]*"\s*\{[^}]*\}/g, (block) => {
    if (!block.includes('UsdPreviewSurface')) return block;
    if (block.includes('inputs:emissiveColor')) return block;
    const conn = /color3f inputs:diffuseColor\.connect = ([^\n]+)/.exec(block);
    const solid = /color3f inputs:diffuseColor = (\([^)]*\))/.exec(block);
    const line = conn
      ? `\n\t\t\tcolor3f inputs:emissiveColor.connect = ${conn[1].trim()}`
      : solid
        ? `\n\t\t\tcolor3f inputs:emissiveColor = ${solid[1]}`
        : null;
    if (!line) return block;
    emissive++;
    return block.replace(/\n(\s*)token outputs:surface/, `${line}\n$1token outputs:surface`);
  });

  return { text, colors, emissive, swatches };
}

/**
 * 把包里的 usda 排版规范化，好让 three 的 USD 加载器读得进去（用于预览渲染）。
 * 只动排版不动语义，所以拿它去渲染和拿原包去渲染是同一个东西。
 */
export function normalizeUsdzForLoader(buf: ArrayBuffer): ArrayBuffer {
  try {
    const entries = unzipSync(new Uint8Array(buf));
    const out: Record<string, Uint8Array> = {};
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    for (const name of Object.keys(entries)) {
      out[name] = /\.usda?$/i.test(name)
        ? enc.encode(normalizeUsda(dec.decode(entries[name])))
        : entries[name];
    }
    return packUsdz(out).slice().buffer as ArrayBuffer;
  } catch {
    return buf; // 规范化失败就用原样的，大不了渲染不出来
  }
}

export async function recolorUsdz(
  buf: ArrayBuffer,
  comp: ColorComp,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; report: RecolorReport }> {
  const src = new Uint8Array(buf);
  const report: RecolorReport = {
    previews: [],
    swatches: [],
    textures: 0,
    colors: 0,
    emissive: 0,
    binary: [],
    skipped: [],
  };
  if (isIdentity(comp)) throw new Error('当前目标还没有校准档，先在「颜色」里选一个校准过的目标');

  const entries = unzipSync(src);
  const out: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  const images = Object.keys(entries).filter((n) => IMAGE.test(n));
  let done = 0;
  for (const name of Object.keys(entries)) {
    const data = entries[name];
    if (IMAGE.test(name)) {
      const r = await recolorImage(data, name, comp);
      out[name] = r.bytes;
      report.previews.push(r.preview);
      report.textures++;
      onProgress?.(++done, images.length);
      // 4K 贴图一张要好几秒，中间把主线程让出去，界面才不会像死了一样
      await yieldToBrowser();
      continue;
    }
    if (/\.usda$/i.test(name)) {
      const r = recolorUsda(dec.decode(data), comp);
      out[name] = enc.encode(r.text);
      report.colors += r.colors;
      report.emissive += r.emissive;
      for (const sw of r.swatches) {
        if (report.swatches.length < 24 && !report.swatches.some((x) => x.before === sw.before)) {
          report.swatches.push(sw);
        }
      }
      continue;
    }
    // .usdc 是二进制的 crate 格式，没有解析器就动不了里面的材质。
    // 贴图是独立文件，照样能补 —— 所以不是全无用处，但要如实告诉用户。
    if (/\.usdc?$/i.test(name)) report.binary.push(name);
    else report.skipped.push(name);
    out[name] = data;
  }

  return { bytes: packUsdz(out), report };
}
