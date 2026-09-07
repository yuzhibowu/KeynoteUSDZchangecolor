/**
 * 把紧凑写法的 USDA 摊成一行一件事。
 *
 * three 的 USDA 解析器是**按行**切的，它假设的是标准排版：
 *
 *   def Mesh "X" (
 *       prepend apiSchemas = ["MaterialBindingAPI"]
 *   )
 *   {
 *
 * 而有些导出器会写成 `def Mesh "X" (prepend apiSchemas = [...]) {` 一整行。
 * 解析器在这一行里找到 `=`，就把左边整段当成了属性名，于是这个 Mesh
 * 从头到尾没被认出来 —— 表现是「加载成功，但一个 mesh 都没有」。
 *
 * 这里只动排版，不改语义：把 def 头部的括号块拆开、大括号各自成行。
 * 数组值本来就在一行里，不受影响。
 */
export function normalizeUsda(text: string): string {
  let s = text;

  // 文件头的元数据块：开括号和闭括号都单独成行。
  // **只在文件头那一段里动**：这条规则如果放开到全文，会匹配到
  // timeSamples 里最后一个 `240: (0, 0, 0)`，把坐标值从中间切断。
  const firstDef = s.search(/^[ \t]*(def|over|class)\s/m);
  const cut = firstDef > 0 ? firstDef : s.length;
  let head = s.slice(0, cut);
  const rest = s.slice(cut);
  head = head.replace(/^(#usda[^\n]*\n)\(/, '$1(\n');
  head = head.replace(/^([^\n]*[^\s)])\)[ \t]*$/m, '$1\n)');
  s = head + rest;

  // def / over / class 的头部：把 `(...)` 摊开，`{` 另起一行
  s = s.replace(
    /^([ \t]*)(def|over|class)([^\n({]*)\(([^)]*)\)[ \t]*\{[ \t]*$/gm,
    (_all, indent: string, kw: string, head: string, meta: string) => {
      const items = meta
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(`\n${indent}\t`);
      return `${indent}${kw}${head.trimEnd()} (\n${indent}\t${items}\n${indent})\n${indent}{`;
    },
  );

  // 没有括号块的：`def Xform "Book" {` → `{` 另起一行
  s = s.replace(/^([ \t]*)(def|over|class)([^\n({]*)\{[ \t]*$/gm, '$1$2$3\n$1{');

  // 属性行尾的括号元数据，比如
  //   texCoord2f[] primvars:st = [(0,1),(1,1),…] (interpolation = "faceVarying")
  //
  // 解析器是拿第一个 `=` 切左右的，右边整段都当成值 —— 括号那一截就跟着混进了数组。
  // 于是 `JSON.parse` 失败，退到「只去方括号」的兜底路径，每对坐标的第一个数
  // 变成 NaN（`parseFloat('(0')`）。表现极具迷惑性：贴图明明加载好了、材质也挂上了，
  // 但 u 是 NaN，整张图一个像素都采不到，模型渲染出来是纯黑的。
  //
  // 摊成标准排版（值一行、元数据一个括号块）就绕开了。行尾括号里必须含 `=` 才算元数据 ——
  // `float3 x = (0, 0, 0)` 这种值本身是向量的行不能碰。
  s = s.replace(
    /^([ \t]*)(?!(?:def|over|class)\b)([^\n]*=[^\n]*?)[ \t]+\(([^()\n]*=[^()\n]*)\)[ \t]*$/gm,
    (_all, indent: string, body: string, meta: string) =>
      `${indent}${body} (\n${indent}\t${meta.trim()}\n${indent})`,
  );

  // 注意：**不要**去拆行尾的 `}`。timeSamples 的值本身就是
  // `{0:(0,0,0),60:(...)}` 这种字典，拆开就把值切碎了。
  // 作用域的右大括号本来就各自成行，不需要动。

  return s;
}
