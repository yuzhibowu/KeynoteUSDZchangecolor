import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 标题栏显示的构建时间戳。
 * 用来一眼判断浏览器里打开的到底是不是最新那一版 —— 之前 Vercel 连着五次部署被拦，
 * 页面看着没变，谁也说不清是代码没改对还是根本没上线。
 */
const BUILD_ID = new Date().toISOString().slice(5, 16).replace('T', ' ');

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
