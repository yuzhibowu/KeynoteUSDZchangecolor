# 在别的网站里用这套颜色补偿

> 给「我自己的网页也要导 USDZ，希望颜色进 Keynote / 无边记不变」的人看。
> 最后更新：2026-09-23。原理和标定方法在 [KEYNOTE-COLOR.md](KEYNOTE-COLOR.md)，
> 非 JS 语言的移植在 [PORTING.md](PORTING.md)。这份只讲**怎么接**。

## 它解决什么

同一张图，当**普通 2D 图片**放进 Keynote，颜色分毫不差；当**USDZ 模型的贴图**，颜色就变了。
因为渲染 3D 时算的是「一个被灯光照亮的物体」，这一步天生会改颜色，而且每个 App 改法不同。

这套东西做的事是：**在你把图写进 usdz 之前，先按目标 App 的脾气反着改一遍**，
进去之后正好抵消。改多少不是猜的，是拿色卡在真机上实测 1130 个颜色拟合出来的。

---

## 一、拿走这些文件

```
color.ts                              ← 唯一要调用的模块
chart.ts                              ← color.ts 只用了它一个函数（pwInvert）
profiles/keynote-prism-dense.json     ← Keynote 棱柱的实测档
profiles/keynote-card-dense.json      ← Keynote 卡片的实测档
profiles/freeform-prism-dense.json    ← 无边记的实测档
profile.ts                            ← 只有要装「自己标的档 json」才需要（parseProfile）
```

**零第三方依赖，不碰 DOM**，浏览器和 Node 里都能跑（已经实测验过：把这五个文件单独拷出去，
`esbuild` 打包后 `node` 直接运行通过）。TypeScript 源码，JS 项目用 esbuild / tsc / vite 随便编一下即可。

`chart.ts` 里还有色卡生成和截图识别，那是**重新标定**时才用的；只做补偿的话它只是个依赖，不用管。

---

## 二、三种调用，覆盖全部场景

```ts
import { applyToImageData, applyToHex, forwardOf, FREEFORM_COMP } from './color';
```

**1）贴图逐像素补偿** —— 在把画布交给 USDZ 导出器之前插一步：

```ts
const img = ctx.getImageData(0, 0, w, h);
applyToImageData(img.data, FREEFORM_COMP);   // 就地改写
ctx.putImageData(img, 0, 0);
```

**2）纯色**（端面、描边、边框这类不走贴图的）：

```ts
material.color.set(applyToHex('#c87850', FREEFORM_COMP));   // → '#dd895c'
```

**3）正向预测**（想在界面上预告「这个颜色进去会长什么样」）：

```ts
forwardOf(226, 226, 226, FREEFORM_COMP);   // → [203, 203, 203]
```

> **同一个问题只能有一个答案。** 贴图、纯色、界面预告这三处**必须调用同一份档**。
> 本项目栽过：端面走的是另一条老路（不带局部修正、负值逐通道夹断、还允许写 >1 的线性值），
> 结果端面比侧面亮 50%，接缝一眼能看出来，而且闭环微调怎么调都不收敛 ——
> 你在给 A 打补丁，导出的却是 B。

---

## 三、最容易被忽略的一步：导出条件必须和标定条件一致

**光调用 API 是不够的。** 每一份档都是在一组具体条件下测出来的，你导出的模型必须落在同一组条件上，
否则补偿量是照着另一个世界算的。条件有五项：**目标 App、模型形状、材质、补光、灯光开关。**

| 用在哪 | 传哪份档 | 材质 | 补光 `lift` | 关灯光 |
|---|---|---|---|---|
| Keynote · 棱柱 | `DEFAULT_COMP` | 纸张 | **0.5** | 否 |
| Keynote · 卡片 | `CARD_COMP` | 纸张 | **0.5** | 否 |
| 无边记 · 棱柱 | `FREEFORM_COMP` | 纸张 | **0** | 否 |
| 无边记 · 卡片 | `FREEFORM_COMP` ※ | 纸张 | **0** | 否 |

「纸张」指的是这组 PBR 参数：`roughness 0.9`、`metallic 0`、`clearcoat 0`、`opacity 1`。

※ 无边记的卡片**还没单独实测过**，暂时沿用它的棱柱档。Keynote 那边两种形状实测下来响应几乎一样
（矩阵和实测点只差 ±1），无边记的环境反射更温和，大概率也一样，但这一条目前是推断不是实测。

**补光（`lift`）是什么、怎么写进文件。** 灯光是乘法且系数小于 1，所以贴图再白也到不了纯白；
自发光是加法、没有天花板。补光就是「额外把同一张贴图再挂到自发光上，强度 lift」：

```ts
material.emissiveMap = lift > 0 ? sameTexture : null;
material.emissive.setRGB(lift, lift, lift);
material.color.setRGB(1, 1, 1);
```

在 usdz 文件里长这样（两项相加，上限就抬起来了）：

```usda
color3f inputs:diffuseColor.connect  = </Materials/M/Tex_diffuse.outputs:rgb>
color3f inputs:emissiveColor.connect = </Materials/M/Tex_emissive.outputs:rgb>
```

**为什么两个目标的补光不一样，这是这套方案里最值钱的一条经验：**
Keynote 的纯白顶死在 244，不靠自发光顶上去整个模型发灰，所以必须给 0.5；
无边记在纸张下光靠漫反射纯白就有 226，补光加满也只多买约 20 阶上限，却要把各个面之间的
明暗差压平（自发光不随角度变化，加得越多明暗越平）—— 不划算，所以给 0，
立体感完整保留，而且颜色反而是所有档里最准的（残差 4.2 阶，Keynote 那份是 12.2）。

---

## 四、API 一览

| 函数 | 干什么 | 备注 |
|---|---|---|
| `applyToImageData(data, comp)` | 贴图逐像素补偿，就地改写 | 占面积大的前 48 种颜色精确求解，其余走 17³ 查找表插值；2K 图几十毫秒 |
| `applyToHex(hex, comp)` | 单个颜色补偿，进出都是 `#rrggbb` | 纯色面、描边用这个 |
| `solveWritten(r, g, b, comp)` | 同上，但收发都是 0–255 三元组 | 上面两个内部都走它 |
| `forwardOf(r, g, b, comp)` | 正向：写这个值，目标 App 里会显示成什么 | 做界面预告、做自检 |
| `predictKeynote(hex, comp)` | 同上，hex 进 hex 出 | |
| `applyForwardToImageData(data, comp)` | 整张图走正向 | 做「模拟预览」用 |
| `isIdentity(comp)` | 这份档是不是等于不补偿 | 省掉整趟像素遍历 |
| `compSignature(comp)` | 档的指纹 | 做缓存键用，别自己拼 |

档（`ColorComp`）：`DEFAULT_COMP`（Keynote 棱柱）、`CARD_COMP`（Keynote 卡片）、
`FREEFORM_COMP`（无边记）、`BLANK_COMP`（空档 = 不补偿）。

---

## 五、几条会让你少走弯路的

**反解不要「算完再逐通道截断」。** 红色算出 280 截成 255、蓝色算出负数截成 0，
两个通道被砍的比例不一样，出来是个不伦不类的颜色。`solveWritten` 是在「所有能写进 8 位贴图的颜色」
里带约束搜索，找经过目标 App 之后最接近的那个，不会跑色相。直接用它，别自己反推公式。

**换了材质就等于换了一个世界，但只在补光低的时候。** 补光高时自发光占大头，材质只影响受光那一半，
换金属换玻璃颜色都还挺准；补光低时材质是决定性的 —— 实测金属（`metallic = 1`，漫反射几乎为零、
全靠反射环境）在无边记补光 0 下纯白只有 124，而纸张是 226。所以上表里的「纸张」不是建议，是前提。

**这些数据跨机器有效，不用重标。** 标定时量到的值经过两层：目标 App 的变换（软件行为）和
显示器色彩管理 / 截图链路。而补偿的目标（「看起来和屏幕上的原图一样」）也经过同一层色彩管理，
等式两边同时出现就约掉了。真正需要重标的只有：换目标 App 的大版本，或者你改了上表里的条件。

**要重新标定**，别自己造轮子：打开 https://keynote-usd-zchangecolor.vercel.app ，
进「USDZ 颜色校正」，按里面的步骤导色卡 → 放进目标 App → 截图传回来，
标完点「导出校准档」拿到一个 json，把它 `parseProfile()` 之后喂给 `applyToImageData` 就行。
方法论在 [PORTING.md](PORTING.md)。

---

## 六、完全不想搬代码的话

把做好的 usdz 直接拖进 https://keynote-usd-zchangecolor.vercel.app 的
**「USDZ 颜色校正」**模式，选目标 App，导出。它会把文件里所有贴图和纯色都按同一份档改一遍，
几何、动画、层级原样不动。适合偶尔处理几个文件，或者先验证「补偿到底有没有用」再决定要不要接代码。
