import { Router } from 'express';
import fs from 'fs/promises';
import { existsSync, mkdirSync, createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuth, requireEditor, requireAdmin } from '../middleware/auth.js';
import { validateDataPath } from './pathUtils.js';
import { bumpFeatureVersion, bumpLayerVersion, bumpTreeVersion, getFeatureVersion, setFeatureModifier, getFeatureModifier, withConfigLock } from './locks.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'D:/cesium-mvp-data');
export const BACKUP_DIR = path.resolve(DATA_DIR, '_backups');
const META_PATH = path.resolve(BACKUP_DIR, 'metadata.json');
const BACKUP_WINDOW_MS = 30 * 60 * 1000; // 30 分钟快速去重窗口（窗口内不计算哈希）
const MAX_BACKUPS_PER_LAYER = 30;
const BACKUP_DAYS = 7;

// 流式计算文件 SHA-256（不将整个文件加载到内存）
const computeFileHash = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', reject);
});

const router = Router();

// per-file mutex（供 schema.js 共用）
export const fileMutexes = new Map();
export const withFileLock = async (filePath, fn) => {
  while (fileMutexes.get(filePath)) await fileMutexes.get(filePath);
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  fileMutexes.set(filePath, promise);
  try { return await fn(); }
  finally { fileMutexes.delete(filePath); resolve(); }
};

// metadata.json 读/写 + 互斥锁（防止并发写覆盖）
let metaLock = null;
export const withMetaLock = async (fn) => {
  while (metaLock) await metaLock;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  metaLock = promise;
  try { return await fn(); }
  finally { metaLock = null; resolve(); }
};
export const readMeta = async () => {
  try { return JSON.parse(await fs.readFile(META_PATH, 'utf-8')); }
  catch (e) { return {}; }
};
export const writeMeta = async (meta) => {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
};

// 智能备份：时间窗口快速去重 + SHA-256 哈希去重 + 7天/30份清理
export const backupFile = async (absolutePath, trigger = 'auto', username = '') => {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return;
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }

  const relPath = path.relative(DATA_DIR, absolutePath);

  // Phase 1: 快速检查（metaLock 内，仅读元数据）
  let entry, now, shouldBackup = false, layerName, backupFileName, backupPath, backupDir;
  await withMetaLock(async () => {
    const meta = await readMeta();
    layerName = path.basename(absolutePath, '.geojson');
    if (!meta[relPath]) {
      try {
        const configRaw = await fs.readFile(path.resolve(DATA_DIR, 'layer-config.json'), 'utf-8');
        const config = JSON.parse(configRaw);
        const findName = (nodes, targetUrl) => {
          for (const n of nodes) {
            if (n.url && (n.url === targetUrl || targetUrl.endsWith(n.url.replace(/^data\//, '')))) return n.name;
            if (n.type === 'folder' && n.children) { const r = findName(n.children, targetUrl); if (r) return r; }
          }
          return null;
        };
        const found = findName(config.layerTree || [], 'data/' + relPath.replace(/\\/g, '/'));
        if (found) layerName = found;
      } catch (_) {}
    }
    entry = meta[relPath] || { layerName, lastBackupTime: 0, backups: [] };
    now = Date.now();

    // 30 分钟窗口内 + 文件大小相同 → 跳过（不计算哈希）
    if (trigger !== 'session_end' && (now - entry.lastBackupTime) < BACKUP_WINDOW_MS && stat.size === entry.lastSize) return;

    // 生成备份路径（锁外执行 copy）
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = path.basename(absolutePath, '.geojson');
    backupFileName = `${baseName}_${ts}.geojson`;
    const backupRelDir = path.dirname(relPath);
    backupDir = path.resolve(BACKUP_DIR, backupRelDir);
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    backupPath = path.resolve(backupDir, backupFileName);
    shouldBackup = true;
  });

  if (!shouldBackup) return;

  // Phase 2: 计算哈希 + 复制文件（锁外，不阻塞其他备份）
  let hash;
  try { hash = await computeFileHash(absolutePath); } catch (_) { return; }

  // 哈希比对（锁内，快速）
  let hashMatch = false;
  await withMetaLock(async () => {
    if (entry.lastBackupHash === hash) { hashMatch = true; entry.lastBackupTime = now; return; }
  });
  if (hashMatch) return; // 内容未变，跳过

  await fs.copyFile(absolutePath, backupPath);

  // Phase 3: 写元数据 + 清理（锁内）
  await withMetaLock(async () => {
    const meta = await readMeta();
    entry = meta[relPath] || entry;
    entry.backups.push({ file: backupFileName, time: new Date(now).toISOString(), size: stat.size, trigger, username });
    entry.lastBackupTime = now;
    entry.lastBackupHash = hash;
    entry.lastSize = stat.size;

    const cutoff = now - BACKUP_DAYS * 86400000;
    const old = entry.backups.filter(b => new Date(b.time).getTime() < cutoff);
    for (const b of old) {
      try { await fs.unlink(path.resolve(backupDir, b.file)); } catch (_) {}
    }
    entry.backups = entry.backups.filter(b => new Date(b.time).getTime() >= cutoff);
    if (entry.backups.length > MAX_BACKUPS_PER_LAYER) {
      const toRemove = entry.backups.slice(0, entry.backups.length - MAX_BACKUPS_PER_LAYER);
      for (const b of toRemove) {
        try { await fs.unlink(path.resolve(backupDir, b.file)); } catch (_) {}
      }
      entry.backups = entry.backups.slice(-MAX_BACKUPS_PER_LAYER);
    }
    meta[relPath] = entry;
    await writeMeta(meta);
  });
};

// 通用备份核心：时间窗口 + SHA-256 哈希去重 + copyFile 在锁外
const _backupGeneric = async ({ filePath, metaKey, backupDir, backupNamePrefix, backupNameSuffix, trigger, username }) => {
  let stat;
  try { stat = await fs.stat(filePath); if (!stat.isFile()) return; }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }

  let entry, now, shouldBackup = false, backupName, backupFilePath;
  await withMetaLock(async () => {
    const meta = await readMeta();
    entry = meta[metaKey] || { lastBackupTime: 0, backups: [] };
    now = Date.now();

    if (trigger !== 'session_end' && (now - entry.lastBackupTime) < BACKUP_WINDOW_MS && stat.size === entry.lastSize) return;

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backupName = `${backupNamePrefix}_${ts}.${backupNameSuffix}`;
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    backupFilePath = path.resolve(backupDir, backupName);
    shouldBackup = true;
  });
  if (!shouldBackup) return;

  let hash;
  try { hash = await computeFileHash(filePath); } catch (_) { return; }

  let hashMatch = false;
  await withMetaLock(async () => {
    if (entry.lastBackupHash === hash) { hashMatch = true; entry.lastBackupTime = now; return; }
  });
  if (hashMatch) return;

  await fs.copyFile(filePath, backupFilePath);

  await withMetaLock(async () => {
    const meta = await readMeta();
    entry = meta[metaKey] || entry;
    entry.backups.push({ file: backupName, time: new Date(now).toISOString(), size: stat.size, trigger, username });
    entry.lastBackupTime = now;
    entry.lastBackupHash = hash;
    entry.lastSize = stat.size;

    const cutoff = now - BACKUP_DAYS * 86400000;
    entry.backups = entry.backups.filter(b => {
      if (new Date(b.time).getTime() < cutoff) {
        try { fs.unlink(path.resolve(backupDir, b.file)); } catch (_) {}
        return false;
      }
      return true;
    });
    if (entry.backups.length > MAX_BACKUPS_PER_LAYER) {
      const toRemove = entry.backups.slice(0, entry.backups.length - MAX_BACKUPS_PER_LAYER);
      for (const b of toRemove) {
        try { fs.unlink(path.resolve(backupDir, b.file)); } catch (_) {}
      }
      entry.backups = entry.backups.slice(-MAX_BACKUPS_PER_LAYER);
    }
    meta[metaKey] = entry;
    await writeMeta(meta);
  });
};

// 备份 layer-config.json
export const backupConfig = (trigger = 'config', username = '') => _backupGeneric({
  filePath: path.resolve(DATA_DIR, 'layer-config.json'),
  metaKey: 'layer-config.json',
  backupDir: BACKUP_DIR,
  backupNamePrefix: 'layer-config',
  backupNameSuffix: 'json',
  trigger, username
});

// 备份 schema 元数据文件
export const backupSchemaFile = (layerId, trigger = 'schema', username = '') => _backupGeneric({
  filePath: path.resolve(DATA_DIR, 'schemas', `${layerId}.json`),
  metaKey: `schemas/${layerId}.json`,
  backupDir: path.resolve(BACKUP_DIR, 'schemas'),
  backupNamePrefix: layerId,
  backupNameSuffix: 'json',
  trigger, username
});

// POST /api/save-geojson — 保存 GeoJSON 数据（需 Editor+）
router.post('/save-geojson', requireEditor, async (req, res) => {
  try {
    const { filePath, data } = req.body;
    const absolutePath = validateDataPath(filePath);

    const targetDir = path.dirname(absolutePath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    await backupFile(absolutePath, 'auto', req.user?.username || '');
    await fs.writeFile(absolutePath, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ success: true, message: '源文件覆写/新建成功！' });
  } catch (e) {
    console.error('保存失败:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/features — 增量更新单个要素（需 Editor+）
router.patch('/features', requireEditor, async (req, res) => {
  try {
    const { filePath, feature } = req.body;
    if (!filePath || !feature) {
      return res.status(400).json({ error: '缺少 filePath 或 feature' });
    }
    const absolutePath = validateDataPath(filePath);

    const usernameP = req.user?.username || '';
    const result = await withFileLock(absolutePath, async () => {
      let geojson;
      try {
        const raw = await fs.readFile(absolutePath, 'utf-8');
        geojson = JSON.parse(raw);
      } catch (e) {
        if (e.code === 'ENOENT') {
          const targetDir = path.dirname(absolutePath);
          if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
          geojson = { type: 'FeatureCollection', features: [] };
        } else {
          throw e;
        }
      }

      const clientId = feature.id ? String(feature.id) : null;
      const idx = clientId
        ? geojson.features.findIndex(f =>
            String(f.id) === clientId || (f.properties && String(f.properties.OBJECTID) === clientId)
          )
        : -1;

      let assignedId = clientId;
      let geometryProtected = false;
      if (idx === -1) {
        // 新要素：服务端分配唯一 OBJECTID
        let maxId = 0;
        geojson.features.forEach(f => {
          const oid = parseInt(f.properties?.OBJECTID || f.properties?.objectId || f.id || 0);
          if (!isNaN(oid) && oid > maxId) maxId = oid;
        });
        assignedId = String(maxId + 1);
        geojson.features.push({
          type: 'Feature',
          id: assignedId,
          properties: { ...(feature.properties || {}), OBJECTID: parseInt(assignedId) },
          geometry: feature.geometry
        });
      } else {
        assignedId = clientId;
        geojson.features[idx].id = clientId;
        if (feature.geometry) {
          // 防腐：现有几何是多部件(Cesium 把 MultiPolygon 拆成多 entity，保存只会传回单部件)时，
          // 拒绝用单部件覆盖整条，避免丢失其它 part；属性照常合并。
          const existType = geojson.features[idx].geometry?.type;
          const inType = feature.geometry.type;
          const existMulti = existType === 'MultiPolygon' || existType === 'MultiLineString' || existType === 'MultiPoint' || existType === 'GeometryCollection';
          const inSingle = inType === 'Polygon' || inType === 'LineString' || inType === 'Point';
          if (existMulti && inSingle) {
            geometryProtected = true;
          } else {
            geojson.features[idx].geometry = feature.geometry;
          }
        }
        if (feature.properties) {
          if (!geojson.features[idx].properties) geojson.features[idx].properties = {};
          Object.assign(geojson.features[idx].properties, feature.properties);
        }
      }

      // 乐观锁：更新已有要素时校验版本号，防止丢失他人的并发修改
      if (idx !== -1 && req.body._clientVersion != null) {
        const serverVer = getFeatureVersion(req.body.layerId, clientId);
        if (Number(req.body._clientVersion) < serverVer) {
          const modifier = getFeatureModifier(req.body.layerId, clientId) || '他人';
          const err = new Error(`数据已被 ${modifier} 修改，请刷新后重试`);
          err.statusCode = 409;
          throw err;
        }
      }

      	      // 校验照片 URL：剔除磁盘上不存在的文件引用（兼容新旧两种格式）
      	      const targetFeature = geojson.features[idx === -1 ? geojson.features.length - 1 : idx];
      	      if (targetFeature?.properties) {
      	        for (const key of Object.keys(targetFeature.properties)) {
      	          const val = targetFeature.properties[key];
      	          if (typeof val === 'string' && val.includes('/data/photos/')) {
      	            // 新 JSON 格式 [{u,n}]：解析后逐条校验
      	            if (val.startsWith('[')) {
      	              try {
      	                const arr = JSON.parse(val);
      	                if (Array.isArray(arr)) {
      	                  const valid = arr.filter(p => {
      	                    if (!p || !p.u) return false;
      	                    const rel = p.u.replace(/^\/data\//, '');
      	                    try { return existsSync(path.resolve(DATA_DIR, rel)); } catch { return false; }
      	                  });
      	                  if (valid.length !== arr.length) {
      	                    targetFeature.properties[key] = valid.length ? JSON.stringify(valid) : '';
      	                  }
      	                }
      	              } catch { /* 解析失败保持原值 */ }
      	            } else {
      	              // 旧格式逗号分隔 URL（向后兼容）
      	              const urls = val.split(',').filter(Boolean);
      	              const valid = urls.filter(u => {
      	                const rel = u.replace(/^\/data\//, '');
      	                try { return existsSync(path.resolve(DATA_DIR, rel)); } catch { return false; }
      	              });
      	              if (valid.length !== urls.length) {
      	                targetFeature.properties[key] = valid.join(',');
      	              }
      	            }
      	          }
      	        }
      	      }

      await backupFile(absolutePath, 'auto', usernameP);
      await fs.writeFile(absolutePath, JSON.stringify(geojson, null, 2), 'utf-8');
      return { idx, assignedId, geometryProtected };
    });

    if (req.body.layerId) {
      bumpLayerVersion(req.body.layerId);
      // 新建要素用服务端分配的 ID，否则用客户端传来的 feature.id
      // （修复：tempId→assignedId 时 version key 错位导致乐观锁对创建者失效）
      const fid = result.idx === -1 ? result.assignedId : (feature?.id ? String(feature.id) : null);
      if (fid) {
        bumpFeatureVersion(req.body.layerId, fid);
        setFeatureModifier(req.body.layerId, fid, req.user?.displayName || req.user?.username || '');
      }
    }
    res.json({ success: true, assignedId: result.idx === -1 ? result.assignedId : undefined, geometryProtected: result.geometryProtected });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 500) console.error('单要素保存失败:', e);
    const modBy = req.body?.layerId && req.body?.feature?.id
      ? getFeatureModifier(req.body.layerId, String(req.body.feature.id)) || ''
      : '';
    res.status(status).json({ success: false, error: e.message, modifiedBy: modBy || undefined });
  }
});

// DELETE /api/features — 删除单个要素（需 Editor+）
router.delete('/features', requireEditor, async (req, res) => {
  try {
    const { filePath, featureId, layerId } = req.body;
    if (!filePath || !featureId) {
      return res.status(400).json({ error: '缺少 filePath 或 featureId' });
    }
    const absolutePath = validateDataPath(filePath);

    await withFileLock(absolutePath, async () => {
      const raw = await fs.readFile(absolutePath, 'utf-8');
      const geojson = JSON.parse(raw);
      const fid = String(featureId);
      const before = geojson.features.length;
      geojson.features = geojson.features.filter(f =>
        String(f.id) !== fid && (!f.properties || String(f.properties.OBJECTID) !== fid)
      );
      if (geojson.features.length === before) {
        throw Object.assign(new Error('未找到该要素'), { status: 404 });
      }
      await backupFile(absolutePath, 'auto', req.user?.username || '');
      await fs.writeFile(absolutePath, JSON.stringify(geojson, null, 2), 'utf-8');
      if (layerId) {
        bumpFeatureVersion(layerId, fid);
        bumpLayerVersion(layerId);
      }
    });
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('要素删除失败:', e);
    res.status(status).json({ success: false, error: e.message });
  }
});

// GET /api/export/geojson?path=xxx&name=xxx.geojson — 导出 GeoJSON 下载
router.get('/export/geojson', requireAuth, (req, res) => {
  try {
    const { path: filePath, name } = req.query;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });
    const absolutePath = validateDataPath(filePath);
    if (!absolutePath.endsWith('.geojson')) {
      return res.status(400).json({ error: '仅支持导出 .geojson 文件' });
    }
    const downloadName = name || path.basename(absolutePath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
    res.setHeader('Content-Type', 'application/geo+json');
    const stream = createReadStream(absolutePath);
    stream.pipe(res);
    stream.on('error', () => res.status(404).json({ error: '文件不存在' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/layers/copy — 复制图层（可选字段过滤）（需 Editor+）
router.post('/layers/copy', requireEditor, async (req, res) => {
  try {
    const { sourceUrl, newLayerName, selectedFields } = req.body;
    if (!sourceUrl || !newLayerName) return res.status(400).json({ error: '缺少参数' });
    let srcPath = validateDataPath(sourceUrl);

    // 如果源文件不存在，尝试扫描同目录找匹配的 .geojson 文件
    let actualSrcPath = srcPath;
    try {
      await fs.stat(srcPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        const dir = path.dirname(srcPath);
        const prefix = path.basename(srcPath, '.geojson').replace(/_\d+$/, ''); // 去尾部时间戳
        const entries = await fs.readdir(dir);
        const match = entries.find(f => f.startsWith(prefix) && f.endsWith('.geojson'));
        if (match) actualSrcPath = path.resolve(dir, match);
        else return res.status(404).json({ error: '源图层文件不存在: ' + path.basename(srcPath) });
      } else throw e;
    }

    const raw = await fs.readFile(actualSrcPath, 'utf-8');
    const geojson = JSON.parse(raw);

    // 过滤字段
    if (selectedFields && selectedFields.length > 0) {
      const fields = new Set(selectedFields);
      fields.add('OBJECTID');
      geojson.features.forEach(f => {
        if (!f.properties) return;
        const filtered = {};
        fields.forEach(k => { if (k in f.properties) filtered[k] = f.properties[k]; });
        f.properties = filtered;
      });
    }

    // 生成新文件路径
    const newPath = path.resolve(path.dirname(srcPath || path.resolve(DATA_DIR, 'annotations')), `layer_${Date.now()}.geojson`);
    if (!existsSync(path.dirname(newPath))) mkdirSync(path.dirname(newPath), { recursive: true });
    await fs.writeFile(newPath, JSON.stringify(geojson, null, 2), 'utf-8');

    const newRelative = path.relative(DATA_DIR, newPath).replace(/\\/g, '/');
    const newUrl = `data/${newRelative}`;

    // 注册到 layer-config.json（放在源图层同级位置）
    const configPath = path.resolve(DATA_DIR, 'layer-config.json');
    try {
      const configRaw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configRaw);
      const newLayer = { id: `layer_${Date.now()}`, name: newLayerName, type: 'geojson', url: newUrl, show: true, opacity: 1.0, geometryType: (req.body.geometryType || 'polygon'), clampMode: 'absolute-plane', heightOffset: 0, style: { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#10b981', outlineWidth: 2 } };
      const srcLayerId = req.body.sourceLayerId;

      if (!config.layerTree) config.layerTree = [];

      // targetFolder：指定文件夹时放入该文件夹下；否则放在源图层同级
      const targetFolder = req.body.targetFolder?.trim();
      if (targetFolder) {
        const findFolderByName = (nodes, name) => {
          for (const n of nodes) {
            if (n.type === 'folder' && n.name === name) return n;
            if (n.children) { const found = findFolderByName(n.children, name); if (found) return found; }
          }
          return null;
        };
        let tFolder = findFolderByName(config.layerTree, targetFolder);
        if (!tFolder) {
          tFolder = { id: `folder_${Date.now()}`, name: targetFolder, type: 'folder', show: true, children: [] };
          config.layerTree.push(tFolder);
        }
        if (!tFolder.children) tFolder.children = [];
        tFolder.children.push(newLayer);
      } else {
        // 在 layerTree 中找到源图层，将新图层插入同级
        const insertSibling = (nodes) => {
          if (!Array.isArray(nodes)) return false;
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.id === srcLayerId) {
              nodes.splice(i + 1, 0, newLayer); // 紧接源图层之后
              return true;
            }
            if (node.type === 'folder' && node.children) {
              if (insertSibling(node.children)) return true;
            }
          }
          return false;
        };
        if (!srcLayerId || !insertSibling(config.layerTree)) {
          // 找不到源图层或未传 sourceLayerId：放顶层
          config.layerTree.push(newLayer);
        }
      }
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      bumpTreeVersion();
    } catch (_) { /* config 更新失败不影响主流程 */ }

    res.json({ success: true, url: `/data/${newRelative}`, newLayerName });
  } catch (e) {
    console.error('图层复制失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// POST /api/layers/import — 从 Excel 批量导入创建图层
// ==========================================
router.post('/layers/import', requireEditor, async (req, res) => {
  try {
    const { layerName, features, schema, targetFolder, geometryType } = req.body;
    if (!layerName || !Array.isArray(features)) {
      return res.status(400).json({ error: '缺少 layerName 或 features' });
    }

    // 生成文件名
    const configPath = path.resolve(DATA_DIR, 'layer-config.json');
    const schemasDir = path.resolve(DATA_DIR, 'schemas');
    const safeName = layerName.replace(/[<>:"/\\|?*]/g, '_');
    const timestamp = Date.now();
    const fileName = `${safeName}_${timestamp}.geojson`;
    const geoJsonPath = path.resolve(DATA_DIR, fileName);
    const relativePath = `data/${fileName}`;

    // 自动分配 OBJECTID（如果未提供）
    let maxOid = 0;
    for (const feat of features) {
      if (feat.properties?.OBJECTID) {
        const oid = parseInt(feat.properties.OBJECTID);
        if (!isNaN(oid)) maxOid = Math.max(maxOid, oid);
      }
    }
    let nextOid = maxOid + 1;
    for (const feat of features) {
      if (!feat.properties.OBJECTID) {
        feat.properties.OBJECTID = nextOid++;
      } else if (isNaN(parseInt(feat.properties.OBJECTID))) {
        feat.properties.OBJECTID = nextOid++;
      }
    }

    // 构建 FeatureCollection
    const featureCollection = {
      type: 'FeatureCollection',
      features: features.map(f => ({
        type: 'Feature',
        geometry: null,
        properties: f.properties
      }))
    };

    // 写入 GeoJSON
    await withFileLock(geoJsonPath, async () => {
      await fs.writeFile(geoJsonPath, JSON.stringify(featureCollection, null, 2), 'utf-8');
    });

    // 注册到 layer-config
    const newLayerId = `layer_${timestamp}`;

    // 写入独立 schema 文件（用 layerId 命名，与 /api/schemas/:layerId 读取路径对齐）
    if (schema && (schema.fields || schema.groups)) {
      if (!existsSync(schemasDir)) mkdirSync(schemasDir, { recursive: true });
      const schemaPath = path.resolve(schemasDir, `${newLayerId}.json`);
      const schemaDoc = {
        fields: schema.fields || {},
        groups: schema.groups || []
      };
      await fs.writeFile(schemaPath, JSON.stringify(schemaDoc, null, 2), 'utf-8');
    }
    const newLayerNode = {
      id: newLayerId,
      name: layerName,
      type: 'geojson',
      url: relativePath,
      show: true
    };
    // 可选：预指定几何类型
    if (geometryType && ['point', 'polyline', 'polygon'].includes(geometryType)) {
      newLayerNode.geometryType = geometryType;
      newLayerNode.style = {};
      if (geometryType === 'polygon') {
        newLayerNode.style = { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#10b981', outlineWidth: 2 };
      } else if (geometryType === 'polyline') {
        newLayerNode.style = { color: '#38bdf8', lineWidth: 3 };
      } else if (geometryType === 'point') {
        newLayerNode.style = { icon: 'none', fillColor: '#38bdf8' };
      }
    }

    await withConfigLock(async () => {
      const configRaw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configRaw);
      if (!config.layerTree) config.layerTree = [];

      // targetFolder：指定文件夹时放入该文件夹下；否则放入第一个 folder 下
      const findFolderByName = (nodes, name) => {
        for (const n of nodes) {
          if (n.type === 'folder' && n.name === name) return n;
          if (n.children) {
            const found = findFolderByName(n.children, name);
            if (found) return found;
          }
        }
        return null;
      };

      if (targetFolder) {
        let tFolder = findFolderByName(config.layerTree, targetFolder);
        if (!tFolder) {
          tFolder = { id: `folder_${Date.now()}`, name: targetFolder, type: 'folder', show: true, children: [] };
          config.layerTree.push(tFolder);
        }
        if (!tFolder.children) tFolder.children = [];
        tFolder.children.push(newLayerNode);
      } else {
        const findFirstFolder = (nodes) => {
          for (const n of nodes) {
            if (n.type === 'folder') {
              if (n.children && n.children.length > 0) {
                const found = findFirstFolder(n.children);
                if (found) return found;
              }
              return n;
            }
          }
          return null;
        };
        const firstFolder = findFirstFolder(config.layerTree);
        if (firstFolder) {
          if (!firstFolder.children) firstFolder.children = [];
          firstFolder.children.push(newLayerNode);
        } else {
          config.layerTree.push(newLayerNode);
        }
      }

      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      bumpTreeVersion();
    });

    bumpLayerVersion(newLayerId);

    res.json({ success: true, layerId: newLayerId, layerName, featureCount: features.length });
  } catch (e) {
    console.error('图层导入失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/backups — 列出所有备份（Admin），含 geometryType 等元数据供 UI 分类
router.get('/backups', requireAdmin, async (req, res) => {
  try {
    const meta = await readMeta();

    // 一次性读取 layer-config，同时获取 geometryType、schema 图层名、已删除图层信息
    let geoTypeMap = {};
    const schemaLayerNames = {};
    const findLayerName = (nodes, targetId) => {
      for (const n of nodes) {
        if (n.id === targetId) return n.name;
        if (n.type === 'folder' && n.children) {
          const r = findLayerName(n.children, targetId);
          if (r) return r;
        }
      }
      return null;
    };
    try {
      const configRaw = await fs.readFile(path.resolve(DATA_DIR, 'layer-config.json'), 'utf-8');
      const config = JSON.parse(configRaw);
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n.url && n.geometryType) {
            geoTypeMap[n.url.replace(/^\/?data\//, '').replace(/\\/g, '/')] = n.geometryType;
          }
          if (n.children) walk(n.children);
        }
      };
      walk(config.layerTree || []);
      // 收集 schema 图层名
      for (const fp of Object.keys(meta)) {
        if (fp.startsWith('schemas/')) {
          const lid = path.basename(fp, '.json');
          const name = findLayerName(config.layerTree || [], lid);
          if (name) schemaLayerNames[lid] = name;
        }
      }
    } catch (_) {}

    // 附加 _deleted 条目
    const deletedEntries = (meta._deleted || []).map(d => ({
      filePath: '_deleted/' + (d.movedTo || ''),
      layerName: d.layerName || '已删除的图层',
      backups: [{
        file: d.movedTo || '',
        time: d.time || '',
        size: 0,
        trigger: 'deleted',
        username: d.username || ''
      }],
      deleted: true,
      deletedInfo: { originalPath: d.originalPath, time: d.time }
    }));

    const entries = Object.entries(meta)
      .filter(([fp]) => fp !== '_deleted')
      .map(([filePath, entry]) => {
        let geometryType = null;
        let layerName = entry.layerName;
        if (filePath.startsWith('schemas/')) {
          const layerId = path.basename(filePath, '.json');
          layerName = schemaLayerNames[layerId] || layerId;
        }
        if (!filePath.startsWith('schemas/') && filePath !== 'layer-config.json') {
          geometryType = geoTypeMap[filePath] || null;
        }
        return {
          filePath,
          layerName: layerName || path.basename(filePath),
          geometryType,
          backups: entry.backups.sort((a, b) => new Date(b.time) - new Date(a.time))
        };
      });

    // 总磁盘占用
    let totalSize = 0;
    [...entries, ...deletedEntries].forEach(l => l.backups.forEach(b => totalSize += b.size || 0));

    res.json({ entries: [...entries, ...deletedEntries], totalSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backups/restore — 恢复指定备份（Admin）
router.post('/backups/restore', requireAdmin, async (req, res) => {
  try {
    const { filePath, backupFile: backupName } = req.body;
    if (!filePath || !backupName) return res.status(400).json({ error: '缺少参数' });
    const backupPath = path.resolve(BACKUP_DIR, path.dirname(filePath), backupName);
    const destPath = validateDataPath(filePath);

    if (!existsSync(backupPath)) return res.status(404).json({ error: '备份文件不存在' });

    // 恢复前先备份当前版本（区分 GeoJSON 和 schema/config 文件，用不同备份策略）
    if (filePath.startsWith('schemas/')) {
      await backupSchemaFile(path.basename(filePath, '.json'), 'restore', req.user?.username || '');
    } else if (filePath === 'layer-config.json') {
      await backupConfig('restore', req.user?.username || '');
    } else {
      await backupFile(destPath, 'restore', req.user?.username || '');
    }

    await fs.copyFile(backupPath, destPath);

    // 恢复后 bump 版本号，让所有客户端感知数据变更
    if (filePath.startsWith('schemas/')) {
      bumpLayerVersion(path.basename(filePath, '.json'));
    }
    bumpTreeVersion();

    res.json({ success: true, message: '备份已恢复' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backups/session-end — 编辑会话结束时备份（Editor+）
router.post('/backups/session-end', requireEditor, async (req, res) => {
  try {
    const { filePaths } = req.body;
    const username = req.user?.username || '';
    const tasks = [];

    // GeoJSON 数据文件并行备份（哈希去重防冗余）
    for (const fp of (filePaths || [])) {
      try {
        const absolutePath = validateDataPath(fp);
        tasks.push(backupFile(absolutePath, 'session_end', username));
      } catch (_) { /* 路径越界，跳过 */ }
    }

    // 始终备份 config + schema（哈希去重：只有实际变更才写盘）
    tasks.push(backupConfig('session_end', username));

    await Promise.all(tasks);

    // 照片目录备份（每次会话结束快照，保留 7 天/10 份）
    for (const fp of (filePaths || [])) {
      try {
        const layerId = path.basename(validateDataPath(fp), '.geojson');
        const photosDir = path.resolve(DATA_DIR, 'photos', layerId);
        if (existsSync(photosDir)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const backupPhotosDir = path.resolve(BACKUP_DIR, 'photos', `${layerId}_${ts}`);
          mkdirSync(backupPhotosDir, { recursive: true });
          const files = await fs.readdir(photosDir);
          for (const f of files) {
            await fs.copyFile(path.resolve(photosDir, f), path.resolve(backupPhotosDir, f));
          }
          // 清理旧备份（7 天/10 份）
          const photosBackupRoot = path.resolve(BACKUP_DIR, 'photos');
          if (existsSync(photosBackupRoot)) {
            const allDirs = await fs.readdir(photosBackupRoot);
            const layerDirs = allDirs.filter(d => d.startsWith(layerId + '_')).sort().reverse();
            const cutoff = Date.now() - 7 * 86400000;
            for (const d of layerDirs.slice(10)) {
              try { await fs.rm(path.resolve(photosBackupRoot, d), { recursive: true }); } catch (_) {}
            }
            for (const d of layerDirs) {
              const match = d.match(/_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
              if (match && new Date(match[1].replace(/-/g, ':').replace('T', ' ')).getTime() < cutoff) {
                try { await fs.rm(path.resolve(photosBackupRoot, d), { recursive: true }); } catch (_) {}
              }
            }
          }
        }
      } catch (_) { /* 照片目录不存在或备份失败，跳过 */ }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backups/cleanup — 清理指定图层的未勾选备份（Admin）
router.post('/backups/cleanup', requireAdmin, async (req, res) => {
  try {
    const { filePath, keepFiles } = req.body;
    if (!filePath || !keepFiles) return res.status(400).json({ error: '缺少参数' });
    let deleted = 0;
    await withMetaLock(async () => {
      const meta = await readMeta();
      const entry = meta[filePath];
      if (!entry) throw Object.assign(new Error('图层无备份记录'), { status: 404 });
      const keepSet = new Set(keepFiles);
      const backupDir = path.resolve(BACKUP_DIR, path.dirname(filePath));
      for (const b of entry.backups) {
        if (!keepSet.has(b.file)) {
          try { await fs.unlink(path.resolve(backupDir, b.file)); deleted++; } catch (_) {}
        }
      }
      entry.backups = entry.backups.filter(b => keepSet.has(b.file));
      if (entry.backups.length === 0) delete meta[filePath];
      await writeMeta(meta);
    });
    res.json({ success: true, deleted });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

export default router;
