import * as Cesium from 'cesium';
import { fieldSchema, getLayerState } from '../../store/mapState';
import { getLayer } from '../layers/LayerManager';
import { applySymbology } from '../symbology/ThematicRenderer';

const evaluateRule = (featureValue, rule, layerId) => {
  const schema = fieldSchema[layerId]?.[rule.field]; 
  if (!schema || featureValue === undefined || featureValue === null) return false;

  if (schema.type === 'number') {
    const val = Number(featureValue);
    const target = Number(rule.value);
    switch (rule.operator) {
      case '>=': return val >= target;
      case '<=': return val <= target;
      case '=':  return val === target;
      case 'between': return val >= Number(rule.value[0]) && val <= Number(rule.value[1]);
      default: return true;
    }
  } 
  
  if (schema.type === 'string') {
    switch (rule.operator) {
      case 'in': 
        if (!rule.value || rule.value.length === 0) return true;
        return rule.value.includes(featureValue);
      default: return true;
    }
  }
  return true;
};

// 🌟 完美下放：接收 layerId，只管过滤当前图层
export const applyAttributeFilter = (layerId) => {
  const config = getLayerState(layerId);
  if (!config || !config.filter) return;
  
  const { logicalOp, rules } = config.filter;
  const dataSource = getLayer(layerId);
  
  if (!dataSource || !dataSource.entities) return;

  dataSource.entities.suspendEvents();

  dataSource.entities.values.forEach(entity => {
    const props = entity.properties;
    if (!props) return;

    if (!rules || rules.length === 0) {
      entity.show = true;
      return;
    }

    let isVisible = logicalOp === 'AND' ? true : false;

    for (const rule of rules) {
      const val = props[rule.field] ? props[rule.field].getValue(Cesium.JulianDate.now()) : null;
      const result = evaluateRule(val, rule, layerId); 

      if (logicalOp === 'AND') {
        isVisible = isVisible && result;
        if (!isVisible) break; 
      } else {
        isVisible = isVisible || result;
        if (isVisible) break; 
      }
    }
    entity.show = isVisible;
  });

  dataSource.entities.resumeEvents();
  
  // 🌟 核心管线联动：过滤完直接丢给渲染引擎重算颜色和大小
  applySymbology(layerId);
};