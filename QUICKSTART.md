# 在别的网站里用这套颜色补偿

现行入口已经整理为 [`src/color-correction/index.ts`](src/color-correction/index.ts)。**复制整个目录**，或运行 `npm run build:color` 使用本地包；旧 `src/lib/color.ts` 只是兼容转发，不能单独拿走。

先读 [docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md) 的安装与接入步骤，再读 [docs/COLOR_CORRECTION.md](docs/COLOR_CORRECTION.md) 的 API/条件。示例位于 [`examples/color-correction/`](examples/color-correction/)，运行 `npm run example:color`。

```ts
import { createCorrectionPreset, applyToImageData } from './color-correction';
const { comp, conditions } = createCorrectionPreset('freeform-prism');
applyToImageData(exportPixels.data, comp);
// 导出材质也必须按 conditions 设置；无边记棱柱档补光为 0。
```

贴图、纯色、预测共享同一份档；不能二次补偿。`forwardOf` 预测原始写入值，`predictKeynote` 预测补偿后最终外观。这套档不保证所有模型/App/材质一致；无边记卡片未独立实测。
