import * as THREE from 'three';
import { unzipSync } from 'fflate';
import { addExtents } from './usdzExtent';
import { fixXformOpNamespaces } from './usdaCompat';
// @ts-expect-error 从 three r185 搬过来的解析器，没有类型声明
import { USDCParser } from '../vendor/usd/USDCParser.js';

/**
 * USDZ 体检：拿一个现成的 usdz，按这个项目攒下来的 Keynote 实测规律逐条过一遍，
 * 报出「在 Keynote 里会出什么问题」，能顺手修的标出来（修在 slim.ts 里做）。
 *
 * 这里只做**分析**，全是同步的纯函数，方便测试；不解码图片（图片尺寸从文件头直接读）。
 * 每一条规则都写明出处：是本项目实测、还是苹果的功能支持表（developer.apple.com
 * 「Validating feature support for USD files」）。没有出处的规则别往里加。
 */

export type Severity = 'bad' | 'warn' | 'info';

export type Finding = {
  id: string;
  severity: Severity;
  /** 一句话说是什么 */
  title: string;
  /** 为什么、会怎样、怎么办 */
  detail: string;
  /** 导出时会顺手修掉 */
  fixable: boolean;
  count?: number;
};

export type TextureInfo = {
  name: string;
  bytes: number;
  format: 'png' | 'jpeg' | 'other';
  width: number | null;
  height: number | null;
  /** PNG 头里声明了 alpha 通道（是否真用到要解码才知道） */
  alphaChannel: boolean;
  /** 被哪些材质输入用到：normal / diffuseColor / ... */
  roles: string[];
  /** 只在二进制图层里被引用：改不了扩展名，只能缩 */
  binaryRef: boolean;
  /** 没有任何图层引用它 */
  unreferenced: boolean;
};

export type LayerInfo = { name: string; binary: boolean; bytes: number };

export type CheckReport = {
  findings: Finding[];
  textures: TextureInfo[];
  layers: LayerInfo[];
  meta: { defaultPrim: string | null; upAxis: string; metersPerUnit: number; rootBinary: boolean };
  totalBytes: number;
  textureBytes: number;
  /** 动画概况 */
  animation: { xformOps: number; materialOps: number; vertex: number; skeletal: number };
  /** 包的问题（压缩 / 对齐），重新打包就好 */
  zip: { compressed: number; misaligned: number };
};

const IMAGE = /\.(png|jpe?g)$/i;
const USD_TEXT = /\.usda$/i;
const USD_ANY = /\.usd[ac]?$/i;
const CRATE_MAGIC = 'PXR-USDC';

function isCrate(data: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(data.subarray(0, 8)) === CRATE_MAGIC;
}

// ---------- zip 结构 ----------

/**
 * usdz 要求包内文件不压缩、数据起始 64 字节对齐。fflate 解出来看不出这些，自己读 zip 头：
 * 从末尾找中央目录，逐条读压缩方式和本地头偏移，再到本地头算数据偏移。
 */
export function inspectZip(src: Uint8Array): { compressed: number; misaligned: number; order: string[] } {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const order: string[] = [];
  let compressed = 0;
  let misaligned = 0;
  // End of central directory：签名 0x06054b50，最短 22 字节，注释最长 65535
  let eocd = -1;
  for (let i = src.length - 22; i >= Math.max(0, src.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { compressed, misaligned, order };
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count && p + 46 <= src.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(src.subarray(p + 46, p + 46 + nameLen));
    order.push(name);
    if (method !== 0) compressed++;
    if (local + 30 <= src.length && dv.getUint32(local, true) === 0x04034b50) {
      const ln = dv.getUint16(local + 26, true);
      const le = dv.getUint16(local + 28, true);
      if ((local + 30 + ln + le) % 64 !== 0) misaligned++;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { compressed, misaligned, order };
}

// ---------- 图片文件头 ----------

/** 不解码，只读文件头里的尺寸。PNG 还能看出有没有 alpha 通道 */
export function imageHeader(data: Uint8Array): { format: 'png' | 'jpeg' | 'other'; width: number | null; height: number | null; alphaChannel: boolean } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length > 26 && dv.getUint32(0) === 0x89504e47) {
    const colorType = data[25];
    return { format: 'png', width: dv.getUint32(16), height: dv.getUint32(20), alphaChannel: colorType === 4 || colorType === 6 };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    // 扫 marker 找 SOF0 / SOF1 / SOF2
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { format: 'jpeg', width: dv.getUint16(i + 7), height: dv.getUint16(i + 5), alphaChannel: false };
      }
      i += 2 + len;
    }
    return { format: 'jpeg', width: null, height: null, alphaChannel: false };
  }
  return { format: 'other', width: null, height: null, alphaChannel: false };
}

// ---------- 文本图层 ----------

export type TextLayerFacts = {
  defaultPrim: string | null;
  upAxis: string | null;
  metersPerUnit: number | null;
  topPrims: string[];
  suffixedOps: number;
  rotateXYZAnimated: number;
  xformAnimated: number;
  materialAnimated: number;
  vertexAnimated: number;
  skeletal: number;
  doubleSided: number;
  meshes: number;
  meshesWithoutExtent: number;
  meshesWithoutSubdiv: number;
  lights: number;
  cameras: number;
  materialX: number;
  /** 引用的资源路径（去掉 @ 和锚点） */
  assets: string[];
  /** 贴图路径 → 用在哪些材质输入上 */
  textureRoles: Record<string, string[]>;
};

/** 把一段块（从 `{` 起）读到配对的 `}`，返回结束位置 */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

export function analyzeUsda(text: string): TextLayerFacts {
  const header = /^#usda[^\n]*\n\s*\(([\s\S]*?)\n\)/.exec(text);
  const h = header ? header[1] : '';
  const dp = /defaultPrim\s*=\s*"([^"]+)"/.exec(h);
  const up = /upAxis\s*=\s*"([^"]+)"/.exec(h);
  const mpu = /metersPerUnit\s*=\s*([\d.eE+-]+)/.exec(h);
  const topPrims = [...text.matchAll(/^(?:def|over|class)\b[^\n"]*"([^"\n]+)"/gm)].map((m) => m[1]);

  const suffixedOps = (text.match(
    /(?:double3|float3|float|double|quatf|quatd|matrix4d)\s+xformOp:(?:translate|rotateXYZ|rotateXYZW|rotateX|rotateY|rotateZ|scale|orient|transform):[A-Za-z_][A-Za-z0-9_]*/g,
  ) ?? []).length;
  const rotateXYZAnimated = (text.match(/xformOp:rotateXYZ(?::\w+)?\.timeSamples\s*=/g) ?? []).length;
  const xformAnimated = (text.match(/xformOp:\w+(?::\w+)?\.timeSamples\s*=/g) ?? []).length;
  const vertexAnimated = (text.match(/\bpoints\.timeSamples\s*=/g) ?? []).length;
  const skeletal = (text.match(/def (?:Skeleton|SkelAnimation|SkelRoot)\b/g) ?? []).length;
  const doubleSided = (text.match(/\bdoubleSided\s*=\s*(?:1|true)\b/g) ?? []).length;
  const lights = (text.match(/def (?:DistantLight|SphereLight|DomeLight|RectLight|DiskLight|CylinderLight|GeometryLight)\b/g) ?? []).length;
  const cameras = (text.match(/def Camera\b/g) ?? []).length;
  const materialX = (text.match(/info:id\s*=\s*"ND_/g) ?? []).length + (text.match(/@[^@\n]*\.mtlx@/g) ?? []).length;

  // 材质 / 着色器块里的动画：Keynote 完全不认
  // Material 块里套着 Shader 块，只数各自直属的那层，别把 Shader 的算两遍
  let materialAnimated = 0;
  for (const m of text.matchAll(/def (?:Shader|Material) "[^"]*"[^{]*\{/g)) {
    const open = m.index + m[0].length - 1;
    let body = text.slice(open, blockEnd(text, open));
    const nested = /^[ \t]+(?:def|over|class)\b/m.exec(body.slice(1));
    if (nested) body = body.slice(0, nested.index + 1);
    materialAnimated += (body.match(/inputs:\w+\.timeSamples\s*=/g) ?? []).length;
  }

  // mesh：有没有 extent、subdivisionScheme
  let meshes = 0;
  let meshesWithoutExtent = 0;
  let meshesWithoutSubdiv = 0;
  for (const m of text.matchAll(/def Mesh "[^"]*"[^{]*\{/g)) {
    meshes++;
    const open = m.index + m[0].length - 1;
    const body = text.slice(open, blockEnd(text, open));
    if (!/\bextent\s*=/.test(body)) meshesWithoutExtent++;
    if (!/\bsubdivisionScheme\s*=/.test(body)) meshesWithoutSubdiv++;
  }

  const assets = [...text.matchAll(/@([^@\n]+)@/g)].map((m) => m[1]);

  // 贴图用在哪：先找 UsdUVTexture 着色器的 file，再看谁 connect 到它
  const textureRoles: Record<string, string[]> = {};
  const fileOf: Record<string, string> = {};
  for (const m of text.matchAll(/def Shader "([^"]*)"[^{]*\{/g)) {
    const open = m.index + m[0].length - 1;
    const body = text.slice(open, blockEnd(text, open));
    const f = /asset inputs:file\s*=\s*@([^@]+)@/.exec(body);
    if (f) fileOf[m[1]] = f[1];
  }
  for (const m of text.matchAll(/inputs:(\w+)\.connect\s*=\s*<[^>]*\/([^/>.]+)\.outputs:\w+>/g)) {
    const file = fileOf[m[2]];
    if (!file) continue;
    (textureRoles[file] ??= []).push(m[1]);
  }

  return {
    defaultPrim: dp ? dp[1] : null,
    upAxis: up ? up[1] : null,
    metersPerUnit: mpu ? Number(mpu[1]) : null,
    topPrims,
    suffixedOps,
    rotateXYZAnimated,
    xformAnimated,
    materialAnimated,
    vertexAnimated,
    skeletal,
    doubleSided,
    meshes,
    meshesWithoutExtent,
    meshesWithoutSubdiv,
    lights,
    cameras,
    materialX,
    assets,
    textureRoles,
  };
}

// ---------- 二进制图层 ----------

export type BinaryLayerFacts = Pick<
  TextLayerFacts,
  | 'defaultPrim' | 'upAxis' | 'metersPerUnit' | 'xformAnimated' | 'materialAnimated' | 'vertexAnimated'
  | 'skeletal' | 'doubleSided' | 'meshes' | 'meshesWithoutExtent' | 'meshesWithoutSubdiv' | 'lights' | 'cameras' | 'assets' | 'textureRoles' | 'rotateXYZAnimated'
> & { parsed: boolean };

const LIGHT_TYPES = new Set(['DistantLight', 'SphereLight', 'DomeLight', 'RectLight', 'DiskLight', 'CylinderLight', 'GeometryLight']);

export function analyzeUsdc(data: Uint8Array): BinaryLayerFacts {
  const facts: BinaryLayerFacts = {
    parsed: false,
    defaultPrim: null,
    upAxis: null,
    metersPerUnit: null,
    xformAnimated: 0,
    rotateXYZAnimated: 0,
    materialAnimated: 0,
    vertexAnimated: 0,
    skeletal: 0,
    doubleSided: 0,
    meshes: 0,
    meshesWithoutExtent: 0,
    meshesWithoutSubdiv: 0,
    lights: 0,
    cameras: 0,
    assets: [],
    textureRoles: {},
  };
  let specs: Record<string, { specType: number; fields: Record<string, unknown> }>;
  try {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    specs = (new USDCParser().parseData(buf) as { specsByPath: typeof specs }).specsByPath;
  } catch {
    return facts;
  }
  facts.parsed = true;
  const root = specs['/']?.fields ?? {};
  facts.defaultPrim = (root.defaultPrim as string | undefined) ?? null;
  facts.upAxis = (root.upAxis as string | undefined) ?? null;
  facts.metersPerUnit = typeof root.metersPerUnit === 'number' ? root.metersPerUnit : null;

  const primType: Record<string, string> = {};
  for (const [path, s] of Object.entries(specs)) {
    if (typeof s.fields.typeName === 'string' && !path.includes('.')) primType[path] = s.fields.typeName as string;
  }
  const isAnimated = (f: Record<string, unknown>) =>
    !!f.timeSamples || (f.default && typeof f.default === 'object' && 'times' in (f.default as object));
  const fileOf: Record<string, string> = {};
  for (const [path, s] of Object.entries(specs)) {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    if (dot > slash) {
      const prim = path.slice(0, dot);
      const attr = path.slice(dot + 1);
      const f = s.fields;
      const type = primType[prim];
      if (attr.startsWith('xformOp:') && isAnimated(f)) {
        facts.xformAnimated++;
        if (attr.startsWith('xformOp:rotateXYZ')) facts.rotateXYZAnimated++;
      }
      if ((type === 'Shader' || type === 'Material') && attr.startsWith('inputs:') && isAnimated(f)) facts.materialAnimated++;
      if (attr === 'points' && isAnimated(f)) facts.vertexAnimated++;
      if (attr === 'doubleSided' && f.default === true) facts.doubleSided++;
      if (attr === 'inputs:file' && typeof f.default === 'string') {
        facts.assets.push(f.default);
        fileOf[prim] = f.default;
      }
      if (attr.startsWith('inputs:') && Array.isArray(f.connectionPaths)) {
        for (const target of f.connectionPaths as string[]) {
          const tp = target.slice(0, target.lastIndexOf('.'));
          const file = fileOf[tp];
          if (file) (facts.textureRoles[file] ??= []).push(attr.slice('inputs:'.length));
        }
      }
      continue;
    }
    const type = primType[path];
    if (type === 'Mesh') {
      facts.meshes++;
      if (!specs[`${path}.extent`]) facts.meshesWithoutExtent++;
      if (!specs[`${path}.subdivisionScheme`]) facts.meshesWithoutSubdiv++;
    }
    if (type === 'Skeleton' || type === 'SkelAnimation' || type === 'SkelRoot') facts.skeletal++;
    if (type && LIGHT_TYPES.has(type)) facts.lights++;
    if (type === 'Camera') facts.cameras++;
    const refs = s.fields.references as { assetPath?: string }[] | undefined;
    if (Array.isArray(refs)) for (const r of refs) if (r && typeof r.assetPath === 'string') facts.assets.push(r.assetPath);
  }
  // connect 可能出现在 file 之前，补一轮
  for (const [path, s] of Object.entries(specs)) {
    const dot = path.lastIndexOf('.');
    if (dot < path.lastIndexOf('/')) continue;
    const attr = path.slice(dot + 1);
    if (!attr.startsWith('inputs:') || !Array.isArray(s.fields.connectionPaths)) continue;
    for (const target of s.fields.connectionPaths as string[]) {
      const file = fileOf[target.slice(0, target.lastIndexOf('.'))];
      if (!file) continue;
      const role = attr.slice('inputs:'.length);
      const list = (facts.textureRoles[file] ??= []);
      if (!list.includes(role)) list.push(role);
    }
  }
  for (const k of Object.keys(facts.textureRoles)) facts.textureRoles[k] = [...new Set(facts.textureRoles[k])];
  return facts;
}

// ---------- 整包 ----------

/** 把 usda 里的相对引用（`./textures/a.png`、`textures/a.png`）归成包内路径 */
export function resolveInPackage(fromLayer: string, ref: string): string {
  let path = ref.replace(/^\.\//, '');
  const anchor = path.indexOf('[');
  if (anchor >= 0) path = path.slice(0, anchor);
  if (path.startsWith('/')) return path.slice(1);
  const dir = fromLayer.includes('/') ? fromLayer.slice(0, fromLayer.lastIndexOf('/') + 1) : '';
  const parts = (dir + path).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

export function checkUsdz(buf: ArrayBuffer | Uint8Array): CheckReport {
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const findings: Finding[] = [];
  const zip = inspectZip(src);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(src);
  } catch {
    throw new Error('这个文件解不开，不是合法的 zip / usdz');
  }
  const names = zip.order.length ? zip.order : Object.keys(entries);
  const dec = new TextDecoder();

  const layers: LayerInfo[] = [];
  const textFacts: { name: string; facts: TextLayerFacts }[] = [];
  const binFacts: { name: string; facts: BinaryLayerFacts }[] = [];
  const images: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  const others: string[] = [];
  for (const name of names) {
    const data = entries[name];
    if (!data) continue;
    totalBytes += data.length;
    if (USD_ANY.test(name)) {
      const binary = !USD_TEXT.test(name) && isCrate(data);
      layers.push({ name, binary, bytes: data.length });
      if (binary) binFacts.push({ name, facts: analyzeUsdc(data) });
      else textFacts.push({ name, facts: analyzeUsda(dec.decode(data)) });
    } else if (IMAGE.test(name)) images[name] = data;
    else if (!/\/$/.test(name)) others.push(name);
  }

  const rootName = names[0] ?? '';
  const rootLayer = layers.find((l) => l.name === rootName) ?? null;
  const rootFacts = rootLayer
    ? rootLayer.binary
      ? binFacts.find((b) => b.name === rootName)!.facts
      : textFacts.find((t) => t.name === rootName)!.facts
    : null;

  if (!rootLayer) {
    findings.push({
      id: 'root',
      severity: 'bad',
      title: '包里第一个文件不是 USD 图层',
      detail: `usdz 规范要求第一个文件就是根图层，现在第一个是「${rootName}」。苹果的读取器按这条找根，找不到就整个不显示。${layers.length === 1 ? '包里只有一个图层，导出时会把它挪到第一位。' : '包里有多个图层，分不清哪个是根，得手动处理。'}`,
      fixable: layers.length === 1,
    });
  }
  if (rootLayer?.binary) {
    findings.push({
      id: 'root-binary',
      severity: 'info',
      title: '根图层是二进制 .usdc',
      detail: '材质里写死的颜色改不了（颜色校正只能改贴图）；加动效时会另写一层文本图层把它引用进来。贴图只能缩尺寸，不能换格式——路径写在二进制里，改扩展名会对不上。',
      fixable: false,
    });
  }
  if (zip.compressed > 0) {
    findings.push({
      id: 'zip-compressed',
      severity: 'bad',
      title: `${zip.compressed} 个文件在包里是压缩存储的`,
      detail: 'usdz 规范要求包内一律不压缩（STORED），苹果的读取器碰到压缩的文件直接失败。导出时会重新打包。',
      fixable: true,
      count: zip.compressed,
    });
  }
  if (zip.misaligned > 0) {
    findings.push({
      id: 'zip-align',
      severity: 'warn',
      title: `${zip.misaligned} 个文件的数据起点没有 64 字节对齐`,
      detail: 'usdz 规范要求每个文件的数据起点 64 字节对齐，读取器才能直接映射内存。Keynote 多半也能读，但不合规。导出时会重新打包。',
      fixable: true,
      count: zip.misaligned,
    });
  }

  const sum = <K extends keyof TextLayerFacts>(key: K): number =>
    textFacts.reduce((a, t) => a + (t.facts[key] as number), 0) +
    binFacts.reduce((a, b) => a + ((b.facts as unknown as Record<string, unknown>)[key] as number ?? 0), 0);

  if (rootFacts && !rootFacts.defaultPrim) {
    const first = 'topPrims' in rootFacts ? (rootFacts as TextLayerFacts).topPrims[0] : undefined;
    findings.push({
      id: 'default-prim',
      severity: 'warn',
      title: '根图层没有 defaultPrim',
      detail: `苹果的读取器按 defaultPrim 找要显示的东西，没有的话有些版本会显示空白。${first && !rootLayer?.binary ? `导出时会指到第一个 prim「${first}」。` : '二进制根图层改不了，得在建模软件里重导。'}`,
      fixable: !!first && !rootLayer?.binary,
    });
  }

  const suffixed = sum('suffixedOps');
  if (suffixed > 0) {
    findings.push({
      id: 'xformop-suffix',
      severity: 'bad',
      title: `${suffixed} 个 xformOp 带命名空间后缀`,
      detail: '本项目实测：带后缀的 xformOp（比如 xformOp:scale:motion）苹果会整层放弃，Keynote 里是一个带播放按钮的空方框。导出时去掉后缀。',
      fixable: true,
      count: suffixed,
    });
  }
  const rotXYZ = sum('rotateXYZAnimated');
  if (rotXYZ > 0) {
    findings.push({
      id: 'rotate-xyz-anim',
      severity: 'warn',
      title: `${rotXYZ} 段旋转动画用的是欧拉角 rotateXYZ`,
      detail: `本项目实测：rotateXYZ 的动画转到 360° Keynote 就不播了，苹果自家工具导出的旋转动画全是四元数 orient。${rootLayer?.binary ? '在二进制图层里，改不了。' : '导出时改写成 orient，逐帧翻成同号，插值走短路。'}`,
      fixable: textFacts.some((t) => t.facts.rotateXYZAnimated > 0),
      count: rotXYZ,
    });
  }
  const matAnim = sum('materialAnimated');
  if (matAnim > 0) {
    findings.push({
      id: 'material-anim',
      severity: 'warn',
      title: `${matAnim} 段材质动画（透明度 / 颜色 / 贴图参数）`,
      detail: '本项目实测：Keynote 对材质动画完全不认——opacity、emissiveColor、diffuseColor、贴图的 scale 加 timeSamples 全都不动，只有位移旋转缩放会播。淡入淡出、呼吸发光这类只能靠 Keynote 自己的构建。这些会静止在默认值上，没法修。',
      fixable: false,
      count: matAnim,
    });
  }
  const vertex = sum('vertexAnimated');
  if (vertex > 0) {
    findings.push({
      id: 'vertex-anim',
      severity: 'warn',
      title: `${vertex} 段顶点动画`,
      detail: '苹果功能支持表：RealityKit 不支持顶点动画（Storm / 光追才支持）。Keynote 里会静止在第一帧。改成骨骼动画才能播。',
      fixable: false,
      count: vertex,
    });
  }
  const xformAnim = sum('xformAnimated');
  const skeletal = sum('skeletal');
  if (xformAnim > 0 || skeletal > 0) {
    findings.push({
      id: 'anim-clock',
      severity: 'info',
      title: `带 ${xformAnim} 段变换动画${skeletal ? `、${skeletal} 个骨骼` : ''}`,
      detail: '本项目实测：Keynote 放映时所有 3D 动画的时钟从第一页起一起起跑，翻页不重置，构建入场也不重置。所以烘在文件里的「入场」只有放映从这页开始时才看得到；反过来，同一个模型放在连续几页上，翻页时动作是接着的，不会跳。',
      fixable: false,
    });
  }
  const noExtent = sum('meshesWithoutExtent');
  if (noExtent > 0) {
    const inText = textFacts.reduce((a, t) => a + t.facts.meshesWithoutExtent, 0);
    findings.push({
      id: 'extent',
      severity: 'warn',
      title: `${noExtent} 个 Mesh 没有包围盒 extent`,
      detail: `本项目实测：读取器拿不到包围盒只能自己猜，猜出来的框会把模型切掉一块（Keynote 里像被方框蒙版截了）。${inText ? `导出时按顶点算出来补上（${inText} 个在文本图层里${inText < noExtent ? '，二进制里的补不了' : ''}）。` : '都在二进制图层里，补不了。'}`,
      fixable: inText > 0,
      count: noExtent,
    });
  }
  const doubleSided = sum('doubleSided');
  if (doubleSided > 0) {
    findings.push({
      id: 'double-sided',
      severity: 'info',
      title: `${doubleSided} 个 Mesh 声明了双面 doubleSided`,
      detail: '苹果功能支持表：RealityKit 不支持双面网格；Keynote 里没有专门验证过。单层的几何（卡片、旗帜、叶片）要是靠这个显示背面，在 Keynote 里转到背面看一眼，空了就得让几何本身有两面（本项目的卡片就是这么做的）。',
      fixable: false,
      count: doubleSided,
    });
  }
  const noSubdiv = sum('meshesWithoutSubdiv');
  if (noSubdiv > 0) {
    findings.push({
      id: 'subdiv',
      severity: 'info',
      title: `${noSubdiv} 个 Mesh 没写 subdivisionScheme`,
      detail: '苹果文档：USD 里不写就默认 catmullClark，等于开了细分曲面，RealityKit 真会去细分——低模会变圆、变慢。建模软件导出时通常会写 none；没写的这里不替你猜，看起来不对再回建模软件设。',
      fixable: false,
      count: noSubdiv,
    });
  }
  const lights = sum('lights');
  const cameras = sum('cameras');
  if (lights > 0 || cameras > 0) {
    findings.push({
      id: 'lights-cameras',
      severity: 'info',
      title: `带 ${lights} 盏灯、${cameras} 个相机`,
      detail: '苹果功能支持表：RealityKit 不用文件里的灯，Keynote 用自己的布光；相机也不用。带着不碍事，只是白占体积。',
      fixable: false,
    });
  }
  const mtlx = textFacts.reduce((a, t) => a + t.facts.materialX, 0);
  if (mtlx > 0) {
    findings.push({
      id: 'materialx',
      severity: 'warn',
      title: '用了 MaterialX 材质',
      detail: '苹果功能支持表说 RealityKit 认 MaterialX，但 Keynote 里没验证过；本项目所有实测都是 UsdPreviewSurface。颜色校正只认 UsdPreviewSurface。',
      fixable: false,
    });
  }

  // 资源引用：外部的、缺失的
  const referenced = new Set<string>();
  const binaryReferenced = new Set<string>();
  const external: string[] = [];
  const missing: string[] = [];
  const roles: Record<string, string[]> = {};
  const collect = (layer: string, facts: { assets: string[]; textureRoles: Record<string, string[]> }, binary: boolean) => {
    for (const a of facts.assets) {
      if (/^[a-z]+:\/\//i.test(a)) {
        external.push(a);
        continue;
      }
      const p = resolveInPackage(layer, a);
      if (a.startsWith('/') || a.startsWith('../') || !p) {
        external.push(a);
        continue;
      }
      referenced.add(p);
      if (binary) binaryReferenced.add(p);
      if (!entries[p]) missing.push(p);
    }
    for (const [file, r] of Object.entries(facts.textureRoles)) {
      const p = resolveInPackage(layer, file);
      roles[p] = [...new Set([...(roles[p] ?? []), ...r])];
    }
  };
  for (const t of textFacts) collect(t.name, t.facts, false);
  for (const b of binFacts) if (b.facts.parsed) collect(b.name, b.facts, true);
  if (external.length > 0) {
    findings.push({
      id: 'external-ref',
      severity: 'bad',
      title: `${external.length} 处引用了包外面的文件`,
      detail: `usdz 必须自包含，包外的路径在别人机器上一定找不到：${external.slice(0, 3).join('、')}${external.length > 3 ? '…' : ''}。得回建模软件重新打包。`,
      fixable: false,
      count: external.length,
    });
  }
  const missingUniq = [...new Set(missing)];
  if (missingUniq.length > 0) {
    findings.push({
      id: 'missing-ref',
      severity: 'bad',
      title: `${missingUniq.length} 个被引用的文件不在包里`,
      detail: `${missingUniq.slice(0, 3).join('、')}${missingUniq.length > 3 ? '…' : ''}。贴图缺了那块就是灰的，图层缺了整块不显示。`,
      fixable: false,
      count: missingUniq.length,
    });
  }

  // 贴图
  const textures: TextureInfo[] = [];
  let textureBytes = 0;
  let huge = 0;
  let opaquePng = 0;
  const badFormat: string[] = [];
  for (const name of Object.keys(images)) {
    const data = images[name];
    textureBytes += data.length;
    const h = imageHeader(data);
    const info: TextureInfo = {
      name,
      bytes: data.length,
      format: h.format,
      width: h.width,
      height: h.height,
      alphaChannel: h.alphaChannel,
      roles: roles[name] ?? [],
      binaryRef: binaryReferenced.has(name),
      unreferenced: (textFacts.length + binFacts.filter((b) => b.facts.parsed).length) > 0 && !referenced.has(name),
    };
    textures.push(info);
    if (h.format === 'other') badFormat.push(name);
    if ((h.width ?? 0) > 4096 || (h.height ?? 0) > 4096) huge++;
    if (h.format === 'png' && !h.alphaChannel) opaquePng++;
  }
  for (const name of others) {
    if (/\.(exr|tiff?|tga|bmp|webp|ktx2?|hdr|gif|avif)$/i.test(name)) badFormat.push(name);
  }
  if (badFormat.length > 0) {
    findings.push({
      id: 'texture-format',
      severity: 'bad',
      title: `${badFormat.length} 张贴图不是 PNG / JPEG`,
      detail: `${badFormat.slice(0, 3).join('、')}${badFormat.length > 3 ? '…' : ''}。usdz 里的贴图苹果只稳定认 PNG 和 JPEG（新系统加了 AVIF），别的格式会显示成灰块。回建模软件换格式重导。`,
      fixable: false,
      count: badFormat.length,
    });
  }
  if (huge > 0) {
    findings.push({
      id: 'texture-huge',
      severity: 'warn',
      title: `${huge} 张贴图超过 4096 像素`,
      detail: '幻灯片上一个模型占不到半屏，4K 以上的贴图纯属浪费显存，Keynote 翻页会卡、文件也大。右边「瘦身」把上限设成 2048 或 4096 就能压下来。',
      fixable: true,
      count: huge,
    });
  }
  if (opaquePng > 0) {
    findings.push({
      id: 'texture-opaque-png',
      severity: 'info',
      title: `${opaquePng} 张 PNG 没有透明通道`,
      detail: '不透明的贴图存成 PNG 白白大几倍，转成 JPEG 肉眼看不出差别（法线贴图除外，那种会留着）。右边「瘦身」勾上就转。',
      fixable: true,
      count: opaquePng,
    });
  }
  if (totalBytes > 50 * 1024 * 1024) {
    findings.push({
      id: 'size',
      severity: 'warn',
      title: `整个文件 ${(totalBytes / 1024 / 1024).toFixed(0)} MB`,
      detail: '一页放几个这种模型，Keynote 文件轻松上百兆，翻页和存盘都跟着卡。贴图通常是大头，先瘦身。',
      fixable: false,
    });
  }
  if (findings.length === 0) {
    findings.push({ id: 'clean', severity: 'info', title: '没查出问题', detail: '按本项目攒下来的规则一条都没撞上。不代表 Keynote 一定好看，颜色还是要校正。', fixable: false });
  }

  const order: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    findings,
    textures: textures.sort((a, b) => b.bytes - a.bytes),
    layers,
    meta: {
      defaultPrim: rootFacts?.defaultPrim ?? null,
      upAxis: rootFacts?.upAxis ?? 'Y',
      metersPerUnit: rootFacts?.metersPerUnit ?? 1,
      rootBinary: !!rootLayer?.binary,
    },
    totalBytes,
    textureBytes,
    animation: { xformOps: xformAnim, materialOps: matAnim, vertex, skeletal },
    zip: { compressed: zip.compressed, misaligned: zip.misaligned },
  };
}

/** 文本图层的可修项：去后缀、补 extent、补 defaultPrim、rotateXYZ 动画改 orient。返回改过的文本和修了什么 */
export function fixUsda(text: string, isRoot: boolean): { text: string; fixes: Record<string, number> } {
  const fixes: Record<string, number> = {};
  let t = text;
  const ns = fixXformOpNamespaces(t);
  t = ns.text;
  if (ns.count) fixes['xformop-suffix'] = ns.count;
  const before = (t.match(/float3\[\] extent/g) ?? []).length;
  t = addExtents(t);
  const added = (t.match(/float3\[\] extent/g) ?? []).length - before;
  if (added) fixes.extent = added;
  if (isRoot) {
    const header = /^#usda[^\n]*\n\s*\(([\s\S]*?)\n\)/.exec(t);
    if (header && !/defaultPrim\s*=/.test(header[1])) {
      const first = /^(?:def|over|class)\b[^\n"]*"([^"\n]+)"/m.exec(t);
      if (first) {
        t = t.replace(/^(#usda[^\n]*\n\s*\()/, `$1\n\tdefaultPrim = "${first[1]}"`);
        fixes['default-prim'] = 1;
      }
    }
  }
  const ro = rotateXYZToOrient(t);
  t = ro.text;
  if (ro.count) fixes['rotate-xyz-anim'] = ro.count;
  return { text: t, fixes };
}

// ---------- rotateXYZ 动画 → orient ----------

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return (r === 0 ? 0 : r).toString();
};

/**
 * 欧拉角（度）→ 四元数 (w, x, y, z)。
 * USD 的 rotateXYZ 是行向量的 Rx·Ry·Rz，对应 three 的 'ZYX' 欧拉序（和 motionExport 里一致）。
 */
export function eulerXYZToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const d = THREE.MathUtils.degToRad;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(x), d(y), d(z), 'ZYX'));
  return [q.w, q.x, q.y, q.z];
}

/**
 * 把带 timeSamples 的 `xformOp:rotateXYZ` 改写成 `quatf xformOp:orient`：
 * 静态值和每个采样都换算成四元数，相邻帧翻成同号让插值走短路，xformOpOrder 里改名。
 * 只处理 prim 直属、且同一个 prim 里没有 orient 的情况；碰到别的写法（rotateX/Y/Z 分开）不动。
 */
export function rotateXYZToOrient(text: string): { text: string; count: number } {
  let count = 0;
  const re = /^([ \t]*)(?:float3|double3)\s+xformOp:rotateXYZ\.timeSamples\s*=\s*\{([^}]*)\}([^\n]*)\n?/gm;
  let out = text;
  const blocks = [...text.matchAll(re)];
  if (blocks.length === 0) return { text, count };
  // 逐个替换，从后往前免得偏移变化
  for (let i = blocks.length - 1; i >= 0; i--) {
    const m = blocks[i];
    const indent = m[1];
    const samples = [...m[2].matchAll(/([-\d.eE]+)\s*:\s*\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)/g)].map((s) => ({
      t: s[1],
      q: eulerXYZToQuat(+s[2], +s[3], +s[4]),
    }));
    if (samples.length === 0) continue;
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1].q;
      const b = samples[k].q;
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) samples[k].q = b.map((v) => -v) as typeof b;
    }
    const line = `${indent}quatf xformOp:orient.timeSamples = {${samples.map((s) => `${s.t}: (${s.q.map(num).join(', ')})`).join(', ')}}\n`;
    out = out.slice(0, m.index) + line + out.slice(m.index + m[0].length);
    count++;
  }
  // 静态值：紧邻的 `float3 xformOp:rotateXYZ = (x, y, z)` 也换掉
  out = out.replace(/^([ \t]*)(?:float3|double3)\s+xformOp:rotateXYZ\s*=\s*\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)([^\n]*)$/gm, (whole, indent: string, x: string, y: string, z: string) => {
    // 只在这个 prim 已经改出了 orient.timeSamples 时才换 —— 用一个粗略的判断：全文里 orient.timeSamples 数量 > 0
    if (count === 0) return whole;
    return `${indent}quatf xformOp:orient = (${eulerXYZToQuat(+x, +y, +z).map(num).join(', ')})`;
  });
  if (count > 0) {
    out = out.replace(/(xformOpOrder\s*=\s*\[[^\]]*)"xformOp:rotateXYZ"/g, '$1"xformOp:orient"');
  }
  return { text: out, count };
}
