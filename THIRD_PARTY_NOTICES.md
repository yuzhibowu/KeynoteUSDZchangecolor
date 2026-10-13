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
| `public/ffmpeg-core/ffmpeg-core.js` / `.wasm` | **含 GPL 组件，非 MIT；发布准备尚未通过**，见下文 |

锁文件许可元数据是盘点依据，不等于逐行来源鉴定。复制/改造 vendored 文件应继续保留通知；不要把第三方软件重新声明为本项目原创。

## FFmpeg 内核：尚需解决的真实发布事项

[ffmpeg.wasm 官方 FAQ](https://ffmpegwasm.netlify.app/docs/faq/) 区分 MIT 的 JavaScript wrapper 与跟随 FFmpeg/外部库许可的 core。[FFmpeg 许可说明](https://www.ffmpeg.org/legal.html) 说明启用 GPL 组件会使 FFmpeg 构建适用 GPL。

仓库内实际 WASM 的配置字符串包含 `--enable-gpl --enable-libx264 --enable-libx265`，还有 vpx、LAME、theora、vorbis、opus、webp、freetype、fribidi、ass、zimg。Git 引入记录说来自另一个 3D 项目；运行时缓存版本名是 `turntable-7.1-r1`。不能仅由此确认源码版本。

实际文件 SHA-256：

- JS：`048fbe17d701fdecfe87f8908090683636d405f87592943e8aae484d18047118`
- WASM：`5d05078d2d38c36140d660bd957dbb27b428dcfbe90155b1bd309ae2b84764d3`

本次对比官方 npm `@ffmpeg/core@0.12.10`（声明 GPL-2.0-or-later），其 WASM SHA-256 为 `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`，**与本仓库不相同**。因此不能把该上游版本源码链接当作本仓库二进制的对应源码证明。

目前不改现有视频能力，也不把许可当作已经清理完成。公开含这些二进制的仓库/部署前，需要找到实际构建的完整对应源码、修改、构建脚本和第三方许可，确定具体 GPL 版本并完成分发要求；或者采用经验证且来源齐全的替代构建。只删当前树文件并不会从 Git 历史移除二进制，若要以源码单独发布需选定发布仓库/历史策略。单独色彩包不包含 FFmpeg，独立使用没有此二进制依赖。
