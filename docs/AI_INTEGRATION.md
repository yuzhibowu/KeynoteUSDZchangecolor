# 给 AI 的 Three.js 接入说明

收到「从几棱体复用 USDZ 色彩校正」请求后，先读根目录 `AGENTS.md`、本文件和 [COLOR_CORRECTION.md](COLOR_CORRECTION.md)。在 TypeScript/JavaScript 项目直接复用代码；不根据旧研究文档重写算法。

## 取得模块

两种方式：

- **源码接入**：将完整 `src/color-correction/`（包括 profiles JSON，测试/tsconfig 可选）复制到目标项目；从 `index.ts` 导入。Vite/其他打包器需支持 TS 和 JSON。保留根 MIT LICENSE 及源码来源/采用提交。
- **本地包接入**：在本仓库 `npm ci`，运行 `npm run build:color`；在目标项目 `npm install /path/to/checkout/artifacts/color-correction`，然后 `import {...} from 'jilingti-color-correction'`。成品是单文件 ESM + 类型声明，运行时零依赖。也可在构建目录 `npm pack` 后安装 tarball。**尚未发布 npm，不要假定 npm registry 上同名包属于本项目。**

构建产物不包含 Three.js 或 FFmpeg。不要把 `src/lib/color.ts` 单独搬走：它现在是兼容转发，真正实现不在那里。

## 接入决策与验收

确认目标 App/版本、模型形状、材质、补光、灯光状态和现有图片编码。默认只有 Keynote 棱柱、Keynote 卡片、无边记棱柱三份档；未知条件先用最接近档作明确标注的试验，或者按现有色卡流程重标。条件信息缺失时，可先完成可逆的代码接入，不能宣称已实测匹配。

找到目标项目唯一的「原图 → 导出纹理」边界。在导出副本创建后、USDZExporter 读取前调用 `applyToImageData`；纯色材质走 `compensateToLinear`，alpha 原样保留，材质补光按档。预览保留原始数据，连续导出不应二次补偿。

调用 `createCorrectionPreset(id)` 获取独立可改配置。自定义 JSON 使用 `parseProfile`，核对外层 target/shape/lift/unlit/material，老档的缺失信息不能靠默认值补成测量事实。`predictKeynote` 是「补偿后预测」，原始写入预测用 `forwardOf`。

用本仓库独立示例和 baseline 核对输出；在目标项目验证图片/纯色一致、alpha 不变、补偿关闭原样、连续导出不叠加、原材质恢复。检查 USD 连接和纹理尺寸。最后把未补偿/补偿成品放入目标 Apple 应用，以照片与纯色一并验收，明确自动测试与实机测试范围。

## 不要改掉的实现

编码空间拟合、单调曲线、RBF 岭正则、带约束搜索、主色精确解/LUT、标定的删失样本约束均来自既有研究。任何改动要有新证据及回归测试，不能以「更物理」为理由换算法。保留原 JSON 数据。算法之外的 UI、模型几何与下载流程由目标项目自己承担。

非 JavaScript 语言才需要结合 [PORTING.md](../PORTING.md) 翻译，并用当前 `core.ts` 和数据做对照。随仓库技能入口是 [SKILL.md](../skills/usdz-color-correction/SKILL.md)；它用于引导，功能仍由代码提供。
