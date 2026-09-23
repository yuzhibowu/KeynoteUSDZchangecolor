import { describe, it, expect } from 'vitest';
import { addExtents, stripInertClearcoat } from './usdzExtent';

const mesh = (name: string, pts: string, extra = '') => `def Mesh "${name}"
\t{
\t\tint[] faceVertexCounts = [4]
\t\tpoint3f[] points = [${pts}]${extra}
\t}
`;

describe('给 Mesh 补 extent', () => {
  it('从 points 算出真实包围盒', () => {
    const out = addExtents(mesh('m', '(-1, 0, 2), (3, -4, 0), (0, 5, -6)'));
    expect(out).toContain('float3[] extent = [(-1, -4, -6), (3, 5, 2)]');
  });

  it('多个 Mesh 各算各的', () => {
    const src = mesh('a', '(0, 0, 0), (1, 1, 1)') + mesh('b', '(-2, -2, -2), (0, 0, 0)');
    const out = addExtents(src);
    expect(out).toContain('extent = [(0, 0, 0), (1, 1, 1)]');
    expect(out).toContain('extent = [(-2, -2, -2), (0, 0, 0)]');
    expect((out.match(/extent = /g) ?? []).length).toBe(2);
  });

  it('已经有 extent 的不重复加', () => {
    const src = mesh('m', '(0, 0, 0), (1, 1, 1)', '\n\t\tfloat3[] extent = [(0, 0, 0), (1, 1, 1)]');
    const out = addExtents(src);
    expect((out.match(/extent = /g) ?? []).length).toBe(1);
  });

  it('没有 points 的块不动它', () => {
    const src = 'def Mesh "empty"\n\t{\n\t\tint[] faceVertexCounts = [4]\n\t}\n';
    expect(addExtents(src)).toBe(src);
  });

  it('不碰 Mesh 以外的东西', () => {
    const src = `def Material "M"
\t{
\t\tcolor3f inputs:diffuseColor = (1, 0, 0)
\t}
` + mesh('m', '(0, 0, 0), (2, 2, 2)');
    const out = addExtents(src);
    expect(out).toContain('def Material "M"');
    expect((out.match(/extent = /g) ?? []).length).toBe(1);
  });

  it('保留原有内容，只是插了一行', () => {
    const src = mesh('m', '(0, 0, 0), (1, 2, 3)');
    const out = addExtents(src);
    expect(out).toContain('int[] faceVertexCounts = [4]');
    expect(out).toContain('point3f[] points =');
    expect(out.length).toBeGreaterThan(src.length);
  });

  it('科学计数法和负号都能解析', () => {
    const out = addExtents(mesh('m', '(-1.5e-2, 0, 0), (1, 1, 1)'));
    expect(out).toContain('extent = [(-0.015, 0, 0), (1, 1, 1)]');
  });
});

describe('删掉不起作用的 clearcoat / ior', () => {
  const mat = (cc: string) => `def Shader "PreviewSurface"
\t\t{
\t\t\tfloat inputs:roughness = 0.18
\t\t\tfloat inputs:metallic = 1
${cc}\t\t\tint inputs:useSpecularWorkflow = 0
\t\t}`;

  it('clearcoat 为 0 时，连同 clearcoatRoughness 和 ior 一起删掉', () => {
    const src = mat('\t\t\tfloat inputs:clearcoat = 0\n\t\t\tfloat inputs:clearcoatRoughness = 0\n\t\t\tfloat inputs:ior = 1.5\n');
    const out = stripInertClearcoat(src);
    expect(out).not.toContain('clearcoat');
    expect(out).not.toContain('ior');
    expect(out).toContain('inputs:metallic = 1');
    expect(out).toContain('useSpecularWorkflow');
  });

  it('clearcoat 真的大于 0 就原样留着', () => {
    const src = mat('\t\t\tfloat inputs:clearcoat = 1\n\t\t\tfloat inputs:clearcoatRoughness = 0.05\n\t\t\tfloat inputs:ior = 1.5\n');
    expect(stripInertClearcoat(src)).toBe(src);
  });
});

describe('clearcoat 真的大于 0 时不许动', () => {
  const mat = (cc: string) =>
    [
      '\t\tdef Shader "PreviewSurface"',
      '\t\t{',
      '\t\t\tfloat inputs:roughness = 0.4',
      '\t\t\tfloat inputs:opacity = 1',
      `\t\t\tfloat inputs:clearcoat = ${cc}`,
      '\t\t\tfloat inputs:clearcoatRoughness = 0.15',
      '\t\t\tfloat inputs:ior = 1.5',
      '\t\t\tint inputs:useSpecularWorkflow = 0',
      '\t\t}',
    ].join('\n');

  /**
   * 2026-09-23 的真事故：`= 0` 没锚定行尾，匹配上了 `0.6` 里的那个 0，
   * 整行被删、只剩 `.6` 粘到上一行 —— 文件里成了 `opacity = 1.6`（不合法），
   * 塑料的清漆被整条吞掉。卡片背面挂塑料时才现形。
   */
  it('塑料（0.6）原样保留，opacity 不许被粘上东西', () => {
    const out = stripInertClearcoat(mat('0.6'));
    expect(out).toContain('float inputs:clearcoat = 0.6');
    expect(out).toContain('float inputs:opacity = 1\n');
    expect(out).not.toContain('opacity = 1.6');
  });

  it('玻璃（1）原样保留', () => {
    expect(stripInertClearcoat(mat('1'))).toContain('float inputs:clearcoat = 1');
  });

  it('真的是 0 才删，连着 clearcoatRoughness 和 ior 一起删', () => {
    const out = stripInertClearcoat(mat('0'));
    expect(out).not.toContain('clearcoat');
    expect(out).not.toContain('inputs:ior');
    expect(out).toContain('float inputs:opacity = 1');
    expect(out).toContain('float inputs:roughness = 0.4');
  });

  it('写成 0.0 也算 0', () => {
    expect(stripInertClearcoat(mat('0.0'))).not.toContain('clearcoat');
  });
});
