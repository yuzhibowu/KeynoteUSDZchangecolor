import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { recolorUsdz } from './recolor';
import { DEFAULT_COMP } from './color';

const enc = (s: string) => new TextEncoder().encode(s);
const USDA = `#usda 1.0
(
\tdefaultPrim = "Root"
)
def Xform "Root"
{
\tdef Material "M"
\t{
\t\tdef Shader "PreviewSurface"
\t\t{
\t\t\tuniform token info:id = "UsdPreviewSurface"
\t\t\tcolor3f inputs:diffuseColor = (0.5, 0.2, 0.1)
\t\t}
\t}
}
`;

describe('二进制 .usdc 的提示只在里面真有材质时才出', () => {
  it('只装几何的 .usdc（three 导出器的写法）不报', async () => {
    const zip = zipSync({
      'model.usda': enc(USDA),
      'geometries/Geometry_1.usdc': new Uint8Array([0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43, 1, 2, 3, 4]),
    }, { level: 0 });
    const r = await recolorUsdz(zip.buffer as ArrayBuffer, DEFAULT_COMP);
    expect(r.report.binary).toEqual([]);
    expect(r.report.colors).toBeGreaterThan(0);
  });

  it('.usdc 里带着材质字样才报', async () => {
    const zip = zipSync({
      'model.usda': enc(USDA),
      'scene.usdc': enc('PXR-USDC....UsdPreviewSurface....diffuseColor....'),
    }, { level: 0 });
    const r = await recolorUsdz(zip.buffer as ArrayBuffer, DEFAULT_COMP);
    expect(r.report.binary).toEqual(['scene.usdc']);
  });
});
