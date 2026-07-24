// postbuild: 从 client/node_modules 复制 Cesium 静态资源到 dist/cesium/
const fs = require('fs');
const path = require('path');

const srcBase = path.resolve(__dirname, '..', 'node_modules', 'cesium', 'Build', 'Cesium');
const destBase = path.resolve(__dirname, '..', 'dist', 'cesium');

if (!fs.existsSync(path.join(srcBase, 'Cesium.js'))) {
  console.error('[copy-cesium] Source not found:', srcBase);
  process.exit(1);
}

// 清理旧文件
fs.rmSync(destBase, { recursive: true, force: true });
fs.mkdirSync(destBase, { recursive: true });

// 复制核心文件 + 目录
const items = ['Cesium.js', 'Assets', 'Workers', 'Widgets', 'ThirdParty'];
for (const name of items) {
  const src = path.join(srcBase, name);
  const dest = path.join(destBase, name);
  fs.cpSync(src, dest, { recursive: true });
}

console.log('[copy-cesium] All Cesium assets copied to dist/cesium/');
