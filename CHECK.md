# USDZ 体检

第四个模式：拖一个现成的 usdz 进来，按这个项目攒下来的 Keynote 实测规律逐条过一遍，
报出「在 Keynote 里会出什么问题」，能修的导出时顺手修掉，贴图顺便瘦身。
原文件不动，导出另存 `-体检.usdz`。

代码：`src/lib/check.ts`（分析，纯函数）、`src/lib/slim.ts`（修 + 瘦身 + 重新打包）、
`src/components/CheckPane.tsx`（报告）、`src/components/CheckPanel.tsx`（侧栏）。

## 规则和出处

每条规则都要有出处：本项目实测，或苹果的功能支持表
（developer.apple.com「Validating feature support for USD files」）。没出处的别加。

| 规则 | 档 | 出处 | 修法 |
| --- | --- | --- | --- |
| 包内文件压缩存储 / 没 64 字节对齐 | 坏 / 警 | usdz 规范 | 重新打包 |
| 第一个文件不是 USD 图层 | 坏 | usdz 规范 | 只有一个图层时挪到第一位 |
| 根图层没 defaultPrim | 警 | 苹果读取器按它找根 | 指到第一个 prim（文本图层） |
| xformOp 带命名空间后缀 | 坏 | 本项目实测（usdaCompat.ts） | 去后缀 |
| rotateXYZ 动画 | 警 | 本项目实测：转到 360° 不播 | 改写成 quatf orient，逐帧同号 |
| 材质 / 着色器动画 | 警 | 本项目实测：完全不认 | 修不了，只告诉你 |
| 顶点动画 | 警 | 苹果支持表：RealityKit ✗ | 修不了 |
| 变换 / 骨骼动画 | 提示 | 本项目实测：时钟从放映开始起跑 | — |
| Mesh 缺 extent | 警 | 本项目实测：被方框截 | 按顶点算出来补（文本图层） |
| doubleSided | 提示 | 苹果支持表：RealityKit ✗；Keynote 未专门验证 | — |
| 缺 subdivisionScheme | 提示 | 苹果文档：默认 catmullClark | 不替用户猜 |
| 灯 / 相机 | 提示 | 苹果支持表：RealityKit 不用 | — |
| MaterialX | 警 | 本项目只验证过 UsdPreviewSurface | — |
| 引用包外文件 / 引用的文件不在包里 | 坏 | usdz 必须自包含 | 修不了 |
| 贴图不是 PNG / JPEG | 坏 | 苹果只稳定认这两种 | 修不了 |
| 贴图超过 4096 | 警 | 经验 | 瘦身缩 |
| 不透明 PNG | 提示 | 经验 | 瘦身转 JPEG |

## 瘦身

- 上限 1024 / 2048 / 4096 / 不限，超过的等比缩小。默认 2048。
- 不透明 PNG 转 JPEG（默认**不勾**，质量 0.92）。只给第三方模型用：自己调过色的卡片转了会抹掉一两个色阶。缩尺寸不伤颜色。「不透明」要真解码扫 alpha 通道 —— PNG 头里声明了 alpha 的
  常常整张都是 255。用在 opacity 上的、法线贴图不转。
- 转格式要改扩展名，文本图层里的引用跟着改；**二进制图层里的路径改不了**（crate 的 token 表
  是压缩的），只被二进制引用的贴图只缩不转。
- 贴图用途（diffuseColor / normal / opacity…）从材质连接里读：文本图层用正则，二进制用
  three 搬来的 crate 解析器读 connectionPaths。
- 颜色校正过的卡片别转 JPEG，会抹掉一两个色阶。

## 实测（2026-09-14）

- 高达（二进制根，5 张 2048 贴图，9.2 MB）上限 1024 → 3.2 MB。
- 棱柱（文本根，3 张 1280×640 PNG 声明了 alpha 但全不透明，4.1 MB）→ 484 KB，rotateXYZ 改成 orient。
