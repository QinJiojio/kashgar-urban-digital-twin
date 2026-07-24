import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import sharp from 'sharp';
import { requireEditor } from '../middleware/auth.js';
import { validateDataPath } from './pathUtils.js';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const THUMB_WIDTH = 200;

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JPG/PNG/WebP 格式'));
    }
  }
});

const router = Router();

// POST /api/upload/photo — 上传照片（需 Editor+）
// 客户端直连 Express:3000 绕过 Vite 代理的 multipart 限制
router.post('/upload/photo', requireEditor, upload.single('photo'), async (req, res) => {
  try {
    console.log('[upload] user:', req.user?.username, 'body keys:', Object.keys(req.body || {}), 'file:', !!req.file);
    const { layerId, objectId, fieldKey, seq } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到文件' });
    if (!layerId || !objectId || !fieldKey) return res.status(400).json({ error: '缺少 layerId/objectId/fieldKey' });

    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const ts = Date.now();
    const baseName = `${layerId}-${objectId}-${fieldKey}-${String(seq).padStart(2, '0')}-${ts}`;
    const filename = `${baseName}${ext}`;
    const thumbFilename = `${baseName}_thumb${ext}`;
    const dir = path.resolve(DATA_DIR, 'photos', layerId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const { writeFile } = await import('fs/promises');

    // 生成缩略图（200px 宽，~10-30KB）
    const thumbBuffer = await sharp(file.buffer)
      .resize(THUMB_WIDTH)
      .jpeg({ quality: 70 })
      .toBuffer();

    await Promise.all([
      writeFile(path.resolve(dir, filename), file.buffer),
      writeFile(path.resolve(dir, thumbFilename), thumbBuffer)
    ]);

    const url = `/data/photos/${layerId}/${filename}`;
    const thumbUrl = `/data/photos/${layerId}/${thumbFilename}`;
    res.json({ success: true, url, thumbUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/upload/photo/delete — 删除单张照片（需 Editor+）
router.post('/upload/photo/delete', requireEditor, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url' });
    const absPath = validateDataPath(url);

    // 同时删除对应的缩略图
    const parsed = path.parse(absPath);
    const thumbPath = path.resolve(parsed.dir, `${parsed.name}_thumb${parsed.ext}`);

    const { unlink } = await import('fs/promises');
    await unlink(absPath);
    try { await unlink(thumbPath); } catch {} // 缩略图可能不存在，忽略
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
