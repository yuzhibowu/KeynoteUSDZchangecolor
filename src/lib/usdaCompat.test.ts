import { describe, it, expect } from 'vitest';
import { fixXformOpNamespaces } from './usdaCompat';

describe('xformOp 命名空间兼容性修复', () => {
  const doc = (ops: string, order: string) => `def Xform "M"
{
${ops}
    uniform token[] xformOpOrder = [${order}]
}`;

  it('把带后缀的 op 改成标准名，声明和 xformOpOrder 一起改', () => {
    const src = doc(
      '    double3 xformOp:translate:microMotion.timeSamples = { 0: (0,0,0) }\n' +
        '    float3 xformOp:scale:microMotion.timeSamples = { 0: (1,1,1) }',
      '"xformOp:translate:microMotion", "xformOp:scale:microMotion"',
    );
    const { text, count } = fixXformOpNamespaces(src);
    expect(count).toBe(2);
    expect(text).not.toContain('microMotion');
    expect(text).toContain('"xformOp:translate", "xformOp:scale"');
    expect(text).toContain('double3 xformOp:translate.timeSamples');
  });

  it('本来就是标准名的不动它', () => {
    const src = doc('    double3 xformOp:translate = (0, 0, 0)', '"xformOp:translate"');
    expect(fixXformOpNamespaces(src)).toEqual({ text: src, count: 0 });
  });

  // 安全阀：改完会撞名的话，宁可不修
  it('会撞名就整个放弃，不能改坏文件', () => {
    const src = doc(
      '    double3 xformOp:translate = (0, 0, 0)\n' +
        '    double3 xformOp:translate:extra.timeSamples = { 0: (1,0,0) }',
      '"xformOp:translate", "xformOp:translate:extra"',
    );
    expect(fixXformOpNamespaces(src).count).toBe(0);
    expect(fixXformOpNamespaces(src).text).toBe(src);
  });
});
