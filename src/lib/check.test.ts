import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { zipSync } from 'fflate';
import { analyzeUsda, checkUsdz, eulerXYZToQuat, fixUsda, imageHeader, inspectZip, resolveInPackage, rotateXYZToOrient } from './check';
import { packUsdz } from './usdzExtent';

const SAMPLE = `#usda 1.0
(
\tdefaultPrim = "Root"
\tmetersPerUnit = 0.01
\tupAxis = "Z"
)

def Xform "Root"
{
\tfloat3 xformOp:rotateXYZ = (0, 90, 0)
\tfloat3 xformOp:rotateXYZ.timeSamples = {0: (0, 0, 0), 1: (0, 180, 0), 2: (0, 360, 0)}
\tdouble3 xformOp:translate:wobble = (0, 0, 0)
\tuniform token[] xformOpOrder = ["xformOp:translate:wobble", "xformOp:rotateXYZ"]

\tdef Mesh "Box"
\t{
\t\tpoint3f[] points = [(-1, -1, -1), (1, 1, 1)]
\t\tuniform bool doubleSided = 1
\t\trel material:binding = </Root/Materials/M>
\t}
\tdef Mesh "Lid"
\t{
\t\tfloat3[] extent = [(-1, -1, -1), (1, 1, 1)]
\t\tpoint3f[] points = [(-1, -1, -1), (1, 1, 1)]
\t\tpoint3f[] points.timeSamples = {0: [(-1, -1, -1), (1, 1, 1)]}
\t\tuniform token subdivisionScheme = "none"
\t}
\tdef Scope "Materials"
\t{
\t\tdef Material "M"
\t\t{
\t\t\ttoken outputs:surface.connect = </Root/Materials/M/S.outputs:surface>
\t\t\tdef Shader "S"
\t\t\t{
\t\t\t\tuniform token info:id = "UsdPreviewSurface"
\t\t\t\tcolor3f inputs:diffuseColor.connect = </Root/Materials/M/T.outputs:rgb>
\t\t\t\tnormal3f inputs:normal.connect = </Root/Materials/M/N.outputs:rgb>
\t\t\t\tfloat inputs:opacity = 1
\t\t\t\tfloat inputs:opacity.timeSamples = {0: 0, 1: 1}
\t\t\t}
\t\t\tdef Shader "T"
\t\t\t{
\t\t\t\tuniform token info:id = "UsdUVTexture"
\t\t\t\tasset inputs:file = @textures/base.png@
\t\t\t}
\t\t\tdef Shader "N"
\t\t\t{
\t\t\t\tuniform token info:id = "UsdUVTexture"
\t\t\t\tasset inputs:file = @./textures/nrm.png@
\t\t\t}
\t\t}
\t}
}

def DistantLight "Sun"
{
}
`;

/** 最小 PNG：只要文件头，尺寸 300×200，颜色类型 6（RGBA） */
function pngHeader(w: number, h: number, colorType: number): Uint8Array {
  const b = new Uint8Array(40);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x89504e47);
  dv.setUint32(4, 0x0d0a1a0a);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8;
  b[25] = colorType;
  return b;
}
/** 最小 JPEG：SOI + SOF0（高 h 宽 w） */
function jpegHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(20);
  const dv = new DataView(b.buffer);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xc0;
  dv.setUint16(4, 17);
  b[6] = 8;
  dv.setUint16(7, h);
  dv.setUint16(9, w);
  return b;
}

describe('analyzeUsda', () => {
  const f = analyzeUsda(SAMPLE);
  it('头部元数据和顶层 prim', () => {
    expect(f.defaultPrim).toBe('Root');
    expect(f.upAxis).toBe('Z');
    expect(f.metersPerUnit).toBe(0.01);
    expect(f.topPrims).toEqual(['Root', 'Sun']);
  });
  it('数出各类问题', () => {
    expect(f.suffixedOps).toBe(1);
    expect(f.rotateXYZAnimated).toBe(1);
    expect(f.xformAnimated).toBe(1);
    expect(f.materialAnimated).toBe(1);
    expect(f.vertexAnimated).toBe(1);
    expect(f.doubleSided).toBe(1);
    expect(f.meshes).toBe(2);
    expect(f.meshesWithoutExtent).toBe(1);
    expect(f.meshesWithoutSubdiv).toBe(1);
    expect(f.lights).toBe(1);
  });
  it('贴图用在哪个输入上', () => {
    expect(f.textureRoles['textures/base.png']).toEqual(['diffuseColor']);
    expect(f.textureRoles['./textures/nrm.png']).toEqual(['normal']);
    expect(f.assets).toEqual(['textures/base.png', './textures/nrm.png']);
  });
});

describe('rotateXYZ → orient', () => {
  it('四元数和 three 的 ZYX 一致', () => {
    const q = eulerXYZToQuat(10, 20, 30);
    const d = THREE.MathUtils.degToRad;
    const ref = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(10), d(20), d(30), 'ZYX'));
    expect(q[0]).toBeCloseTo(ref.w, 9);
    expect(q[1]).toBeCloseTo(ref.x, 9);
    expect(q[2]).toBeCloseTo(ref.y, 9);
    expect(q[3]).toBeCloseTo(ref.z, 9);
  });
  it('改写采样、静态值和 xformOpOrder，相邻帧同号', () => {
    const r = rotateXYZToOrient(SAMPLE);
    expect(r.count).toBe(1);
    expect(r.text).not.toMatch(/rotateXYZ/);
    expect(r.text).toMatch(/quatf xformOp:orient = \(0\.707107, 0, 0\.707107, 0\)/);
    // 0° → (1,0,0,0)，180° → (0,0,1,0)，360° → (-1,0,0,0) 翻成同号后仍连续
    expect(r.text).toMatch(/quatf xformOp:orient\.timeSamples = \{0: \(1, 0, 0, 0\), 1: \(0, 0, 1, 0\), 2: \(-1, 0, 0, 0\)\}/);
    expect(r.text).toMatch(/xformOpOrder = \["xformOp:translate:wobble", "xformOp:orient"\]/);
  });
  it('没有旋转动画就不动', () => {
    const s = SAMPLE.replace(/.*rotateXYZ\.timeSamples.*\n/, '');
    expect(rotateXYZToOrient(s).count).toBe(0);
    expect(rotateXYZToOrient(s).text).toBe(s);
  });
});

describe('fixUsda', () => {
  it('去后缀、补 extent、改 orient，缺 defaultPrim 就补', () => {
    const noDp = SAMPLE.replace(/\tdefaultPrim = "Root"\n/, '');
    const r = fixUsda(noDp, true);
    expect(r.fixes).toEqual({ 'xformop-suffix': 1, extent: 1, 'default-prim': 1, 'rotate-xyz-anim': 1 });
    expect(r.text).toMatch(/^#usda 1\.0\n\(\n\tdefaultPrim = "Root"\n/);
    expect(r.text).toMatch(/xformOp:translate = \(0, 0, 0\)/);
    expect(r.text).not.toMatch(/translate:wobble/);
    expect(analyzeUsda(r.text).meshesWithoutExtent).toBe(0);
  });
});

describe('图片文件头', () => {
  it('PNG 读尺寸和 alpha', () => {
    expect(imageHeader(pngHeader(300, 200, 6))).toEqual({ format: 'png', width: 300, height: 200, alphaChannel: true });
    expect(imageHeader(pngHeader(4096, 4096, 2)).alphaChannel).toBe(false);
  });
  it('JPEG 读尺寸', () => {
    expect(imageHeader(jpegHeader(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480, alphaChannel: false });
  });
  it('别的格式', () => {
    expect(imageHeader(new Uint8Array([1, 2, 3, 4, 5])).format).toBe('other');
  });
});

describe('zip 结构', () => {
  const files = { 'model.usda': new TextEncoder().encode(SAMPLE), 'textures/base.png': pngHeader(8, 8, 6) };
  it('packUsdz 出来的：不压缩、对齐、顺序对', () => {
    const z = inspectZip(packUsdz(files));
    expect(z).toEqual({ compressed: 0, misaligned: 0, order: ['model.usda', 'textures/base.png'] });
  });
  it('普通 zip：压缩了、没对齐', () => {
    const z = inspectZip(zipSync(files, { level: 6 }));
    expect(z.compressed).toBe(2);
    expect(z.misaligned).toBeGreaterThan(0);
  });
});

describe('resolveInPackage', () => {
  it('相对路径按图层所在目录解析', () => {
    expect(resolveInPackage('model.usda', './textures/a.png')).toBe('textures/a.png');
    expect(resolveInPackage('layers/b.usda', '../textures/a.png')).toBe('textures/a.png');
    expect(resolveInPackage('model.usda', 'geo.usdc[/x]')).toBe('geo.usdc');
  });
});

describe('checkUsdz', () => {
  const files = {
    'model.usda': new TextEncoder().encode(SAMPLE),
    'textures/base.png': pngHeader(5000, 5000, 2),
    'textures/nrm.png': pngHeader(1024, 1024, 6),
    'textures/unused.jpg': jpegHeader(64, 64),
  };
  const r = checkUsdz(packUsdz(files));
  const ids = r.findings.map((f) => f.id);
  it('报出每一类问题，坏的排前面', () => {
    expect(ids.slice(0, 1)).toEqual(['xformop-suffix']);
    for (const id of ['rotate-xyz-anim', 'material-anim', 'vertex-anim', 'anim-clock', 'extent', 'double-sided', 'subdiv', 'lights-cameras', 'texture-huge', 'texture-opaque-png']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('zip-compressed');
    expect(ids).not.toContain('missing-ref');
  });
  it('贴图表：按体积排、角色、是否被引用', () => {
    const base = r.textures.find((t) => t.name === 'textures/base.png')!;
    expect(base.roles).toEqual(['diffuseColor']);
    expect(base.width).toBe(5000);
    expect(base.unreferenced).toBe(false);
    expect(r.textures.find((t) => t.name === 'textures/nrm.png')!.roles).toEqual(['normal']);
    expect(r.textures.find((t) => t.name === 'textures/unused.jpg')!.unreferenced).toBe(true);
  });
  it('元数据', () => {
    expect(r.meta).toEqual({ defaultPrim: 'Root', upAxis: 'Z', metersPerUnit: 0.01, rootBinary: false });
    expect(r.layers).toEqual([{ name: 'model.usda', binary: false, bytes: files['model.usda'].length }]);
  });
  it('引用缺失的文件', () => {
    const { 'textures/nrm.png': _drop, ...rest } = files;
    void _drop;
    const r2 = checkUsdz(packUsdz(rest));
    const m = r2.findings.find((f) => f.id === 'missing-ref')!;
    expect(m.severity).toBe('bad');
    expect(m.detail).toContain('textures/nrm.png');
  });
  it('压缩过的 zip 会被报出来', () => {
    const r3 = checkUsdz(zipSync(files, { level: 6 }));
    expect(r3.findings.find((f) => f.id === 'zip-compressed')?.fixable).toBe(true);
  });
});
