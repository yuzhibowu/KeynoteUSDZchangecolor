import * as THREE from 'three';

/**
 * 棱柱躺倒：长轴 = X，多边形端面朝左右（±X）。
 * 侧面顶点分布在 YZ 平面的圆上，角度用 y = r·sin(θ)、z = r·cos(θ)，所以 θ = 0 正对 +Z（相机方向）。
 * 侧面 i 的面心角 = 2πi/sides，两个顶点在面心角 ± π/sides —— 整圈偏移半个扇区，
 * 打开工具时正对着你的就是 face 0。
 */
export function faceCenterAngle(i: number, sides: number): number {
  return (2 * Math.PI * i) / sides;
}

/**
 * 横截面：绕 X 轴的那个多边形，写成「各向异性的正多边形」。
 * 顶点 k 落在 (ry·sinθ, rz·cosθ)，θ = 面心角 − 半个扇区。
 *
 * ry === rz 就是外接圆半径为 r 的正多边形 —— 棱柱。
 * 四边形上让 ry ≠ rz 就是矩形 —— 卡片。两种模型共用下面所有几何代码，
 * 不用为卡片另起一套。
 */
export type Section = { sides: number; ry: number; rz: number };

export const prismSection = (sides: number, radius: number): Section => ({ sides, ry: radius, rz: radius });

/** 卡片：正面朝 +Z，高度沿 Y、厚度沿 Z。除以 √2 是因为四边形顶点在 ±45°。 */
export const cardSection = (height: number, thickness: number): Section => ({
  sides: 4,
  ry: height / Math.SQRT2,
  rz: thickness / Math.SQRT2,
});

/** 横截面第 k 个顶点，(y, z) */
export function sectionVertex(sec: Section, k: number): [number, number] {
  const half = Math.PI / sec.sides;
  const t = faceCenterAngle(k % sec.sides, sec.sides) - half;
  return [sec.ry * Math.sin(t), sec.rz * Math.cos(t)];
}

/** 侧面 i 的那条边：从顶点 i 到顶点 i+1 */
function faceEdge(sec: Section, i: number) {
  const [y0, z0] = sectionVertex(sec, i);
  const [y1, z1] = sectionVertex(sec, i + 1);
  return { y0, z0, y1, z1 };
}

/**
 * 侧面 i 朝外的单位法线。
 * 从边算，不是拿面心角凑 —— 截面各向异性之后，只有面心角是不够的。
 */
function faceNormal(sec: Section, i: number): [number, number] {
  const { y0, z0, y1, z1 } = faceEdge(sec, i);
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dy, dz) || 1;
  return [-dz / len, dy / len];
}

export type FaceFrame = {
  center: THREE.Vector3; // 面心
  normal: THREE.Vector3; // 朝外法线
  u: THREE.Vector3; // 贴图 u 增大方向 = 棱柱长度方向 (+X)
  v: THREE.Vector3; // 贴图 v 增大方向 = 圆周切线
  width: number; // u 方向的物理长度 = 棱柱长度
  height: number; // v 方向的物理长度 = 弦长
};

export function faceFrame(i: number, sec: Section, length: number): FaceFrame {
  const { y0, z0, y1, z1 } = faceEdge(sec, i);
  const [ny, nz] = faceNormal(sec, i);
  const dy = y1 - y0;
  const dz = z1 - z0;
  const edge = Math.hypot(dy, dz);
  return {
    center: new THREE.Vector3(0, (y0 + y1) / 2, (z0 + z1) / 2),
    normal: new THREE.Vector3(0, ny, nz),
    u: new THREE.Vector3(1, 0, 0),
    // v 沿圆周切线，方向和顶点 i → i+1 一致（贴图的上下就是靠它定的）
    v: new THREE.Vector3(0, dy / (edge || 1), dz / (edge || 1)),
    width: length,
    height: edge,
  };
}

/** 单个侧面 —— 一个独立 mesh、一个独立材质、UV 干净地 0→1 满铺。 */
/**
 * 侧面。`face` 决定生成外面还是内面 —— 内面是独立的一组三角形，挂自己的贴图。
 *
 * 为什么在**几何**里做，而不是把材质设成 DoubleSide：
 * USD 格式本身是支持双面的 —— `doubleSided` 就是 UsdGeomGprim 的标准属性。
 * 但 three 的 USDZExporter **不写这个属性**（遇到 DoubleSide 材质只会 console.warn 一句），
 * 所以从它导出的文件里几何仍然是单面。补一组反向三角形不依赖导出器的支持，
 * 而且反面可以挂自己的材质 —— 正反两面用不同的图，这是 doubleSided 做不到的。
 */
export function sideGeometry(
  i: number,
  sec: Section,
  length: number,
  face: 'outer' | 'inner' = 'outer',
): THREE.BufferGeometry {
  const half = Math.PI / sec.sides;
  const hl = length / 2;
  const { y0, z0, y1, z1 } = faceEdge(sec, i);
  const [ny, nz] = faceNormal(sec, i);

  // 从外部看：u 沿 +X 向右，v 沿圆周向上
  const positions = new Float32Array([
    -hl, y0, z0, // u0 v0
    hl, y0, z0, // u1 v0
    hl, y1, z1, // u1 v1
    -hl, y1, z1, // u0 v1
  ]);
  const normals = new Float32Array([0, ny, nz, 0, ny, nz, 0, ny, nz, 0, ny, nz]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

  const g = new THREE.BufferGeometry();
  if (face === 'outer') {
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  // 内面：法线翻过来、绕序反过来，这样只有从里面才看得见。
  // u 左右镜像 —— 从里面看这个面，左右本来就是反的，不镜像贴上去的图就是反的。
  //
  // **必须沿法线往里让开一点**：内面和外面如果顶点完全重合，就是一层贴在另一层上，
  // 谁在前面完全看渲染器的深度判定。three 靠背面剔除看不出问题，
  // 但 Keynote 里会随机显示成内壁 —— 看起来就像摄像机跑进了模型内部。
  // 让开的量取半径的千分之二，肉眼看不出厚度，又足够拉开深度差。
  //
  // 让开的方式很讲究：**不能把四边形整块沿自己的法线平移**。相邻两个面的法线方向不同，
  // 同一个棱上的顶点被推向两个方向，棱上就裂开一条缝（四棱柱是半径的 0.28%），
  // 没有端面时能透过这条缝看见内壁 —— 表现就是模型每条边上一道浅色虚线。
  // 正确做法是让内面落在一个**同心的小一圈棱柱**上：面到轴的距离减 gap，
  // 对应外接圆半径减 gap/cos(half)。这样相邻内面仍然共用棱上的顶点，缝就不存在。
  // 两个半轴各自缩同样的量，每个面的平面就都往里让开 gap（矩形截面同样成立）。
  // gap 取较短那个半轴的千分之二 —— 卡片很薄时不能让开得比它自己还厚。
  const gap = Math.min(sec.ry, sec.rz) * 0.002;
  const shrink = gap / Math.cos(half);
  const inner: Section = { sides: sec.sides, ry: sec.ry - shrink, rz: sec.rz - shrink };
  const [iy0, iz0] = sectionVertex(inner, i);
  const [iy1, iz1] = sectionVertex(inner, i + 1);
  const inset = new Float32Array([
    -hl, iy0, iz0,
    hl, iy0, iz0,
    hl, iy1, iz1,
    -hl, iy1, iz1,
  ]);
  const inv = new Float32Array(12);
  for (let k = 0; k < 12; k++) inv[k] = -normals[k];
  const uvMirror = new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]);
  g.setAttribute('position', new THREE.BufferAttribute(inset, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(inv, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvMirror, 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/** 端面：中心点 + N 个扇形三角形，法线 ±X。 */
export function capGeometry(
  sec: Section,
  length: number,
  right: boolean,
): THREE.BufferGeometry {
  const sides = sec.sides;
  const x = right ? length / 2 : -length / 2;
  const positions: number[] = [x, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  // 贴图朝向：图片的「上」对着模型的 +Y，也就是默认正视时端面的下边缘 = 图片的下边缘。
  // 原来写的是 u 跟着 y、v 跟着 z，等于把整张图转了 90°。
  // 横轴要跟着从外面看这个端面时的「右手边」：从 +X 往里看，右手边是 -Z；
  // 从 -X 往里看，右手边是 +Z。搞反了图就是镜像的。
  const uSign = right ? -1 : 1;
  for (let i = 0; i < sides; i++) {
    const [y, z] = sectionVertex(sec, i);
    positions.push(x, y, z);
    uvs.push(0.5 + uSign * (z / sec.rz) * 0.5, 0.5 + (y / sec.ry) * 0.5);
  }
  const index: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % sides);
    // (center, a, b) 且角度递增 → 法线 -X，所以右端面要反过来绕
    if (right) index.push(0, b, a);
    else index.push(0, a, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  const n = right ? [1, 0, 0] : [-1, 0, 0];
  const normals: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) normals.push(n[0], n[1], n[2]);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return g;
}

/**
 * 卡片专用几何：圆角矩形沿厚度方向拉出来。
 *
 * 为什么不能沿用「横截面」那一套：横截面是绕 X 轴的截面，沿 X 拉伸出来的形状
 * 在长度方向上处处相同。而卡片的圆角在**正面这个平面里**（XY 平面），
 * 拉伸方向反过来了 —— 只能单独建。
 *
 * 返回三块：正面、背面、一圈侧边。正面朝 +Z，和四棱柱模式下的面 0 一致，
 * 所以 faceFrame 那套拖拽/缩放的坐标系原样能用。
 */
export function cardGeometry(width: number, height: number, thickness: number, corner: number) {
  const hw = width / 2;
  const hh = height / 2;
  const hz = thickness / 2;
  const r = Math.max(0, Math.min(corner, Math.min(hw, hh)));
  const pts = roundedRect(hw, hh, r);

  const front = faceOfOutline(pts, hz, hw, hh, true);
  const back = faceOfOutline(pts, -hz, hw, hh, false);
  const band = bandOfOutline(pts, hz);
  return { front, back, band };
}

/** 圆角矩形的轮廓点，逆时针（从 +Z 方向看），起点在右下角那段圆弧 */
function roundedRect(hw: number, hh: number, r: number): [number, number][] {
  if (r <= 1e-9) {
    return [
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
      [-hw, -hh],
    ];
  }
  // 圆角越大、卡片越大，分段就要越多，否则边缘看得出棱
  const seg = Math.max(4, Math.min(24, Math.round(r / Math.max(hw, hh) * 120) + 4));
  const centers: [number, number, number][] = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  const out: [number, number][] = [];
  for (const [cx, cy, a0] of centers) {
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (Math.PI / 2) * (k / seg);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return out;
}

/** 把轮廓做成一个平面：从中心扇形三角化，UV 按外接矩形铺满 */
function faceOfOutline(
  pts: [number, number][],
  z: number,
  hw: number,
  hh: number,
  front: boolean,
): THREE.BufferGeometry {
  const n = pts.length;
  const position: number[] = [0, 0, z];
  // 背面按「左右翻」贴：u 镜像、v 不变。
  // 也就是说，把卡片像翻书一样左右翻过来，背面的图是正的、头朝上。
  // 配套的是 faceOn(CARD_BACK) 也走左右翻（绕 Y 转半圈）——
  // 两边必须是同一种翻法，否则点一下「背」看到的图就是倒的。
  // （物理上本来就这样：把一张真卡片上下颠着翻，背面当然是倒的。）
  const uOf = (x: number) => (front ? 0.5 + x / (2 * hw) : 0.5 - x / (2 * hw));
  const vOf = (y: number) => 0.5 + y / (2 * hh);
  const uv: number[] = [0.5, 0.5];
  for (const [x, y] of pts) {
    position.push(x, y, z);
    uv.push(uOf(x), vOf(y));
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % n);
    if (front) index.push(0, a, b);
    else index.push(0, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const nz = front ? 1 : -1;
  const normal: number[] = [];
  for (let i = 0; i < position.length / 3; i++) normal.push(0, 0, nz);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setIndex(index);
  return g;
}

/** 沿轮廓围一圈侧边 */
function bandOfOutline(pts: [number, number][], hz: number): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // 轮廓是逆时针，边 (i → i+1) 的朝外法线是 (dy, -dx)
    const nx = dy / len;
    const ny = -dx / len;
    const base = position.length / 3;
    position.push(x0, y0, hz, x1, y1, hz, x1, y1, -hz, x0, y0, -hz);
    for (let k = 0; k < 4; k++) normal.push(nx, ny, 0);
    uv.push(0, 1, 1, 1, 1, 0, 0, 0);
    // 绕序要让法线朝外：(A,C,B) 和 (A,D,C)
    index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}
