import { copyFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';

// GitHub Pages 只按静态文件匹配路径：SPA 深链接（/earth、/par…）直接访问会返回
// 404 页面，搜索引擎无法收录这些子页。构建结束后把 index.html 复制成 404.html，
// Pages 在 404 时返回它，Vue Router 仍按原 URL 渲染对应路由。
function spa404Fallback() {
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    closeBundle() {
      copyFileSync('dist/index.html', 'dist/404.html');
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // 查看样式源码位置
  css: {
    devSourcemap: true,
  },
  plugins: [vue(), vueDevTools(), spa404Fallback()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
