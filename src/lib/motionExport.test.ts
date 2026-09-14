import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { expandExtents, poseToFile, stripOwnAnimation, wrapWithMotion } from './motionExport';

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
  rotate: [[0, 0, 0], [1, 0, 0.5], [0, 0, 0]],
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
  it('动画写成一行的 timeSamples，op 名不带后缀', () => {
    expect(r.text).toMatch(/double3 xformOp:translate\.timeSamples = \{0: \(0, 0, 0\), 1: \(0, 0\.1, 0\), 2: \(0, 0, 0\)\}/);
    expect(r.text).toMatch(/float3 xformOp:rotateXYZ\.timeSamples = \{0: \(0, 0, 0\), 1: \(1, 0, 0\.5\), 2: \(0, 0, 0\)\}/);
    expect(r.text).toMatch(/xformOpOrder = \["xformOp:translate", "xformOp:rotateXYZ"\]/);
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
    const f = poseToFile({ position: [0, 0.2, 0], rotation: [1, 0, 0.5] }, new THREE.Vector3(), I, I);
    expect(f.translate.map((v) => +v.toFixed(6))).toEqual([0, 0.2, 0]);
    expect(f.rotate.map((v) => +v.toFixed(4))).toEqual([1, 0, 0.5]);
  });
  it('中心不在原点：平移里补上 c − R·c，绕中心转的点回到原位', () => {
    const c = new THREE.Vector3(3, 4, 5);
    const f = poseToFile({ position: [0, 0, 0], rotation: [0, 90, 0] }, c, I, I);
    // 中心点自己经过变换后还在原地
    const p = c.clone().applyMatrix4(f.matrix);
    expect(p.distanceTo(c)).toBeLessThan(1e-9);
    expect(f.rotate.map((v) => +v.toFixed(4))).toEqual([0, 90, 0]);
  });
  it('metersPerUnit 缩放和 Z-up 转换都被换算回文件坐标', () => {
    // 加载器：先绕 X 转 -90°（Z-up → Y-up），再缩放 0.01
    const G = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01));
    const Ginv = G.clone().invert();
    const f = poseToFile({ position: [0, 0.02, 0], rotation: [0, 0, 0] }, new THREE.Vector3(), G, Ginv);
    // three 里往上（+Y）挪 0.02，文件里是 Z-up 单位 cm：+Z 挪 2
    expect(f.translate.map((v) => +v.toFixed(6))).toEqual([0, 0, 2]);
  });
});
