/**
 * 已知会让苹果的渲染器（Keynote / 预览 / AR Quick Look）出问题的写法，
 * 以及对应的修法。
 *
 * 这里每一条都是实测出来的，不是照着规范猜的 —— 规范允许的写法苹果未必认。
 * 加新规则之前请先用最小对照文件验证，别凭印象加。
 */

export type CompatFix = { what: string; count: number };

/**
 * 带命名空间后缀的 xformOp，例如 `xformOp:scale:microMotion`。
 *
 * USD 规范是允许给 xformOp 起带后缀的名字的，但苹果的解析器碰到**带后缀的缩放**
 * 会整层放弃 —— 表现是 Keynote 里一个带播放按钮的空方框，模型完全不见。
 *
 * 实测（2026-09-07，饼饼那个「布白三维卡片-微动」）：
 * - 三段动画都带后缀 → 不显示
 * - 同样三段、只把后缀去掉 → 正常显示，动画一帧不少
 * - 只留平移（带后缀）→ 正常；平移 + 缩放（带后缀）→ 不显示
 * 所以致命的是「带后缀的 scale」，但既然去掉后缀对所有情况都安全，就一律去掉。
 *
 * 安全阀：改完之后如果某个 xformOpOrder 里出现了重名（说明原本就同时存在
 * 带后缀和不带后缀的同类 op），就整个放弃这次改写 —— 宁可不修，也不能改坏。
 */
export function fixXformOpNamespaces(usda: string): { text: string; count: number } {
  const suffixed = /xformOp:(translate|rotateXYZ|rotateXYZW|rotateX|rotateY|rotateZ|scale|orient|transform):[A-Za-z_][A-Za-z0-9_]*/g;
  const hits = usda.match(suffixed);
  if (!hits) return { text: usda, count: 0 };

  const text = usda.replace(suffixed, (_m, op: string) => `xformOp:${op}`);

  // 改完检查每个 xformOpOrder 里有没有重名
  const orders = text.match(/xformOpOrder\s*=\s*\[([^\]]*)\]/g) ?? [];
  for (const o of orders) {
    const items = (o.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
    if (new Set(items).size !== items.length) return { text: usda, count: 0 };
  }

  // count 按「改了几个 op 声明」算，xformOpOrder 里的引用不重复计数
  const decls = usda.match(
    /(?:double3|float3|float|double|quatf|quatd|matrix4d)\s+xformOp:(?:translate|rotateXYZ|rotateXYZW|rotateX|rotateY|rotateZ|scale|orient|transform):[A-Za-z_][A-Za-z0-9_]*/g,
  );
  return { text, count: decls?.length ?? 0 };
}
