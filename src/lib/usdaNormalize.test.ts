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
