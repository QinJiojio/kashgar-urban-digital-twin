import { Router } from 'express';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { requireEditor } from '../middleware/auth.js';
import { validateDataPath } from './pathUtils.js';
import { bumpLayerVersion, bumpTreeVersion } from './locks.js';
import { withFileLock, backupFile, backupSchemaFile } from './features.js';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const SCHEMAS_DIR = path.resolve(DATA_DIR, 'schemas');

const router = Router();

// 读取图层 GeoJSON 文件
export const readLayerFile = async (layerUrl) => {
  let filePath;
  try { filePath = validateDataPath(layerUrl); } catch (_) { return null; }
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

// 写入图层 GeoJSON 文件
const writeLayerFile = async (layerUrl, data) => {
  const filePath = validateDataPath(layerUrl);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

// Schema 文件读写（独立于 GeoJSON，存储在 schemas/ 目录）
export const readSchemaFile = async (layerId) => {
  if (!existsSync(SCHEMAS_DIR)) return {};
  const filePath = path.resolve(SCHEMAS_DIR, `${layerId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
};

export const writeSchemaFile = async (layerId, data) => {
  // 先备份再写入
  await backupSchemaFile(layerId, 'schema', '');
  if (!existsSync(SCHEMAS_DIR)) mkdirSync(SCHEMAS_DIR, { recursive: true });
  const filePath = path.resolve(SCHEMAS_DIR, `${layerId}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

export const deleteSchemaFile = async (layerId) => {
  // 删除前备份（rename 不存在则尝试 copy 后 unlink）
  try { await backupSchemaFile(layerId, 'schema-delete', ''); } catch (_) {}
  const filePath = path.resolve(SCHEMAS_DIR, `${layerId}.json`);
  try { await fs.unlink(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};

// PUT /api/layers/:layerId/schema — 修改字段定义（需 Editor+）
router.put('/layers/:layerId/schema', requireEditor, async (req, res) => {
  try {
    const { url, action, field } = req.body;
    if (!url || !action || !field || !field.key) {
      return res.status(400).json({ error: '缺少必要参数: url, action, field.key' });
    }

    // 将读-改-写放在文件锁内，防止并发 PATCH 覆盖
    const filePath = path.resolve(DATA_DIR, url.replace(/^\/data\//, '').replace(/^data\//, '').replace(/^\//, ''));
    await withFileLock(filePath, async () => {
      const geojson = await readLayerFile(url);
      if (!geojson) throw Object.assign(new Error('图层文件不存在: ' + url), { status: 404 });

      // 改字段属性键前先备份 GeoJSON（删错/改错可回滚），与迁移端点同级保护
      await backupFile(filePath, 'schema', req.user?.username || '');

      if (action === 'add') {
        for (const feat of geojson.features) {
          if (!feat.properties) feat.properties = {};
          if (!(field.key in feat.properties)) {
            feat.properties[field.key] = '';
          }
        }
      } else if (action === 'delete') {
        for (const feat of geojson.features) {
          if (feat.properties) delete feat.properties[field.key];
        }
      } else if (action === 'rename') {
        const { key: oldKey, newKey } = field;
        if (!oldKey || !newKey) throw Object.assign(new Error('rename 需要 field.key 和 field.newKey'), { status: 400 });
        for (const feat of geojson.features) {
          if (feat.properties && oldKey in feat.properties) {
            feat.properties[newKey] = feat.properties[oldKey];
            delete feat.properties[oldKey];
          }
        }
      } else {
        throw Object.assign(new Error('无效的 action: ' + action), { status: 400 });
      }

      await writeLayerFile(url, geojson);
      bumpLayerVersion(req.params.layerId);
    });
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('Schema 操作失败:', e);
    res.status(status).json({ error: e.message });
  }
});

// GET /api/schemas/:layerId — 读取 schema（公开）
router.get('/schemas/:layerId', async (req, res) => {
  try {
    const data = await readSchemaFile(req.params.layerId);
    res.json(data);
  } catch (e) {
    console.error('读取 schema 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/schemas/:layerId — 更新 schema（需 Editor+）
router.put('/schemas/:layerId', requireEditor, async (req, res) => {
  try {
    const { layerId } = req.params;
    const { fields, groups } = req.body;
    if (!fields || typeof fields !== 'object') {
      return res.status(400).json({ error: '缺少必要参数: fields' });
    }
    const schemaPath = path.resolve(SCHEMAS_DIR, `${layerId}.json`);
    await withFileLock(schemaPath, async () => {
      // 解耦：持久化 groups（若提供）；fields 内的 group/order 随 fields 原样写入
      await writeSchemaFile(layerId, Array.isArray(groups) ? { groups, fields } : { fields });
      bumpLayerVersion(layerId);
    });
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('Schema 写入失败:', e);
    res.status(status).json({ error: e.message });
  }
});

// DELETE /api/schemas/:layerId — 删除 schema 文件（需 Editor+）
router.delete('/schemas/:layerId', requireEditor, async (req, res) => {
  try {
    await deleteSchemaFile(req.params.layerId);
    bumpLayerVersion(req.params.layerId);
    res.json({ success: true });
  } catch (e) {
    console.error('删除 schema 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/layers/:layerId/migrate-grouping — 把"分组编码在字段名前缀"的旧图层迁移为
// "干净字段名 + schema 元数据(groups + group/order)"。带 backup、文件锁、可回滚。
router.post('/layers/:layerId/migrate-grouping', requireEditor, async (req, res) => {
  try {
    const { layerId } = req.params;
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url' });

    const absPath = validateDataPath(url);

    let result = { migrated: 0, groups: 0, renamed: 0, skipped: false };
    await withFileLock(absPath, async () => {
      const geojson = await readLayerFile(url);
      if (!geojson || !Array.isArray(geojson.features)) throw Object.assign(new Error('图层文件不存在或无 features'), { status: 404 });

      // 收集所有字段名（来自要素 properties，排除 OBJECTID 等系统字段）
      const SYS = new Set(['OBJECTID', 'FID', 'Shape_Length', 'Shape_Area']);
      const fieldNames = new Set();
      for (const f of geojson.features) {
        if (f.properties) for (const k of Object.keys(f.properties)) if (!SYS.has(k)) fieldNames.add(k);
      }

      // 解析前缀：1-xxx=组父字段；1.1-xxx=组子字段；无前缀=基本信息。与 fieldGroups.js 同款规则。
      const renameMap = {};            // 旧名 -> 干净名
      const fieldMeta = {};            // 干净名 -> { group, order }
      const groupMap = {};             // 组号 -> { id, label, order, _fieldOrder }
      const ungrouped = [];
      let groupOrderSeq = 0;
      for (const name of fieldNames) {
        const top = name.match(/^(\d+)(?:-|\.)/);
        if (!top) { ungrouped.push(name); renameMap[name] = name; continue; }
        const gnum = top[1];
        if (!groupMap[gnum]) groupMap[gnum] = { id: `g${gnum}`, label: `分组 ${gnum}`, order: groupOrderSeq++, _fo: 0 };
        const sub = name.match(/^\d+\.(\d+)-(.*)$/);
        const parent = name.match(/^\d+-(.*)$/);
        let clean;
        if (sub) { clean = sub[2]; }
        else if (parent) { clean = parent[1]; groupMap[gnum].label = parent[1]; }
        else { clean = name.replace(/^\d+[-.]/, ''); }
        if (!clean) clean = name; // 防空名
        renameMap[name] = clean;
        fieldMeta[clean] = { group: groupMap[gnum].id, order: groupMap[gnum]._fo++ };
      }
      let uo = 0;
      for (const name of ungrouped) fieldMeta[name] = { group: null, order: uo++ };

      // 是否真的有前缀需要迁移（renameMap 中 oldK !== newK 的条目）
      const hasPrefix = Object.keys(renameMap).some(k => renameMap[k] !== k);

      // 构建 groups 元数据：有前缀→从 name 解析；无前缀→空数组（全在基本信息，group=null）
      const groups = Object.values(groupMap)
        .sort((a, b) => a.order - b.order)
        .map(g => ({ id: g.id, label: g.label, order: g.order }));

      // 有无前缀都需要写 schema 元数据，让无前缀图层也能获得 groups[] + group/order，启用任意位置添加
      const oldSchema = await readSchemaFile(layerId);
      const oldFields = oldSchema.fields || {};
      const newFields = {};
      for (const name of Object.keys(fieldMeta)) {
        const fmt = oldFields[name] || {};
        newFields[name] = { ...fmt, label: name, group: fieldMeta[name].group, order: fieldMeta[name].order };
      }

      // 始终备份（schema 重写是破坏性操作）
      await backupFile(absPath, 'migrate', req.user?.username || '');
      if (hasPrefix) {
        // 有前缀字段 → 重写 GeoJSON 属性键
        let renamed = 0;
        for (const f of geojson.features) {
          if (!f.properties) continue;
          for (const [oldK, newK] of Object.entries(renameMap)) {
            if (oldK !== newK && oldK in f.properties) {
              f.properties[newK] = f.properties[oldK];
              delete f.properties[oldK];
              renamed++;
            }
          }
        }
        await writeLayerFile(url, geojson);
        result.renamed = renamed;
      }

      await writeSchemaFile(layerId, { groups, fields: newFields });
      bumpLayerVersion(layerId);
      result.migrated = Object.keys(newFields).length;
      result.groups = groups.length;
    });
    res.json({ success: true, ...result });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('分组迁移失败:', e);
    res.status(status).json({ error: e.message });
  }
});

// ==========================================
// POST /api/layers/merge — 连接表格合并到已有图层
// ==========================================
router.post('/layers/merge', requireEditor, async (req, res) => {
  try {
    const { url, layerId, importRows, importFields, targetMatchField, importMatchField, matchMode, auxMatchMode, secondaryTargetField, secondaryImportField, tertiaryTargetField, tertiaryImportField, selectedImportFields, fieldNameResolutions, groupAssignments, createUnmatched, deleteUnmatched } = req.body;

    if (!url || !layerId || !Array.isArray(importRows) || !targetMatchField || !importMatchField || !Array.isArray(selectedImportFields)) {
      return res.status(400).json({ error: '缺少必填参数：url, layerId, importRows, targetMatchField, importMatchField, selectedImportFields' });
    }
    if (importRows.length === 0) {
      return res.status(400).json({ error: '导入数据为空' });
    }
    if (!selectedImportFields.length) {
      return res.status(400).json({ error: '至少需要选择一个要合并的字段' });
    }

    const resolutions = fieldNameResolutions || {};

    const hasAux = !!(secondaryImportField || tertiaryImportField);
    // 轻量公共子串检测（O(n) per comparison, n=短串长度）
    const _hasCommonSubstring = (a, b, minLen) => {
      if (a.length < minLen || b.length < minLen) return false;
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      const seen = new Set();
      for (let i = 0; i <= shorter.length - minLen; i++) {
        seen.add(shorter.substring(i, i + minLen));
      }
      for (const sub of seen) {
        if (longer.includes(sub)) return true;
      }
      return false;
    };
    // 路径安全校验
    const absolutePath = validateDataPath(url);

    let matchedCount = 0;
    let unmatchedCount = 0;
    let createdCount = 0;
    let deletedCount = 0;
    let skippedEmptyKey = 0;
    let newFieldsAdded = [];

    await withFileLock(absolutePath, async () => {
      const geojson = await readLayerFile(url);
      if (!geojson || !Array.isArray(geojson.features)) {
        throw Object.assign(new Error('图层文件不存在或格式错误'), { status: 404 });
      }

      // 辅助字段值归一化
      const _normAux = (v) => {
        const s = String(v ?? '').trim();
        if (!s || auxMatchMode !== 'firstlast') return s;
        return s.length === 1 ? s : s[0] + s[s.length - 1];
      };

      // 建匹配索引：主键 + 可选辅助键 → feature 索引数组
      const targetIndex = new Map();
      geojson.features.forEach((f, i) => {
        if (!f.properties) f.properties = {};
        const pk = String(f.properties[targetMatchField] ?? '').trim();
        if (!pk) return;
        const parts = [pk];
        if (secondaryTargetField) parts.push(_normAux(f.properties[secondaryTargetField]));
        if (tertiaryTargetField) parts.push(_normAux(f.properties[tertiaryTargetField]));
        const key = parts.join('||');
        if (!targetIndex.has(key)) targetIndex.set(key, []);
        targetIndex.get(key).push(i);
      });

      if (targetIndex.size === 0) {
        throw Object.assign(new Error(`目标图层 "${layerId}" 中未找到字段 "${targetMatchField}" 的有效值（全部为空）`), { status: 400 });
      }

      // 获取最大 OBJECTID（createUnmatched 时需要）
      let maxOid = 0;
      if (createUnmatched) {
        for (const f of geojson.features) {
          const oid = parseInt(f.properties?.OBJECTID);
          if (!isNaN(oid) && oid > maxOid) maxOid = oid;
        }
      }

      // 追踪已匹配的目标要素索引（用于 deleteUnmatched）
      const touchedIndices = new Set();

      // 遍历导入行
      for (const row of importRows) {
        const pk = String(row[importMatchField] ?? '').trim();
        if (!pk) { skippedEmptyKey++; continue; }
        const parts = [pk];
        if (secondaryImportField) parts.push(_normAux(row[secondaryImportField]));
        if (tertiaryImportField) parts.push(_normAux(row[tertiaryImportField]));
        const matchVal = parts.join('||');
        const hasAux = !!(secondaryImportField || tertiaryImportField);

        // 精确匹配
        let matchedIndices = targetIndex.get(matchVal);
        // 包含匹配：A包含B / B包含A / 公共子串≥5字符（仅无辅助键时使用）
        if (!matchedIndices && matchMode === 'contains' && !hasAux) {
          for (const [targetVal, indices] of targetIndex) {
            if (targetVal.includes(pk) || pk.includes(targetVal) || _hasCommonSubstring(targetVal, pk, 5)) {
              matchedIndices = indices;
              break;
            }
          }
        }

        if (matchedIndices && matchedIndices.length > 0) {
          // 构建合并属性（应用字段名映射）
          const mergeProps = {};
          for (const key of selectedImportFields) {
            const resolvedKey = resolutions[key] || key;
            const rawVal = row[key];
            mergeProps[resolvedKey] = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';
          }

          for (const idx of matchedIndices) {
            Object.assign(geojson.features[idx].properties, mergeProps);
            touchedIndices.add(idx);
          }
          matchedCount++;
        } else if (createUnmatched) {
          // 为未匹配行创建新要素
          const props = { OBJECTID: ++maxOid };
          // 也带上匹配字段的原始值
          props[importMatchField] = pk;
          if (secondaryImportField) props[secondaryImportField] = String(row[secondaryImportField] ?? '');
          if (tertiaryImportField) props[tertiaryImportField] = String(row[tertiaryImportField] ?? '');
          for (const key of selectedImportFields) {
            const resolvedKey = resolutions[key] || key;
            const rawVal = row[key];
            props[resolvedKey] = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';
          }
          geojson.features.push({
            type: 'Feature',
            geometry: null,
            properties: props
          });
          createdCount++;
        } else {
          unmatchedCount++;
        }
      }

      // 删除未匹配的目标表行
      if (deleteUnmatched && touchedIndices.size < geojson.features.length) {
        const kept = [];
        for (let i = 0; i < geojson.features.length; i++) {
          if (touchedIndices.has(i)) kept.push(geojson.features[i]);
          else deletedCount++;
        }
        geojson.features = kept;
      }

      // 更新 schema 文件（锁内原子操作）
      newFieldsAdded = [];
      const existingSchema = await readSchemaFile(layerId);
      const existingFields = existingSchema.fields || {};
      const existingFieldKeys = Object.keys(existingFields);
      const existingGroups = Array.isArray(existingSchema.groups) ? [...existingSchema.groups] : [];
      const maxOrder = Object.values(existingFields).reduce((max, f) => Math.max(max, f.order ?? 0), -1);
      let maxGroupOrder = existingGroups.reduce((max, g) => Math.max(max, g.order ?? 0), -1);

      const ga = groupAssignments || {};
      const createdGroupIds = {}; // label → id，同标签字段共享

      for (let i = 0; i < selectedImportFields.length; i++) {
        const key = selectedImportFields[i];
        const resolvedKey = resolutions[key] || key;
        if (existingFieldKeys.includes(resolvedKey)) continue;

        let groupId = null;
        const assign = ga[key] || {};
        if (assign.group) {
          groupId = assign.group;
        } else if (assign.newGroup) {
          const label = assign.newGroup.trim();
          if (createdGroupIds[label]) {
            groupId = createdGroupIds[label];
          } else {
            const newId = 'g_import_' + Date.now() + '_' + i;
            existingGroups.push({ id: newId, label, order: ++maxGroupOrder });
            groupId = newId;
            createdGroupIds[label] = newId;
          }
        }
        const importField = Array.isArray(importFields) ? importFields.find(f => f.key === key) : null;
        const inferredType = importField?.inferredType || 'text';
        const isNumeric = ['int', 'float', 'percent'].includes(inferredType);
        const entry = {
          label: resolvedKey, type: isNumeric ? 'number' : 'string',
          group: groupId, order: maxOrder + 1 + newFieldsAdded.length
        };
        if (inferredType && inferredType !== 'text') entry.format = inferredType;
        if (inferredType === 'select' && importField?.inferredOptions) entry.options = importField.inferredOptions;
        existingFields[resolvedKey] = entry;
        newFieldsAdded.push(resolvedKey);
      }

      if (newFieldsAdded.length > 0) {
        await writeSchemaFile(layerId, { fields: existingFields, groups: existingGroups });
      }

      // 备份 + 写入
      await backupFile(absolutePath, 'merge');
      await fs.writeFile(absolutePath, JSON.stringify(geojson, null, 2), 'utf-8');
    });

    // bump 版本号
    bumpLayerVersion(layerId);
    if (newFieldsAdded.length > 0) bumpTreeVersion();

    res.json({
      success: true,
      matchedCount,
      unmatchedCount,
      createdCount,
      deletedCount,
      skippedEmptyKey,
      newFields: newFieldsAdded
    });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('表格合并失败:', e);
    res.status(status).json({ error: e.message });
  }
});

// ==========================================
export default router;
