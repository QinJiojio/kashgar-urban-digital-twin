import { Router } from 'express';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { requireEditor } from '../middleware/auth.js';
import { validateDataPath } from './pathUtils.js';
import { bumpTreeVersion, bumpLayerVersion, withConfigLock } from './locks.js';
import { deleteSchemaFile } from './schema.js';
import { withFileLock, backupFile, backupConfig, BACKUP_DIR, withMetaLock, readMeta, writeMeta } from './features.js';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const configPath = path.resolve(DATA_DIR, 'layer-config.json');

const router = Router();

const readConfig = async () => {
  if (existsSync(configPath)) return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  return { project: 'Kashgar_GIS_Base', layerTree: [] };
};

const writeConfig = async (config) => {
  // 先备份再写入（去重窗口内不会重复备份）
  await backupConfig('config', '');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  bumpTreeVersion();
};

// 递归查找节点
const findNode = (nodes, id) => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder' && n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
};

// 递归查找节点及其父数组+索引
const findNodeWithParent = (nodes, id) => {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { node: nodes[i], parent: nodes, index: i };
    if (nodes[i].type === 'folder' && nodes[i].children) {
      const found = findNodeWithParent(nodes[i].children, id);
      if (found) return found;
    }
  }
  return null;
};

// GET /api/layer-config — 读取图层配置
router.get('/layer-config', async (req, res) => {
  try {
    res.json(await readConfig());
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/layer-config — 保存图层配置（需 Editor+，保留兼容旧调用）
router.post('/layer-config', requireEditor, async (req, res) => {
  try {
    await withConfigLock(async () => {
      await writeConfig(req.body);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/layers — 创建空白标注图层（需 Editor+）
router.post('/layers', requireEditor, async (req, res) => {
  try {
    const { name, geometryType } = req.body;
    if (!name) return res.status(400).json({ error: '缺少图层名称' });
    const geomType = geometryType || 'polygon';
    const result = await withConfigLock(async () => {
      const config = await readConfig();
      const url = `data/annotations/layer_${Date.now()}.geojson`;
      const newLayer = {
        id: `layer_${Date.now()}`, name, type: 'geojson', url, show: true, opacity: 1.0,
        geometryType: geomType, clampMode: 'absolute-plane', heightOffset: 0,
        features: [],
        style: { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#ffffff', outlineWidth: 2, color: '#38bdf8', lineWidth: 3, radius: 10, icon: 'none' },
        thematic: { colorField: '', colorRamp: ['#0000ff','#00ffff','#00ff00','#ffff00','#ff0000'], colorMap: {}, customMin: null, customMax: null, sizeField: '', sizeMin: 5, sizeMax: 30, currentStats: [] },
        filter: { logicalOp: 'AND', rules: [] }
      };
      if (!config.layerTree) config.layerTree = [];
      let annoFolder = config.layerTree.find(n => n.type === 'folder' && n.name === '✍️ 我的标注');
      if (!annoFolder) {
        annoFolder = { id: `folder_anno_${Date.now()}`, name: '✍️ 我的标注', type: 'folder', show: true, children: [] };
        config.layerTree.unshift(annoFolder);
      }
      if (!annoFolder.children) annoFolder.children = [];
      annoFolder.children.unshift(newLayer);
      await writeConfig(config);
      return newLayer;
    });
    res.json({ success: true, layer: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/layers/:id — 删除图层或文件夹（需 Editor+）
router.delete('/layers/:id', requireEditor, async (req, res) => {
  try {
    let nodeUrl, nodeName;
    await withConfigLock(async () => {
      const config = await readConfig();
      const found = findNodeWithParent(config.layerTree, req.params.id);
      if (!found) throw Object.assign(new Error('图层不存在'), { status: 404 });
      // 捕获 URL 和名称（在 splice 之前，之后 findNode 会返回 null）
      nodeUrl = found.node?.url;
      nodeName = found.node?.name;
      found.parent.splice(found.index, 1);
      await writeConfig(config);
      // 清理关联的 schema 文件
      try { await deleteSchemaFile(req.params.id); } catch (_) {}
    });
    // 可选：删除 GeoJSON 文件（rename 到 _deleted/ 而非 unlink，可恢复）
    if (req.query.deleteFile === 'true' && nodeUrl) {
      const fp = path.resolve(DATA_DIR, nodeUrl.replace(/^data\//, ''));
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const deletedDir = path.resolve(BACKUP_DIR, '_deleted');
      if (!existsSync(deletedDir)) mkdirSync(deletedDir, { recursive: true });
      const dest = path.resolve(deletedDir, `${path.basename(fp, '.geojson')}_deleted_${ts}.geojson`);
      try {
        await fs.rename(fp, dest);
        // 记录到 metadata 供恢复
        await withMetaLock(async () => {
          const meta = await readMeta();
          if (!meta._deleted) meta._deleted = [];
          meta._deleted.push({
            originalPath: nodeUrl, movedTo: path.relative(BACKUP_DIR, dest),
            layerName: nodeName || path.basename(fp, '.geojson'), time: new Date().toISOString(),
            username: req.user?.username || ''
          });
          await writeMeta(meta);
        });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    res.json({ success: true });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/layers/:id — 重命名图层/文件夹（需 Editor+）
router.patch('/layers/:id', requireEditor, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '缺少 name' });
    await withConfigLock(async () => {
      const config = await readConfig();
      const node = findNode(config.layerTree, req.params.id);
      if (!node) return res.status(404).json({ error: '节点不存在' });
      node.name = name;
      await writeConfig(config);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/layers/reorder — 拖拽排序（需 Editor+）
router.put('/layers/reorder', requireEditor, async (req, res) => {
  try {
    const { layerId, newParentId, index } = req.body;
    if (!layerId) return res.status(400).json({ error: '缺少 layerId' });
    await withConfigLock(async () => {
      const config = await readConfig();
      const found = findNodeWithParent(config.layerTree, layerId);
      if (!found) return res.status(404).json({ error: '节点不存在' });
      // 从原位置移除
      const [node] = found.parent.splice(found.index, 1);
      // 插入新位置
      const target = newParentId ? findNode(config.layerTree, newParentId) : null;
      const targetArr = (target && target.type === 'folder' && target.children) ? target.children : config.layerTree;
      const idx = Math.min(Math.max(0, index ?? targetArr.length), targetArr.length);
      targetArr.splice(idx, 0, node);
      await writeConfig(config);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/layers/normalize-oids — 规范化 GeoJSON 中的 OBJECTID + 清理退化碎片
router.post('/layers/normalize-oids', requireEditor, async (req, res) => {
  try {
    const { filePath, layerId, dryRun } = req.body;
    if (!filePath) return res.status(400).json({ error: '缺少 filePath' });
    const absPath = validateDataPath(filePath);
    if (!existsSync(absPath)) return res.status(404).json({ error: '文件不存在' });

    let cleaned = 0, updated = 0, dupFixed = 0;
    let brokenOids = [];  // dryRun 时收集前几个异常 OBJECTID 供预览

    await withFileLock(absPath, async () => {
      const raw = await fs.readFile(absPath, 'utf-8');
      const geojson = JSON.parse(raw);
      if (!geojson.features || !Array.isArray(geojson.features)) return;

      // 清理退化碎片：MultiPolygon 中面积 < 1m² 且非主 part 的子多边形
      const ringAreaM2 = (ring) => {
        if (!Array.isArray(ring) || ring.length < 4) return 0;
        const mLat = 111320, mLon = 111320 * Math.cos((ring[0][1] || 0) * Math.PI / 180);
        const x0 = ring[0][0], y0 = ring[0][1];
        let a = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const ax = (ring[i][0] - x0) * mLon, ay = (ring[i][1] - y0) * mLat;
          const bx = (ring[i + 1][0] - x0) * mLon, by = (ring[i + 1][1] - y0) * mLat;
          a += ax * by - bx * ay;
        }
        return Math.abs(a / 2);
      };
      const AREA_THRESHOLD = 1;
      for (const f of geojson.features) {
        const g = f.geometry;
        if (!g || g.type !== 'MultiPolygon' || !Array.isArray(g.coordinates) || g.coordinates.length <= 1) continue;
        const parts = g.coordinates.map(poly => ({ poly, area: ringAreaM2(poly && poly[0]) }));
        const maxArea = Math.max(...parts.map(p => p.area));
        if (maxArea <= 0) continue;
        const kept = parts.filter(p => p.area >= AREA_THRESHOLD || p.area >= maxArea);
        if (kept.length === parts.length) continue;
        cleaned += parts.length - kept.length;
        if (kept.length === 1) f.geometry = { type: 'Polygon', coordinates: kept[0].poly };
        else g.coordinates = kept.map(p => p.poly);
      }

      // 规范化 OBJECTID
      let maxId = 0;
      const needsFix = [];
      for (let i = 0; i < geojson.features.length; i++) {
        const oid = geojson.features[i].properties?.OBJECTID;
        const oidStr = String(oid);
        if (!oid || oid === 0 || (oidStr.length > 10 && oidStr.includes('-')) || isNaN(Number(oid))) {
          needsFix.push(i);
          // dryRun 时收集前 5 个异常 OID 样本
          if (dryRun && brokenOids.length < 5) {
            brokenOids.push(oidStr.substring(0, 40));
          }
        } else {
          const n = Number(oid);
          if (n > maxId) maxId = n;
        }
      }
      for (const idx of needsFix) {
        maxId++;
        geojson.features[idx].properties = geojson.features[idx].properties || {};
        geojson.features[idx].properties.OBJECTID = maxId;
      }

      // 去重
      const seen = new Set();
      for (const f of geojson.features) {
        const oid = f.properties?.OBJECTID;
        if (oid === undefined || oid === null) continue;
        const key = String(oid);
        if (seen.has(key)) {
          maxId++;
          f.properties.OBJECTID = maxId;
          seen.add(String(maxId));
          dupFixed++;
        } else {
          seen.add(key);
        }
      }

      updated = needsFix.length;
      if (!dryRun && (updated > 0 || cleaned > 0 || dupFixed > 0)) {
        await backupFile(absPath, 'cleanup');
        await fs.writeFile(absPath, JSON.stringify(geojson, null, 2), 'utf-8');
        if (layerId) bumpLayerVersion(layerId);
      }
    });

    res.json({ success: true, updated, cleaned, dupFixed, brokenOids: dryRun ? brokenOids : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/layers/renumber-oids — 按当前排序重新编号 OBJECTID
router.post('/layers/renumber-oids', requireEditor, async (req, res) => {
  try {
    const { url, layerId, mapping } = req.body; // mapping: [{ oldOid, newOid }]
    if (!url || !Array.isArray(mapping) || mapping.length === 0) {
      return res.status(400).json({ error: '缺少 url 或 mapping' });
    }

    const absPath = validateDataPath(url);
    if (!existsSync(absPath)) return res.status(404).json({ error: '文件不存在' });

    let updated = 0;
    await withFileLock(absPath, async () => {
      const raw = await fs.readFile(absPath, 'utf-8');
      const geojson = JSON.parse(raw);
      if (!geojson.features || !Array.isArray(geojson.features)) {
        throw Object.assign(new Error('图层文件格式错误'), { status: 400 });
      }

      // 构建 oldOid → newOid 映射表（去重：同 OBJECTID 的多部件取首次出现位置）
      const oidMap = new Map();
      for (const { oldOid, newOid } of mapping) {
        const key = String(oldOid);
        if (!oidMap.has(key)) oidMap.set(key, Number(newOid));
      }

      // 验证所有 oldOid 都在 GeoJSON 中存在（防并发修改）
      const existingOids = new Set();
      for (const f of geojson.features) {
        const oid = f.properties?.OBJECTID;
        if (oid !== undefined && oid !== null) existingOids.add(String(oid));
      }
      for (const oldOid of oidMap.keys()) {
        if (!existingOids.has(oldOid)) {
          throw Object.assign(new Error(`OBJECTID ${oldOid} 不存在（图层可能已被修改，请刷新后重试）`), { status: 409 });
        }
      }

      // 应用映射
      for (const f of geojson.features) {
        const oid = f.properties?.OBJECTID;
        if (oid === undefined || oid === null) continue;
        const newOid = oidMap.get(String(oid));
        if (newOid !== undefined) {
          f.properties = f.properties || {};
          f.properties.OBJECTID = newOid;
          updated++;
        }
      }

      if (updated > 0) {
        await backupFile(absPath, 'renumber');
        await fs.writeFile(absPath, JSON.stringify(geojson, null, 2), 'utf-8');
        if (layerId) bumpLayerVersion(layerId);
      }
    });

    res.json({ success: true, updated });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('重编号失败:', e);
    res.status(status).json({ error: e.message });
  }
});

export default router;
