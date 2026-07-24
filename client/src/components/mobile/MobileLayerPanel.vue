<template>
  <div class="mobile-layer-panel">
    <div class="header"><h4>🗺️ 图层管理</h4></div>

    <div class="basemap-bar">
      <label>🌍 底图</label>
      <select v-model="mapState.system.baseMap" @change="handleBaseMapChange" class="sel-sm">
        <option value="google-satellite">谷歌 高清卫星</option>
        <option value="google-hybrid">谷歌 混合卫星</option>
        <option value="google-tianditu">谷歌+天地注记</option>
        <option value="arcgis-satellite">ArcGIS 卫星</option>
        <option value="arcgis-street">ArcGIS 街道</option>
        <option value="tianditu-satellite">天地图 卫星</option>
        <option value="tianditu-hybrid">天地图 卫星+注记</option>
        <option value="tianditu-vector">天地图 电子</option>
        <option value="amap-satellite">高德 卫星</option>
        <option value="amap-vector">高德 电子</option>
      </select>
    </div>

    <div class="basemap-bar">
      <label>🏢 模型</label>
      <select :value="qualityTier" @change="handleQualityTier" class="sel-sm">
        <option value="fast">流畅（省流量）</option>
        <option value="balanced">均衡</option>
        <option value="sharp">清晰（高流量）</option>
      </select>
    </div>

    <div class="tree-list">
      <MobileTreeNode v-for="node in mapState.layerTree" :key="node.id" :node="node" :depth="0" @open-settings="openSettings" />
      <div v-if="mapState.layerTree.length === 0" class="empty-hint">图层为空</div>
    </div>

    <div class="layer-actions">
      <button class="btn-new" @click="showNewForm = true">＋ 新建图层</button>
    </div>

    <div v-if="showNewForm" class="modal-mask" @click.self="showNewForm = false">
      <div class="modal-box">
        <h4>新建图层</h4>
        <input v-model="newName" placeholder="图层名称" class="inp" />
        <select v-model="newGeomType" class="sel">
          <option value="polygon">面要素</option>
          <option value="polyline">线要素</option>
          <option value="point">点要素</option>
        </select>
        <div class="modal-btns"><button @click="showNewForm = false">取消</button><button class="primary" @click="createLayer">确定上架</button></div>
      </div>
    </div>

    <!-- 图层样式设置 Sheet -->
    <div v-if="settingsLayer" class="settings-sheet">
      <div class="ss-header">
        <span class="ss-title">⚙ {{ settingsLayer.name }}</span>
        <button @click="settingsLayer = null" class="ss-close">✕</button>
      </div>
      <div class="ss-body">
        <!-- 基本颜色 -->
        <div class="ss-section">
          <div class="ss-label">基本样式</div>
          <template v-if="settingsLayer.geometryType !== 'polyline'">
            <div class="ss-row">
              <span>填充色</span>
              <input type="color" v-model="styleRef.fillColor" @change="onStyleChange" />
            </div>
            <div class="ss-row">
              <span>填充透明度</span>
              <input type="range" min="0" max="1" step="0.01" v-model.number="styleRef.fillOpacity" @input="onStyleChange" />
              <span class="ss-val">{{ Math.round((styleRef.fillOpacity ?? 0.4) * 100) }}%</span>
            </div>
            <div class="ss-row" v-if="settingsLayer.geometryType !== 'point' || styleRef.icon === 'none'">
              <span>轮廓色</span>
              <input type="color" v-model="styleRef.outlineColor" @change="onStyleChange" />
            </div>
            <div class="ss-row" v-if="settingsLayer.geometryType !== 'point' || styleRef.icon === 'none'">
              <span>轮廓宽度</span>
              <input type="range" min="0" max="15" v-model.number="styleRef.outlineWidth" @input="onStyleChange" />
              <span class="ss-val">{{ styleRef.outlineWidth }}</span>
            </div>
          </template>
          <template v-if="settingsLayer.geometryType === 'polyline'">
            <div class="ss-row">
              <span>线条色</span>
              <input type="color" v-model="styleRef.color" @change="onStyleChange" />
            </div>
            <div class="ss-row">
              <span>线宽</span>
              <input type="range" min="1" max="15" v-model.number="styleRef.lineWidth" @input="onStyleChange" />
              <span class="ss-val">{{ styleRef.lineWidth }}</span>
            </div>
          </template>
          <!-- 点要素特有 -->
          <template v-if="settingsLayer.geometryType === 'point'">
            <div class="ss-row">
              <span>半径</span>
              <input type="range" min="4" max="50" v-model.number="styleRef.radius" @input="onStyleChange" />
              <span class="ss-val">{{ styleRef.radius }}</span>
            </div>
            <div class="ss-row">
              <span>图标</span>
              <select v-model="styleRef.icon" @change="onStyleChange" class="ss-sel">
                <option value="none">默认圆点</option>
                <option value="pin">📍 图钉</option>
                <option value="flag">🚩 旗帜</option>
                <option value="warning">⚠️ 警告</option>
                <option value="hospital">🏥 医院</option>
                <option value="school">🏫 学校</option>
                <option value="police">👮 公安</option>
                <option value="factory">🏭 工厂</option>
              </select>
            </div>
          </template>
        </div>

        <!-- 透明度 -->
        <div class="ss-section">
          <div class="ss-label">透明度</div>
          <div class="ss-row">
            <input type="range" min="0" max="1" step="0.01" v-model.number="settingsLayer.opacity" @input="onOpacityChange" />
            <span class="ss-val">{{ Math.round(settingsLayer.opacity * 100) }}%</span>
          </div>
        </div>

        <!-- 高度偏移 -->
        <div class="ss-section" v-if="settingsLayer.type === 'geojson'">
          <div class="ss-label">高度偏移</div>
          <div class="ss-row">
            <input type="range" min="-50" max="500" v-model.number="settingsLayer.heightOffset" @input="onHeightChange" />
            <span class="ss-val">{{ settingsLayer.heightOffset }}m</span>
          </div>
        </div>

        <!-- 标签 -->
        <div class="ss-section" v-if="settingsLayer.type === 'geojson'">
          <div class="ss-label">标签</div>
          <div class="ss-row">
            <span>显示标签</span>
            <label class="ss-toggle"><input type="checkbox" v-model="settingsLayer.showLabel" @change="onLabelChange" /></label>
          </div>
          <div class="ss-row" v-if="settingsLayer.showLabel">
            <span>标签字段</span>
            <select v-model="settingsLayer.labelField" @change="onLabelChange" class="ss-sel">
              <option value="">-- 选择 --</option>
              <option v-for="(f, k) in layerSchema" :key="k" :value="k">{{ f.label || k }}</option>
            </select>
          </div>
          <div class="ss-row" v-if="settingsLayer.showLabel">
            <span>字号</span>
            <input type="range" min="8" max="48" v-model.number="settingsLayer.labelFontSize" @input="onLabelChange" />
            <span class="ss-val">{{ settingsLayer.labelFontSize || 14 }}</span>
          </div>
          <div class="ss-row" v-if="settingsLayer.showLabel">
            <span>颜色</span>
            <input type="color" v-model="settingsLayer.labelColor" @change="onLabelChange" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { mapState, getLayerState, fieldSchema, saveLayerConfig, saveUserSetting, saveLayerStyle, loadLabelSettings, uk } from '../../store/mapState';
import { apiHeaders } from '../../core/apiClient';
import { switchBaseMap } from '../../core/viewer/ViewerSetup';
import { update3DTilesQuality } from '../../core/layers/LayerManager';
import MobileTreeNode from './MobileTreeNode.vue';

const emit = defineEmits(['edit-schema', 'close']);
const showNewForm = ref(false);
const newName = ref('');
const newGeomType = ref('polygon');

const handleBaseMapChange = () => { switchBaseMap(mapState.system.baseMap); saveUserSetting('cesium_baseMap', mapState.system.baseMap); };

// 模型质量三档：SSE 越小越清晰（流量/GPU 开销越大），默认均衡 2.0
const QUALITY_TIER_SSE = { fast: 8, balanced: 2, sharp: 0.5 };
const qualityTier = computed(() => {
  const sse = Number(mapState.system.currentQuality) || 2;
  if (sse >= 5) return 'fast';
  if (sse <= 1) return 'sharp';
  return 'balanced';
});
const handleQualityTier = (e) => {
  const sse = QUALITY_TIER_SSE[e.target.value] ?? 2;
  mapState.system.currentQuality = sse;
  update3DTilesQuality(sse);
};

const createLayer = async () => {
  if (!newName.value.trim()) return;
  const res = await fetch('/api/layers', {
    method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: newName.value.trim(), geometryType: newGeomType.value })
  });
  if (res.ok) {
    const { loadLayerConfig } = await import('../../store/mapState');
    await loadLayerConfig();
    const { syncTreeLayers } = await import('../../core/layers/LayerManager');
    await syncTreeLayers();
    showNewForm.value = false;
    newName.value = '';
  }
};

// ---- 图层样式设置 ----
const settingsLayer = ref(null);
const styleRef = ref({});

const layerSchema = computed(() => {
  if (!settingsLayer.value) return {};
  return fieldSchema[settingsLayer.value.id] || {};
});

const openSettings = (node) => {
  const layer = getLayerState(node.id);
  if (!layer) return;
  if (!layer.style) layer.style = {};
  const s = layer.style;
  // 确保默认值
  if (!s.fillColor) s.fillColor = '#10b981';
  if (!s.fillOpacity && s.fillOpacity !== 0) s.fillOpacity = 0.4;
  if (!s.outlineColor) s.outlineColor = '#ffffff';
  if (!s.outlineWidth) s.outlineWidth = 2;
  if (!s.color) s.color = '#38bdf8';
  if (!s.lineWidth) s.lineWidth = 3;
  if (!s.radius) s.radius = 10;
  if (!s.icon) s.icon = 'none';
  // 合并个人标签设置到图层对象（桌面端 LayerTreePanel 同样逻辑）
  const savedLabel = loadLabelSettings(node.id);
  if (savedLabel) {
    if (savedLabel.showLabel !== undefined) layer.showLabel = savedLabel.showLabel;
    if (savedLabel.labelField) layer.labelField = savedLabel.labelField;
    if (savedLabel.labelFontSize) layer.labelFontSize = savedLabel.labelFontSize;
    if (savedLabel.labelColor) layer.labelColor = savedLabel.labelColor;
    if (savedLabel.labelBold !== undefined) layer.labelBold = savedLabel.labelBold;
    if (savedLabel.labelFontFamily) layer.labelFontFamily = savedLabel.labelFontFamily;
  }
  settingsLayer.value = layer;
  styleRef.value = { ...s };
};

const onStyleChange = () => {
  if (!settingsLayer.value) return;
  Object.assign(settingsLayer.value.style, styleRef.value);
  saveLayerStyle(settingsLayer.value.id, {
    opacity: settingsLayer.value.opacity,
    heightOffset: settingsLayer.value.heightOffset,
    style: { ...settingsLayer.value.style }
  });
  import('../../core/symbology/ThematicRenderer').then(m => m.applySymbology(settingsLayer.value.id));
};

const onOpacityChange = () => {
  if (!settingsLayer.value) return;
  saveLayerStyle(settingsLayer.value.id, {
    opacity: settingsLayer.value.opacity,
    heightOffset: settingsLayer.value.heightOffset,
    style: settingsLayer.value.style ? { ...settingsLayer.value.style } : undefined
  });
  import('../../core/symbology/ThematicRenderer').then(m => m.applySymbology(settingsLayer.value.id));
};

const onHeightChange = () => {
  if (!settingsLayer.value) return;
  import('../../core/layers/LayerManager').then(m => m.updateLayerHeight(settingsLayer.value.id, settingsLayer.value.heightOffset));
  saveLayerStyle(settingsLayer.value.id, {
    opacity: settingsLayer.value.opacity,
    heightOffset: settingsLayer.value.heightOffset,
    style: settingsLayer.value.style ? { ...settingsLayer.value.style } : undefined
  });
};

const onLabelChange = async () => {
  if (!settingsLayer.value) return;
  const l = settingsLayer.value;
  const { applyLayerLabels, removeLayerLabels } = await import('../../core/layers/LayerManager');
  if (l.showLabel && l.labelField) {
    applyLayerLabels(l.id, l.labelField, l.labelFontSize || 14, l.labelFontFamily || 'sans-serif', l.labelBold || false, l.labelColor || '#ffffff');
  } else {
    removeLayerLabels(l.id);
  }
  // persist label settings to localStorage (user-isolated)
  const stored = JSON.parse(localStorage.getItem(uk('cesium_mvp_label_settings')) || '{}');
  stored[l.id] = { showLabel: l.showLabel, labelField: l.labelField, labelFontSize: l.labelFontSize, labelFontFamily: l.labelFontFamily, labelBold: l.labelBold, labelColor: l.labelColor };
  localStorage.setItem(uk('cesium_mvp_label_settings'), JSON.stringify(stored));
};
</script>

<style scoped>
.mobile-layer-panel { display: flex; flex-direction: column; height: 100%; }
.header h4 { margin: 0 0 8px; color: #38bdf8; font-size: 16px; }
.basemap-bar { display: flex; align-items: center; gap: 8px; padding: 8px 0; margin-bottom: 8px; font-size: 13px; }
.basemap-bar label { color: #94a3b8; white-space: nowrap; flex-shrink: 0; }
.basemap-bar .sel-sm { flex: 1; padding: 6px 8px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; font-size: 13px; }
.edit-toggle { margin-bottom: 10px; }
.btn-edit-on { padding: 8px 16px; background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 6px; width: 100%; font-size: 14px; cursor: pointer; }
.editing-bar { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #10b981; }
.pulse { animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.btn-edit-off { margin-left: auto; padding: 4px 12px; background: #ef4444; color: #fff; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; }
.tree-list { flex: 1; overflow-y: auto; }
.empty-hint { text-align: center; padding: 20px; color: #64748b; font-size: 13px; }
.layer-actions { padding-top: 10px; }
.btn-new { width: 100%; padding: 10px; background: rgba(56,189,248,0.1); border: 1px dashed #38bdf8; color: #38bdf8; border-radius: 6px; font-size: 14px; cursor: pointer; }
.modal-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 6000; display: flex; align-items: center; justify-content: center; }
.modal-box { background: #1e293b; padding: 20px; border-radius: 10px; width: 280px; color: #fff; }
.modal-box h4 { margin: 0 0 12px; color: #38bdf8; }
.inp, .sel { width: 100%; padding: 8px; margin-bottom: 10px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; box-sizing: border-box; }
.modal-btns { display: flex; gap: 8px; justify-content: flex-end; }
.modal-btns button { padding: 6px 14px; border: 1px solid #475569; background: #0f172a; color: #94a3b8; border-radius: 4px; cursor: pointer; }
.modal-btns .primary { background: #38bdf8; color: #000; border-color: #38bdf8; }

.settings-sheet { position: fixed; bottom: 0; left: 0; right: 0; max-height: 60vh; background: rgba(15,23,42,0.98); border-top: 2px solid #38bdf8; border-radius: 12px 12px 0 0; z-index: 6100; display: flex; flex-direction: column; }
.ss-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid #334155; flex-shrink: 0; }
.ss-title { color: #38bdf8; font-size: 14px; font-weight: bold; }
.ss-close { width: 30px; height: 30px; background: none; border: 1px solid #475569; color: #94a3b8; border-radius: 50%; font-size: 14px; cursor: pointer; }
.ss-body { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }
.ss-section { margin-bottom: 14px; }
.ss-label { color: #38bdf8; font-size: 12px; font-weight: bold; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.ss-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #cbd5e1; gap: 8px; }
.ss-row span:first-child { flex-shrink: 0; }
.ss-row input[type="range"] { flex: 1; min-width: 0; accent-color: #38bdf8; }
.ss-row input[type="color"] { width: 32px; height: 28px; border: 1px solid #475569; border-radius: 4px; background: none; cursor: pointer; padding: 1px; }
.ss-sel { padding: 4px 6px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; font-size: 12px; flex: 1; min-width: 0; }
.ss-val { color: #64748b; font-size: 12px; min-width: 32px; text-align: right; }
.ss-toggle input { width: 18px; height: 18px; accent-color: #38bdf8; }
</style>