# 几棱体：给 AI 编程助手的入口

本仓库包含浏览器 USDZ 工具和可独立调用的模型色彩预补偿模块。先读 README；接入其他项目时读 `docs/AI_INTEGRATION.md`、`docs/COLOR_CORRECTION.md` 和 `docs/USDZ_EXPORT.md`。

## 架构

| 位置 | 职责 |
|---|---|
| `src/color-correction/index.ts` | 独立模块公共入口；源码接入复制整个目录 |
| `src/color-correction/core.ts` | 原实测校正算法：矩阵/曲线/RBF/带约束反解/LUT |
| `src/color-correction/profiles/*.json` | 三份实测数值档；不可随意改动 |
| `src/color-correction/profile.ts`, `presets.ts`, `math.ts` | 校准档格式、条件与配置工厂、共享曲线数学 |
| `src/lib/color.ts`, `profile.ts` | 旧路径兼容转发；禁止分叉算法 |
| `src/lib/chart.ts`, `exportCard.ts` | 色卡、截图识别、拟合、同条件色卡 USDZ 导出 |
| `src/lib/faceTexture.ts`, `viewer.ts`, `material.ts` | 原图/导出烘焙、Three.js 预览与纯色、统一材质/补光 |
| `src/lib/exportUsdz.ts`, `usdzExtent.ts` | r169 导出及 extent 兼容补丁 |
| `src/lib/recolor.ts`, `check.ts`, `slim.ts` | 已有 USDZ 改色、体检、贴图瘦身 |
| `src/lib/motion*.ts`, `videoExport.ts` | 动画烘焙、USDZ 动画、浏览器视频 |
| `src/components/`, `App.tsx` | React 界面；UI 规范见 UI.md |
| `src/vendor/` | r185 USD 加载器，独立保留上游 MIT 通知 |
| `examples/color-correction/` | 无主界面的最小 Three.js 导出和原算法数值基线 |
| `scripts/` | 独立打包、隔离消费测试、历史/源码审计 |

## 保留的行为和边界

- 优先直接复用公共模块，网页项目不要照研究笔记重写算法。
- 拟合在 sRGB 编码空间；Three.js 材质纯色在 Linear-sRGB。保持这两个边界，不进行重复 gamma 转换。
- RBF（含岭正则）、单调曲线、带约束反解、主色精确解/17³ LUT 是经过验证的选择。改动需要新测量证据与回归，不能为了整理或「物理正确」替换。
- 纹理/纯色/动态探针共享 solveWritten。仅补偿原始数据的导出副本一次，连续导出不叠加。
- 默认档只覆盖文档记录的形状、材质、补光和目标。无边记卡片未独立实测；模型预测不能作为 Apple 实测。不要承诺解决所有 USDZ 色差。
- 不混用不同测量条件的样本。纸张贴图面粗糙度 0.9，端面 0.85。补光既要正确像素也要正确 diffuse/emissive 连接。
- `three@0.169.0` 导出链路与 vendored r185 加载链路分开维护；不要因加载器而整体升级。保留 visible 过滤、原动画、标准 64 字节 USDZ 对齐与 extent 规则。
- 独立核心不引入 DOM、React、Three.js 或 FFmpeg；外部适配放调用方。

## 验证

```sh
npm ci
npm test
npm run build
npm run test:color:standalone
npm run example:color
npm run audit:source
```

数值基线来自提取前 `c947ee4`，不是本次新增的实机截图。涉及 Apple 外观的行为变化应额外使用照片+纯色、未补偿+补偿 USDZ 做目标 App 验收，记录版本与条件。

## 开源状态

准备开始时 GitHub 仓库为 PRIVATE；用户已授权在检查无阻塞项后提交、推送并公开，FFmpeg 原未知内核已移出当前分发文件和发布历史，采用外部固定版本 CDN + 哈希校验；核对最终历史和 dist 后按用户授权公开。不要将根 MIT LICENSE 解释成 FFmpeg WASM 也为 MIT。详见 `THIRD_PARTY_NOTICES.md`、`docs/OPEN_SOURCE_REVIEW.md`；FFmpeg 外部内核仍适用上游许可，不能复制进仓库/dist 而不处理其对应源码分发；用户已决定移除历史私人邮箱/主机名，本地与 GitHub main 的历史清理已完成并经全新远端克隆验证，仓库仍私有。后续提交使用仓库本地配置中的 GitHub noreply 身份。采用外部按需加载方案并核对仓库不含未知二进制后可按用户授权公开；远端历史替换状态见 `docs/HISTORY_PRIVACY.md`，不要 merge/push 旧克隆或备份中的未清理历史。
