<template>
  <div class="layer-panel-container">
    <div class="tree-panel">
      <div class="panel-header">
        <h4>图层管理</h4>
        <div class="header-actions">
          <button class="action-btn" title="新建文件夹" @click="addFolder">➕ 文件夹</button>
          <button class="action-btn" title="新建空白标注图层" @click="addEmptyLayer">➕ 空图层</button>
          <button class="action-btn" title="关联本地数据" @click="openAddModal">🔗 关联图层</button>
          <span class="status-dot" :class="{ ready: mapState.system.isViewerReady }"></span>
        </div>
      </div>

      <details class="system-settings-group">
        <summary>🌍 系统环境与底图设置</summary>
        <div class="setting-content">
          <div class="setting-row">
            <span>底图源</span>
            <select v-model="mapState.system.baseMap" @change="handleBaseMapChange" class="tech-select">
              <option value="google-satellite">谷歌 高清卫星 (无偏移推荐)</option>
              <option value="google-hybrid">谷歌 混合卫星 (带路网注记)</option>
              <option value="google-tianditu">谷歌卫星+天地注记 (无偏移推荐)</option>
              <option value="arcgis-satellite">ArcGIS 环球卫星 (无偏移)</option>
              <option value="arcgis-street">ArcGIS 街道地图 (清爽)</option>
              <option value="tianditu-satellite">天地图 卫星影像 (无偏移)</option>
              <option value="tianditu-hybrid">天地图 卫星+注记 (路网标注)</option>
              <option value="tianditu-vector">天地图 电子地图</option>
              <option value="amap-satellite">高德 卫星影像 (有偏移参考)</option>
              <option value="amap-vector">高德 电子地图</option>
            </select>
          </div>
          <div class="setting-row"><span>底图透明度</span><input type="range" min="0" max="1" step="0.1" v-model="mapState.system.baseMapOpacity" @input="handleBaseOpacity" /></div>
          <div class="setting-row">
            <span>空间背景色</span>
            <input type="color" v-model="mapState.system.backgroundColor" @input="handleBackgroundColor" style="width: 24px; height: 24px; padding: 0; border: none; border-radius: 4px; cursor: pointer; background: none;" />
          </div>
          <div class="setting-row">
          <span>模型精度: {{ qualityTierLabel }} (SSE {{ mapState.system.currentQuality }})</span>
          <input type="range" min="0" max="1" step="0.01" :value="qualitySlider" @input="handleQualitySlider" />
          </div>
        </div>
      </details>

      <div class="tree-scroll-area">
        <draggable v-model="mapState.layerTree" :group="{ name: 'layers', pull: true, put: true }" item-key="id" handle=".drag-handle" ghost-class="ghost-node" :animation="250" :fallbackOnBody="true" :swapThreshold="0.65" @change="onTreeChange">
          <template #item="{ element }"><LayerTreeNode :node="element" @open-settings="openSettingsDrawer" @tree-changed="onTreeChange" /></template>
        </draggable>
        <div v-if="mapState.layerTree.length === 0" class="empty-state">图层库为空，请联系管理员配置。</div>
      </div>
    </div>

    <teleport to="body">
      <div v-if="activeNode" class="drawer-mask" @click="closeSettingsDrawer"></div>
      <div class="settings-drawer" :class="{ 'is-open': activeNode }">
        <div v-if="activeNode" class="drawer-inner">
          <div class="drawer-header">
            <h4>{{ activeNode.name }}</h4>
            <button class="close-btn" @click="closeSettingsDrawer">✖</button>
          </div>

          <div class="drawer-body">
            
            <div class="prop-group">
              <label>全局透明度</label>
              <div class="slider-row">
                <input type="range" min="0" max="1" step="0.01" v-model="activeNode.opacity" @input="handleOpacityChange" />
                <input type="number" min="0" max="1" step="0.01" :value="activeNode.opacity" @change="activeNode.opacity = parseFloat($event.target.value) || 0; handleOpacityChange()" class="num-input" />
              </div>
            </div>

            <template v-if="activeNode.type === 'geojson'">
              <div class="prop-group">
                <label>整体抬升高度</label>
                <div class="slider-row">
                  <input type="range" min="-50" max="500" step="1" v-model="activeNode.heightOffset" @change="handleHeightChange" />
                  <input type="number" min="-50" max="500" step="1" :value="activeNode.heightOffset" @change="activeNode.heightOffset = parseFloat($event.target.value) || 0; handleHeightChange()" class="num-input" />
                </div>
              </div>

              <div class="prop-group" v-if="activeNode.geometryType !== 'point' && activeNode.geometryType !== 'polyline'">
                <label>🏗️ 挤出体块</label>
                <div style="display:flex;align-items:center;gap:8px;">
                  <select v-model="extrudeField" class="tech-select" style="flex:1;">
                    <option value="">-- 不启用（平面） --</option>
                    <option v-for="(cfg, key) in numericSchemaFields" :key="key" :value="key">{{ cfg.label || key }}</option>
                  </select>
                  <button class="btn-apply-style" @click="applyExtrusion" style="flex-shrink:0;margin-top:0;">✅ 应用</button>
                </div>
              </div>

              <div class="prop-group">
                <label class="checkbox-label"><input type="checkbox" v-model="activeNode.showLabel" @change="handleLabelToggle" /> 显示标签</label>
                <select v-if="activeNode.showLabel" v-model="activeNode.labelField" @change="handleLabelChange" class="tech-select" style="margin-top:6px;">
                  <option value="">-- 选择显示字段 --</option>
                  <option v-for="(cfg, key) in activeSchema" :key="key" :value="key">{{ cfg.label || key }}</option>
                </select>
                <div v-if="activeNode.showLabel && activeNode.labelField" class="label-style-row">
                  <span class="style-label">字号</span>
                  <input type="number" v-model.number="activeNode.labelFontSize" min="8" max="48" step="1" @change="handleLabelStyleChange" class="num-input" style="width:48px;" />
                  <span class="style-label">字体</span>
                  <select v-model="activeNode.labelFontFamily" @change="handleLabelStyleChange" class="tech-select-small" style="width:85px;">
                    <option value="sans-serif">标准</option>
                    <option value="SimHei, sans-serif">黑体</option>
                    <option value="FangSong, serif">仿宋</option>
                    <option value="KaiTi, serif">楷体</option>
                    <option value="Microsoft YaHei, sans-serif">微软雅黑</option>
                    <option value="serif">衬线</option>
                    <option value="monospace">等宽</option>
                  </select>
                  <label class="checkbox-label" style="margin:0 4px;display:flex;align-items:center;gap:2px;font-size:11px;color:#94a3b8;">
                    <input type="checkbox" v-model="activeNode.labelBold" @change="handleLabelStyleChange" /> 粗
                  </label>
                  <span class="style-label">色</span>
                  <input type="color" v-model="activeNode.labelColor" @change="handleLabelStyleChange" title="字体颜色" style="width:24px;height:24px;padding:0;border:1px solid #475569;border-radius:4px;cursor:pointer;background:none;" />
                </div>
              </div>

              <div class="prop-group" v-if="activeNode.style">
                <label>📦 基础几何与图标外观</label>
                
                <div class="style-row" v-if="activeNode.geometryType === 'point'">
                  <span>点样式/图标</span>
                  <select v-model="activeNode.style.icon" class="tech-select-small" style="width:130px; margin-left:0;">
                    <option value="none">🔵 基础纯色圆点</option>
                    <option value="pin">📍 经典定位指针</option>
                    <option value="flag">🚩 目的地旗帜</option>
                    <option value="warning">⚠️ 危险/警告</option>
                    <option value="hospital">🏥 医疗救助</option>
                    <option value="school">🏫 教育文化</option>
                    <option value="police">🚓 公共安全/警务</option>
                    <option value="factory">🏭 工业/厂房</option>
                    <option value="water">🚰 供水/水利</option>
                    <option value="power">⚡ 电力/能源</option>
                    <option value="park">🌳 公园/绿地</option>
                    <option value="residential">🏙️ 住宅/居民区</option>
                    <option value="shopping">🛍️ 商业/购物</option>
                    <option value="airport">✈️ 机场/航空</option>
                    <option value="train">🚄 轨道交通</option>
                  </select>
                </div>

                <div class="style-row" v-if="activeNode.geometryType !== 'polyline'"><span>基础颜色</span><input type="color" v-model="activeNode.style.fillColor"  /></div>
                <div class="style-row" v-if="activeNode.geometryType === 'polyline'"><span>基础线色</span><input type="color" v-model="activeNode.style.color"  /></div>
                
                <template v-if="!activeNode.style.icon || activeNode.style.icon === 'none'">
                  <div class="style-row" v-if="activeNode.geometryType !== 'polyline'"><span>边线颜色</span><input type="color" v-model="activeNode.style.outlineColor"  /></div>
                  <div class="style-row" v-if="activeNode.geometryType !== 'polyline'"><span>边线宽度</span><input type="number" v-model="activeNode.style.outlineWidth" min="0" max="15"  /></div>
                  <div class="style-row" v-if="activeNode.geometryType !== 'polyline'"><span>填充透明度</span><input type="range" min="0" max="1" step="0.01" v-model.number="activeNode.style.fillOpacity"  /><span class="val-hint">{{ Math.round((activeNode.style.fillOpacity ?? 0.4) * 100) }}%</span></div>
                </template>

                <div class="style-row" v-if="activeNode.geometryType === 'polyline'"><span>基础线宽</span><input type="number" v-model="activeNode.style.lineWidth" min="1" max="15"  /></div>
                <div class="style-row" v-if="activeNode.geometryType === 'point'"><span>基础缩放大小</span><input type="number" v-model="activeNode.style.radius" min="1" max="50"  /></div>
                <div style="display:flex;gap:6px;margin-top:6px;">
                  <button class="btn-apply-style" @click="updateStyle">✅ 应用样式</button>
                  <button class="btn-reset-style" @click="handleResetStyle">↺ 恢复默认</button>
                </div>
              </div>

              <div class="prop-group" v-if="activeSchema">
                <label>🔍 数据属性过滤 (先过滤，后渲染)</label>
                
                <div class="logic-toggle">
                  <label><input type="radio" value="AND" v-model="activeNode.filter.logicalOp" @change="applyFilterEngine" /> 全部满足(AND)</label>
                  <label><input type="radio" value="OR" v-model="activeNode.filter.logicalOp" @change="applyFilterEngine" /> 任一满足(OR)</label>
                </div>

                <div class="filter-rules-list">
                  <div v-for="(rule, index) in activeNode.filter.rules" :key="rule.id" class="rule-row">
                    <select v-model="rule.field" @change="handleFilterFieldChange(rule)" class="f-select" style="width: 24%">
                    <option v-for="(config, key) in activeSchema" :key="key" :value="key">{{ config.label }}</option>
                  </select>

                  <template v-if="activeSchema[rule.field]?.type === 'number'">
                    <select v-model="rule.operator" @change="handleFilterOpChange(rule)" class="f-select" style="width: 16%">
                      <option value=">=">&ge;</option><option value="<=">&le;</option><option value="=">=</option><option value="between">介于</option>
                    </select>
                  </template>
                    <template v-else><div class="f-static">包含</div></template>

                    <div class="f-val-area">
                      <input v-if="activeSchema[rule.field]?.type === 'number' && rule.operator !== 'between'" type="number" v-model="rule.value" @input="applyFilterEngine" class="f-input" />
                      <div v-if="activeSchema[rule.field]?.type === 'number' && rule.operator === 'between'" class="f-range">
                        <input type="number" v-model="rule.value[0]" @input="applyFilterEngine" placeholder="Min" />
                        <input type="number" v-model="rule.value[1]" @input="applyFilterEngine" placeholder="Max" />
                      </div>
                      <div v-if="activeSchema[rule.field]?.type === 'string'" class="f-checks">
                        <label v-for="opt in activeSchema[rule.field].options" :key="opt">
                          <input type="checkbox" :value="opt" v-model="rule.value" @change="applyFilterEngine" /> {{ opt }}
                        </label>
                      </div>
                    </div>
                    <button class="remove-btn" @click="removeFilterRule(index)">×</button>
                  </div>
                </div>
                <button class="add-rule-btn" @click="addFilterRule">+ 增加条件</button>
              </div>

              <div class="prop-group" v-if="activeSchema">
                <label>🎨 数据驱动渲染</label>
                <div class="thematic-row">
                  <span>按字段调色：</span>
                  <select v-model="activeNode.thematic.colorField" @change="handleThematicChange" class="tech-select-small">
                    <option value="">-- 恢复默认外观色 --</option>
                    <option v-for="(cfg, key) in activeSchema" :key="key" :value="key">{{ cfg.label }}</option>
                  </select>
                </div>

                <div v-if="activeNode.thematic.colorField" class="thematic-sub-config">
                  <template v-if="activeSchema[activeNode.thematic.colorField].type === 'number'">
                    <div class="range-inputs">
                      <input type="number" v-model="activeNode.thematic.customMin" placeholder="自适应极小" @change="handleThematicChange" />
                      <span>~</span>
                      <input type="number" v-model="activeNode.thematic.customMax" placeholder="自适应极大" @change="handleThematicChange" />
                    </div>
                    <select v-model="activeNode.thematic.colorRamp" @change="handleThematicChange" class="tech-select-small ramp-select">
                      <option :value="['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000']">热力 (蓝-青-绿-黄-红)</option>
                      <option :value="['#4575b4', '#ffffbf', '#d73027']">冷暖 (蓝-黄-红)</option>
                      <option :value="['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15']">危险度 (浅红-深红)</option>
                      <option :value="['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c']">安全度 (浅蓝-深蓝)</option>
                    </select>
                    <div class="ramp-preview" :style="{ background: `linear-gradient(to right, ${activeNode.thematic.colorRamp.join(',')})` }"></div>
                  </template>

                  <template v-else>
                    <div class="category-list">
                      <div v-for="opt in activeSchema[activeNode.thematic.colorField].options" :key="opt" class="category-item">
                        <input type="color" v-model="activeNode.thematic.colorMap[opt]" @change="handleThematicChange" />
                        <span :title="opt">{{ opt }}</span>
                      </div>
                    </div>
                  </template>
                </div>

                <template v-if="activeNode.geometryType !== 'polygon'">
                  <div class="thematic-row" style="margin-top: 12px;">
                    <span>按数值调大小：</span>
                    <select v-model="activeNode.thematic.sizeField" @change="handleThematicChange" class="tech-select-small">
                      <option value="">-- 恢复默认外观大小 --</option>
                      <option v-for="(cfg, key) in numericSchemaFields" :key="key" :value="key">{{ cfg.label }}</option>
                    </select>
                  </div>
                  <div v-if="activeNode.thematic.sizeField" class="thematic-sub-config">
                    <div class="range-inputs">
                      <span>最小 px</span><input type="number" v-model="activeNode.thematic.sizeMin" @change="handleThematicChange" />
                      <span>最大 px</span><input type="number" v-model="activeNode.thematic.sizeMax" @change="handleThematicChange" />
                    </div>
                  </div>
                </template>
              </div>

              <div class="stats-area" v-if="activeNode.thematic?.currentStats?.length > 0">
                <div class="stats-header">📊 剩余数据渲染频次</div>
                <div class="stats-list">
                  <div v-for="stat in activeNode.thematic.currentStats" :key="stat.name" class="stat-item">
                    <div class="stat-info">
                      <span class="stat-name" :title="stat.name">{{ stat.name }}</span><span class="stat-count">{{ stat.count }} 项</span>
                    </div>
                    <div class="stat-bar-bg"><div class="stat-bar" :style="{ width: Math.max(1, (stat.count / activeNode.thematic.currentStats[0].count) * 100) + '%' }"></div></div>
                  </div>
                </div>
              </div>
            </template>
            <template v-if="activeNode.type === '3dtiles' && !activeNode.transform">
              <div class="prop-group">
                <label>高度偏移</label>
                <div class="slider-row">
                  <input type="range" min="-200" max="500" step="1" v-model="activeNode.heightOffset" @change="handleHeightChange" />
                  <input type="number" min="-200" max="500" step="1" :value="activeNode.heightOffset" @change="activeNode.heightOffset = parseFloat($event.target.value) || 0; handleHeightChange()" class="num-input" />
                </div>
              </div>
            </template>
            <template v-if="activeNode.type === '3dtiles' && activeNode.transform">
              <div class="prop-group">
                <label>模型位置 (经纬度)</label>
                <div class="slider-row">
                  <span style="color:#94a3b8;font-size:12px;width:36px;">经度</span>
                  <input type="number" step="0.0001" v-model.number="activeNode.transform.longitude" @change="onTransformChange" class="num-input" style="width:100px;" />
                </div>
                <div class="slider-row" style="margin-top:4px;">
                  <span style="color:#94a3b8;font-size:12px;width:36px;">纬度</span>
                  <input type="number" step="0.0001" v-model.number="activeNode.transform.latitude" @change="onTransformChange" class="num-input" style="width:100px;" />
                </div>
              </div>
              <div class="prop-group">
                <label>高度</label>
                <div class="slider-row">
                  <input type="range" min="-100" max="500" step="1" v-model.number="activeNode.transform.height" @change="onTransformChange" />
                  <input type="number" min="-100" max="500" step="1" v-model.number="activeNode.transform.height" @change="onTransformChange" class="num-input" />
                </div>
              </div>
              <div class="prop-group">
                <label>旋转角度</label>
                <div class="slider-row">
                  <input type="range" min="0" max="360" step="1" v-model.number="activeNode.transform.heading" @change="onTransformChange" />
                  <input type="number" min="0" max="360" step="1" v-model.number="activeNode.transform.heading" @change="onTransformChange" class="num-input" />
                </div>
              </div>
              <div class="prop-group">
                <label>缩放比例</label>
                <div class="slider-row">
                  <input type="range" min="0.1" max="5" step="0.01" v-model.number="activeNode.transform.scale" @change="onTransformChange" />
                  <input type="number" min="0.1" max="5" step="0.01" v-model.number="activeNode.transform.scale" @change="onTransformChange" class="num-input" />
                </div>
              </div>
            </template>
            <template v-if="activeNode.type === 'geojson'">
              <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="action-btn" @click="downloadGeoJson">📥 下载</button>
                <button class="action-btn" @click="showCopyPanel = !showCopyPanel">📋 复制</button>
              </div>
              <div v-if="showCopyPanel" style="margin-top:8px;padding:12px;background:#1e293b;border-radius:6px;border:1px solid #334155;">
                <p style="color:#94a3b8;font-size:12px;margin:0 0 8px 0;">新图层名称：</p>
                <input v-model="copyLayerName" class="field-input" placeholder="输入新图层名称" style="margin-bottom:8px;" />
                <p style="color:#94a3b8;font-size:12px;margin:0 0 4px 0;">归属分组（可选）：</p>
                <select v-model="copyTargetFolder" style="width:100%;padding:6px 10px;background:#1e293b;border:1px solid #475569;border-radius:4px;color:#e2e8f0;font-size:13px;outline:none;margin-bottom:8px;">
                  <option value="">不指定（放在源图层同级）</option>
                  <option v-for="folder in availableFolders" :key="folder.id" :value="folder.name">{{ folder.name }}</option>
                </select>
                <p style="color:#94a3b8;font-size:12px;margin:0 0 4px 0;">保留字段（<label style="cursor:pointer;color:#38bdf8;"><input type="checkbox" @change="toggleAllFields" :checked="copySelectedFields.length === copyFields.length && copyFields.length > 0" style="margin-right:2px;" />全选</label>）：</p>
                <div v-if="copyFields.length > 0" style="max-height:120px;overflow-y:auto;margin-bottom:8px;">
                  <label v-for="k in copyFields" :key="k" style="display:block;padding:2px 0;color:#e2e8f0;cursor:pointer;font-size:13px;">
                    <input type="checkbox" :value="k" v-model="copySelectedFields" :disabled="k.toUpperCase()==='OBJECTID'" style="margin-right:4px;" />{{ k }}<span v-if="k.toUpperCase()==='OBJECTID'" style="color:#64748b;font-size:11px;"> (必选)</span>
                  </label>
                </div>
                <div v-else style="color:#64748b;font-size:12px;margin-bottom:8px;">该图层仅有几何数据，无自定义字段</div>
                <button class="action-btn" @click="handleCopyLayer" :disabled="!copyLayerName.trim()" style="width:100%;">确认复制</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </teleport>

    <div v-if="isAddModalOpen" class="modal-overlay">
      <div class="modal-content">
        <h4>🔗 挂载本地图层</h4>
        <div class="form-group"><label>本地数据源</label><select v-model="newLayerData.url"><option disabled value="">-- 选择 --</option><option v-for="file in availableFiles" :key="file" :value="file">{{ isUrlUsed(file) ? '✅' : '📄' }} {{ file }}</option></select></div>
        <div class="form-group"><label>图层名称</label><input type="text" v-model="newLayerData.name" /></div>
        <div class="form-group"><label>归属文件夹</label><input list="folder-options" v-model="newLayerData.targetFolder" /><datalist id="folder-options"><option v-for="folder in availableFolders" :key="folder.id" :value="folder.name"></option></datalist></div>
        <div class="form-group"><label>数据类型</label><select v-model="newLayerData.type"><option value="geojson">二维矢量</option><option value="3dtiles">三维实景</option></select></div>
        <div class="form-group" v-if="newLayerData.type === 'geojson'">
          <label>几何要素类型</label>
          <select v-model="newLayerData.geometryType"><option value="polygon">面要素</option><option value="polyline">线要素</option><option value="point">点要素/图标</option></select>
        </div>
        <div class="modal-actions"><button class="cancel-btn" @click="isAddModalOpen = false">取消</button><button class="confirm-btn" @click="confirmAddLayer">确定上架</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'; 
import draggable from 'vuedraggable';
import LayerTreeNode from './LayerTreeNode.vue';
import { mapState, saveLayerConfig, fieldSchema, getLayerState, saveLabelSettings, loadLabelSettings, showToast, hideToast, saveUserSetting, saveLayerStyle, resetLayerStyle } from '../../store/mapState';
import { switchBaseMap } from '../../core/viewer/ViewerSetup';
import { update3DTilesQuality, updateBaseMapOpacity, updateLayerOpacity, updateLayerHeight, updateBackgroundColor, applyLayerZOrder, getLayer, applyLayerLabels, removeLayerLabels, updateTilesetTransform, reloadLayer } from '../../core/layers/LayerManager';
import * as Cesium from 'cesium';
import { applySymbology } from '../../core/symbology/ThematicRenderer';
import { applyAttributeFilter } from '../../core/filter/AttributeFilter';

const presetColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
const activeNode = ref(null);
const extrudeField = ref(''); // 挤出体块高度字段选择
const activeSchema = computed(() => activeNode.value ? fieldSchema[activeNode.value.id] : null);
const numericSchemaFields = computed(() => {
  const s = activeSchema.value;
  if (!s) return {};
  const res = {};
  for (const k in s) if (s[k].type === 'number') res[k] = s[k];
  return res;
});

const openSettingsDrawer = (node) => {
  if (node.type === 'geojson') {
    // 确保 style 对象始终存在，否则基础几何外观面板不显示
    if (!node.style) node.style = { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#ffffff', outlineWidth: 2, color: '#38bdf8', lineWidth: 3, radius: 10, icon: 'none' };
    if (!node.thematic) {
      node.thematic = { colorField: '', colorRamp: ['#fee5d9', '#a50f15'], colorMap: {}, customMin: null, customMax: null, sizeField: '', sizeMin: 5, sizeMax: 30, currentStats: [] };
    }
    // 🌟 注入最新的过滤配置包
    if (!node.filter) {
      node.filter = { logicalOp: 'AND', rules: [] };
    }
    // 先加载用户个人标签设置
    const saved = loadLabelSettings(node.id);
    if (saved) {
      Object.assign(node, saved);
    }
    if (node.opacity === undefined || node.opacity === null) node.opacity = 1.0;
    if (node.heightOffset === undefined || node.heightOffset === null) node.heightOffset = 0;
    if (node.showLabel === undefined) node.showLabel = false;
    // 挤出体块：初始化为当前 heightField 值
    if (node.geometryType !== 'point' && node.geometryType !== 'polyline') {
      extrudeField.value = node.heightField || '';
    } else {
      extrudeField.value = '';
    }
    if (!node.labelField) node.labelField = '';
    if (!node.labelFontSize) node.labelFontSize = 14;
    if (!node.labelFontFamily) node.labelFontFamily = 'sans-serif';
    if (node.labelBold === undefined) node.labelBold = false;
    if (!node.labelColor) node.labelColor = '#ffffff';
  }
  if (node.type === '3dtiles') {
    if (node.heightOffset === undefined || node.heightOffset === null) node.heightOffset = 0;
  }
  if (node.type === '3dtiles' && node.transform) {
    const t = node.transform;
    if (t.longitude === undefined) t.longitude = 75.983;
    if (t.latitude === undefined) t.latitude = 39.468;
    if (t.height === undefined) t.height = 0;
    if (t.heading === undefined) t.heading = 0;
    if (t.scale === undefined) t.scale = 1.0;
  }
  activeNode.value = node;
};

const closeSettingsDrawer = () => { activeNode.value = null; showCopyPanel.value = false; };

const showCopyPanel = ref(false);
const copyLayerName = ref('');
const copyFields = ref([]);
const copySelectedFields = ref([]);
const copyTargetFolder = ref('');

const downloadGeoJson = async () => {
  const layerInfo = getLayerState(activeNode.value?.id);
  const url = activeNode.value?.url || layerInfo?.url;
  if (!url) return;
  const name = (activeNode.value.name || 'layer') + '.geojson';
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const res = await fetch(`/api/export/geojson?path=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) { const d = await res.json().catch(()=>({})); showToast(d.error || '导出失败', 'error'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
};

const toggleAllFields = () => {
  if (copySelectedFields.value.length === copyFields.value.length) {
    copySelectedFields.value = copyFields.value.filter(f => f.toUpperCase() === 'OBJECTID');
  } else {
    copySelectedFields.value = [...copyFields.value];
  }
};

watch(showCopyPanel, (val) => {
  if (!val) return;
  const node = activeNode.value;
  if (!node) return;
  const schema = fieldSchema[node.id] || {};
  copyFields.value = Object.keys(schema);
  copySelectedFields.value = [...copyFields.value];
  copyLayerName.value = (node.name || 'layer') + '_副本';
  copyTargetFolder.value = '';
});

const handleCopyLayer = async () => {
  const node = activeNode.value;
  if (!node) return;
  const layerInfo = getLayerState(node.id);
  let sourceUrl = node.url || layerInfo?.url;
  if (!sourceUrl) {
    sourceUrl = `data/annotations/layer_${node.id.split('_')[1] || Date.now()}.geojson`;
  }
  const newName = copyLayerName.value.trim();
  if (!newName) return;

  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const fields = copySelectedFields.value.filter(f => f.toUpperCase() !== 'OBJECTID');
    const res = await fetch('/api/layers/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sourceUrl, newLayerName: newName, selectedFields: fields, sourceLayerId: node.id, geometryType: node.geometryType || layerInfo?.geometryType || 'polygon', targetFolder: copyTargetFolder.value.trim() })
    });
    const data = await res.json();
    if (data.success) {
      showCopyPanel.value = false;
      const { loadLayerConfig: lc } = await import('../../store/mapState.js');
      await lc();
      const { syncTreeLayers: stl } = await import('../../core/layers/LayerManager.js');
      await stl();
    } else {
      alert('复制失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('复制异常: ' + (e.message || '网络错误'));
  }
};

let saveTimeout = null;
const onTreeChange = () => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    // saveLayerConfig 内部已通过 checkTreeStale 同步树版本号，此处无需重复检查
    saveLayerConfig();
    applyLayerZOrder();
  }, 200);
};
const handleBaseMapChange = () => { switchBaseMap(mapState.system.baseMap); saveUserSetting('cesium_baseMap', mapState.system.baseMap); };
const handleBaseOpacity = () => { updateBaseMapOpacity(Number(mapState.system.baseMapOpacity)); saveUserSetting('cesium_baseMapOpacity', String(mapState.system.baseMapOpacity)); };
const handleBackgroundColor = () => { updateBackgroundColor(mapState.system.backgroundColor); saveUserSetting('cesium_backgroundColor', mapState.system.backgroundColor); };
// SSE（ScreenSpaceError）与滑块的对数映射：SSE 越小越清晰，直接绑定语义会反转。
// 滑块 0=流畅(SSE 8) ↔ 1=清晰(SSE 0.01)，默认值 2.0 约在 21% 处。
const SSE_SHARP = 0.01, SSE_FAST = 8;
const qualitySlider = computed(() => {
  const sse = Number(mapState.system.currentQuality) || 2;
  const clamped = Math.max(SSE_SHARP, Math.min(SSE_FAST, sse));
  return Math.log(SSE_FAST / clamped) / Math.log(SSE_FAST / SSE_SHARP);
});
const qualityTierLabel = computed(() => {
  const sse = Number(mapState.system.currentQuality) || 2;
  return sse >= 4 ? '流畅' : (sse >= 1 ? '均衡' : '清晰');
});
const handleQualitySlider = (e) => {
  const q = Number(e.target.value);
  const sse = Math.round(SSE_FAST * Math.pow(SSE_SHARP / SSE_FAST, q) * 100) / 100;
  mapState.system.currentQuality = sse;
  update3DTilesQuality(sse);
};

const addFolder = () => {
  const fName = prompt("请输入新文件夹名称：", "新建文件夹");
  if (fName) { mapState.layerTree.unshift({ id: `folder_${Date.now()}`, name: fName, type: 'folder', show: true, children: [] }); onTreeChange(); }
};

const getDefaultGeojsonProps = (geomType) => ({
  geometryType: geomType, clampMode: 'absolute-plane', heightOffset: 0, features: [],
  style: { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#ffffff', outlineWidth: 2, color: '#38bdf8', lineWidth: 3, radius: 10, icon: 'none' },
  thematic: { colorField: '', colorRamp: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'], colorMap: {}, customMin: null, customMax: null, sizeField: '', sizeMin: 5, sizeMax: 30, currentStats: [] },
  filter: { logicalOp: 'AND', rules: [] }
});

const addEmptyLayer = () => {
  const layerName = prompt("请输入新建图层的名称：", "自定义标注图层");
  if (!layerName) return;
  const typeChoice = prompt("请选择几何类型:\n1. 面要素(Polygon)\n2. 线要素(Polyline)\n3. 点/图标(Point)", "1");
  let geomType = 'polygon'; if (typeChoice === '2') geomType = 'polyline'; if (typeChoice === '3') geomType = 'point';
  const url = `data/annotations/layer_${Date.now()}.geojson`;
  const newEmptyLayer = { id: `layer_${Date.now()}`, name: layerName, type: 'geojson', url, show: true, opacity: 1.0, ...getDefaultGeojsonProps(geomType) };
  let annotationFolder = mapState.layerTree.find(node => node.type === 'folder' && node.name === "✍️ 我的标注");
  if (!annotationFolder) { annotationFolder = { id: `folder_anno_${Date.now()}`, name: "✍️ 我的标注", type: 'folder', show: true, children: [] }; mapState.layerTree.unshift(annotationFolder); }
  if (!annotationFolder.children) annotationFolder.children = [];
  annotationFolder.children.unshift(newEmptyLayer);
  onTreeChange(); 
};

let _styleSaveTimer = null;
const _debouncedSaveStyle = () => {
  clearTimeout(_styleSaveTimer);
  _styleSaveTimer = setTimeout(() => {
    const n = activeNode.value;
    if (!n) return;
    saveLayerStyle(n.id, {
      opacity: n.opacity,
      heightOffset: n.heightOffset,
      style: n.style ? { ...n.style } : undefined
    });
  }, 800);
};
const handleOpacityChange = () => {
  if (activeNode.value.type === '3dtiles') updateLayerOpacity(activeNode.value.id, Number(activeNode.value.opacity));
  else applySymbology(activeNode.value.id);
  _debouncedSaveStyle();
};
const handleHeightChange = () => { updateLayerHeight(activeNode.value.id, Number(activeNode.value.heightOffset)); applyLayerZOrder(); _debouncedSaveStyle(); };

const applyingExtrusion = ref(false);
const applyExtrusion = async () => {
  const node = activeNode.value;
  if (!node || applyingExtrusion.value) return;
  const field = extrudeField.value;
  const prevField = node.heightField;
  // 未变化则跳过
  if ((prevField || '') === (field || '')) return;

  applyingExtrusion.value = true;
  try {
    if (field) {
      node.heightField = field;
      showToast('正在启用挤出体块...', 'info', 0);
    } else {
      delete node.heightField;
      showToast('正在关闭挤出体块...', 'info', 0);
    }
    await saveLayerConfig();
    await reloadLayer(node.id);
    hideToast();
    showToast(field ? `挤出体块已启用（高度字段: ${field}）` : '挤出体块已关闭', 'success', 2000);
  } catch (e) {
    // 回滚
    if (field) delete node.heightField;
    else if (prevField) node.heightField = prevField;
    hideToast();
    showToast('挤出设置失败: ' + (e.message || '未知错误'), 'error', 3000);
  } finally {
    applyingExtrusion.value = false;
  }
};

const onTransformChange = () => {
  const node = activeNode.value;
  if (!node || node.type !== '3dtiles' || !node.transform) return;
  const featureId = node.features?.[0]?.id || node.id + '_feature';
  updateTilesetTransform(node.id, featureId, { ...node.transform });
};

const handleLabelToggle = () => {
  const node = activeNode.value;
  if (!node) return;
  if (node.showLabel && node.labelField) {
    applyLayerLabels(node.id, node.labelField, node.labelFontSize || 14, node.labelFontFamily || 'sans-serif', node.labelBold, node.labelColor || '#ffffff');
    saveLabelSettings(node.id, { showLabel: true, labelField: node.labelField, labelFontSize: node.labelFontSize, labelFontFamily: node.labelFontFamily, labelBold: node.labelBold, labelColor: node.labelColor });
  } else {
    removeLayerLabels(node.id);
    saveLabelSettings(node.id, { showLabel: false });
  }
};

let _saveLabelTimer = null;
const handleLabelStyleChange = () => { handleLabelChange(); };

const handleLabelChange = () => {
  const node = activeNode.value;
  if (!node || !node.labelField) return;
  applyLayerLabels(node.id, node.labelField, node.labelFontSize || 14, node.labelFontFamily || 'sans-serif', node.labelBold, node.labelColor || '#ffffff');
  saveLabelSettings(node.id, { showLabel: true, labelField: node.labelField, labelFontSize: node.labelFontSize, labelFontFamily: node.labelFontFamily, labelBold: node.labelBold, labelColor: node.labelColor });
};

const getEntityCenter = (entity) => {
  const time = Cesium.JulianDate.now();
  if (entity.polygon && entity.polygon.hierarchy) {
    const positions = entity.polygon.hierarchy.getValue(time).positions;
    let lonSum = 0, latSum = 0, hSum = 0;
    for (const p of positions) {
      const c = Cesium.Cartographic.fromCartesian(p);
      lonSum += Cesium.Math.toDegrees(c.longitude);
      latSum += Cesium.Math.toDegrees(c.latitude);
      hSum += c.height;
    }
    const n = positions.length;
    return Cesium.Cartesian3.fromDegrees(lonSum / n, latSum / n, hSum / n);
  }
  if (entity.polyline && entity.polyline.positions) {
    const positions = entity.polyline.positions.getValue(time);
    const mid = Math.floor(positions.length / 2);
    return positions[mid];
  }
  if (entity.position) return entity.position.getValue(time);
  return null;
};

const updateStyle = () => { if (activeNode.value.type === 'geojson') { showToast('正在应用样式...', 'info', 0); setTimeout(() => { applySymbology(activeNode.value.id); hideToast(); }, 50); } _debouncedSaveStyle(); };

const handleResetStyle = async () => {
  const n = activeNode.value;
  if (!n) return;
  resetLayerStyle(n.id);
  // 从服务端获取该图层的默认样式，不重载整个 layerTree
  try {
    const res = await fetch('/api/layer-config');
    const data = await res.json();
    const findNode = (nodes, id) => {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) { const f = findNode(node.children, id); if (f) return f; }
      }
      return null;
    };
    const def = findNode(data.layerTree, n.id);
    if (def) {
      n.opacity = def.opacity ?? 1;
      n.heightOffset = def.heightOffset ?? 0;
      n.style = def.style ? { ...def.style } : { fillColor: '#10b981', fillOpacity: 0.4, outlineColor: '#ffffff', outlineWidth: 2, color: '#38bdf8', lineWidth: 3, radius: 10, icon: 'none' };
      if (n.type === 'geojson') applySymbology(n.id);
      if (n.type === '3dtiles') updateLayerOpacity(n.id, Number(n.opacity));
      updateLayerHeight(n.id, Number(n.heightOffset));
      applyLayerZOrder();
      showToast('已恢复默认样式', 'info', 2000);
    }
  } catch (_) { showToast('恢复失败', 'error', 2000); }
};

// 🌟 数据流管线接管：过滤与专题配置的任何改动，均在此完成闭环
const applyFilterEngine = () => {
  applyAttributeFilter(activeNode.value.id);
};

const handleFilterFieldChange = (rule) => {
  const schema = activeSchema.value[rule.field];
  if (schema.type === 'number') { rule.operator = '>='; rule.value = 0; } 
  else if (schema.type === 'string') { rule.operator = 'in'; rule.value = []; }
  applyFilterEngine();
};

const handleFilterOpChange = (rule) => {
  if (rule.operator === 'between') { if (!Array.isArray(rule.value)) rule.value = [0, 100]; } 
  else { if (Array.isArray(rule.value)) rule.value = Number(rule.value[0]) || 0; }
  applyFilterEngine(); 
};

const addFilterRule = () => {
  const fields = Object.keys(activeSchema.value || {});
  if (fields.length === 0) return; 
  const newRule = { id: Date.now(), field: fields[0], operator: '>=', value: 0 };
  activeNode.value.filter.rules.push(newRule);
  handleFilterFieldChange(newRule); 
};

const removeFilterRule = (index) => {
  activeNode.value.filter.rules.splice(index, 1);
  applyFilterEngine();
};

const handleThematicChange = () => {
  const field = activeNode.value.thematic.colorField;
  if (field && activeSchema.value[field].type === 'string') {
    const schema = activeSchema.value[field];
    schema.options.forEach((opt, index) => {
      if (!activeNode.value.thematic.colorMap[opt]) activeNode.value.thematic.colorMap[opt] = presetColors[index % presetColors.length];
    });
  }
  applySymbology(activeNode.value.id);
};

const isAddModalOpen = ref(false);
const availableFiles = ref([]); 
const usedUrls = computed(() => {
  const urls = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.url) urls.push(n.url);
      if (n.children) walk(n.children);
    }
  };
  walk(mapState.layerTree);
  return urls;
});

const isUrlUsed = (url) => usedUrls.value.some(u => u === url || u.endsWith(url.replace('/data/', '')));

const openAddModal = async () => {
  isAddModalOpen.value = true;
  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const res = await fetch('/api/local-files', { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.success) {
      availableFiles.value = data.files;
      if (data.files.length > 0 && !newLayerData.value.url) newLayerData.value.url = data.files[0];
    }
  } catch (error) {}
};

const newLayerData = ref({ name: '', type: 'geojson', geometryType: 'polygon', url: '', targetFolder: '' });
const availableFolders = computed(() => {
  const folders = [];
  const traverse = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'folder') { folders.push(node); if (node.children) traverse(node.children); }
    }
  };
  traverse(mapState.layerTree); return folders;
});

watch(() => newLayerData.value.url, (newUrl) => {
  if (!newUrl) return;
  if (newUrl.includes('tileset.json')) newLayerData.value.type = '3dtiles';
  else if (newUrl.endsWith('.geojson') || newUrl.endsWith('.json')) newLayerData.value.type = 'geojson';
});

const confirmAddLayer = async () => {
  if (!newLayerData.value.url) return;
  if (!newLayerData.value.name.trim()) newLayerData.value.name = newLayerData.value.url.split('/').pop().replace(/\.[^/.]+$/, "");
  const newLayer = { id: `layer_${Date.now()}`, name: newLayerData.value.name, type: newLayerData.value.type, url: newLayerData.value.url, show: true, opacity: 1.0 };
  if (newLayerData.value.type === 'geojson') Object.assign(newLayer, getDefaultGeojsonProps(newLayerData.value.geometryType));
  else if (newLayerData.value.type === '3dtiles') newLayer.features = [{ id: `feature_${Date.now()}`, name: newLayerData.value.name, url: newLayerData.value.url, show: true }];

  const fName = newLayerData.value.targetFolder.trim();
  if (!fName) mapState.layerTree.unshift(newLayer);
  else {
    let tFolder = availableFolders.value.find(f => f.name === fName);
    if (!tFolder) { tFolder = { id: `folder_${Date.now()}`, name: fName, type: 'folder', show: true, children: [] }; mapState.layerTree.unshift(tFolder); }
    if (!tFolder.children) tFolder.children = []; tFolder.children.unshift(newLayer);
  }
  // 关联 GeoJSON 后先规范化 OBJECTID，再通知加载
  if (newLayer.type === 'geojson' && newLayer.url) {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    await fetch('/api/layers/normalize-oids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filePath: newLayer.url })
    }).catch(() => { showToast('OBJECTID 规范化请求失败', 'error'); });
  }

  onTreeChange();

  newLayerData.value = { name: '', type: 'geojson', geometryType: 'polygon', url: '', targetFolder: '' };
  isAddModalOpen.value = false;
};
</script>

<style scoped>
/* 原有布局样式 */
.drawer-mask { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 9998; background: transparent; cursor: default; }
.layer-panel-container { position: relative; width: 100%; height: 100%; display: flex; background: var(--color-floor); }
.tree-panel { width: 100%; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; }
.panel-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--text-secondary); padding-bottom: 12px; margin-bottom: 12px; }
h4 { margin: 0; color: var(--color-accent); font-size: 15px; }
.header-actions { display: flex; align-items: center; gap: 10px; }
.action-btn { background: rgba(56, 189, 248, 0.1); border: 1px solid var(--color-accent); color: var(--color-accent); border-radius: var(--radius-control); font-size: 11px; padding: 2px 6px; cursor: pointer; transition: 0.2s; }
.action-btn:hover { background: var(--color-accent); color: #000; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.status-dot.ready { background: #10b981; box-shadow: 0 0 8px #10b981; }

.system-settings-group { background: rgba(2,6,23,0.3); border-radius: var(--radius-panel); padding: 6px; margin-bottom: 12px; font-size: 12px; }
.system-settings-group summary { color: var(--text-secondary); cursor: pointer; font-weight: bold; outline: none; }
.setting-content { padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.setting-row { display: flex; justify-content: space-between; align-items: center; color: var(--text-primary); }
.tech-select { background: var(--color-elevated); color: var(--color-accent); border: 1px solid var(--text-secondary); border-radius: var(--radius-control); outline: none; }
input[type="range"] { accent-color: var(--color-accent); width: 100px; cursor: pointer; }

.tree-scroll-area { flex: 1; overflow-y: auto; padding-right: 4px; }
.empty-state { text-align: center; color: var(--text-secondary); font-size: 12px; margin-top: 30px; }
.ghost-node { opacity: 0.5; background: var(--color-elevated); border: 1px dashed var(--color-accent); }

.settings-drawer { position: fixed; top: 60px; left: 330px; width: 450px; height: calc(100vh - 80px); background: var(--color-surface); backdrop-filter: blur(10px); border: 1px solid var(--text-secondary); box-shadow: var(--shadow-panel); transform: translateX(-20px); opacity: 0; pointer-events: none; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); z-index: 9999; border-radius: var(--radius-panel); }
.settings-drawer.is-open { transform: translateX(0); opacity: 1; pointer-events: auto; }
.drawer-inner { padding: 16px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.drawer-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--text-secondary); padding-bottom: 12px; margin-bottom: 16px; }
.drawer-header h4 { color: var(--text-primary); font-size: 14px; }
.close-btn { background: none; border: none; color: var(--text-secondary); font-size: 16px; cursor: pointer; transition: 0.2s; }
.close-btn:hover { color: #ef4444; transform: rotate(90deg); }

.drawer-body { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; padding-right: 6px; }
.prop-group { background: rgba(2,6,23,0.3); padding: 10px; border-radius: var(--radius-panel); }
.prop-group label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; font-weight: bold; }
.style-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-primary); margin-bottom: 6px; }
.style-row input[type="color"] { width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--radius-control); cursor: pointer; background: none; }
.style-row input[type="number"] { width: 45px; background: var(--color-elevated); border: 1px solid var(--text-secondary); color: var(--text-primary); text-align: center; border-radius: var(--radius-control); outline: none; }
.btn-apply-style { flex: 1; margin-top: 10px; padding: 6px 0; background: #10b981; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; }
.btn-apply-style:hover { background: #059669; }
.btn-reset-style { flex: 1; margin-top: 10px; padding: 4px 0; background: transparent; border: 1px dashed #64748b; color: #64748b; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-reset-style:hover { border-color: #ef4444; color: #ef4444; }

/* 🌟 内置过滤规则器样式 */
.logic-toggle { font-size: 11px; display: flex; gap: 10px; margin-bottom: 10px; color: #cbd5e1; }
.filter-rules-list { margin-bottom: 8px; }
.rule-row { display: flex; gap: 4px; align-items: center; background: rgba(255,255,255,0.03); padding: 6px; border-radius: 4px; margin-bottom: 4px; }
.f-select { background: var(--color-floor); border: 1px solid var(--text-secondary); color: var(--text-primary); padding: 2px; border-radius: var(--radius-control); font-size: 11px; outline: none; }
.f-static { font-size: 11px; color: var(--text-secondary); width: 16%; text-align: center; }
.f-val-area { flex: 1; }
.f-input { width: 100%; box-sizing: border-box; background: var(--color-floor); border: 1px solid var(--text-secondary); color: var(--text-primary); padding: 2px; font-size: 11px; border-radius: var(--radius-control); }
.f-range { display: flex; gap: 2px; }
.f-range input { width: 45%; background: var(--color-floor); border: 1px solid var(--text-secondary); color: var(--text-primary); padding: 2px; font-size: 11px; border-radius: var(--radius-control); }
.f-checks { 
  display: flex; 
  flex-wrap: wrap; 
  gap: 6px; /* 稍微拉开一点间距防误触 */
  font-size: 11px; /* 字体稍微调大一点点 */
  max-height: 180px; /* 🌟 核心：高度限制由 50px 暴增到 180px */
  overflow-y: auto; 
  padding: 4px; /* 加点内边距，滚动时更好看 */
  background: rgba(0,0,0,0.2); /* 给备选池加个微弱的底色区分 */
  border-radius: 4px;
}
.remove-btn { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 14px; padding: 0 4px; }
.add-rule-btn { width: 100%; padding: 4px; background: rgba(56, 189, 248, 0.1); border: 1px dashed #38bdf8; color: #38bdf8; border-radius: 4px; cursor: pointer; font-size: 11px; }

/* 专题渲染UI */
.thematic-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #cbd5e1; }
.tech-select-small { background: var(--color-elevated); color: var(--text-primary); border: 1px solid var(--text-secondary); border-radius: var(--radius-control); outline: none; font-size: 11px; padding: 4px; flex: 1; margin-left: 8px; }
.thematic-sub-config { margin-top: 8px; padding: 8px; border: 1px dashed rgba(56, 189, 248, 0.3); border-radius: var(--radius-control); background: rgba(2,6,23,0.3); }
.range-inputs { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; }
.range-inputs input { width: 35%; background: var(--color-floor); color: var(--text-primary); border: 1px solid var(--text-secondary); text-align: center; border-radius: var(--radius-control); font-size: 11px; padding: 2px; }
.ramp-select { width: 100%; margin-left: 0; margin-bottom: 6px; }
.ramp-preview { height: 12px; border-radius: var(--radius-control); width: 100%; }
.category-list { max-height: 150px; overflow-y: auto; }
.category-item { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; color: var(--text-primary); }
.category-item input[type="color"] { width: 20px; height: 18px; padding: 0; border: none; background: none; cursor: pointer; }

/* 统计条块 */
.stats-area { background: rgba(2,6,23,0.4); padding: 10px; border-radius: var(--radius-panel); border: 1px solid rgba(56, 189, 248, 0.2); }
.stats-header { font-size: 12px; color: #fbbf24; font-weight: bold; margin-bottom: 10px; border-bottom: 1px dashed rgba(251, 191, 36, 0.4); padding-bottom: 6px; }
.stats-list { max-height: 180px; overflow-y: auto; padding-right: 4px; }
.stat-item { margin-bottom: 8px; }
.stat-info { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-primary); margin-bottom: 4px; }
.stat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
.stat-count { color: var(--color-accent); }
.stat-bar-bg { width: 100%; height: 5px; background: rgba(255,255,255,0.05); border-radius: var(--radius-control); }
.stat-bar { height: 100%; background: linear-gradient(90deg, #0ea5e9, #38bdf8); border-radius: var(--radius-control); }

/* 弹窗等样式保持不变 */
.info-box { font-size: 11px; color: #fbbf24; background: rgba(251, 191, 36, 0.1); border-left: 2px solid #fbbf24; padding: 8px; border-radius: 4px; line-height: 1.5; }
.modal-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 999; }
.modal-content { background: var(--color-elevated); padding: 20px; border-radius: var(--radius-modal); width: 300px; border: 1px solid var(--color-accent); box-shadow: var(--shadow-modal); }
.modal-content h4 { margin: 0 0 16px 0; color: var(--text-primary); font-size: 15px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.form-group input, .form-group select { width: 100%; box-sizing: border-box; padding: 6px; background: var(--color-floor); border: 1px solid var(--text-secondary); color: var(--text-primary); border-radius: var(--radius-control); font-size: 12px; outline: none; }
.form-group input:focus, .form-group select:focus { border-color: var(--color-accent); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.cancel-btn { background: none; border: 1px solid var(--text-secondary); color: var(--text-secondary); padding: 4px 12px; border-radius: var(--radius-control); cursor: pointer; }
.confirm-btn { background: var(--color-accent); border: none; color: var(--color-floor); font-weight: bold; padding: 4px 12px; border-radius: var(--radius-control); cursor: pointer; }
.slider-row { display: flex; align-items: center; gap: 8px; }
.slider-row input[type="range"] { flex: 1; }
.num-input { width: 64px; padding: 4px 6px; background: var(--color-floor); border: 1px solid var(--text-secondary); color: var(--text-primary); border-radius: var(--radius-control); font-size: 12px; text-align: center; }
</style>