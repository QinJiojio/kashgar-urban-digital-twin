// 要素搜索引擎：从已加载的 Cesium DataSource 中按字段模糊匹配
import * as Cesium from 'cesium';
import { getViewer } from './viewer/ViewerSetup';
import { getLayer } from './layers/LayerManager';
import { fieldSchema, getLayerState, getFlatLayers } from '../store/mapState';

// 返回可搜索的矢量图层列表（不含 3dtiles）
export const getSearchableLayers = () => {
  return getFlatLayers(['geojson']).filter(l => l.url && l.features?.length > 0);
};

// 获取图层的可搜索字段列表（排除系统字段）
export const getSearchableFields = (layerId) => {
  const schema = fieldSchema[layerId];
  if (!schema) return [];
  return Object.keys(schema).filter(k => k.toUpperCase() !== 'OBJECTID');
};

// 搜索：从 DataSource 的 entity.properties 中部分匹配
// 返回 { featureId, entityId, matchValue, properties }，最多 maxResults 条
export const searchByField = (layerId, fieldKey, searchText, maxResults = 50) => {
  if (!searchText || searchText.trim().length === 0) return [];
  const term = searchText.trim().toLowerCase();
  const ds = getLayer(layerId);
  if (!(ds instanceof Cesium.GeoJsonDataSource)) return [];
  const time = Cesium.JulianDate.now();
  const results = [];
  for (const entity of ds.entities.values) {
    if (results.length >= maxResults) break;
    const props = entity.properties ? entity.properties.getValue(time) : null;
    if (!props) continue;
    const raw = props[fieldKey];
    if (raw === undefined || raw === null) continue;
    const str = String(raw);
    if (str.toLowerCase().includes(term)) {
      results.push({
        featureId: String(props.OBJECTID || entity.id),
        entityId: entity.id,
        matchValue: str,
        properties: props
      });
    }
  }
  return results;
};

// 飞到要素
export const flyToFeatureById = (layerId, featureId) => {
  const viewer = getViewer();
  if (!viewer || viewer.isDestroyed()) return;
  const ds = getLayer(layerId);
  const entities = ds instanceof Cesium.GeoJsonDataSource ? ds.entities.values : viewer.entities.values;
  for (const e of entities) {
    const p = e.properties ? e.properties.getValue(Cesium.JulianDate.now()) : null;
    if (p && String(p.OBJECTID) === String(featureId)) {
      viewer.flyTo(e, { duration: 1.2 });
      return;
    }
  }
};
