<template>
  <div class="main-layout">
    <div v-if="deskOpHint" class="op-hint-bar">{{ deskOpHint }}</div>
    <!-- 桌面端自定义十字准星（定点放置时跟随鼠标，比系统光标精准） -->
    <Teleport to="body">
      <div v-if="isDrawing" class="desk-crosshair" :style="crosshairStyle"></div>
    </Teleport>
    <div class="global-edit-console">
      <button
        v-if="!mapState.editor.isEditing"
        class="console-btn auth-btn"
        @click="handleEditToggle"
      >
        {{ mapState.editor.isEditing ? '退出编辑模式' : '🛠️ 开启编辑模式' }}
      </button>

      <template v-else>
        <div class="editing-indicator">
          <span class="pulse-dot"></span> 正在编辑数据
        </div>
        
        <button class="console-btn tool-btn" :class="{ active: isDrawing }" @click="startDrawFeature" v-if="mapState.editor.isEditing">
          <span v-if="!activeGeomType">⚠️ 请选择工作图层</span>
          <span v-else-if="isDrawing">⏸ 暂停标绘 (ESC)</span>
          <span v-else>
            {{
              activeGeomType === 'polyline' ? '〰️ 新增线段' :
              (activeGeomType === 'point' ? '📍 新增标绘点' : '⬟ 新增面要素')
            }}
          </span>
        </button>

        <button class="console-btn exit-btn" @click="toggleEditMode">
          ⏹ 退出编辑
        </button>
      </template>
    </div>

    <!-- 编辑模式：当前工作图层 + 切换面板 -->
    <div v-if="mapState.editor.isEditing" class="working-layer-bar">
      <span class="wl-label">✏️</span>
      <span class="wl-name" @click="showLayerPicker = !showLayerPicker">{{ workingLayerName }}</span>
      <span class="wl-arrow" @click="showLayerPicker = !showLayerPicker">{{ showLayerPicker ? '▲' : '▼' }}</span>
    </div>

    <Teleport to="body">
      <div v-if="showLayerPicker" class="layer-picker-mask" @click.self="showLayerPicker = false">
        <div class="layer-picker-popover">
          <div class="lp-header">选择工作图层</div>
          <div class="lp-tree">
            <template v-for="node in mapState.layerTree" :key="node.id">
              <PickerTreeNode :node="node" :depth="0" />
            </template>
          </div>
        </div>
      </div>
    </Teleport>

    <div class="sidebar-dock">
      <div class="logo">GIS</div>
      <div class="menu-list">
        <div class="menu-item" :class="{ active: mapState.ui.activeMenu === 'layers' && mapState.ui.isPanelOpen && mapState.ui.currentView === 'map' }" @click="toggleMenu('layers')" title="图层管理">🗺️</div>
        <div class="menu-item" :class="{ active: mapState.ui.activeMenu === 'filter' && mapState.ui.isPanelOpen && mapState.ui.currentView === 'map' }" @click="toggleMenu('filter')" title="属性查询">🔍</div>
        <div class="menu-item" :class="{ active: mapState.ui.activeMenu === 'symbology' && mapState.ui.isPanelOpen && mapState.ui.currentView === 'map' }" @click="toggleMenu('symbology')" title="专题渲染">🎨</div>
        <div class="menu-item" :class="{ active: mapState.ui.activeMenu === 'analysis' && mapState.ui.isPanelOpen && mapState.ui.currentView === 'map' }" @click="toggleMenu('analysis')" title="空间分析">📐</div>
        <div class="menu-item" :class="{ active: mapState.ui.activeMenu === 'search' && mapState.ui.isPanelOpen && mapState.ui.currentView === 'map' }" @click="toggleMenu('search')" title="搜索定位">🔎</div>

        <div class="menu-divider"></div>
        
        <div class="menu-item action-btn" :class="{ active: mapState.ui.currentView === 'table' }" @click="toggleView('table')" title="批量数据工作台">
          🗄️
        </div>
      </div>
    </div>

    <div class="view-container" v-show="mapState.ui.currentView === 'map'">
      <div class="panel-drawer" v-show="mapState.ui.isPanelOpen">
        <div class="panel-content">
          <LayerTreePanel v-if="mapState.ui.activeMenu === 'layers'" />
          <SymbologyPanel v-if="mapState.ui.activeMenu === 'symbology'" />
          <DataFilterPanel v-if="mapState.ui.activeMenu === 'filter'" />
          <div v-if="mapState.ui.activeMenu === 'analysis'" class="placeholder">
            <h4 style="color: #38bdf8; margin-top:0;">空间分析模块</h4>
            <p style="color: #94a3b8; font-size: 13px;">等待接入 Turf.js...</p>
          </div>
          <SearchPanel v-if="mapState.ui.activeMenu === 'search'" />
        </div>
        <button class="close-btn" @click="mapState.ui.isPanelOpen = false">◀</button>
      </div>

      <MapCockpitHUD />
      <DataDetailPanel />
      <SelectionFocusBox />
    </div>

      <div class="view-container table-view" v-show="mapState.ui.currentView === 'table'">
        <keep-alive>
          <DataTablePanel v-if="mapState.ui.currentView === 'table'" />
        </keep-alive>
      </div>

    <transition name="toast-fade">
      <div v-if="mapState.ui.toast" class="global-toast" :class="mapState.ui.toast.type || 'info'">
        {{ mapState.ui.toast.message }}
      </div>
    </transition>
  </div>
</template>

<script setup>
import SelectionFocusBox from '../viewer/SelectionFocusBox.vue';
import DataTablePanel from '../layer-control/DataTablePanel.vue';
import DataDetailPanel from '../layer-control/DataDetailPanel.vue';
import { mapState, getLayerState, getFlatLayers, fieldSchema, showToast, hideToast } from '../../store/mapState';
import LayerTreePanel from '../layer-control/LayerTreePanel.vue';
import DataFilterPanel from '../filter-panel/DataFilterPanel.vue';
import SymbologyPanel from '../symbology-panel/SymbologyPanel.vue';
import SearchPanel from '../search/SearchPanel.vue';
import MapCockpitHUD from '../map-tools/MapCockpitHUD.vue';
import PickerTreeNode from '../shared/PickerTreeNode.vue';
import { computed, watch, toRaw, onErrorCaptured, ref, onMounted, onBeforeUnmount } from 'vue'; 
import { spatialEditor } from '../../core/viewer/SpatialEditor';
import { drawEngine } from '../../core/viewer/DrawEngine';
import * as Cesium from 'cesium';
import { getViewer } from '../../core/viewer/ViewerSetup';
import { toggleLayerVisibility, reloadLayer, getLayer } from '../../core/layers/LayerManager';
import { checkTreeStale } from '../../core/locks';
import { apiHeaders } from '../../core/apiClient';

watch(() => mapState.interaction.selectedFeatureId, (newId, oldId) => {
  if (mapState.editor.activeTool === 'vertex' && newId !== oldId) {
    spatialEditor.deactivate();
  }
});

const deskOpHint = computed(() => {
  if (mapState.editor.activeTool === 'draw') {
    if (activeGeomType.value === 'point') return '点击放置点位 · Esc 停止放置';
    return '左键点击放置顶点 · 右键/双击完成 · Esc 取消';
  }
  if (mapState.editor.activeTool === 'vertex') return '拖动绿点移动 · 右键绿点删除 · 点击黄点新增 · 点击空白完成';
  return '';
});

const showLayerPicker = ref(false);
const workingLayerName = computed(() => {
  const id = mapState.editor.selectedLayerId;
  if (!id) return '点击选择工作图层';
  const layer = getLayerState(id);
  return layer ? layer.name : '点击选择工作图层';
});

const _onPickerClose = () => { showLayerPicker.value = false; };
onMounted(() => window.addEventListener('layerpicker:close', _onPickerClose));
onBeforeUnmount(() => window.removeEventListener('layerpicker:close', _onPickerClose));

const toggleMenu = (menuId) => {
  if (mapState.ui.currentView !== 'map') {
    toggleView('map');
    if (mapState.ui.currentView !== 'map') return; 
  }
  if (mapState.ui.activeMenu === menuId) {
    mapState.ui.isPanelOpen = !mapState.ui.isPanelOpen;
  } else {
    mapState.ui.activeMenu = menuId;
    mapState.ui.isPanelOpen = true;
  }
};

// 🌟 严格模式：只认当前显式指定的“工作图层”
const activeGeomType = computed(() => {
  const layerId = mapState.editor.selectedLayerId;
  if (!layerId) return null;
  const layer = getLayerState(layerId);
  return layer ? (layer.geometryType || 'polygon') : null;
});

const isDrawing = computed(() => mapState.editor.activeTool === 'draw');

// 桌面端自定义十字准星跟随鼠标（精准于系统光标）
const crosshairPos = ref({ x: 0, y: 0 });
const crosshairStyle = computed(() => ({
  left: crosshairPos.value.x + 'px',
  top: crosshairPos.value.y + 'px'
}));
const onCrosshairMove = (e) => { crosshairPos.value = { x: e.clientX, y: e.clientY }; };
watch(isDrawing, (v) => {
  const container = getViewer()?._container;
  if (v) {
    window.addEventListener('mousemove', onCrosshairMove);
    if (container) container.style.cursor = 'none';
  } else {
    window.removeEventListener('mousemove', onCrosshairMove);
    if (container) container.style.cursor = '';
  }
});

const startDrawFeature = () => {
  if (isDrawing.value) { drawEngine.stop(); return; }
  const layerId = mapState.editor.selectedLayerId;
  if (layerId) {
    if (mapState.ui.currentView !== 'map') toggleView('map'); // 绘制需在地图上进行，自动切回地图
    drawEngine.start(layerId);
  } else {
    alert("⚠️ 请先在左侧【图层管理器】中，将目标图层设为“工作图层”！");
    // 💡 贴心交互：如果图层面板没开，自动帮你展开！
    if (mapState.ui.activeMenu !== 'layers') {
      toggleMenu('layers');
    }
  }
};

// ==========================================
// 🌟 新增：强制清理污染数据并重新从硬盘拉取的帮手函数
// ==========================================
// ==========================================
// 🌟 重构版：调用底层接口，强制清理并重载
const handleEditToggle = () => {
  toggleEditMode();
};

const toggleEditMode = () => {
  if (mapState.editor.isEditing) {
    spatialEditor.deactivate();
    drawEngine.stop();
    mapState.editor.isEditing = false;
    mapState.editor.activeTool = null;
    // 会话结束：备份可见的 geojson 图层（服务端哈希去重：只有实际变更才写盘）
    const visibleLayers = getFlatLayers(['geojson']).filter(l => l.show && l.url);
    fetch('/api/backups/session-end', {
      method: 'POST', keepalive: true,
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filePaths: visibleLayers.map(l => l.url) })
    }).catch(err => console.warn('[session-end] 备份请求失败:', err.message));
  } else {
    mapState.editor.isEditing = true;
    spatialEditor.init();
    // 检查图层树是否有结构变更
    checkTreeStale().then(async (stale) => {
      if (stale) {
        showToast('检测到图层列表有更新...', 'info', 0);
        const { loadLayerConfig: lc } = await import('../../store/mapState.js');
        await lc();
        const { syncTreeLayers: stl } = await import('../../core/layers/LayerManager.js');
        await stl();
        hideToast();
      }
    });
  }
};

const toggleView = (targetView) => {
  if (mapState.ui.currentView === targetView) return;
  if (mapState.editor.isEditing) {
    if (targetView === 'table') {
      // 离开地图：保存并释放在编辑的几何、收起控制点；保留编辑会话
      spatialEditor.deactivate();
      drawEngine.stop();
      mapState.editor.activeTool = null;
    } else if (targetView === 'map') {
      // 回到地图：重新启用几何编辑器（init 幂等）
      spatialEditor.init();
    }
  }

  mapState.ui.currentView = targetView;
};

onErrorCaptured((err, instance, info) => {
  console.error('[MainLayout] Child render error:', err.message, '| Component:', instance?.$options?.name || instance?.$options?.__name || 'anonymous', '| Info:', info);
  return false;
});
</script>

<style scoped>
.main-layout { position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; display: flex; z-index: 100; }
.op-hint-bar { position: fixed; top: 122px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9); font-size: 24px; padding: 6px 18px; border-radius: 14px; z-index: 5000; white-space: nowrap; pointer-events: none; }
.desk-crosshair { position: fixed; width: 32px; height: 32px; transform: translate(-50%, -50%); pointer-events: none; z-index: 10000; }
.desk-crosshair::before, .desk-crosshair::after { content: ''; position: absolute; background: var(--color-accent); box-shadow: 0 0 4px rgba(56,189,248,0.6); }
.desk-crosshair::before { left: 50%; top: 0; width: 1px; height: 100%; }
.desk-crosshair::after { top: 50%; left: 0; height: 1px; width: 100%; }
.view-container { position: absolute; top: 0; left: 60px; right: 0; bottom: 0; pointer-events: none; }

.global-edit-console {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%); 
  z-index: 3000;
  pointer-events: auto;
  display: flex;
  gap: 12px;
  align-items: center;
  background: rgba(15, 23, 42, 0.7); 
  padding: 6px 12px;
  border-radius: 8px;
  backdrop-filter: blur(8px);
  border: 1px solid rgba(56, 189, 248, 0.2);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
}

.console-btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: bold;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s;
  font-size: 14px;
  box-shadow: 0 4px 10px rgba(0,0,0,0.3);
}

.auth-btn { background: var(--color-elevated); color: var(--color-accent); border-color: var(--color-accent); }
.auth-btn:hover { background: var(--color-accent); color: #000; }

/* 🌟 新增画图按钮的专属样式 */
.tool-btn { background: rgba(56, 189, 248, 0.1); border-color: var(--color-accent); color: var(--color-accent); margin-right: 8px; }
.tool-btn:hover { background: var(--color-accent); color: #000; box-shadow: 0 0 10px rgba(56, 189, 248, 0.6); }
.tool-btn.active { background: rgba(251, 191, 36, 0.2); border-color: #fbbf24; color: #fbbf24; }

.save-btn { 
  background: #10b981; color: white; border-color: #059669;
  animation: save-pulse 2s infinite; 
}
.save-btn:hover { background: #059669; animation: none; transform: scale(1.05); }

.exit-btn { background: #ef4444; color: white; border-color: #dc2626; }
.exit-btn:hover { background: #dc2626; transform: scale(1.05); }

/* 工作图层选择条 */
.working-layer-bar { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 5000; display: flex; align-items: center; gap: 6px; background: var(--color-surface); padding: 4px 12px; border-radius: var(--radius-panel); border: 1px solid rgba(56,189,248,0.15); font-size: 12px; pointer-events: auto; }
.wl-label { color: var(--color-accent); }
.wl-name { color: var(--text-primary); cursor: pointer; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-name:hover { color: var(--color-accent); }
.wl-arrow { color: var(--text-secondary); cursor: pointer; font-size: 10px; }
/* 图层选择弹窗 */
.layer-picker-mask { position: fixed; inset: 0; z-index: 10001; pointer-events: auto; }
.layer-picker-popover { position: absolute; top: 80px; left: 50%; transform: translateX(-50%); width: 300px; max-height: 360px; background: var(--color-floor); border: 1px solid var(--color-accent); border-radius: var(--radius-panel); overflow-y: auto; box-shadow: var(--shadow-modal); }
.lp-header { padding: 8px 12px; color: var(--color-accent); font-size: 13px; border-bottom: 1px solid var(--color-elevated); }
.lp-tree { padding: 4px 0; }

.editing-indicator {
  background: rgba(15, 23, 42, 0.85);
  color: #10b981;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid #10b981;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: bold;
  backdrop-filter: blur(5px);
  box-shadow: 0 4px 10px rgba(0,0,0,0.3);
}

.pulse-dot {
  width: 10px;
  height: 10px;
  background: #10b981;
  border-radius: 50%;
  animation: save-pulse 1s infinite;
}

@keyframes save-pulse {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
  70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

.sidebar-dock { width: 60px; background: var(--color-surface); backdrop-filter: blur(10px); border-right: 1px solid rgba(255,255,255,0.1); pointer-events: auto; display: flex; flex-direction: column; align-items: center; padding-top: 20px; box-shadow: var(--shadow-panel); z-index: 102; }
.logo { color: var(--color-accent); font-weight: bold; font-size: 18px; margin-bottom: 30px; border-bottom: 2px solid var(--color-accent); padding-bottom: 5px; }
.menu-list { display: flex; flex-direction: column; gap: 15px; width: 100%; }
.menu-item { width: 100%; height: 50px; display: flex; justify-content: center; align-items: center; font-size: 24px; cursor: pointer; color: var(--text-secondary); transition: 0.2s; border-left: 3px solid transparent; }
.menu-item:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
.menu-item.active { color: var(--color-accent); border-left-color: var(--color-accent); background: rgba(56, 189, 248, 0.1); }
.menu-divider { height: 1px; width: 60%; margin: 10px auto; background: rgba(255,255,255,0.1); }
.action-btn { font-size: 20px; }

.panel-drawer { position: absolute; top: 0; bottom: 0; left: 0; width: 380px; background: var(--color-surface); backdrop-filter: blur(10px); border-right: 1px solid rgba(255,255,255,0.1); pointer-events: auto; display: flex; flex-direction: column; box-shadow: var(--shadow-panel); z-index: 101; }
.panel-content { flex: 1; padding: 20px; overflow-y: auto; }
.close-btn { position: absolute; right: -20px; top: 50%; transform: translateY(-50%); width: 20px; height: 50px; background: var(--color-surface); border: 1px solid rgba(255,255,255,0.1); border-left: none; border-radius: 0 8px 8px 0; color: var(--text-secondary); cursor: pointer; display: flex; justify-content: center; align-items: center; font-size: 12px; }
.close-btn:hover { color: var(--text-primary); }

.table-view { background: var(--color-floor); pointer-events: auto; display: flex; justify-content: center; align-items: center;}
.table-view :deep(.data-table-panel) { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.placeholder-table { text-align: center; color: var(--color-accent); }
.return-btn { margin-top: 20px; padding: 10px 20px; background: transparent; border: 1px solid var(--color-accent); color: var(--color-accent); cursor: pointer; border-radius: var(--radius-control); transition: 0.2s;}
.return-btn:hover { background: var(--color-accent); color: var(--text-primary); }

.slide-enter-active, .slide-leave-active { transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.slide-enter-from, .slide-leave-to { transform: translateX(-100%); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.global-toast {
  position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
  padding: 16px 32px; border-radius: 10px; font-size: 28px; z-index: 100001; pointer-events: none;
  background: rgba(56,189,248,0.75); border: 1px solid var(--color-accent); color: var(--text-primary);
}
.global-toast.error { background: rgba(239,68,68,0.75); border-color: #ef4444; color: #fff; }
.global-toast.success { background: rgba(16,185,129,0.75); border-color: #10b981; color: #fff; }
.toast-fade-enter-active, .toast-fade-leave-active { transition: opacity 0.3s; }
.toast-fade-enter-from, .toast-fade-leave-to { opacity: 0; }
</style>