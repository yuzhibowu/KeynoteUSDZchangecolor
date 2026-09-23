import { unzipSync, zipSync } from 'fflate';

/**
 * 给导出的 usdz 补上每个 Mesh 的 `extent`（包围盒）。
 *
 * three 的 USDZExporter **一个 extent 都不写**。extent 是 UsdGeomBoundable 的标准属性，
 * Apple 的 usdchecker 会因为缺它报警告；渲染器拿不到包围盒就只能自己猜，
 * 猜出来的框可能把模型切掉一块 —— 实测在 Keynote 里就是被一个方框当蒙版截了。
 *
 * 做法是把 usdz（本质是个 zip）拆开，对每个 .usda 里的 `def Mesh`，
 * 从它自己的 `point3f[] points` 算出真实包围盒，插一行 extent 回去，再原样打包。
 */

/**
 * 把不起作用的 clearcoat / ior 从材质里删掉。
 *
 * three 的导出器只要材质是 MeshPhysicalMaterial 就一定会写这三行，
 * 哪怕 clearcoat 是 0。按 UsdPreviewSurface 的规范它们是无害的，
 * 但这是我们的导出文件和「在 Keynote 里确认能显示金属」的最小对照之间
 * **唯一剩下的差异** —— 排查到最后只剩这一条，那就别留着。
 * clearcoat 真的大于 0 时（亮面塑料、铜版纸）原样保留。
 *
 * **数字后面必须跟着换行**（下面那个 `(?=\n)`）。少了它就是个真事故：
 * 2026-09-23 给卡片背面挂「塑料」（clearcoat = 0.6）时发现，`= 0` 会匹配上 `0.6` 的那个 0，
 * 于是整行被删掉、只剩个孤零零的 `.6` 粘到上一行末尾 —— 文件里变成
 * `float inputs:opacity = 1.6`（不合法，opacity 最大就是 1），而塑料的清漆被整条吞掉，
 * 导出之后根本不是塑料。玻璃（clearcoat = 1）侥幸躲过，因为 `1` 不匹配 `0`。
 */
export function stripInertClearcoat(usda: string): string {
  return usda.replace(/(\n[^\n]*float inputs:clearcoat = 0(?:\.0+)?(?=\n))((?:\n[^\n]*float inputs:clearcoatRoughness = [^\n]*)?)((?:\n[^\n]*float inputs:ior = [^\n]*)?)/g, '');
}

/** 从一段 usda 文本里，给每个 def Mesh 块补 extent */
export function addExtents(usda: string): string {
  // points 形如：point3f[] points = [(x, y, z), (x, y, z), ...]
  const meshRe = /(def Mesh "[^"]*"\s*\{)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = meshRe.exec(usda)) !== null) {
    const blockStart = m.index + m[0].length;
    const block = readBlock(usda, blockStart);
    if (block === null) continue;
    const body = usda.slice(blockStart, block.end);
    if (/\bextent\s*=/.test(body)) continue; // 已经有了就不动
    const box = boundsOf(body);
    if (!box) continue;
    const line = `\n\t\tfloat3[] extent = [(${fmt(box.min)}), (${fmt(box.max)})]`;
    out += usda.slice(last, blockStart) + line;
    last = blockStart;
  }
  return out + usda.slice(last);
}

/** 从 `{` 之后开始，找到与之配对的 `}` */
function readBlock(s: string, start: number): { end: number } | null {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { end: i };
    }
  }
  return null;
}

function boundsOf(body: string): { min: number[]; max: number[] } | null {
  const m = /point3f\[\]\s+points\s*=\s*\[([\s\S]*?)\]/.exec(body);
  if (!m) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pt = /\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)/g;
  let p: RegExpExecArray | null;
  let n = 0;
  while ((p = pt.exec(m[1])) !== null) {
    for (let c = 0; c < 3; c++) {
      const v = Number(p[c + 1]);
      if (!Number.isFinite(v)) return null;
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
    n++;
  }
  return n > 0 ? { min, max } : null;
}

const fmt = (v: number[]) => v.map((x) => (Math.round(x * 1e6) / 1e6).toString()).join(', ');

/**
 * 拆开 usdz、补 extent、再按 usdz 的要求打回去。
 *
 * usdz 就是个 zip，但有两条硬要求：**不能压缩**（STORED），
 * 且每个文件的数据起始偏移要 64 字节对齐 —— 靠往 extra 字段里塞 padding 实现。
 * 这两条和 three 的 USDZExporter 里做的是同一件事，照搬它的算法。
 */
export function withExtents(usdz: ArrayBuffer | Uint8Array): Uint8Array {
  const src = usdz instanceof Uint8Array ? usdz : new Uint8Array(usdz);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(src);
  } catch {
    return src; // 拆不开就原样返回，宁可少一个 extent 也不能导出一个坏文件
  }

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const plain: Record<string, Uint8Array> = {};
  for (const name of Object.keys(entries)) {
    const data = entries[name];
    plain[name] = name.endsWith('.usda')
      ? enc.encode(stripInertClearcoat(addExtents(dec.decode(data))))
      : data;
  }

  try {
    return packUsdz(plain);
  } catch {
    return src;
  }
}

/**
 * 按 usdz 的要求打包：**不压缩**（STORED），且每个文件的数据起始偏移
 * 要 64 字节对齐 —— 靠往 extra 字段里塞 padding 实现。算法和 three 的
 * USDZExporter 里那段一致。
 */
export function packUsdz(plain: Record<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }]> = {};
  let offset = 0;
  for (const name of Object.keys(plain)) {
    const file = plain[name];
    offset += 34 + name.length;
    const mod = offset & 63;
    files[name] = mod !== 4 ? [file, { extra: { [USDZ_ALIGN_EXTRA_ID]: new Uint8Array(64 - mod) } }] : file;
    offset = file.length;
  }
  return zipSync(files as Parameters<typeof zipSync>[0], { level: 0 });
}

/**
 * 对齐用的 zip 扩展字段 ID。
 *
 * `0x1986` 是 Pixar 的 usdzip 写的那个，苹果自家工具产出的 usdz 里也是它。
 * three 的导出器随手挑了 12345 —— 那个值我们的模型在 Keynote 里能用，
 * 但既然官方有约定的 ID，就没有理由不跟着走。
 */
const USDZ_ALIGN_EXTRA_ID = 0x1986;
