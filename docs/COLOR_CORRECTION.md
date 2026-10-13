# USDZ 模型色彩预补偿：已验证实现与使用边界

本模块复用「几棱体」在 `c947ee4` 中实际使用的代码和三份实测数据。提取改变了文件归属与入口，没有重新设计求解算法。它在**导出前**改写纹理像素和纯色材质值，降低特定 Apple 渲染条件下的颜色偏差；不是通用 USDZ 色彩空间转换器。

## 原始问题与证据

同一图像作为普通二维图片与 USDZ 模型贴图放进 Keynote 时，外观不同。网页 Three.js 渲染器和 Apple 应用的环境、光照、PBR 材质、色调映射及纹理色彩解释可能不同。错误的纹理编码、重复 gamma 转换也会产生色差，应先排除管线错误，再应用经验补偿。

Three.js 工作色彩空间是 Linear-sRGB；颜色纹理通常需声明 `SRGBColorSpace`，数值颜色和纹理像素不能混用。见 [Three.js 色彩管理](https://threejs.org/manual/en/color-management.html)。本仓库算法却在 **sRGB 编码空间**建模，这来自历史交叉验证的选择，与 Three.js 在线性光中做光照计算不矛盾。

不要把历史记录中的「P3 色域错位」当作已证明的 Apple 内部实现。实测能确认的是输入输出响应、通道耦合、裁切和亮度限制；内部渲染成因仍包含推断。完整研究过程在 [KEYNOTE-COLOR.md](../KEYNOTE-COLOR.md) 和 [PORTING.md](../PORTING.md)，其中早期方案与旧数据不能当当前默认值。

| 档 | 测量记录 | 已验证条件 |
|---|---|---|
| `keynote-prism` / `DEFAULT_COMP` | 2026-09-13，1130 对样本，Keynote 14.5 | 棱柱、纸张、补光 0.5、灯光开启、正视 |
| `keynote-card` / `CARD_COMP` | 2026-09-13，1130 对样本，Keynote 14.5 | 卡片、纸张、补光 0.5、灯光开启、正视 |
| `freeform-prism` / `FREEFORM_COMP` | 2026-09-23，1130 对样本 | 无边记、棱柱、纸张、补光 0、灯光开启、正视；未记录应用版本 |

无边记卡片未独立实测。主应用暂沿用棱柱档；公共预设没有自动提供 `freeform-card`，接入方如需沿用，应明确说明推断和验收结果。历史记录报告无边记密集档拟合残差约 4.2/255；这个数值不是任意模型的误差保证。本次自动测试没有重新测量 Apple 应用。

纸张：贴图面 roughness=0.9，端面/窄边=0.85；metalness=0、clearcoat=0、opacity=1。金属、玻璃、清漆、透明度、姿态、周围面与环境变化都可能使档失效，尤其在低补光下。不要依据「某一次高补光金属也准确」推论所有材质都通用。

## 代码位置与依赖

- `src/color-correction/index.ts`：对外稳定入口。
- `core.ts`：原 `src/lib/color.ts` 的正向模型、反解、缓存和像素处理。
- `math.ts`：从 `src/lib/chart.ts` 原样提取的五节点曲线常量与逆运算，标定端也使用它。
- `presets.ts`：实测条件、独立配置工厂；只描述条件，不修改外部材质。
- `profile.ts`：原校准档序列化/解析代码。
- `profiles/*.json`：原始内置数值文件，逐字保留。
- `src/lib/color.ts`、`src/lib/profile.ts`：兼容入口，原项目全部继续调用这一份实现。

核心没有运行时第三方依赖、DOM、React、Three.js、文件读写或 FFmpeg。绘制色卡、识别截图与拟合在 `src/lib/chart.ts`，重新标定时才需要。不要把主应用的 `recolorUsdz()` 误认为纯核心：它还依赖 Canvas、ZIP 和 USD 文本处理，且不能重写二进制 USDC 材质。

## 数学流程（保留现行实现）

1. 将 8 位 RGB 除以 255，仍是 sRGB 编码值。
2. 行优先 3×3 矩阵和三元偏移：`p = M*x + offset`，在 0..1 夹限后逐通道通过五节点单调分段线性曲线。
3. 将实测 `ref → got` 与全局模型的残差构成高斯径向基修正场。作用半径 `LOCAL_SIGMA=0.07`，岭正则 `1e-2`，保留现有裁切与远点跳过规则。
4. `solveWritten()` 用带约束迭代在可写 0..1 范围里求最接近目标的输入。不能改成「逆矩阵算完再逐通道截断」；旧方案会扭曲色相。
5. 整图使用 17³ LUT 三线性插值；采样直方图中占比至少 0.4%、最多 48 个主色直接精确求解。大图超过 400000 像素时直方图步长为 8。纯色和大面积图色都共享相同求解器。

首次建立密集档 RBF/LUT 可能耗时，随后缓存复用。大纹理请放入 Worker 或在任务之间让出主线程；不承诺所有设备「几毫秒完成」。内部数值常量是验证过的实现细节，不作为普通集成可调参数；有证据和回归测试时才修改。

## 调用接口与参数

```ts
import {
  createCorrectionPreset, applyToImageData, applyToHex, solveWritten,
  forwardOf, compensateToLinear, parseProfile,
} from './color-correction';
const { comp, conditions } = createCorrectionPreset('keynote-card');
```

默认参数为 `keynote-prism`。工厂每次深拷贝校准数据；更改 `comp.on` 不影响其他实例。内置 `*_COMP` 常量为兼容旧代码保留，调用方不要原地修改它们。

| 接口 | 输入 | 输出与语义 |
|---|---|---|
| `applyToImageData(data, comp)` | `Uint8ClampedArray`，RGBA 四字节一组、8 位 sRGB、长度为 4 的倍数 | 返回 void；原地修改 RGB，alpha 保持原值 |
| `applyToHex(hex, comp)` | `#rrggbb` 或六位十六进制 | 补偿后的 hex；不支持的格式原样返回 |
| `solveWritten(r,g,b,comp)` | 目标外观的 0..255 RGB | 实际应写入的三元组，启用档时为 0..255 整数 |
| `compensateToLinear(hex, comp)` | hex | 同一反解结果经 sRGB 解码后的 Linear-sRGB 三元组；无效 hex/关闭档返回 null |
| `forwardOf(r,g,b,comp)` | **已写入**的 0..255 RGB | 该档预测显示的 0..255 整数三元组 |
| `applyForwardToImageData(data,comp)` | RGBA | 原地进行正向预测；alpha 不变；LUT 近似 |
| `predictKeynote(hex,comp)` | **目标** hex | 先反解再正向预测的最终外观；关闭档/无效 hex 返回 null。函数名为历史名称，也能使用无边记档 |
| `isIdentity(comp)` | 档 | `on=false` 或 `matrix=null` 时 true |
| `compSignature(comp)` | 档 | 缓存指纹；关闭时为 `off`，不能当密码学摘要 |
| `parseProfile(text)` | 导出的 JSON 文本 | `ok` 判别联合；成功带 `comp`（部分字段）、target/shape/lift/unlit/material/sampleCount，失败带 reason |
| `serializeProfile(comp,target?,shape?)` | 档及条件名称 | v3 校准档对象；`JSON.stringify()` 后保存 |

`ColorComp` 参数：`on` 总开关；`matrix` 长度 9；`offset` 长度 3；`curve` 三条五节点单调曲线；`samples` 为 `{ref:[写入R,G,B],got:[实测R,G,B]}` 数组；`calibratedAt` 标签或日期；`calibratedLift`、`calibratedUnlit`、`calibratedMaterial` 记录测量条件。后三项不会自动改变渲染器。内部矩阵/曲线使用归一化尺度（拟合曲线端点可以略低于 0 或高于 1，不能擅自裁掉原数据），samples 是 0..255。

核心旧 API 假定数值和数组布局合法，不会替调用方校验 NaN、浮点 HDR、Display-P3、premultiplied alpha 或越界 RGB。调用方先转换到 sRGB 8 位、检查布局。对外导入 JSON 使用 `parseProfile()`；它只做现有格式校验，不保证未知旧档的条件齐全。

## 纹理接入：只补偿导出副本一次

```ts
const exportCanvas = document.createElement('canvas');
exportCanvas.width = sourceCanvas.width;
exportCanvas.height = sourceCanvas.height;
const ctx = exportCanvas.getContext('2d')!;
ctx.drawImage(sourceCanvas, 0, 0);
const pixels = ctx.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
applyToImageData(pixels.data, comp);
ctx.putImageData(pixels, 0, 0);
const tex = new THREE.CanvasTexture(exportCanvas);
tex.colorSpace = THREE.SRGBColorSpace;
const mat = new THREE.MeshPhysicalMaterial({
  map: tex, roughness: conditions.roughness,
  metalness: conditions.metalness, clearcoat: conditions.clearcoat, opacity: conditions.opacity,
});
mat.color.setRGB(1, 1, 1); // 贴图已补偿，不再改色
mat.emissiveMap = conditions.lift > 0 ? tex : null;
mat.emissive.setRGB(conditions.lift, conditions.lift, conditions.lift);
```

保留原图给网页预览和再次导出。每次从原始数据产生副本，不能把已经补过的像素再补一次。贴图需要同一个对象同时连接 diffuse/emissive。`lift` 不是任意曝光滑杆；换了它就换了标定条件。若开启伪 unlit，需要专门在该条件下标定，不能继续用上述默认档。

纯色材质也需补偿和补光，规则来自 `viewer.paintSolid()`：

```ts
const linear = compensateToLinear('#c87850', comp)!
const solid = new THREE.MeshPhysicalMaterial({ roughness: conditions.capRoughness, metalness: 0 });
solid.color.setRGB(...linear); // 已是线性值，不再从 hex 自动转换
solid.emissiveMap = null;
solid.emissive.setRGB(...linear.map(v => conditions.lift * v) as [number, number, number]);
```

也可用 `solid.color.set(applyToHex(hex,comp))` 让 Three.js 转换一次，再 `solid.emissive.copy(solid.color).multiplyScalar(conditions.lift)`。这条与 `setRGB(...linear)` 等价；不要对线性值再次调用 sRGB 解码。纹理已补过时不可再乘补偿后的材质颜色。

## 自定义档与重新标定

`serializeProfile` 格式为 `prism-usdz-color-profile`，版本 3；samples 扁平每六个数为一组。公共内置 JSON 是原内部数据，不带该格式标记，**不能直接喂给 parseProfile**，通过工厂加载。

```ts
const parsed = parseProfile(profileJson);
if (!parsed.ok) throw new Error(parsed.reason);
// 核对 parsed.target/shape/lift/unlit/material 与实际导出条件。
// 若 null / 缺失，依据真实测量记录补齐，不能默认为已经匹配。
const custom = { ...comp, ...parsed.comp, on: true };
```

原解析器为了老档兼容，会在部分 `comp.calibrated*` 字段缺失时回退 Keynote 默认值；外层 `parsed.lift/unlit/material` 的 null 才表示文件未记录。接入方必须检查这些外层值，不要把回退值误当测量事实。

重标流程沿用主应用：相同几何、各面颜色、材质、补光、灯光条件导出原始密集色卡三张 → 在目标应用正视截图 → 在 `chart.ts` 识别 → 使用现有 `fitChart()` 拟合，保留裁切样本的单边约束 → 保存样本/矩阵/曲线及条件 → 独立照片验收。动态探针 ref 必须是实际写入值；不同条件的样本不能混用。

## 限制与验证

- 只能在已测响应的范围内逼近目标。0..255 的写入范围、黑位抬升、白位天花板和通道裁切意味着某些颜色不可达。
- 正视色卡不能覆盖任意朝向、金属反射、半透明叠色或所有 Apple 版本。跨设备可复用是原项目观察和截图链路推理，不能保证所有 ICC/HDR/广色域设置一致。
- 不替代正确纹理编码、色彩空间声明、曝光和 tone mapping 设置。升级 Three.js 导出器可能改变 USD 材质连接/scale 语义，需要重新验收。
- `forwardOf` / 模拟预览是同一拟合模型预测，不是独立真机验收；拟合残差也不是新照片的泛化误差。

运行 `npm test`、`npm run build`、`npm run test:color:standalone`。独立测试在只有待测包、无主应用及其他依赖的临时目录导入 ESM 成品，检查提取前数值、三份档、alpha、关闭档、JSON 回环和 NodeNext 类型消费。最小 Three.js 导出示例：`npm run example:color`，位置 `examples/color-correction/`。色卡、梯度及未补偿/补偿 USDZ 由示例生成，无私人素材。

自动测试能确认原算法行为和导出结构，不证明今天的 Apple 显示色准。实机对照应记录 App/OS 版本、姿态、材质、补光、颜色管理和截图方法，保留原图、照片、未补偿与补偿 USDZ。当前仓库没有纳入原始实拍截图；数值档与历史记录是保留的证据。
