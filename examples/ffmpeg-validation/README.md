# 浏览器编码内核验证

运行 `npm run dev`，访问 `/examples/ffmpeg-validation/`，点击「验证透明 MOV」。页面生成两帧 64×64 PNG，四个透明度区域为 0/64/128/255；使用与主应用相同的内核下载/哈希校验和 Worker，再编码 ProRes 4444 XQ，解码检查 alpha 最大误差不超过 1/255。输出 `ok:true` 才算通过。首次执行需要联网下载约 31 MiB 内核。

这验证浏览器 Worker 编码链路，不是 Apple Keynote 实机验色。测试图片由代码生成，未上传到 CDN；CDN 只提供上游固定版本代码。
