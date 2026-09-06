import { unzipSync } from 'fflate';
import { applyToImageData, compensateToLinear, isIdentity, linearToSrgb, type ColorComp } from './color';
import { packUsdz } from './usdzExtent';

/**
 * 给一个**已有的** usdz 做颜色校正。
 *
 * 和「生成模型」那条路走的是同一套补偿，只是对象换成了别人做好的文件：
 * 拆开包 → 每张贴图逐像素反向补偿 → 材质里写死的纯色也补一遍 →
 * 按我们标定时的条件补上自发光 → 原样打回去。
 */

export type RecolorReport = {
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

function linearToHex(r: number, g: number, b: number): string {
  const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255)));
  return '#' + [to255(r), to255(g), to255(b)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

async function recolorImage(bytes: Uint8Array, name: string, comp: ColorComp): Promise<Uint8Array> {
  const mime = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyToImageData(img.data, comp);
  ctx.putImageData(img, 0, 0);
  // **原样保留扩展名对应的格式**：usda 里是按文件名引用的，
  // 把 .jpg 换成 PNG 字节，有些读取器会按扩展名挑解码器，直接读不出来。
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, mime === 'image/jpeg' ? 0.95 : 1));
  if (!out) return bytes;
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * 处理一份 usda 文本：补偿写死的纯色，并按标定条件补上自发光。
 *
 * 为什么一定要补自发光：那份校准档是在「灯光开着 + 补光拉满」下标出来的，
 * 只改像素、不补自发光，等于换了一套响应条件，补偿量就对不上了。
 */
export function recolorUsda(usda: string, comp: ColorComp): { text: string; colors: number; emissive: number } {
  let colors = 0;
  let emissive = 0;

  // 1) 写死的漫反射色。USD 里存的是线性值，先转回 sRGB 才能进补偿
  let text = usda.replace(
    /color3f inputs:diffuseColor = \(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)/g,
    (whole, r: string, g: string, b: string) => {
      const lin = compensateToLinear(linearToHex(+r, +g, +b), comp);
      if (!lin) return whole;
      colors++;
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

  return { text, colors, emissive };
}

export async function recolorUsdz(
  buf: ArrayBuffer,
  comp: ColorComp,
): Promise<{ bytes: Uint8Array; report: RecolorReport }> {
  const src = new Uint8Array(buf);
  const report: RecolorReport = { textures: 0, colors: 0, emissive: 0, binary: [], skipped: [] };
  if (isIdentity(comp)) throw new Error('当前目标还没有校准档，先在「颜色」里选一个校准过的目标');

  const entries = unzipSync(src);
  const out: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  for (const name of Object.keys(entries)) {
    const data = entries[name];
    if (IMAGE.test(name)) {
      out[name] = await recolorImage(data, name, comp);
      report.textures++;
      continue;
    }
    if (/\.usda$/i.test(name)) {
      const r = recolorUsda(dec.decode(data), comp);
      out[name] = enc.encode(r.text);
      report.colors += r.colors;
      report.emissive += r.emissive;
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
