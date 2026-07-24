import * as Cesium from 'cesium';
import { fieldSchema, getLayerState } from '../../store/mapState';
import { getLayer, IconRegistry } from '../layers/LayerManager';
import { getViewer } from '../viewer/ViewerSetup';

export const applySymbology = (layerId) => {
  const dataSource = getLayer(layerId);
  if (!dataSource || !dataSource.entities) return;

  const layerConf = getLayerState(layerId);
  if (!layerConf) return;

  const entities = dataSource.entities.values;
  dataSource.entities.suspendEvents();

  const baseAlpha = layerConf.opacity !== undefined ? Number(layerConf.opacity) : 1.0;
  const style = layerConf.style || {};
  const geomType = layerConf.geometryType || 'polygon';
  const isHeightField = !!layerConf.heightField;
  const fillAlpha = geomType === 'polygon' ? baseAlpha * (style.fillOpacity ?? 0.4) : baseAlpha;

  const thematic = layerConf.thematic || {};
  const colorField = thematic.colorField; 
  const sizeField = thematic.sizeField;   

  const schema = fieldSchema[layerId] || {};

  let colorMin = Infinity, colorMax = -Infinity;
  let sizeDataMin = Infinity, sizeDataMax = -Infinity;
  const statsMap = {}; 

  const statField = colorField || sizeField;

  entities.forEach(ent => {
    // 🛡️ 核心拦截：完全忽略被上一级“属性过滤(Filter)”干掉的要素
    if (ent.show === false) return; 

    if (statField) {
      let sVal = (ent.properties && ent.properties[statField]) ? ent.properties[statField].getValue() : null;
      const statKey = (sVal === null || sVal === undefined || sVal === '') ? '空值/未填' : String(sVal);
      statsMap[statKey] = (statsMap[statKey] || 0) + 1;
    }

    if (colorField && schema[colorField]?.type === 'number') {
      let cVal = (ent.properties && ent.properties[colorField]) ? Number(ent.properties[colorField].getValue()) : 0;
      if (!isNaN(cVal)) {
        if (cVal < colorMin) colorMin = cVal;
        if (cVal > colorMax) colorMax = cVal;
      }
    }

    if (sizeField && geomType !== 'polygon' && schema[sizeField]?.type === 'number') {
      let sVal = (ent.properties && ent.properties[sizeField]) ? Number(ent.properties[sizeField].getValue()) : 0;
      if (!isNaN(sVal)) {
        if (sVal < sizeDataMin) sizeDataMin = sVal;
        if (sVal > sizeDataMax) sizeDataMax = sVal;
      }
    }
  });

  if (thematic.customMin !== null && thematic.customMin !== undefined && thematic.customMin !== '') colorMin = Number(thematic.customMin);
  if (thematic.customMax !== null && thematic.customMax !== undefined && thematic.customMax !== '') colorMax = Number(thematic.customMax);
  if (colorMin === Infinity) colorMin = 0;
  if (colorMax === -Infinity) colorMax = 100;
  if (sizeDataMin === Infinity) sizeDataMin = 0;
  if (sizeDataMax === -Infinity) sizeDataMax = 100;

  if (statField) {
    thematic.currentStats = Object.keys(statsMap).map(key => ({
      name: key, count: statsMap[key]
    })).sort((a, b) => b.count - a.count);
  } else {
    thematic.currentStats = [];
  }

  // 预计算非专题模式下的 uniform 颜色——循环外算一次，避免 24K 次重复 fromCssColorString
  let uniformColor = null;
  if (!colorField) {
    if (geomType === 'polygon') {
      uniformColor = Cesium.Color.fromCssColorString(style.fillColor || '#10b981')
        .withAlpha(baseAlpha * (style.fillOpacity ?? 0.4));
    } else if (geomType === 'polyline') {
      uniformColor = Cesium.Color.fromCssColorString(style.color || style.outlineColor || '#38bdf8').withAlpha(baseAlpha);
    } else {
      uniformColor = Cesium.Color.fromCssColorString(style.fillColor || '#ef4444').withAlpha(baseAlpha);
    }
  }
  const uniformOutlineColor = Cesium.Color.fromCssColorString(style.outlineColor || '#ffffff').withAlpha(baseAlpha);
  const uniformOutlineWidth = style.outlineWidth || 2;
  let uniformSize = null;
  if (!sizeField || geomType === 'polygon') {
    uniformSize = geomType === 'polyline' ? (style.lineWidth || 3) : (style.radius || 10);
  }

  entities.forEach(entity => {
    let finalColorObj = uniformColor;
    if (colorField) {
      let val = (entity.properties && entity.properties[colorField]) ? entity.properties[colorField].getValue() : null;
      const fSchema = schema[colorField];

      if (fSchema && fSchema.type === 'string') {
        const hexColor = (thematic.colorMap && thematic.colorMap[val]) ? thematic.colorMap[val] : '#cccccc';
        finalColorObj = Cesium.Color.fromCssColorString(hexColor).withAlpha(fillAlpha);
      } else if (fSchema && fSchema.type === 'number') {
        if (val === undefined || val === null || val === '') val = 0;
        val = Number(val);
        let safeVal = Math.max(colorMin, Math.min(colorMax, val));
        const ratio = colorMax === colorMin ? 0 : (safeVal - colorMin) / (colorMax - colorMin);
        const rawColors = thematic.colorRamp || ['#fee5d9', '#a50f15'];
        const colors = rawColors.filter(c => typeof c === 'string');
        if (colors.length === 0) colors.push('#ffffff');
        const scaledRatio = Math.max(0, Math.min(1, ratio)) * (colors.length - 1);
        const index = Math.floor(scaledRatio);
        const remainder = scaledRatio - index;

        if (index >= colors.length - 1) {
          finalColorObj = Cesium.Color.fromCssColorString(colors[colors.length - 1]);
        } else {
          const c1 = Cesium.Color.fromCssColorString(colors[index]);
          const c2 = Cesium.Color.fromCssColorString(colors[index + 1]);
          finalColorObj = Cesium.Color.lerp(c1, c2, remainder, new Cesium.Color());
        }
        finalColorObj = finalColorObj.withAlpha(fillAlpha);
      }
    }

    let finalSize = uniformSize;
    if (sizeField && geomType !== 'polygon' && schema[sizeField]?.type === 'number') {
      let sVal = (entity.properties && entity.properties[sizeField]) ? Number(entity.properties[sizeField].getValue()) : 0;
      let safeVal = Math.max(sizeDataMin, Math.min(sizeDataMax, sVal));
      const ratio = sizeDataMax === sizeDataMin ? 0 : (safeVal - sizeDataMin) / (sizeDataMax - sizeDataMin);
      const minP = thematic.sizeMin || 5;
      const maxP = thematic.sizeMax || 30;
      finalSize = minP + ratio * (maxP - minP);
    }

    // 🌟 赋值管道
    if (geomType === 'polygon' && entity.polygon) {
      entity.polygon.material = finalColorObj;
      // 挤出大图层不创建 outline polyline entity——省 24K entity，render 量减半
      if (isHeightField) {
        entity.polygon.outline = false;
      } else {
        entity.polygon.outline = false;
        const positions = entity._hierarchyPositions || [];
        if (positions.length >= 3) {
          if (!entity._outline) {
            const outlinePositions = [...positions, positions[0]];
            entity._outline = dataSource.entities.add({
              polyline: { positions: outlinePositions, width: uniformOutlineWidth, material: uniformOutlineColor, clampToGround: false }
            });
            entity._outline._outlineParent = entity;
            entity._outline.basePositions = outlinePositions;
          } else {
            entity._outline.polyline.material = uniformOutlineColor;
            entity._outline.polyline.width = uniformOutlineWidth;
          }
        }
      }
    } else if (geomType === 'polyline' && entity.polyline) {
      entity.polyline.material = finalColorObj;
      entity.polyline.width = finalSize;
    } else if (geomType === 'point') {
      
      // 🌟 核心拦截：图标(Billboard) 与 小圆点(Point) 的动态切换
      const iconKey = style.icon || 'none';
      if (iconKey !== 'none' && IconRegistry[iconKey]) {
        // 使用矢量图标
        if (!entity.billboard) entity.billboard = new Cesium.BillboardGraphics();
        if (entity.point) entity.point.show = false;
        entity.billboard.show = true;
        entity.billboard.image = IconRegistry[iconKey];
        entity.billboard.color = finalColorObj;
        // Canvas 原始尺寸 64x64，scale = 目标像素 / 64
        entity.billboard.scale = finalSize / 64;
      } else {
        // 恢复为基础圆点
        if (!entity.point) entity.point = new Cesium.PointGraphics();
        if (entity.billboard) entity.billboard.show = false;
        entity.point.show = true;
        entity.point.color = finalColorObj;
        entity.point.pixelSize = finalSize;
        entity.point.outlineColor = Cesium.Color.fromCssColorString(style.outlineColor || '#ffffff').withAlpha(baseAlpha);
        entity.point.outlineWidth = style.outlineWidth || 2;
      }
    }
  });

  dataSource.entities.resumeEvents();
  const v = getViewer();
  if (v && !v.isDestroyed()) v.scene.requestRender();
};