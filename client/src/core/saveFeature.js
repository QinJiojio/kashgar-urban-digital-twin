// 保存单个要素到 GeoJSON 文件
import * as Cesium from 'cesium';
import { getViewer } from './viewer/ViewerSetup';
import { getLayerState, fieldSchema, showToast } from '../store/mapState';
import { getLayer } from './layers/LayerManager';
import { markSaved, getKnownVersion, syncLayerVersion, syncFeatureVersion, fetchFeatureVersion } from './locks';

export const saveFeature = async (layerId, featureId, options = {}) => {
  const { keepLock = false } = options;
  const viewer = getViewer();
  const layerInfo = getLayerState(layerId);
  if (!layerInfo || !layerInfo.features) return null;
  let targetUrl = layerInfo.url;
  if (!targetUrl) {
    targetUrl = `data/annotations/layer_${Date.now()}.geojson`;
    layerInfo.url = targetUrl;
    import('../store/mapState.js').then(m => m.saveLayerConfig());
  }

  // 找到被编辑的那个 entity（优先 OBJECTID 匹配，其次 Cesium entity ID）
  const layerDataSource = getLayer(layerId);
  let entity = null;
  const candidates = layerDataSource ? layerDataSource.entities.values : viewer.entities.values;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    if (!e.properties) continue;
    const props = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
    if (props && String(props.OBJECTID) === String(featureId)) { entity = e; break; }
    if (String(e.id) === String(featureId)) { entity = e; break; }
  }
  if (!entity) {
    console.warn('[saveFeature] 未找到实体:', featureId);
    return null;
  }

  // 提取该要素的 geometry
  let coords = [];
  const geomType = layerInfo.geometryType || 'polygon';
  if (geomType === 'polygon' && entity.polygon && entity.polygon.hierarchy) {
    const hierarchy = entity.polygon.hierarchy.getValue ? entity.polygon.hierarchy.getValue(Cesium.JulianDate.now()) : entity.polygon.hierarchy;
    const toLonLat = (p) => { const c = Cesium.Cartographic.fromCartesian(p); return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]; };
    const makeRing = (positions) => { const ring = positions.map(toLonLat); ring.push(ring[0]); return ring; };
    const rings = [makeRing(hierarchy.positions)];
    if (hierarchy.holes && hierarchy.holes.length) {
      for (const hole of hierarchy.holes) rings.push(makeRing(hole.positions));
    }
    coords = rings;
  } else if (geomType === 'polyline' && entity.polyline) {
    const positions = typeof entity.polyline.positions.getValue === 'function' ? entity.polyline.positions.getValue(Cesium.JulianDate.now()) : entity.polyline.positions;
    coords = positions.map(p => { const c = Cesium.Cartographic.fromCartesian(p); return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]; });
  } else if (geomType === 'point' && entity.position) {
    const pos = typeof entity.position.getValue === 'function' ? entity.position.getValue(Cesium.JulianDate.now()) : entity.position;
    const c = Cesium.Cartographic.fromCartesian(pos);
    coords = [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
  }

  // 提取 properties
  const cleanProps = {};
  if (entity.properties) {
    const readVal = (name) => { const p = entity.properties[name]; if (p === undefined || p === null) return undefined; return p.getValue ? p.getValue(Cesium.JulianDate.now()) : p; };
    const schema = fieldSchema[layerId] || {};
    for (const key in schema) { const v = readVal(key); if (v !== undefined && v !== null) cleanProps[key] = v; }
    entity.properties.propertyNames.forEach(name => { if (!(name in cleanProps)) { const v = readVal(name); if (v !== undefined && v !== null) cleanProps[name] = v; } });
  }

  const feature = {
    id: String(featureId),
    properties: cleanProps,
    geometry: { type: geomType === 'polygon' ? 'Polygon' : (geomType === 'polyline' ? 'LineString' : 'Point'), coordinates: coords }
  };

  // 要素版本未知时先从服务端拉取（从未编辑过的要素版本不在本地缓存中）
  if (!getKnownVersion(layerId, featureId)) {
    await fetchFeatureVersion(layerId, featureId);
  }
  const payload = JSON.stringify({ filePath: targetUrl, feature, layerId, _clientVersion: getKnownVersion(layerId, featureId) });

  const t1 = performance.now();
  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const response = await fetch('/api/features', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: payload
    });
    const result = await response.json();
    const elapsed = (performance.now() - t1).toFixed(0);
    if (response.ok && result.success) {
      const finalId = result.assignedId || featureId;
      if (result.geometryProtected) {
        showToast('该要素为多部件几何，几何编辑暂不支持保存（已保护原几何、仅保存了属性）', 'warning', 5000);
      }
      // 服务端分配了新 ID：更新 entity 属性和 layer.features
      if (result.assignedId && result.assignedId !== String(featureId)) {
        if (entity.properties) {
          entity.properties.OBJECTID = parseInt(result.assignedId);
        }
        const layerFeatures = layerInfo.features;
        if (layerFeatures) {
          const feat = layerFeatures.find(f => String(f.id) === String(featureId) || String(f.properties?.OBJECTID) === String(featureId));
          if (feat) {
            feat.id = result.assignedId;
            if (feat.properties) feat.properties.OBJECTID = parseInt(result.assignedId);
          }
        }
      }
      if (keepLock) {
        syncLayerVersion(layerId);
        syncFeatureVersion(layerId, finalId);
      } else {
        await markSaved(layerId, finalId);
      }
    } else {
      if (response.status === 409) {
        showToast('数据已被他人修改，正在刷新...', 'warning', 0);
        return { success: false, conflict: true, modifiedBy: result.modifiedBy };
      }
      console.warn(`[saveFeature] ❌ 保存失败 | HTTP ${response.status} | 耗时 ${elapsed}ms |`, result.error || result);
    }
    // 挤出模型图层：保存后同步更新 extrudedHeight
    if (result?.success && entity?._heightField) {
      const { refreshExtrudedHeight } = await import('./layers/LayerManager.js');
      refreshExtrudedHeight(entity);
    }
    return result;
  } catch (err) { console.error(`[saveFeature] ❌ 网络错误 | 耗时 ${(performance.now()-t1).toFixed(0)}ms |`, err); return null; }
};

/**
 * 为已有要素（geometry:null）直接保存几何，跳过 entity 查找和提取。
 * 适用于"纯表格行绑定绘图"场景——该行在 Cesium 中没有 entity。
 * @param {string} layerId
 * @param {string} objectId - 已有要素的 OBJECTID
 * @param {object} geometry - { type: 'Point'|'LineString'|'Polygon', coordinates }
 */
export const saveGeometryForFeature = async (layerId, objectId, geometry) => {
  const layerInfo = getLayerState(layerId);
  if (!layerInfo) return null;
  let targetUrl = layerInfo.url;
  if (!targetUrl) {
    targetUrl = `data/annotations/layer_${Date.now()}.geojson`;
    layerInfo.url = targetUrl;
    import('../store/mapState.js').then(m => m.saveLayerConfig());
  }

  const feature = {
    id: String(objectId),
    properties: {},
    geometry
  };

  if (!getKnownVersion(layerId, objectId)) {
    await fetchFeatureVersion(layerId, String(objectId));
  }
  const payload = JSON.stringify({
    filePath: targetUrl,
    feature,
    layerId,
    _clientVersion: getKnownVersion(layerId, objectId)
  });

  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const response = await fetch('/api/features', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: payload
    });
    const result = await response.json();
    if (response.ok && result.success) {
      if (result.geometryProtected) {
        showToast('该要素为多部件几何，几何编辑暂不支持（已保护原几何、仅保存了属性）', 'warning', 5000);
      }
      await markSaved(layerId, String(objectId));
      return result;
    }
    if (response.status === 409) {
      showToast('数据已被他人修改，正在刷新...', 'warning', 0);
      return { success: false, conflict: true, modifiedBy: result.modifiedBy };
    }
    showToast(result.error || '保存失败', 'error');
    return null;
  } catch (err) {
    console.error('[saveGeometryForFeature] 网络错误:', err);
    return null;
  }
};
