---
name: usdz-color-correction
description: Reuse 几棱体's measured color precompensation in Three.js USDZ export projects targeting Keynote or Freeform. Use when integrating this repository's implementation, not for generic image grading or guaranteed correction of arbitrary Apple models.
---

# 集成几棱体 USDZ 色彩校正

从 [AGENTS.md](../../AGENTS.md) 和 [AI_INTEGRATION.md](../../docs/AI_INTEGRATION.md) 找到公共入口。参数与限制以 [COLOR_CORRECTION.md](../../docs/COLOR_CORRECTION.md) 为准。技能留在仓库中使用；只复制此文件不包含实现和说明。

目标是直接调用 `src/color-correction/index.ts` 或它的本地构建包，避免重新实现算法。先核对 App/版本、形状、材质、补光、灯光和输入色彩空间；三份内置档仅覆盖文档中的条件。无边记卡片没有独立实测档。未知条件下的试用要标注为试验，不能称已验证。

在导出副本上应用一次 `applyToImageData`；纯色使用同一份档的 `compensateToLinear`。Three.js 颜色纹理声明 SRGBColorSpace，线性材质值不再解码。按预设条件连接 diffuse/emissive，保持原始网页预览数据。不要用颜色乘常数、无约束截断或另一条纯色算法取代现行求解器。

读 [USDZ_EXPORT.md](../../docs/USDZ_EXPORT.md) 对齐导出器选项和版本。源码接入复制完整模块目录（含 JSON）并保留 MIT 许可；本地包是 ESM、零运行时依赖，尚未发布 npm。

用隔离消费测试和示例核对：原数值输出、alpha、关闭档、校准 JSON、连续导出不叠加、材质连接/纹理尺寸。Apple 外观必须在目标 App 用照片与纯色验收；模型预测不能充当截图证据。条件失配时沿用原 `chart.ts` 标定流程，不能混入其他条件的样本。
