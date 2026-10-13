# 几棱体 · USDZ 工具与模型色彩校正

几棱体是一个纯前端 Three.js 工具，用于制作棱柱和卡片模型、调整贴图与材质、检查和处理 USDZ，并把结果用于 Apple Keynote、无边记等场景。用户导入的模型和图片在浏览器本地处理。

同一个模型在网页中和 Apple 应用中可能呈现不同颜色。本项目保留了实际研究与标定得到的预补偿代码，并将它整理成**不依赖主界面的独立模块**，方便其他 Three.js 项目复用。

> 开源准备正在完成，尚未更改仓库可见性。自有代码及独立模块使用 MIT；随项目提供的第三方代码与 FFmpeg 内核有各自许可证。发布前待办见 [开源检查报告](docs/OPEN_SOURCE_REVIEW.md)。

## 功能

- 制作 3–12 面棱柱及卡片，逐面贴图、正反面设置、裁切定位、圆角和正面轮廓适应。
- 纸张、塑料、金属、玻璃材质及相关参数；Three.js 模型预览。
- USDZ 导出，基于目标应用校准档的贴图及纯色预补偿、密集色卡标定、档案导入/导出。
- 对已有 USDZ 做颜色处理与前后预览；检查 Apple 兼容问题及贴图尺寸，修补支持的文本层问题。
- USDZ 加动效：漂浮、旋转、轨迹和入场，保留原模型动画；导出 USDZ、PNG 序列与透明 MOV。

## 安装与运行

需要 Node.js 20.19+ 或 22+ 及 npm，现代支持 WebGL 的桌面浏览器。

```sh
git clone https://github.com/yuzhibowu/KeynoteUSDZchangecolor.git
cd KeynoteUSDZchangecolor
npm ci
npm run dev
```

访问终端显示的本地地址（默认 5173）。当前私有仓库需要访问权限；公开后可直接 clone。

```sh
npm test                        # 回归测试
npm run build                   # TypeScript 检查 + Vite 构建到 dist/
npm run preview                 # 预览构建
npm run test:color:standalone    # 独立模块隔离消费测试 + 类型检查
npm run example:color           # 无主界面 Three.js 最小导出示例
npm run audit:source            # 当前文件及全部可达 Git 历史的规则扫描
```

主应用是 Vite 静态站点。视频编码器从本站 `/ffmpeg-core/` 按需加载；部署需要保留其文件和资源路径。视频相关第三方许可与源码分发问题尚未完成核实，见 [第三方声明](THIRD_PARTY_NOTICES.md)。无需上传用户素材；应用静态资源加载仍需网络。

## 在其他项目使用色彩模块

入口：[`src/color-correction/index.ts`](src/color-correction/index.ts)。复制完整目录即可在支持 TS/JSON 的项目使用；也可 `npm run build:color` 生成 `artifacts/color-correction/` 本地 ESM 包，再在目标项目安装这个目录。包没有运行时第三方依赖，**尚未发布 npm registry**。

```ts
import { createCorrectionPreset, applyToImageData } from './color-correction';

const { comp, conditions } = createCorrectionPreset('keynote-card');
const pixels = exportContext.getImageData(0, 0, width, height);
applyToImageData(pixels.data, comp);
exportContext.putImageData(pixels, 0, 0);
// 还需按 conditions 配置材质、diffuse/emissive 和补光，再导 USDZ。
```

内置实测档包括 Keynote 棱柱、Keynote 卡片（纸张/补光 0.5），无边记棱柱（纸张/补光 0）。形状、光照、材质、色彩空间和应用版本都会影响结果；不能承诺任意 USDZ 自动色准。补偿仅作用于导出副本一次，网页保留原图。

给 Codex 的接入提示：

> 我的项目需要导出 USDZ。请阅读几棱体仓库的 AGENTS.md、docs/AI_INTEGRATION.md 和 docs/COLOR_CORRECTION.md，复用 src/color-correction 的已验证实现。先核对目标 App、模型与材质/补光条件，按示例接入并测试，不要重新发明算法。没有实机验收的条件请明确注明。

## 架构与文档

React + TypeScript + Vite 管理界面；Three.js r169 负责预览与导出，独立 r185 USD 加载器用于读入；fflate 处理 USDZ ZIP；FFmpeg WASM 负责透明视频。色彩核心不依赖这些 UI/编码组件。

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 入口、架构、修改边界与验证 |
| [COLOR_CORRECTION.md](docs/COLOR_CORRECTION.md) | 原理、API、参数、实测条件与局限 |
| [AI_INTEGRATION.md](docs/AI_INTEGRATION.md) | 其他 Three.js 项目接入与本地包方式 |
| [USDZ_EXPORT.md](docs/USDZ_EXPORT.md) | 导出材质连接和版本/兼容性约束 |
| [SKILL.md](skills/usdz-color-correction/SKILL.md) | 随仓库提供的 AI 使用步骤 |
| [KEYNOTE-COLOR.md](KEYNOTE-COLOR.md)、[PORTING.md](PORTING.md) | 历史研究与跨语言移植依据（含旧方案） |
| [MOTION.md](MOTION.md)、[CHECK.md](CHECK.md) | 动画、视频和体检说明 |
| [UI.md](UI.md)、[HANDOFF.md](HANDOFF.md) | 原界面规范与历史交接 |

## 许可与贡献

原创源码、独立校正模块、项目文档及内置数值档按 [MIT License](LICENSE) 提供；第三方权利不因此改变，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。实拍素材未收入仓库。提出修改时说明行为变化、校准条件和验证结果；算法调整应提供测量依据，避免破坏既有导出结果。
