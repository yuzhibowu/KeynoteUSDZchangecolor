# USDZ 导出接入

当前验证链路使用 `three@0.169.0` 的 `USDZExporter`；预览加载器单独 vendored 自 r185。不要只为了加载器更新整体 Three.js：新版导出器、可见性过滤和材质写法可能不同。

1. 根据 [色彩说明](COLOR_CORRECTION.md) 选择档和匹配条件。
2. 从原始像素建立导出纹理副本、补偿一次、标 `SRGBColorSpace`。纯色走同一求解器。
3. 使用 `MeshPhysicalMaterial`，纸张参数及 diffuse/emissive 连接遵循档；补偿不是 `scene` 上的灯光。
4. 每个 mesh 单个材质；数组材质和任意共享子集不能假定本导出器支持。
5. 显式 `maxTextureSize` 等于所需最大纹理边长，r169 默认 1024 会缩图；设置 `includeAnchoringProperties:true`、`quickLookCompatible:false`，与原项目一致。
6. `group.updateMatrixWorld(true)`，只导出模型分组。主应用通过 `runCanonical` 去掉视口临时旋转；示例没有交互旋转。
7. 主应用的 `src/lib/usdzExtent.ts` / `withExtents()` 是额外的包围盒兼容修补，独立颜色模块不做这件事。需要时按原实现复用，而不是往颜色 API 塞入 ZIP 依赖。
8. 在 finally 中恢复临时材质/释放临时纹理，并释放下载 URL。

```ts
const bytes = await new USDZExporter().parseAsync(modelGroup, {
  maxTextureSize: 2048,
  includeAnchoringProperties: true,
  quickLookCompatible: false,
});
```

[官方 USDZExporter 说明](https://threejs.org/docs/pages/USDZExporter.html) 反映当前版本，具体行为以仓库锁定的 r169 源码为准。不能根据文档最新版默认值改变旧导出流程。

对已有 USDZ，`src/lib/recolor.ts` 改写图片及文本 USDA 中的纯色，并保留其他数据；不能编辑二进制 USDC 内的材质，报告会列出这类未处理内容。它也不知道别人的模型是否已补偿或是否满足内置档条件，因此不能承诺给任意 USDZ 一次处理就准确。
