<template>
  <div class="symbology-panel">
    <div class="header"><h4>智能专题图渲染</h4></div>

    <div class="control-group">
      <label>渲染图层：</label>
      <select v-model="mapState.symbology.targetLayerId" @change="resetSymbology" class="block-select">
        <option v-for="layer in availableLayers" :key="layer.id" :value="layer.id">{{ layer.name }}</option>
      </select>
    </div>

    <div class="control-group" v-if="currentSchema">
      <label>映射字段：</label>
      <select v-model="mapState.symbology.activeField" @change="handleFieldChange" class="block-select">
        <option value="">-- 不渲染 (恢复默认) --</option>
        <option v-for="(config, key) in currentSchema" :key="key" :value="key">
          {{ config.label || key }} ({{ config.type === 'number' ? '数值' : '类型' }})
        </option>
      </select>
    </div>

    <div class="config-area" v-if="currentSchema && mapState.symbology.activeField && currentSchema[mapState.symbology.activeField]">
      
      <div v-if="mapState.symbology.renderType === 'graduated'">
        <div class="hint">当前为数值型字段，将使用渐变色映射</div>
        
        <div class="custom-range">
          <label>数据映射区间 (越界自动收敛):</label>
          <div class="range-inputs">
            <input type="number" v-model="mapState.symbology.customMin" placeholder="自动最小值" @change="triggerRender" />
            <span> ~ </span>
            <input type="number" v-model="mapState.symbology.customMax" placeholder="自动最大值" @change="triggerRender" />
          </div>
        </div>
        
        <div class="ramp-selector">
          <select v-model="mapState.symbology.colorRamp" @change="triggerRender" class="block-select ramp-select">
            <option :value="['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000']">经典热力 (蓝-青-绿-黄-红)</option>
            <option :value="['#4575b4', '#ffffbf', '#d73027']">冷暖过渡 (蓝-黄-红)</option>
            <option :value="['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15']">危险度渐变 (浅红-深红)</option>
            <option :value="['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c']">安全度渐变 (浅蓝-深蓝)</option>
            <option :value="['#ffeda0', '#feb24c', '#f03b20']">预警过渡 (黄-橙-红)</option>
          </select>
          <div class="ramp-preview" :style="{ background: `linear-gradient(to right, ${mapState.symbology.colorRamp.join(',')})` }"></div>
        </div>
      </div>

      <div v-if="mapState.symbology.renderType === 'categorized'">
        <div class="hint">当前为文本型字段，请为不同类型指定颜色：</div>
        <div class="category-list">
          <div v-for="opt in currentSchema[mapState.symbology.activeField].options" :key="opt" class="category-item">
            <input type="color" v-model="mapState.symbology.colorMap[opt]" @change="triggerRender" />
            <span>{{ opt }}</span>
          </div>
        </div>
      </div>

    </div>

    </div> <div class="stats-area" v-if="mapState.symbology.activeField && mapState.symbology.currentStats && mapState.symbology.currentStats.length > 0">
      <div class="stats-header">📊 字段数值频次统计 (受当前筛选影响)</div>
      <div class="stats-list">
        <div v-for="stat in mapState.symbology.currentStats" :key="stat.name" class="stat-item">
          <div class="stat-info">
            <span class="stat-name" :title="stat.name">{{ stat.name }}</span>
            <span class="stat-count">{{ stat.count }} 项</span>
          </div>
          <div class="stat-bar-bg">
            <div class="stat-bar" :style="{ width: Math.max(1, (stat.count / mapState.symbology.currentStats[0].count) * 100) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>
</template>

<script setup>
import { computed, watch } from 'vue';
import { mapState, fieldSchema, getFlatLayers, saveSymbologySettings, loadSymbologySettings } from '../../store/mapState';
import { applySymbology } from '../../core/symbology/ThematicRenderer';

const availableLayers = computed(() => getFlatLayers(['geojson']));

const presetColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
const currentSchema = computed(() => fieldSchema[mapState.symbology.targetLayerId] || null);

let _prevLayerId = null;
let _saveTimer = null;

// 切换目标图层时：保存旧图层设置，恢复新图层设置
watch(() => mapState.symbology.targetLayerId, (newId, oldId) => {
  if (oldId && _prevLayerId === oldId) {
    saveSymbologySettings(oldId, { ...mapState.symbology, targetLayerId: undefined });
  }
  _prevLayerId = newId;
  if (newId) {
    const saved = loadSymbologySettings(newId);
    if (saved) {
      Object.assign(mapState.symbology, saved, { targetLayerId: newId, currentStats: [] });
      applySymbology();
    } else {
      resetSymbology();
    }
  }
});

// 符号化设置变更时自动保存（500ms 防抖，避免频繁写 localStorage）
watch(() => mapState.symbology, () => {
  const layerId = mapState.symbology.targetLayerId;
  if (!layerId) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveSymbologySettings(layerId, { ...mapState.symbology, targetLayerId: undefined });
  }, 500);
}, { deep: true });

const resetSymbology = () => {
  mapState.symbology.activeField = '';
  mapState.symbology.renderType = 'none';
  mapState.symbology.customMin = null;
  mapState.symbology.customMax = null;
  applySymbology();
};

const handleFieldChange = () => {
  const field = mapState.symbology.activeField;
  if (!field) return resetSymbology();

  const schema = currentSchema.value[field];
  mapState.symbology.customMin = null; 
  mapState.symbology.customMax = null;

  if (schema.type === 'number') {
    mapState.symbology.renderType = 'graduated';
    mapState.symbology.colorRamp = ['#ffffff', '#ef4444']; 
  } else if (schema.type === 'string') {
    mapState.symbology.renderType = 'categorized';
    mapState.symbology.colorMap = {};
    schema.options.forEach((opt, index) => {
      mapState.symbology.colorMap[opt] = presetColors[index % presetColors.length];
    });
  }
  triggerRender();
};

const triggerRender = () => applySymbology();
</script>

<style scoped>
.symbology-panel { width: 100%; color: white; display: flex; flex-direction: column; }
.header { margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
h4 { margin: 0; color: #38bdf8; font-size: 16px; }

.control-group { margin-bottom: 12px; font-size: 13px; }
.block-select { width: 100%; margin-top: 4px; padding: 6px; background: #1e293b; color: white; border: 1px solid #475569; border-radius: 4px; outline: none; }

/* 🌟 新增：极值输入框 CSS */
.custom-range { margin-bottom: 10px; border: 1px dashed rgba(0, 240, 255, 0.4); padding: 8px; border-radius: 4px; background: rgba(0,0,0,0.3);}
.custom-range label { font-size: 11px; color: #38bdf8; display: block; margin-bottom: 6px; }
.range-inputs { display: flex; align-items: center; justify-content: space-between; }
.range-inputs input { width: 42%; background: #1e293b; color: #fff; border: 1px solid #475569; border-radius: 4px; padding: 4px; font-size: 12px; text-align: center; }

.ramp-selector { margin-top: 10px; }
.ramp-select { margin-bottom: 8px; }
.ramp-preview { height: 16px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); width: 100%; box-sizing: border-box;}

.config-area { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-top: 10px; }
.hint { font-size: 12px; color: #94a3b8; margin-bottom: 12px; }

.category-list { max-height: 200px; overflow-y: auto; }
.category-item { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px; }
.category-item input[type="color"] { width: 30px; height: 25px; border: none; cursor: pointer; background: none; }
.category-item span { font-size: 13px; }

/* 🌟 新增：频次统计面板样式 */
.stats-area { background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-top: 15px; border: 1px solid rgba(56, 189, 248, 0.2); }
.stats-header { font-size: 13px; color: #fbbf24; font-weight: bold; margin-bottom: 12px; border-bottom: 1px dashed rgba(251, 191, 36, 0.4); padding-bottom: 6px; }
.stats-list { max-height: 250px; overflow-y: auto; padding-right: 4px; }
.stat-item { margin-bottom: 10px; }
.stat-info { display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1; margin-bottom: 4px; }
.stat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
.stat-count { color: #38bdf8; font-weight: bold; }
.stat-bar-bg { width: 100%; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; }
.stat-bar { height: 100%; background: linear-gradient(90deg, #0ea5e9, #38bdf8); border-radius: 3px; transition: width 0.3s ease; }

/* 滚动条美化 */
.stats-list::-webkit-scrollbar { width: 4px; }
.stats-list::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }

</style>