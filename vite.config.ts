import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 标题栏显示的构建时间戳。
 * 用来一眼判断浏览器里打开的到底是不是最新那一版 —— 之前 Vercel 连着五次部署被拦，
 * 页面看着没变，谁也说不清是代码没改对还是根本没上线。
 */
// 构建时间按北京时间显示，不是 UTC。Vercel 的构建机在 UTC 上跑，toISOString 出来会比
// 用户电脑上看到的时间慢 8 小时，对着页面右上角核对「线上是不是最新版」就对不上号。
const BUILD_ID = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
  .format(new Date())
  .replace(/\//g, '-')
  .replace(/\s+/, ' ');

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
