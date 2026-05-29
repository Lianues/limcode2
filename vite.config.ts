import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@webview': path.resolve(__dirname, 'webview/src'),
      '@shared': path.resolve(__dirname, 'shared')
    }
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
