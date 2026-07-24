import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth.js';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';

const router = Router();

// GET /api/local-files — 递归扫描数据目录
router.get('/local-files', requireAuth, (req, res) => {
  try {
    const dataDir = path.resolve(DATA_DIR);
    const files = [];

    function getAllFiles(dirPath, basePath = '') {
      if (!fs.existsSync(dirPath)) return;

      const items = fs.readdirSync(dirPath);

      // 发现 tileset.json → 登记为 3D Tiles 入口并停止递归
      if (items.includes('tileset.json')) {
        const relativePath = basePath ? `${basePath}/tileset.json` : 'tileset.json';
        files.push(`/data/${relativePath}`.replace(/\\/g, '/'));
        return;
      }

      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativePath = basePath ? `${basePath}/${item}` : item;

        if (item === "_backups" || item.startsWith(".")) continue;
          if (fs.statSync(fullPath).isDirectory()) {
          getAllFiles(fullPath, relativePath);
        } else {
          if (item.endsWith('.geojson') || item.endsWith('.json')) {
            files.push(`/data/${relativePath}`.replace(/\\/g, '/'));
          }
        }
      }
    }

    getAllFiles(dataDir);

    res.json({ success: true, files });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
