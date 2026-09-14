import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { alignQuaternions, binaryRootLayer, expandExtents, neutralizeOwnWrapper, poseToFile, rebaseFrames, startName, stripOwnAnimation, unwrapDegrees, wrapWithMotion } from './motionExport';

const SAMPLE = `#usda 1.0
(
\tdefaultPrim = "Root"
\tmetersPerUnit = 1
\tupAxis = "Y"
)

def Xform "Root" (
\tkind = "component"
)
{
\tdef Mesh "Box" (
\t\tprepend apiSchemas = ["MaterialBindingAPI"]
\t)
\t{
\t\tfloat3[] extent = [(-1, -1, -1), (1, 1, 1)]
\t\trel material:binding = </Root/Materials/M>
\t}
\tdef Scope "Materials"
\t{
\t\tdef Material "M"
\t\t{
\t\t\ttoken outputs:surface.connect = </Root/Materials/M/S.outputs:surface>
\t\t}
\t}
}

def DistantLight "Sun"
{
}
`;

const OPTS = {
  translate: [[0, 0, 0], [0, 0.1, 0], [0, 0, 0]],
  orient: [[1, 0, 0, 0], [0.99, 0.01, 0, 0.005], [1, 0, 0, 0]],
  fps: 60,
};

describe('wrapWithMotion', () => {
  const r = wrapWithMotion(SAMPLE, OPTS);
  it('套上新的根节点并改 defaultPrim', () => {
    expect(r.wrapper).toBe('Motion');
    expect(r.root).toBe('Root');
    expect(r.text).toMatch(/defaultPrim = "Motion"/);
    expect(r.text).toMatch(/^def Xform "Motion"\n\{/m);
    expect(r.text).toMatch(/^\tdef Xform "Root" \(/m);
  });
  it('文件头写上时间码', () => {
    expect(r.text).toMatch(/startTimeCode = 0/);
    expect(r.text).toMatch(/endTimeCode = 2/);
    expect(r.text).toMatch(/framesPerSecond = 60/);
    expect(r.text).toMatch(/timeCodesPerSecond = 60/);
  });
  it('动画写成一行的 timeSamples，op 名不带后缀，默认值等于第 0 帧', () => {
    expect(r.text).toMatch(/double3 xformOp:translate = \(0, 0, 0\)\n/);
    expect(r.text).toMatch(/double3 xformOp:translate\.timeSamples = \{0: \(0, 0, 0\), 1: \(0, 0\.1, 0\), 2: \(0, 0, 0\)\}/);
    expect(r.text).toMatch(/quatf xformOp:orient = \(1, 0, 0, 0\)\n/);
    expect(r.text).toMatch(/quatf xformOp:orient\.timeSamples = \{0: \(1, 0, 0, 0\), 1: \(0\.99, 0\.01, 0, 0\.005\), 2: \(1, 0, 0, 0\)\}/);
    expect(r.text).toMatch(/xformOpOrder = \["xformOp:translate", "xformOp:orient"\]/);
    expect(r.text).not.toMatch(/rotateXYZ/);
    expect(r.text).not.toMatch(/xformOp:\w+:\w+/);
  });
  it('绝对路径跟着搬家', () => {
    expect(r.text).toMatch(/material:binding = <\/Motion\/Root\/Materials\/M>/);
    expect(r.text).toMatch(/<\/Motion\/Root\/Materials\/M\/S\.outputs:surface>/);
    expect(r.text).not.toMatch(/<\/Root\//);
  });
  it('根节点之外的顶层 prim 不动', () => {
    expect(r.text).toMatch(/^def DistantLight "Sun"/m);
  });
  it('原来就叫 Motion 的话换个名字', () => {
    const s = SAMPLE.replace(/Root/g, 'Motion');
    const x = wrapWithMotion(s, OPTS);
    expect(x.wrapper).toBe('Motion_1');
    expect(x.text).toMatch(/<\/Motion_1\/Motion\/Materials\/M>/);
  });
  it('没有文件头也能加', () => {
    const s = SAMPLE.replace(/\(\n\tdefaultPrim[\s\S]*?\)\n/, '');
    const x = wrapWithMotion(s, OPTS);
    expect(x.text).toMatch(/^#usda 1\.0\n\(\n/);
    expect(x.text).toMatch(/defaultPrim = "Motion"/);
    expect(x.text).toMatch(/^def Xform "Motion"/m);
  });
  it('根节点自带的动画被替换、深处的会报出来', () => {
    const s = SAMPLE.replace(
      'def Xform "Root" (\n\tkind = "component"\n)\n{',
      'def Xform "Root" (\n\tkind = "component"\n)\n{\n\tdouble3 xformOp:translate.timeSamples = {0: (0, 0, 0), 1: (0, 1, 0)}\n\tfloat3 xformOp:rotateXYZ = (0, 90, 0)\n\tuniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]',
    ).replace('float3[] extent', 'double3 xformOp:translate.timeSamples = {0: (0, 0, 0)}\n\t\tfloat3[] extent');
    const x = wrapWithMotion(s, OPTS);
    expect(x.replacedAnimation).toBe(true);
    expect(x.nestedAnimation).toBe(1);
    // 根节点自己的动画没了，静态旋转留着，order 也对
    const inner = x.text.slice(x.text.indexOf('def Xform "Root"'), x.text.indexOf('def Mesh'));
    expect(inner).not.toMatch(/timeSamples/);
    expect(inner).toMatch(/xformOp:rotateXYZ = \(0, 90, 0\)/);
    expect(inner).toMatch(/xformOpOrder = \["xformOp:rotateXYZ"\]/);
  });
});

describe('stripOwnAnimation', () => {
  it('没动画就原样返回', () => {
    const r = stripOwnAnimation('def Xform "A"\n{\n\tfloat3 xformOp:rotateXYZ = (0, 0, 0)\n}');
    expect(r.stripped).toBe(false);
  });
});

describe('expandExtents', () => {
  it('每个 extent 往外扩', () => {
    const r = expandExtents('float3[] extent = [(-1, -1, -1), (1, 2, 3)]\nfloat3[] extent = [(0,0,0),(1,1,1)]', 0.5);
    expect(r.count).toBe(2);
    expect(r.text).toBe('float3[] extent = [(-1.5, -1.5, -1.5), (1.5, 2.5, 3.5)]\nfloat3[] extent = [(-0.5, -0.5, -0.5), (1.5, 1.5, 1.5)]');
  });
});

describe('poseToFile', () => {
  const I = new THREE.Matrix4();
  it('Y-up、单位 1、中心在原点：原样写出', () => {
    const f = poseToFile({ position: [0, 0.2, 0], rotation: [1, 0, 0.5], scale: 1 }, new THREE.Vector3(), I, I);
    expect(f.translate.map((v) => +v.toFixed(6))).toEqual([0, 0.2, 0]);
    expect(f.rotate.map((v) => +v.toFixed(4))).toEqual([1, 0, 0.5]);
  });
  it('中心不在原点：平移里补上 c − R·c，绕中心转的点回到原位', () => {
    const c = new THREE.Vector3(3, 4, 5);
    const f = poseToFile({ position: [0, 0, 0], rotation: [0, 90, 0], scale: 1 }, c, I, I);
    // 中心点自己经过变换后还在原地
    const p = c.clone().applyMatrix4(f.matrix);
    expect(p.distanceTo(c)).toBeLessThan(1e-9);
    expect(f.rotate.map((v) => +v.toFixed(4))).toEqual([0, 90, 0]);
  });
  it('metersPerUnit 缩放和 Z-up 转换都被换算回文件坐标', () => {
    // 加载器：先绕 X 转 -90°（Z-up → Y-up），再缩放 0.01
    const G = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01));
    const Ginv = G.clone().invert();
    const f = poseToFile({ position: [0, 0.02, 0], rotation: [0, 0, 0], scale: 1 }, new THREE.Vector3(), G, Ginv);
    // three 里往上（+Y）挪 0.02，文件里是 Z-up 单位 cm：+Z 挪 2
    expect(f.translate.map((v) => +v.toFixed(6))).toEqual([0, 0, 2]);
  });
});

describe('缩放 op', () => {
  it('给了 scale 才写，写在 order 最后', () => {
    const r = wrapWithMotion(SAMPLE, { ...OPTS, scale: [[0.001, 0.001, 0.001], [0.5, 0.5, 0.5], [1, 1, 1]] });
    expect(r.text).toMatch(/float3 xformOp:scale = \(0\.001, 0\.001, 0\.001\)\n/);
    expect(r.text).toMatch(/float3 xformOp:scale\.timeSamples = \{0: \(0\.001, 0\.001, 0\.001\), 1: \(0\.5, 0\.5, 0\.5\), 2: \(1, 1, 1\)\}/);
    expect(r.text).toMatch(/xformOpOrder = \["xformOp:translate", "xformOp:orient", "xformOp:scale"\]/);
    expect(wrapWithMotion(SAMPLE, OPTS).text).not.toMatch(/xformOp:scale/);
  });
  it('绕中心缩放：中心点不动，缩放从矩阵里分解出来', () => {
    const I = new THREE.Matrix4();
    const c = new THREE.Vector3(3, 4, 5);
    const f = poseToFile({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 0.5 }, c, I, I);
    expect(c.clone().applyMatrix4(f.matrix).distanceTo(c)).toBeLessThan(1e-9);
    expect(f.scale.map((v) => +v.toFixed(6))).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('旋入的 Y 角', () => {
  it('Y-up 文件：角度原样照抄，转过 90° 也不折', () => {
    const I = new THREE.Matrix4();
    const f = poseToFile({ position: [0, 0, 0], rotation: [0.7, 150, 0.5], scale: 1 }, new THREE.Vector3(), I, I);
    expect(f.rotate).toEqual([0.7, 150, 0.5]);
  });
  it('Z-up 文件：自转落在 Z 角上，分解后角度连续', () => {
    const G = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const Ginv = G.clone().invert();
    const ys = [0, 60, 120, 150, 179, 200, 300, 359].map(
      (y) => poseToFile({ position: [0, 0, 0], rotation: [0, y, 0], scale: 1 }, new THREE.Vector3(), G, Ginv).rotate,
    );
    // 落在 Z 上，X、Y 基本为 0
    for (const r of ys) {
      expect(Math.abs(r[0])).toBeLessThan(1e-6);
      expect(Math.abs(r[1])).toBeLessThan(1e-6);
    }
    const z = unwrapDegrees(ys).map((r) => r[2]);
    for (let i = 1; i < z.length; i++) expect(Math.abs(z[i] - z[i - 1])).toBeLessThan(120);
  });
});

describe('binaryRootLayer', () => {
  it('新根图层：抄元数据、引用二进制里的根 prim、动画写外层', () => {
    const t = binaryRootLayer(
      { defaultPrim: 'scene', upAxis: 'Y', metersPerUnit: 0.01, animatedOps: 0 },
      'scene.usdc',
      OPTS,
    );
    expect(t).toMatch(/^#usda 1\.0\n\(\n\tdefaultPrim = "Motion"\n\tupAxis = "Y"\n\tmetersPerUnit = 0\.01\n/);
    expect(t).toMatch(/endTimeCode = 2/);
    expect(t).toMatch(/def Xform "Motion"/);
    expect(t).toMatch(/def "scene" \(\n\t\tprepend references = @\.\/scene\.usdc@<\/scene>\n\t\)/);
    expect(t).toMatch(/xformOpOrder = \["xformOp:translate", "xformOp:orient"\]/);
  });
});

describe('unwrapDegrees', () => {
  it('跨过 180° 的序列变成连续的', () => {
    const r = unwrapDegrees([[0, 0, 0], [0, -12, 0], [0, -170, 0], [0, 178, 0], [0, 90, 0], [0, 0, 0]]);
    expect(r.map((v) => v[1])).toEqual([0, -12, -170, -182, -270, -360]);
  });
  it('本来就连续的不动', () => {
    const r = unwrapDegrees([[1, 0, 0.5], [0.9, 0, 0.6], [0.8, 0, 0.7]]);
    expect(r).toEqual([[1, 0, 0.5], [0.9, 0, 0.6], [0.8, 0, 0.7]]);
  });
});

describe('占位盒', () => {
  it('给了 bounds 就在 Motion 外面放一个不动的 Mesh，extent 是扫过的范围', () => {
    const r = wrapWithMotion(SAMPLE, { ...OPTS, bounds: { min: [-1, -2, -3], max: [1, 2, 3] } });
    const i = r.text.indexOf('def Xform "MotionBounds"');
    expect(i).toBeGreaterThan(r.text.indexOf('def Xform "Motion"'));
    // 在 Motion 的大括号之外（Motion 结束的 } 在它前面）
    expect(r.text.slice(0, i)).toMatch(/\n\}\n\n$/);
    expect(r.text).toMatch(/float3\[\] extent = \[\(-1, -2, -3\), \(1, 2, 3\)\]/);
    expect(r.text).toMatch(/int\[\] faceVertexIndices = \[0, 0, 0\]/);
    expect(wrapWithMotion(SAMPLE, OPTS).text).not.toMatch(/MotionBounds/);
  });
  it('再加一次动效：旧占位盒被拿掉，只剩一个', () => {
    const once = wrapWithMotion(SAMPLE, { ...OPTS, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } }).text;
    const twice = wrapWithMotion(once, { ...OPTS, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } });
    expect(twice.wrapper).toBe('Motion_1');
    expect(twice.text.match(/def Xform "MotionBounds"/g)).toHaveLength(1);
    expect(twice.text).toMatch(/extent = \[\(-2, -2, -2\), \(2, 2, 2\)\]/);
    expect(twice.replacedAnimation).toBe(true);
  });
  it('二进制根图层也放', () => {
    const t = binaryRootLayer(
      { defaultPrim: 'scene', upAxis: 'Y', metersPerUnit: 0.01, animatedOps: 0 },
      'scene.usdc',
      { ...OPTS, bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
    );
    expect(t).toMatch(/def Xform "MotionBounds"/);
    expect(t.indexOf('MotionBounds')).toBeGreaterThan(t.indexOf('scene.usdc'));
  });
});

describe('四元数', () => {
  it('poseToFile 给的是 (w, x, y, z)，Y 转 180° 是 (0, 0, 1, 0)', () => {
    const I = new THREE.Matrix4();
    const f = poseToFile({ position: [0, 0, 0], rotation: [0, 180, 0], scale: 1 }, new THREE.Vector3(), I, I);
    expect(f.orient.map((v) => +v.toFixed(6))).toEqual([0, 0, 1, 0]);
    const g = poseToFile({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, new THREE.Vector3(), I, I);
    expect(g.orient).toEqual([1, 0, 0, 0]);
  });
  it('旋入一整圈：相邻帧同号，没有一帧翻到另一侧', () => {
    const I = new THREE.Matrix4();
    const rows = [];
    for (let y = 360; y >= 0; y -= 12) {
      rows.push(poseToFile({ position: [0, 0, 0], rotation: [0.7, y, 0.5], scale: 1 }, new THREE.Vector3(), I, I).orient);
    }
    const q = alignQuaternions(rows);
    for (let i = 1; i < q.length; i++) {
      const dot = q[i].reduce((acc, v, k) => acc + v * q[i - 1][k], 0);
      expect(dot).toBeGreaterThan(0.9);
    }
  });
});

describe('起始姿态层（放映开播前 Keynote 不看动画层）', () => {
  const START = { translate: [0, -2, 0], orient: [1, 0, 0, 0], scale: [0.001, 0.001, 0.001] };
  it('动画层里面再套一层静态 Xform，第 0 帧姿态写在它身上，绝对路径多一级', () => {
    const r = wrapWithMotion(SAMPLE, { ...OPTS, start: START });
    expect(r.text).toMatch(/^def Xform "Motion"\n\{\n\tdouble3 xformOp:translate = /m);
    expect(r.text).toMatch(/\n\tdef Xform "Start"\n\t\{\n\t\tdouble3 xformOp:translate = \(0, -2, 0\)\n\t\tquatf xformOp:orient = \(1, 0, 0, 0\)\n\t\tfloat3 xformOp:scale = \(0\.001, 0\.001, 0\.001\)\n\t\tuniform token\[\] xformOpOrder = \["xformOp:translate", "xformOp:orient", "xformOp:scale"\]\n/);
    // 静态层没有 timeSamples
    const startBlock = r.text.slice(r.text.indexOf('def Xform "Start"'), r.text.indexOf('def Xform "Root"'));
    expect(startBlock).not.toMatch(/timeSamples/);
    expect(r.text).toMatch(/\n\t\tdef Xform "Root"/);
    expect(r.text).toMatch(/material:binding = <\/Motion\/Start\/Root\/Materials\/M>/);
    expect(r.text).toMatch(/<\/Motion\/Start\/Root\/Materials\/M\/S\.outputs:surface>/);
  });
  it('缩放接近 1 就不写静态 scale', () => {
    const r = wrapWithMotion(SAMPLE, { ...OPTS, start: { ...START, scale: [1, 1, 1] } });
    const startBlock = r.text.slice(r.text.indexOf('def Xform "Start"'), r.text.indexOf('def Xform "Root"'));
    expect(startBlock).not.toMatch(/scale/);
  });
  it('被套的 prim 就叫 Start 时换名', () => {
    expect(startName('Root')).toBe('Start');
    expect(startName('Start')).toBe('Start_1');
  });
  it('二进制根图层也套', () => {
    const t = binaryRootLayer({ defaultPrim: 'scene', upAxis: 'Y', metersPerUnit: 1, animatedOps: 0 }, 'scene.usdc', { ...OPTS, start: START });
    expect(t).toMatch(/\n\tdef Xform "Start"\n\t\{\n\t\tdouble3 xformOp:translate = \(0, -2, 0\)\n/);
    expect(t).toMatch(/\n\t\tdef "scene" \(\n\t\t\tprepend references = @\.\/scene\.usdc@<\/scene>\n\t\t\)\n\t\t\{\n\t\t\}\n\t\}\n\}/);
  });
  it('rebaseFrames：第 0 帧是单位变换，起始 × 相对 = 原来的每一帧', () => {
    const c = new THREE.Vector3(3, 4, 5);
    const I = new THREE.Matrix4();
    const poses = [
      { position: [0, -2, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 0.001 },
      { position: [0, -1, 0.2] as [number, number, number], rotation: [5, 40, -3] as [number, number, number], scale: 0.4 },
      { position: [0.1, 0, 0] as [number, number, number], rotation: [1, 95, 2] as [number, number, number], scale: 1 },
    ];
    const F = poses.map((p) => poseToFile(p, c, I, I).fileMatrix);
    const r = rebaseFrames(F);
    for (const v of r.translate[0]) expect(v).toBeCloseTo(0, 9);
    expect(r.orient[0].map((v) => +v.toFixed(6))).toEqual([1, 0, 0, 0]);
    expect(r.scale[0].map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
    expect(r.start.scale.map((v) => +v.toFixed(6))).toEqual([0.001, 0.001, 0.001]);
    const S = new THREE.Matrix4().compose(
      new THREE.Vector3(...r.start.translate),
      new THREE.Quaternion(r.start.orient[1], r.start.orient[2], r.start.orient[3], r.start.orient[0]),
      new THREE.Vector3(...r.start.scale),
    );
    for (let i = 0; i < F.length; i++) {
      const A = new THREE.Matrix4().compose(
        new THREE.Vector3(...r.translate[i]),
        new THREE.Quaternion(r.orient[i][1], r.orient[i][2], r.orient[i][3], r.orient[i][0]),
        new THREE.Vector3(...r.scale[i]),
      );
      const back = A.multiply(S);
      for (let k = 0; k < 16; k++) expect(back.elements[k]).toBeCloseTo(F[i].elements[k], 6);
    }
  });
});

describe('再套一次：起始姿态层要清掉', () => {
  const START = { translate: [0, -2, 0], orient: [1, 0, 0, 0], scale: [0.001, 0.001, 0.001] };
  it('上一次的 Start 层和动画层都变成没有 op 的空壳，新的套在外面', () => {
    const once = wrapWithMotion(SAMPLE, { ...OPTS, start: START, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } }).text;
    const twice = wrapWithMotion(once, { ...OPTS, start: { ...START, translate: [0, -3, 0] }, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } });
    expect(twice.wrapper).toBe('Motion_1');
    expect(twice.replacedAnimation).toBe(true);
    // 只剩新的一套：一处 0.001 缩放、一处 timeSamples 的 translate
    expect(twice.text.match(/xformOp:scale = \(0\.001, 0\.001, 0\.001\)/g)).toHaveLength(1);
    expect(twice.text.match(/xformOp:translate\.timeSamples/g)).toHaveLength(1);
    expect(twice.text.match(/xformOpOrder/g)).toHaveLength(2);
    // 旧的 Motion 和它的 Start 还在，但都是空壳
    const oldMotion = twice.text.slice(twice.text.indexOf('\tdef Xform "Motion"'), twice.text.indexOf('def Xform "Root"'));
    expect(oldMotion).toMatch(/def Xform "Start"/);
    expect(oldMotion).not.toMatch(/xformOp/);
    expect(twice.text).toMatch(/<\/Motion_1\/Start\/Motion\/Start\/Root\/Materials\/M>/);
  });
  it('不是我们套的就不认', () => {
    expect(neutralizeOwnWrapper(SAMPLE.slice(SAMPLE.indexOf('def Xform "Root"')))).toBeNull();
  });
});
