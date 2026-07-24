import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cesium from 'vite-plugin-cesium';
import path from 'path'

const CESIUM_BUILD_ROOT = path.resolve(__dirname, 'node_modules', 'cesium', 'Build');

export default defineConfig({
  plugins: [
    vue(),
    cesium({ cesiumBuildRootPath: CESIUM_BUILD_ROOT, devMinifyCesium: true }),
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': 'http://localhost:3000',
      '/data': 'http://localhost:3000',
      '/tiles': 'http://localhost:3000'
    }
  }
});
