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

  // 注意：**不要**去拆行尾的 `}`。timeSamples 的值本身就是
  // `{0:(0,0,0),60:(...)}` 这种字典，拆开就把值切碎了。
  // 作用域的右大括号本来就各自成行，不需要动。

  return s;
}
