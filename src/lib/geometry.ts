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

export type FaceFrame = {
  center: THREE.Vector3; // 面心
  normal: THREE.Vector3; // 朝外法线
  u: THREE.Vector3; // 贴图 u 增大方向 = 棱柱长度方向 (+X)
  v: THREE.Vector3; // 贴图 v 增大方向 = 圆周切线
  width: number; // u 方向的物理长度 = 棱柱长度
  height: number; // v 方向的物理长度 = 弦长
};

export function faceFrame(i: number, sides: number, radius: number, length: number): FaceFrame {
  const a = faceCenterAngle(i, sides);
  const half = Math.PI / sides;
  const normal = new THREE.Vector3(0, Math.sin(a), Math.cos(a));
  const center = normal.clone().multiplyScalar(radius * Math.cos(half));
  return {
    center,
    normal,
    u: new THREE.Vector3(1, 0, 0),
    v: new THREE.Vector3(0, Math.cos(a), -Math.sin(a)),
    width: length,
    height: 2 * radius * Math.sin(half),
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
  sides: number,
  radius: number,
  length: number,
  face: 'outer' | 'inner' = 'outer',
): THREE.BufferGeometry {
  const a = faceCenterAngle(i, sides);
  const half = Math.PI / sides;
  const hl = length / 2;
  const a0 = a - half;
  const a1 = a + half;
  const y0 = radius * Math.sin(a0);
  const z0 = radius * Math.cos(a0);
  const y1 = radius * Math.sin(a1);
  const z1 = radius * Math.cos(a1);
  const ny = Math.sin(a);
  const nz = Math.cos(a);

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
  const gap = radius * 0.002;
  const inset = new Float32Array(12);
  for (let k = 0; k < 4; k++) {
    inset[k * 3] = positions[k * 3];
    inset[k * 3 + 1] = positions[k * 3 + 1] - ny * gap;
    inset[k * 3 + 2] = positions[k * 3 + 2] - nz * gap;
  }
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
  sides: number,
  radius: number,
  length: number,
  right: boolean,
): THREE.BufferGeometry {
  const x = right ? length / 2 : -length / 2;
  const half = Math.PI / sides;
  const positions: number[] = [x, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  for (let i = 0; i < sides; i++) {
    const ang = faceCenterAngle(i, sides) - half;
    const y = radius * Math.sin(ang);
    const z = radius * Math.cos(ang);
    positions.push(x, y, z);
    uvs.push(0.5 + (y / radius) * 0.5, 0.5 + (z / radius) * 0.5);
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
