# 2026-10-13 公开发布记录

仓库：[yuzhibowu/KeynoteUSDZchangecolor](https://github.com/yuzhibowu/KeynoteUSDZchangecolor)，GitHub 确认 PUBLIC。

- 原创源码、色彩模块、文档及实测档使用 MIT，第三方保留原许可。
- 个人邮箱及旧主机名已从主线提交记录清理，后续使用 GitHub noreply。
- 未知来源 FFmpeg JS/WASM 已从当前树和完整主线历史移除；其余文件、作者/日期及提交关系逐项核对保留。
- 浏览器从固定 CDN 加载官方 `@ffmpeg/core@0.12.10`，下载后校验 SHA-256。内核仍适用上游 GPL；仓库及 dist 不携带内核二进制。
- 273 项测试、类型检查、生产构建和独立色彩包测试通过。真实浏览器 Worker 成功编码及解码 ProRes 4444 XQ MOV，最大 alpha 误差 1/255；本机独立解码验证相同误差上限。
- 公开前从 GitHub 全新镜像验证 157 个提交、仅 main 引用、旧内核 blob 不在对象库、提交身份均为 noreply；GitHub 没有 PR 或 fork。之后仅追加发布文档提交。

其他项目集成请从 [AI_INTEGRATION.md](AI_INTEGRATION.md) 和 [COLOR_CORRECTION.md](COLOR_CORRECTION.md) 开始。首次浏览器 MOV 编码需要联网，用户图片与帧数据不上传 CDN。USDZ、PNG 序列和独立颜色模块不依赖内核下载。

另一任务的导出助手接入未纳入此次发布，未提交文件完整保留。此次没有重新验证所有 Apple 版本的显示色准。再分发许可边界见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，GitHub 缓存和私有恢复备份边界见 [HISTORY_PRIVACY.md](HISTORY_PRIVACY.md)。
