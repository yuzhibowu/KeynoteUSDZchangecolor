import { describe, it, expect } from 'vitest';
import { recolorUsda } from './recolor';
import { DEFAULT_COMP } from './color';

const surface = (body: string) => `def Shader "PreviewSurface"
\t\t{
\t\t\tuniform token info:id = "UsdPreviewSurface"
${body}
\t\t\ttoken outputs:surface
\t\t}`;

describe('给现成的 usdz 做颜色校正', () => {
  it('写死的漫反射色会被补偿，而且还是线性值', () => {
    const src = surface('\t\t\tcolor3f inputs:diffuseColor = (0.5, 0.1, 0.05)');
    const { text, colors } = recolorUsda(src, DEFAULT_COMP);
    expect(colors).toBe(1);
    const m = /diffuseColor = \(([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(text)!;
    const v = [+m[1], +m[2], +m[3]];
    // 补偿是「反着推」，红色会被压暗 —— 不该原样不动，也不该跑出 0..1
    expect(v[0]).not.toBeCloseTo(0.5, 3);
    for (const x of v) expect(x).toBeGreaterThanOrEqual(0);
    for (const x of v) expect(x).toBeLessThanOrEqual(1);
  });

  it('接了贴图的材质，自发光连到同一张贴图上', () => {
    const src = surface(
      '\t\t\tcolor3f inputs:diffuseColor.connect = </Materials/M/Tex.outputs:rgb>',
    );
    const { text, emissive } = recolorUsda(src, DEFAULT_COMP);
    expect(emissive).toBe(1);
    expect(text).toContain('inputs:emissiveColor.connect = </Materials/M/Tex.outputs:rgb>');
  });

  it('作者本来就写了自发光的，不去动它', () => {
    const src = surface(
      '\t\t\tcolor3f inputs:diffuseColor = (0.5, 0.1, 0.05)\n\t\t\tcolor3f inputs:emissiveColor = (1, 0, 0)',
    );
    const { text, emissive } = recolorUsda(src, DEFAULT_COMP);
    expect(emissive).toBe(0);
    expect(text).toContain('inputs:emissiveColor = (1, 0, 0)');
  });

  it('不是 PreviewSurface 的 Shader 一律不碰', () => {
    const src = `def Shader "Tex"
\t\t{
\t\t\tuniform token info:id = "UsdUVTexture"
\t\t\tcolor3f inputs:diffuseColor = (0.5, 0.1, 0.05)
\t\t\ttoken outputs:surface
\t\t}`;
    const { emissive } = recolorUsda(src, DEFAULT_COMP);
    expect(emissive).toBe(0);
  });
});
