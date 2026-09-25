import * as THREE from 'three';
import { unzipSync } from 'fflate';
import { addExtents, packUsdz } from './usdzExtent';
import { bakeMotion, type MotionParams, type Pose } from './motion';
// @ts-expect-error 从 three r185 搬过来的解析器，没有类型声明
import { USDCParser } from '../vendor/usd/USDCParser.js';

/**
 * 把运动写进 usdz。
 *
 * 做法是在原模型外面**套一层新的 Xform 父节点**，动画只写在这一层：
 * 一个 `xformOp:translate` 加一个 `xformOp:orient`，都是不带后缀的名字 ——
 * 带后缀的 xformOp 苹果会整层放弃（见 usdaCompat.ts 的实测记录），
 * 所以不能用 `xformOp:translate:motion` 那种写法，也别指望 `!invert!` 的 pivot 语法。
 * 旋转中心的补偿直接折进每帧的平移里：T = d + c − R·c。
 *
 * 不碰原模型自己的变换，也就没有命名冲突。原模型里的绝对路径
 * （`</Root/Materials/X>`）要跟着改成 `</Motion/Root/...>`。
 */

/** 加载器给整个模型套的变换，和它算出来的包围盒（都在 three 的世界坐标里） */
export type ModelSpace = {
  /** metersPerUnit 缩放 + Z-up 转 Y-up 的旋转，列主序 16 个数（three 的 Matrix4.elements） */
  groupMatrix: number[];
  min: [number, number, number];
  max: [number, number, number];
  /** 原模型动画的完整周期（秒）；没有原动画时省略 */
  animationDuration?: number;
};

export type MotionReport = {
  frames: number;
  seconds: number;
  fps: number;
  /** 套在外面那层的名字 */
  wrapper: string;
  /** 被套住的原根节点 */
  root: string;
  /** 再次处理本工具的输出时，上一次添加的整体动画被更新 */
  replacedAnimation: boolean;
  /** 原文件保留下来的动画属性数，会和新加的叠在一起 */
  nestedAnimation: number;
  /** 扩大了多少个 extent */
  extents: number;
  /** 根图层是二进制 .usdc：另写了一个文本根图层把它引用进来，原文件一个字节没动 */
  binaryRoot: boolean;
};

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return (r === 0 ? 0 : r).toString();
};
const vec = (v: number[]) => `(${v.map(num).join(', ')})`;

/**
 * 把 three 世界坐标里的一帧姿态（绕 center 转）换算成文件坐标里的平移和 rotateXYZ。
 * F = G⁻¹ · M · G：G 是加载器套的缩放 + 朝向，M 是我们在 three 世界里的运动。
 */
export function poseToFile(pose: Pose, center: THREE.Vector3, G: THREE.Matrix4, Ginv: THREE.Matrix4) {
  // rotateXYZ 在 USD 里是 Rx·Ry·Rz（行向量），对应 three 的 'ZYX' 欧拉序
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(pose.rotation[0]),
    THREE.MathUtils.degToRad(pose.rotation[1]),
    THREE.MathUtils.degToRad(pose.rotation[2]),
    'ZYX',
  );
  const q = new THREE.Quaternion().setFromEuler(euler);
  const d = new THREE.Vector3(...pose.position);
  // 世界 = s·R·(p − c) + c + d
  const M = new THREE.Matrix4()
    .compose(center.clone().add(d), q, new THREE.Vector3(pose.scale, pose.scale, pose.scale))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
  const F = Ginv.clone().multiply(M).multiply(G);
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  F.decompose(pos, rot, scl);
  // 文件里写的是四元数（见 motionOps），欧拉角只是留给测试和排查看的。
  // 能不分解就不分解：three 的 ZYX 分解把 Y 角限制在 ±90°，旋入转过 90° 时
  // 会把多出来的塞到 X、Z 上各加 180°。G 没有旋转（Y-up 文件，绝大多数）时
  // 角度原样照抄；Z-up 文件才真要换轴，那时自转落在 Z 角上，分解没有这个限制。
  const rotate = hasRotation(G)
    ? (() => {
        const e = new THREE.Euler().setFromQuaternion(rot, 'ZYX');
        return [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)];
      })()
    : [...pose.rotation];
  return {
    translate: [pos.x, pos.y, pos.z],
    rotate,
    // USD 文本里四元数是 (w, x, y, z)，实部在前
    orient: [rot.w, rot.x, rot.y, rot.z],
    scale: [scl.x, scl.y, scl.z],
    matrix: M,
    /** 文件坐标里的同一帧 */
    fileMatrix: F,
  };
}

/** 静态的一帧：平移、四元数 (w, x, y, z)、缩放 */
export type StaticPose = { translate: number[]; orient: number[]; scale: number[] };

function decomposeFile(F: THREE.Matrix4): StaticPose {
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  F.decompose(pos, rot, scl);
  return { translate: [pos.x, pos.y, pos.z], orient: [rot.w, rot.x, rot.y, rot.z], scale: [scl.x, scl.y, scl.z] };
}

/**
 * 把整段动画改写成「起始姿态 × 相对变化」。
 *
 * Keynote 放映时，动画开始播之前**不理会动画层**：默认值也好、第 0 帧也好都不看，
 * 把模型按没套动画的原样画出来 —— 「长出」会先看到完整的模型摆着，过一会儿缩没再长出来
 * （2026-09-14 高达实测；编辑状态下倒是显示默认值）。
 *
 * 所以第 0 帧的隐藏姿态不能只靠动画层：把它拆成一层**静态**的 Xform（Start，不带 timeSamples），
 * 动画层只写相对于它的变化 A(t) = F(t) · F(0)⁻¹，第 0 帧正好是单位变换。这样不管 Keynote
 * 播放前是显示默认值、第一个采样还是把动画层当不存在，看到的都是那个隐藏姿态。
 * 缩放是均匀的，所以 F(t) · F(0)⁻¹ 仍能分解成平移 · 旋转 · 缩放。
 */
export function rebaseFrames(frames: THREE.Matrix4[]): { start: StaticPose; translate: number[][]; orient: number[][]; scale: number[][] } {
  const F0 = frames[0];
  const inv = F0.clone().invert();
  const translate: number[][] = [];
  const orient: number[][] = [];
  const scale: number[][] = [];
  for (const F of frames) {
    const d = decomposeFile(F.clone().multiply(inv));
    translate.push(d.translate);
    orient.push(d.orient);
    scale.push(d.scale);
  }
  return { start: decomposeFile(F0), translate, orient, scale };
}

/** G 除了均匀缩放还带不带旋转 */
function hasRotation(G: THREE.Matrix4): boolean {
  const q = new THREE.Quaternion();
  G.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return Math.abs(q.w) < 1 - 1e-9;
}

/** 运动扫过的范围：包围盒八个角在所有帧里到过的地方，换算到文件坐标后取轴对齐的框 */
function sweptBox(frames: THREE.Matrix4[], min: number[], max: number[], Ginv: THREE.Matrix4) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        p.set(x, y, z);
        for (const M of frames) {
          q.copy(p).applyMatrix4(M).applyMatrix4(Ginv);
          for (let a = 0; a < 3; a++) {
            const v = q.getComponent(a);
            if (v < lo[a]) lo[a] = v;
            if (v > hi[a]) hi[a] = v;
          }
        }
      }
  return { min: lo, max: hi };
}

/** 运动扫过的范围：包围盒八个角在所有帧里离开原位最远的距离（three 世界单位） */
function sweptMargin(frames: THREE.Matrix4[], min: number[], max: number[]): number {
  let worst = 0;
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        p.set(x, y, z);
        for (const M of frames) {
          q.copy(p).applyMatrix4(M);
          worst = Math.max(worst, q.distanceTo(p));
        }
      }
  return worst;
}

/**
 * 从矩阵分解出来的欧拉角被折在 ±180° 里，旋入那一整圈会在 180° 处从 −179 跳到 +179。
 * Keynote 按帧线性插值，那一帧就会狂转一圈。逐帧挑离上一帧最近的等价角，让序列连续。
 */
export function unwrapDegrees(rows: number[][]): number[][] {
  const out = rows.map((r) => [...r]);
  for (let i = 1; i < out.length; i++) {
    for (let a = 0; a < 3; a++) {
      let v = out[i][a];
      const prev = out[i - 1][a];
      while (v - prev > 180) v -= 360;
      while (v - prev < -180) v += 360;
      out[i][a] = v;
    }
  }
  return out;
}

/**
 * q 和 −q 是同一个旋转，但插值走的路不一样：相邻两帧异号，渲染器会绕远路转 358°。
 * 逐帧把符号翻到和上一帧同一侧。
 */
export function alignQuaternions(rows: number[][]): number[][] {
  const out = rows.map((r) => [...r]);
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (dot < 0) out[i] = b.map((v) => (v === 0 ? 0 : -v));
  }
  return out;
}

// ---------- 纯文本部分 ----------

/** 文件头：`#usda 1.0` 之后紧跟的 `( ... )` 块 */
function findHeader(usda: string): { start: number; end: number } | null {
  const m = /^#usda[^\n]*\n\s*\(/.exec(usda);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < usda.length; i++) {
    if (usda[i] === '(') depth++;
    else if (usda[i] === ')') {
      depth--;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return null;
}

function setHeaderField(header: string, key: string, value: string): string {
  const re = new RegExp(`^([ \\t]*)${key}\\s*=\\s*[^\\n]*$`, 'm');
  if (re.test(header)) return header.replace(re, `$1${key} = ${value}`);
  // 没有就插在开括号后面
  return header.replace(/^\(\s*/, `(\n\t${key} = ${value}\n\t`).replace(/\n\t\)$/, '\n)');
}

/** 顶层 prim 的位置：从 def 行开头到配对的 `}` 之后 */
function findTopPrim(usda: string, name: string | null): { start: number; end: number; name: string } | null {
  const re = name
    ? new RegExp(`^(?:def|over|class)\\b[^\\n]*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm')
    : /^(?:def|over|class)\b[^\n]*"([^"\n]+)"/m;
  const m = re.exec(usda);
  if (!m) return null;
  const primName = name ?? m[1];
  let i = m.index + m[0].length;
  // 跳过 def 头部的 `( ... )` 元数据块，找到 `{`
  let depth = 0;
  for (; i < usda.length; i++) {
    const c = usda[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '{' && depth === 0) break;
  }
  if (i >= usda.length) return null;
  depth = 1;
  for (let j = i + 1; j < usda.length; j++) {
    if (usda[j] === '{') depth++;
    else if (usda[j] === '}') {
      depth--;
      if (depth === 0) return { start: m.index, end: j + 1, name: primName };
    }
  }
  return null;
}

/**
 * 把根节点自己那一层的动画去掉（只动它直属的属性，不进子节点）。
 * 返回去掉之后的文本和是否真的去掉了什么。
 */
export function stripOwnAnimation(prim: string): { text: string; stripped: boolean } {
  const open = prim.indexOf('{');
  if (open < 0) return { text: prim, stripped: false };
  // 直属范围：到第一个嵌套的 def/over/class 为止
  const nested = /^[ \t]+(?:def|over|class)\b/m.exec(prim.slice(open));
  const ownEnd = nested ? open + nested.index : prim.length;
  let own = prim.slice(open, ownEnd);
  const animated: string[] = [];
  own = own.replace(
    /^[ \t]*[\w\[\]]+\s+(xformOp:[\w:!]+)\.timeSamples\s*=\s*\{[^}]*\}[^\n]*\n?/gm,
    (_all, op: string) => {
      animated.push(op);
      return '';
    },
  );
  if (animated.length === 0) return { text: prim, stripped: false };
  // xformOpOrder 里把这些 op 摘掉；没有静态值的话它们已经不存在了
  own = own.replace(/(uniform\s+token\[\]\s+xformOpOrder\s*=\s*\[)([^\]]*)(\])/, (_all, a: string, list: string, b: string) => {
    const keep = (list.match(/"[^"]*"/g) ?? []).filter((item) => {
      const op = item.slice(1, -1).replace(/^!invert!/, '');
      // 还有静态声明的留着
      return !animated.includes(op) || new RegExp(`\\s${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(own);
    });
    return `${a}${keep.join(', ')}${b}`;
  });
  return { text: prim.slice(0, open) + own + prim.slice(ownEnd), stripped: true };
}

/** 一个 prim 直属那一层（不进子节点）的范围 */
function ownRange(prim: string): { open: number; ownEnd: number } | null {
  const open = prim.indexOf('{');
  if (open < 0) return null;
  const nested = /^[ \t]+(?:def|over|class)\b/m.exec(prim.slice(open));
  return { open, ownEnd: nested ? open + nested.index : prim.length };
}

/** 把 prim 直属的 xformOp 声明（静态值、timeSamples、xformOpOrder）全部拿掉 */
function stripOwnOps(prim: string): string {
  const r = ownRange(prim);
  if (!r) return prim;
  const own = prim
    .slice(r.open, r.ownEnd)
    .replace(/^[ \t]*[\w\[\]]+\s+xformOp:[\w:!]+(?:\.timeSamples)?\s*=\s*(?:\{[^}]*\}|\([^)]*\))[^\n]*\n?/gm, '')
    .replace(/^[ \t]*uniform\s+token\[\]\s+xformOpOrder\s*=\s*\[[^\]]*\][^\n]*\n?/gm, '');
  return prim.slice(0, r.open) + own + prim.slice(r.ownEnd);
}

/**
 * 给我们自己套过的文件再套一次：上一次的动画层和起始姿态层都要清成单位变换。
 * 起始姿态层是静态的，留着的话「长出」那 0.001 的缩放会把模型永远藏起来。
 * 认的是「直属子节点里有 def Xform "Start"」这个签名；返回 null 表示不是我们套的。
 */
export function neutralizeOwnWrapper(prim: string): string | null {
  const r = ownRange(prim);
  if (!r) return null;
  const marked = /\bcustom string prismMotionWrapper = "1"/.test(prim.slice(r.open, r.ownEnd));
  // 旧文件靠 Start 识别；新文件用明确标记，也兼容没有 Start 的包装层。
  if (!/^[ \t]+def Xform "Start(?:_\d+)?"/.test(prim.slice(r.ownEnd))) {
    return marked ? stripOwnOps(prim) : null;
  }
  const startAt = r.ownEnd;
  const startPrim = findTopPrimAt(prim, startAt);
  if (!startPrim) return null;
  const cleaned = stripOwnOps(prim.slice(startAt, startPrim.end));
  return stripOwnOps(prim.slice(0, startAt) + cleaned + prim.slice(startPrim.end));
}

/** 从 `def ...` 的位置起找到这个 prim 的结束 `}` */
function findTopPrimAt(usda: string, at: number): { end: number } | null {
  let depth = 0;
  let i = at;
  for (; i < usda.length; i++) {
    const c = usda[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '{' && depth === 0) break;
  }
  if (i >= usda.length) return null;
  depth = 1;
  for (let j = i + 1; j < usda.length; j++) {
    if (usda[j] === '{') depth++;
    else if (usda[j] === '}') {
      depth--;
      if (depth === 0) return { end: j + 1 };
    }
  }
  return null;
}

/** 把每个 `float3[] extent = [(..), (..)]` 往外扩 margin */
export function expandExtents(usda: string, margin: number): { text: string; count: number } {
  let count = 0;
  const text = usda.replace(
    /(float3\[\]\s+extent\s*=\s*\[)\s*\(([^)]*)\)\s*,\s*\(([^)]*)\)\s*(\])/g,
    (_all, a: string, lo: string, hi: string, b: string) => {
      const l = lo.split(',').map(Number);
      const h = hi.split(',').map(Number);
      if (l.length !== 3 || h.length !== 3 || [...l, ...h].some((v) => !Number.isFinite(v))) return _all;
      count++;
      return `${a}${vec(l.map((v) => v - margin))}, ${vec(h.map((v) => v + margin))}${b}`;
    },
  );
  return { text, count };
}

export type WrapOptions = {
  translate: number[][];
  /** 四元数 (w, x, y, z)，逐帧 */
  orient: number[][];
  /** 只有入场用到缩放时才给；不给就不写 scale op，少一个 op 少一分风险 */
  scale?: number[][];
  /**
   * 起始姿态：动画层里面再套一层不带 timeSamples 的 Xform。
   * Keynote 放映时开播前不理会动画层，隐藏姿态得写成静态的才藏得住（见 rebaseFrames）
   */
  start?: StaticPose;
  fps: number;
  /** 原文件的每秒时间码；保留原动画的播放速度 */
  timeCodesPerSecond?: number;
  /** 整段运动扫过的范围（文件坐标）。给了就放一个看不见的占位盒，让 Keynote 按它定视角 */
  bounds?: { min: number[]; max: number[] };
};

/**
 * 看不见的占位盒。
 *
 * Keynote 按**第 0 帧**的包围盒定视角：「长出」第 0 帧缩放是 0.001，模型几乎是个点，
 * 镜头就怼到那个点上，等模型长到原大镜头已经在它肚子里了（2026-09-14 高达实测）。
 * 放一个不动的 Mesh 在 Motion 外面，extent 是整段运动扫过的范围，只有 8 个顶点和
 * 一个零面积的面 —— 什么都画不出来，但包围盒在。
 */
export function boundsPrim(bounds: { min: number[]; max: number[] }, name = 'MotionBounds'): string {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
  return `def Xform "${name}"
{
	def Mesh "Box"
	{
		float3[] extent = [${vec(bounds.min)}, ${vec(bounds.max)}]
		point3f[] points = [${corners.map(vec).join(', ')}]
		int[] faceVertexCounts = [3]
		int[] faceVertexIndices = [0, 0, 0]
		uniform token subdivisionScheme = "none"
	}
}`;
}

/**
 * 三个 op 的声明和顺序。名字都不带后缀 —— 带后缀的 scale 是实测会让苹果放弃的那种。
 *
 * 旋转写四元数 `orient` 而不是 `rotateXYZ`：旋入那一整圈用欧拉角写到 360°，
 * Keynote 就不播了（2026-09-14 高达实测）；苹果自家工具导出的旋转动画用的都是 orient。
 *
 * 每个 op 除了 timeSamples 还写一个等于第 0 帧的默认值：Keynote 开始播放之前显示的是
 * 默认值，不写就是原大原位，一开播跳到第 0 帧 —— 「长出」会先看到模型缩没再长出来。
 */
function motionOps(opts: WrapOptions, indent: string): string {
  const ts = (rows: number[][]) => `{${rows.map((v, i) => `${num(i * (opts.timeCodesPerSecond ?? opts.fps) / opts.fps)}: ${vec(v)}`).join(', ')}}`;
  const order = ['xformOp:translate', 'xformOp:orient'];
  const lines = [
    `${indent}double3 xformOp:translate = ${vec(opts.translate[0])}`,
    `${indent}double3 xformOp:translate.timeSamples = ${ts(opts.translate)}`,
    `${indent}quatf xformOp:orient = ${vec(opts.orient[0])}`,
    `${indent}quatf xformOp:orient.timeSamples = ${ts(opts.orient)}`,
  ];
  if (opts.scale) {
    lines.push(`${indent}float3 xformOp:scale = ${vec(opts.scale[0])}`);
    lines.push(`${indent}float3 xformOp:scale.timeSamples = ${ts(opts.scale)}`);
    order.push('xformOp:scale');
  }
  lines.push(`${indent}uniform token[] xformOpOrder = [${order.map((o) => `"${o}"`).join(', ')}]`);
  return lines.join('\n');
}

/** 起始姿态那层的三个静态 op。缩放接近 1 就不写，和动画层一样能省一个 op */
function startOps(start: StaticPose, indent: string): string {
  const order = ['xformOp:translate', 'xformOp:orient'];
  const lines = [
    `${indent}double3 xformOp:translate = ${vec(start.translate)}`,
    `${indent}quatf xformOp:orient = ${vec(start.orient)}`,
  ];
  if (start.scale.some((v) => Math.abs(v - 1) > 1e-6)) {
    lines.push(`${indent}float3 xformOp:scale = ${vec(start.scale)}`);
    order.push('xformOp:scale');
  }
  lines.push(`${indent}uniform token[] xformOpOrder = [${order.map((o) => `"${o}"`).join(', ')}]`);
  return lines.join('\n');
}

/** 起始姿态那层的名字，别和被套住的 prim 撞了 */
export function startName(inner: string): string {
  let name = 'Start';
  for (let n = 1; name === inner; n++) name = `Start_${n}`;
  return name;
}

/** 把一段 prim 文本整体缩进一层 */
const indentBlock = (text: string) => text.split('\n').map((line) => (line.length ? '\t' + line : line)).join('\n');

/**
 * 在根 prim 外面套一层带动画的 Xform。纯文本操作，方便测试。
 */
export function wrapWithMotion(
  usda: string,
  opts: WrapOptions,
): { text: string; wrapper: string; root: string; replacedAnimation: boolean; nestedAnimation: number } {
  // 给加过动效的文件再加一次：上次放的占位盒要先拿掉，不然会有两个同名 prim
  const oldBounds = findTopPrim(usda, 'MotionBounds');
  if (oldBounds) usda = usda.slice(0, oldBounds.start) + usda.slice(oldBounds.end).replace(/^\n+/, '');

  const header = findHeader(usda);
  let headerText = header ? usda.slice(header.start, header.end) : '(\n)';
  const dp = /defaultPrim\s*=\s*"([^"]+)"/.exec(headerText);
  const prim = findTopPrim(usda, dp ? dp[1] : null);
  if (!prim) throw new Error('找不到根节点，这个文件的场景可能全在二进制 .usdc 里');

  let wrapper = 'Motion';
  for (let n = 1; findTopPrim(usda, wrapper); n++) wrapper = `Motion_${n}`;

  // 再次处理本工具的输出时，更新旧整体动画；原模型的根节点和子节点动画全部保留。
  const primText = usda.slice(prim.start, prim.end);
  const ours = neutralizeOwnWrapper(primText);
  const own = ours !== null ? { text: ours, stripped: true } : { text: primText, stripped: false };
  const nestedAnimation = (own.text.match(/\.timeSamples\s*=/g) ?? []).length;

  // 绝对路径跟着搬家：</Root/...> → </Motion/Root/...>（有起始姿态层就是 </Motion/Start/Root/...>）
  const esc = prim.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = opts.start ? startName(prim.name) : null;
  const prefix = start ? `${wrapper}/${start}` : wrapper;
  let inner = indentBlock(own.text.replace(new RegExp(`</${esc}(?=[/>.])`, 'g'), `</${prefix}/${prim.name}`));
  if (start && opts.start) {
    inner = indentBlock(`def Xform "${start}"
{
${startOps(opts.start, '\t')}

${inner}
}`);
  }

  const frames = opts.translate.length - 1;
  const timeCodesPerSecond = opts.timeCodesPerSecond ?? Number(/timeCodesPerSecond\s*=\s*([\d.]+)/.exec(headerText)?.[1] ?? /framesPerSecond\s*=\s*([\d.]+)/.exec(headerText)?.[1] ?? opts.fps);
  if (!Number.isFinite(timeCodesPerSecond) || timeCodesPerSecond <= 0) throw new Error('原文件的时间码频率无效');
  const timedOpts = { ...opts, timeCodesPerSecond };
  const wrapped = `def Xform "${wrapper}"
{
	custom string prismMotionWrapper = "1"
${motionOps(timedOpts, '\t')}

${inner}
}` + (opts.bounds ? `\n\n${boundsPrim(opts.bounds)}` : '');

  headerText = setHeaderField(headerText, 'timeCodesPerSecond', String(timeCodesPerSecond));
  headerText = setHeaderField(headerText, 'framesPerSecond', String(opts.fps));
  headerText = setHeaderField(headerText, 'endTimeCode', num(frames * timeCodesPerSecond / opts.fps));
  headerText = setHeaderField(headerText, 'startTimeCode', '0');
  headerText = setHeaderField(headerText, 'defaultPrim', `"${wrapper}"`);

  let text: string;
  if (header) {
    text = usda.slice(0, header.start) + headerText + usda.slice(header.end, prim.start) + wrapped + usda.slice(prim.end);
  } else {
    const nl = usda.indexOf('\n');
    const first = nl < 0 ? usda : usda.slice(0, nl + 1);
    const rest = nl < 0 ? '' : usda.slice(nl + 1);
    const p = prim.start - first.length;
    text = first + headerText + '\n' + rest.slice(0, p) + wrapped + rest.slice(prim.end - first.length);
  }
  return { text, wrapper, root: prim.name, replacedAnimation: own.stripped, nestedAnimation };
}

/**
 * 二进制根图层：另写一个文本根图层，把原来的 .usdc 整个 reference 进来。
 *
 * upAxis / metersPerUnit 这类图层元数据只认根图层的，得从二进制里抄出来 ——
 * 用 three 那个 crate 解析器读一遍字段就有了，不用自己解二进制。
 * 引用时把 prim 路径写明（`</scene>`），不依赖对方的 defaultPrim。
 */
export type BinaryRootInfo = {
  defaultPrim: string;
  upAxis: string;
  metersPerUnit: number;
  /** 里面已有的动画 op 数 */
  animatedOps: number;
  timeCodesPerSecond?: number;
};

export function readBinaryRoot(data: Uint8Array): BinaryRootInfo {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const parsed = new USDCParser().parseData(buf) as {
    specsByPath: Record<string, { specType: number; fields: Record<string, unknown> }>;
  };
  const root = parsed.specsByPath['/']?.fields ?? {};
  const children = (root.primChildren as string[] | undefined) ?? [];
  const defaultPrim = (root.defaultPrim as string | undefined) ?? children[0];
  if (!defaultPrim) throw new Error('二进制根图层里找不到任何 prim');
  let animatedOps = 0;
  for (const spec of Object.values(parsed.specsByPath)) {
    for (const [k, v] of Object.entries(spec.fields)) {
      if (k.startsWith('xformOp:') && v && typeof v === 'object' && 'times' in (v as object)) animatedOps++;
    }
  }
  return {
    defaultPrim,
    upAxis: (root.upAxis as string | undefined) ?? 'Y',
    metersPerUnit: (root.metersPerUnit as number | undefined) ?? 1,
    animatedOps,
    timeCodesPerSecond: (root.timeCodesPerSecond as number | undefined) ?? (root.framesPerSecond as number | undefined),
  };
}

export function binaryRootLayer(info: BinaryRootInfo, usdcPath: string, opts: WrapOptions): string {
  const frames = opts.translate.length - 1;
  const timeCodesPerSecond = info.timeCodesPerSecond ?? opts.fps;
  const timedOpts = { ...opts, timeCodesPerSecond };
  let inner = `def "${info.defaultPrim}" (
\tprepend references = @./${usdcPath}@</${info.defaultPrim}>
)
{
}`;
  if (opts.start) {
    inner = `def Xform "${startName(info.defaultPrim)}"
{
${startOps(opts.start, '\t')}

${indentBlock(inner)}
}`;
  }
  return `#usda 1.0
(
	defaultPrim = "Motion"
	upAxis = "${info.upAxis}"
	metersPerUnit = ${num(info.metersPerUnit)}
	startTimeCode = 0
	endTimeCode = ${num(frames * timeCodesPerSecond / opts.fps)}
	framesPerSecond = ${opts.fps}
	timeCodesPerSecond = ${timeCodesPerSecond}
)

def Xform "Motion"
{
${motionOps(timedOpts, '\t')}

${indentBlock(inner)}
}
${opts.bounds ? `\n${boundsPrim(opts.bounds)}\n` : ''}`;
}

const CRATE_MAGIC = 'PXR-USDC';
function isCrate(data: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(data.subarray(0, 8)) === CRATE_MAGIC;
}

// ---------- 整包 ----------

export function addMotionToUsdz(
  usdz: ArrayBuffer,
  params: MotionParams,
  space: ModelSpace,
  seconds: number,
  fps = 60,
): { bytes: Uint8Array; report: MotionReport } {
  const entries = unzipSync(new Uint8Array(usdz));
  const names = Object.keys(entries);
  // usdz 规范：包里第一个文件就是根图层
  const rootName = names[0];
  if (!rootName || !/\.usd[ac]?$/i.test(rootName)) throw new Error('这个包的第一个文件不是 USD 图层，不像是合法的 usdz');
  const binaryRoot = /\.usdc$/i.test(rootName) || (/\.usd$/i.test(rootName) && isCrate(entries[rootName]));

  const G = new THREE.Matrix4().fromArray(space.groupMatrix);
  const Ginv = G.clone().invert();
  const center = new THREE.Vector3(
    (space.min[0] + space.max[0]) / 2,
    (space.min[1] + space.max[1]) / 2,
    (space.min[2] + space.max[2]) / 2,
  );
  const size = new THREE.Vector3(space.max[0] - space.min[0], space.max[1] - space.min[1], space.max[2] - space.min[2]);
  const radius = Math.max(1e-4, size.length() / 2);

  const poses = bakeMotion(params, radius, seconds, fps);
  const mats: THREE.Matrix4[] = [];
  const fileMats: THREE.Matrix4[] = [];
  for (const pose of poses) {
    const f = poseToFile(pose, center, G, Ginv);
    mats.push(f.matrix);
    fileMats.push(f.fileMatrix);
  }
  // 第 0 帧写成静态的起始姿态层，动画层只写相对变化（放映开播前 Keynote 不看动画层）
  const { start, translate, orient, scale } = rebaseFrames(fileMats);
  const scaled = poses.some((p) => p.scale !== 1);
  // 每个 mesh 的 extent 只按漂浮扫过的距离往外扩 —— 入场那一下（浮起、长出）扫得很远，
  // 按它扩会把每个 mesh 的框都撑大一圈，视角就变小了。入场的范围交给占位盒
  const unit = new THREE.Vector3().setFromMatrixColumn(G, 0).length() || 1;
  const floatOnly = bakeMotion({ ...params, entrance: 'none' }, radius, seconds, fps).map(
    (pose) => poseToFile(pose, center, G, Ginv).matrix,
  );
  const margin = sweptMargin(floatOnly, space.min, space.max) / unit;
  const bounds = sweptBox(mats, space.min, space.max, Ginv);
  const opts: WrapOptions = { translate, orient: alignQuaternions(orient), scale: scaled ? scale : undefined, start, fps, bounds };

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const out: Record<string, Uint8Array> = {};
  let extents = 0;

  if (binaryRoot) {
    // 二进制根图层：新写一个文本根图层放在第一位，其余文件原样搬过去
    const info = readBinaryRoot(entries[rootName]);
    let layer = 'motion.usda';
    for (let n = 1; names.includes(layer); n++) layer = `motion_${n}.usda`;
    out[layer] = enc.encode(binaryRootLayer(info, rootName, opts));
    for (const name of names) out[name] = entries[name];
    return {
      bytes: packUsdz(out),
      report: {
        frames: poses.length - 1,
        seconds,
        fps,
        wrapper: 'Motion',
        root: info.defaultPrim,
        replacedAnimation: false,
        nestedAnimation: info.animatedOps,
        extents: 0,
        binaryRoot: true,
      },
    };
  }

  let info: ReturnType<typeof wrapWithMotion> | null = null;
  for (const name of names) {
    // .usd 两种编码都可能，二进制的照搬
    if (!/\.usda?$/i.test(name) || isCrate(entries[name])) {
      out[name] = entries[name];
      continue;
    }
    let text = addExtents(dec.decode(entries[name]));
    const ex = expandExtents(text, margin);
    text = ex.text;
    extents += ex.count;
    if (name === rootName) {
      info = wrapWithMotion(text, opts);
      text = info.text;
    }
    out[name] = enc.encode(text);
  }
  return {
    bytes: packUsdz(out),
    report: {
      frames: poses.length - 1,
      seconds,
      fps,
      wrapper: info!.wrapper,
      root: info!.root,
      replacedAnimation: info!.replacedAnimation,
      nestedAnimation: info!.nestedAnimation,
      extents,
      binaryRoot: false,
    },
  };
}
