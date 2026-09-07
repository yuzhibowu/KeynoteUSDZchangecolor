import { describe, it, expect } from 'vitest';
import { normalizeUsda } from './usdaNormalize';

describe('USDA 排版规范化', () => {
  it('把挤在一行的 def 头部摊开', () => {
    const src = 'def Mesh "FrontCover" (prepend apiSchemas = ["MaterialBindingAPI"]) {\npoint3f[] points = [(0,0,0)]\n}';
    const out = normalizeUsda(src);
    expect(out).toContain('def Mesh "FrontCover" (');
    expect(out).toMatch(/\)\n\{/);
    expect(out).toContain('prepend apiSchemas = ["MaterialBindingAPI"]');
  });

  it('没有括号块的也把大括号另起一行', () => {
    expect(normalizeUsda('def Xform "Book" {')).toMatch(/def Xform "Book"\s*\n\{/);
  });

  it('文件头的括号单独成行', () => {
    const out = normalizeUsda('#usda 1.0\n(defaultPrim = "Book"\nupAxis = "Y")\n');
    expect(out).toMatch(/^#usda 1\.0\n\(\n/);
    expect(out).toMatch(/upAxis = "Y"\n\)/);
  });

  // 这条是重点：timeSamples 的值本身就带大括号，拆开就把值切碎了
  it('不能去动值里面的大括号', () => {
    const src = 'double3 xformOp:translate.timeSamples = {0:(0,0,0),60:(0,0.0042,0)}';
    expect(normalizeUsda(src)).toBe(src);
  });
});

describe('别碰动画数据', () => {
  // 真实文件里踩到的：timeSamples 的最后一行以 `)` 结尾，
  // 如果把「行尾的 ) 拆到下一行」这条规则放开到全文，坐标值会被从中间切断
  it('timeSamples 里以 ) 结尾的行不能被拆开', () => {
    const src = `#usda 1.0
(
    defaultPrim = "M"
)

def Xform "M"
{
    double3 xformOp:translate.timeSamples = {
        0: (0, 0, 0),
        240: (0, 0, 0)
    }
}`;
    const out = normalizeUsda(src);
    expect(out).toContain('240: (0, 0, 0)\n');
    expect(out).not.toMatch(/240: \(0, 0, 0\n/);
  });
});

describe('属性行尾的括号元数据', () => {
  // 真实文件里踩到的（正面千面英雄-3d.usdz）：
  //   texCoord2f[] primvars:st = [(0,1),(1,1)] (interpolation = "faceVarying")
  // 解析器按第一个 = 切左右，右边整段当值，括号那一截混进数组 → JSON.parse 崩 →
  // 退到「只去方括号」的兜底，每对坐标的第一个数变成 NaN，贴图一个像素都采不到。
  it('摊到下一行，值本身不动', () => {
    const src = `#usda 1.0
(
    defaultPrim = "M"
)

def Mesh "M"
{
    texCoord2f[] primvars:st = [(0,1),(1,1),(1,0)] (interpolation = "faceVarying")
}`;
    const out = normalizeUsda(src);
    expect(out).toContain('texCoord2f[] primvars:st = [(0,1),(1,1),(1,0)] (\n');
    expect(out).toContain('interpolation = "faceVarying"');
    expect(out).not.toMatch(/\] \(interpolation/);
  });

  it('值本身就是括号向量的行不能碰', () => {
    const src = `#usda 1.0
(
    defaultPrim = "M"
)

def Xform "M"
{
    float3 xformOp:translate = (0, 0, 0)
}`;
    expect(normalizeUsda(src)).toContain('float3 xformOp:translate = (0, 0, 0)\n');
  });
});
