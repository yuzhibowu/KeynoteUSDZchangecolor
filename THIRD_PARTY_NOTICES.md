# 第三方代码与许可范围

根 `LICENSE` 适用于本项目原创源码、文档、独立色彩模块和内置数值数据。第三方版权和许可不被 MIT 覆盖。依赖列表及锁定版本见 [dependency-licenses.json](docs/dependency-licenses.json)，本机已安装包的原许可/NOTICE 合集见 [NPM-NOTICES.txt](licenses/NPM-NOTICES.txt)；未安装的可选平台包由包管理器随包提供通知。

| 部分 | 许可与处理 |
|---|---|
| React、React DOM、Three.js r169、fflate、`@ffmpeg/ffmpeg`、`@ffmpeg/util` 等 | MIT；分发时保留各包原版权与许可通知 |
| `src/vendor/USDLoader.js`、`src/vendor/usd/*.js` | three.js r185 来源，MIT；已补 `src/vendor/LICENSE`（2010–2026 three.js authors），本地导入有调整 |
| TypeScript、部分开发依赖 | Apache-2.0；保留许可和适用 NOTICE |
| `@webgpu/types`、`source-map-js` | BSD-3-Clause |
| 一些开发依赖 | ISC |
| `caniuse-lite` 浏览器数据（构建工具依赖） | CC-BY-4.0；原许可与署名在通知合集，数据本身遵循该许可 |
| 浏览器独立 Worker 按需加载的 `@ffmpeg/core@0.12.10` | 上游 npm 包声明 GPL-2.0-or-later；由固定版本 CDN 提供，源码仓库和本站构建不携带它，见下文 |

锁文件许可元数据是盘点依据，不等于逐行来源鉴定。复制/改造 vendored 文件应继续保留通知；不要把第三方软件重新声明为本项目原创。

## FFmpeg 内核：外部按需加载

原未知来源的 `public/ffmpeg-core/` 二进制已移出当前文件和发布历史。项目源码及 `dist` 不分发 FFmpeg 内核；浏览器首次编码时，从固定版本 CDN 获取上游发布文件，通过 SHA-256 校验后交给独立 Worker。用户图片仍只在本机处理，不会上传 CDN。

- 包：`@ffmpeg/core@0.12.10`（单线程），上游 npm 包声明 GPL-2.0-or-later。
- 发布文件：`https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/`。
- JS SHA-256：`67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3`。
- WASM SHA-256：`9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`。
- 实现与校验：`src/lib/ffmpegCore.ts`；FFmpeg 内核没有被重新声明为 MIT。

[官方 FAQ](https://ffmpegwasm.netlify.app/docs/faq/) 区分 MIT wrapper 与跟随 FFmpeg/外部库许可的 core；[官方用法](https://ffmpegwasm.netlify.app/docs/getting-started/usage/) 给出该版本 CDN 及 Vite ESM 接入。上游项目为 [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)，[FFmpeg 许可](https://www.ffmpeg.org/legal.html) 与 [GPL-2.0](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) 说明内核许可边界。

这个处理避免本项目继续分发无法确认对应源码的历史二进制。它不免除 FFmpeg 发布方或其他分发方的许可责任。如果派生项目把内核复制到自己的仓库、静态站点、安装包或离线缓存包中进行再分发，需另行准备对应源码、构建/修改说明、完整许可与外部库通知；不能仅引用本项目 MIT LICENSE。

首次浏览器编码需要联网。固定版本校验失败或 CDN 不可达时会提示下载/校验失败；USDZ 导出、颜色模块和 PNG 序列不依赖这个下载。
