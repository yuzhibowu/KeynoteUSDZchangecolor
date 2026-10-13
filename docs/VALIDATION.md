# 验证记录

日期：2026-10-13；提取来源：`432fe3b`。

## 算法与数据保真

- 三份 profiles JSON 与原提交逐字节相同。
- 从 `isIdentity()` 开始的核心求解、缓存、正向模型、色彩转换与像素处理实现除注释尾部空白规范化外逐字节相同；仅移动文件、改导入、更新过期注释。
- 五节点曲线常量和 `pwInvert()` 从原 `chart.ts` 提取，标定端和核心共享。
- `examples/color-correction/baseline.json` 在提取前原代码上运行生成，覆盖三份档、七种输入、反解与正向预测；隔离测试核对相同输出。

## 自动验证

原有 268 项回归涵盖色彩、色卡识别/拟合、纯色与纹理一致、校准档、几何、材料、USDZ 改色、动画、体检和视频配置。新增两项验证独立配置的条件一致和深拷贝隔离。最终全量运行：25 个测试文件、270 项测试全部通过。

独立消费测试运行 `npm run test:color:standalone`：

- 构建单文件 ESM（约 144 KiB，未压缩）与 .d.ts，构建输入仅 `src/color-correction/`。
- 临时目录只有待测包，按真实包名 `jilingti-color-correction` 导入，测试 package exports。
- 不提供 DOM、React、Three.js、FFmpeg 或其他运行时依赖。
- 核对原算法输出、三份预设、RGBA alpha 保留、关闭档原样、无效 hex 返回、拒绝不存在的无边记卡片预设。
- 校准档 serialize/parse 回环及补偿输出一致。
- 独立 NodeNext TypeScript 消费端通过 package types/exports 检查。

`tsc -b`（包含示例）通过；Vite 生产构建通过，97 modules，保留原大 bundle 警告（约 1.06 MB）。Skill 经官方 `quick_validate.py` 校验通过。源码/历史规则扫描只命中 FFmpeg 上游构建路径，未命中常见秘密格式；边界见 OPEN_SOURCE_REVIEW。

本机初始 esbuild/原生 Rollup 无法加载；验证时使用本机 Node 临时副本及从 npm 官方获取的同版本 esbuild 0.21.5。没有升级导出器、改变依赖算法版本或写入个人运行时路径到项目配置。仓库命令在正常 Node/npm 环境仍按 README 使用。

## 浏览器检查

本机独立示例使用公共模块与 r169 USDZExporter，不使用主 App：

- Keynote 卡片：原始/补偿两侧显示、未补偿与补偿 USDZ 生成均返回成功。
- 无边记棱柱：切换条件后预览正常，补偿 USDZ 生成成功。
- Keynote 棱柱：预览正常，连续两次补偿导出无异常，每次从原始生成纹理开始。
- 原项目：默认棱柱预览正常，导出提示 193 KB、已套用颜色补偿。

浏览器检查确认调用与生成流程，未读取浏览器下载成品的 ZIP 内容，也没有在 Apple 应用中重新打开验色。现有 USDZ 内容/材质逻辑由原回归测试覆盖。示例截图保存为 `examples/color-correction/preview.png`；截图是网页写入值预览，**不是 Apple 校正前后实拍**。

## 本次未验证的范围

本次未重新采集 Keynote/无边记照片，没有测试新的 App/OS 版本，也未运行实际透明视频编码。原视频功能和二进制保持不变，已有配置测试通过；FFmpeg 对应源码许可仍是发布待办。原始实拍截图未在仓库中找到，保留的实测证据为 profiles 数值档与研究记录。

## 提交前复核

在精确暂存快照的隔离目录中重新运行：270 项测试、TypeScript、Vite 构建和独立包消费/类型检查全部通过。本次提交不包含工作区另一组导出助手接入改动。仓库继续保持私有，FFmpeg 源码与许可分发事项尚未解决。

## 官方编码内核替代验证

采用上游 npm `@ffmpeg/core@0.12.10`，CDN 文件与 npm tarball 内 ESM 文件逐字节一致。使用真实 ProRes 4444 XQ 参数编码两帧 64×64 RGBA（alpha 0、64、128、255）。本机 FFprobe 识别 ProRes XQ、64×64、2 帧、含 alpha 的像素格式；本机 FFmpeg 独立解码最大 alpha 误差 1/255、平均 0.25/255。浏览器验证入口 `examples/ffmpeg-validation/` 使用真正 @ffmpeg/ffmpeg Worker、哈希校验下载、MOV 编解码回环。当前仓库和 dist 不携带内核二进制。

最终精确暂存快照验证：26 个测试文件、273 项测试全部通过，类型检查、Vite 构建、独立色彩包消费测试通过。真实浏览器 Worker 返回 `ok:true`、2 帧、alphaMaxError=1；生成 MOV 为 2574 字节。生产 dist 不包含 ffmpeg-core JS/WASM 或其他 WASM。
