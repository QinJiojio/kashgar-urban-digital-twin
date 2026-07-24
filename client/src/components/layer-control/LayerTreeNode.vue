<template>
  <div class="layer-tree-node">
    <div class="node-main" :class="{ 'is-folder': node.type === 'folder' }">
      
      <span class="drag-handle">⋮⋮</span>

      <button 
        v-if="node.type === 'folder'" 
        class="icon-btn expand-btn" 
        @click="toggleExpand"
      >
        {{ isExpanded ? '▼' : '▶' }}
      </button>
      <span v-else class="indent-spacer"></span>

      <span class="type-icon">{{ getTypeIcon(node) }}</span>

      <input 
        v-if="isRenaming"
        ref="renameInputRef"
        v-model="editName"
        class="rename-input"
        @blur="finishRename"
        @keyup.enter="finishRename"
        @keyup.esc="cancelRename"
      />
      <span 
        v-else 
        class="node-name" 
        @dblclick="startRename" 
        title="双击重命名"
      >
        {{ node.name }}
        <span 
          v-if="node.type === '3dtiles' && node.features?.[0]?.isLoading" 
          class="loading-badge"
          title="正在下载瓦片数据..."
        >
          ⬇️ {{ node.features[0].pendingRequests }}
        </span>
      </span>

      <div class="node-actions">
        
        <div class="hover-actions">
          <button 
            v-if="mapState.editor.isEditing && node.type === 'geojson' && mapState.editor.selectedLayerId !== node.id"
            class="working-layer-btn"
            @click.stop="setWorkingLayer(node.id)"
            title="点击设为工作图层"
          >
            ✏️ 设为工作
          </button>

          <button v-if="mapState.editor.isEditing" class="icon-btn" @click.stop="startRename" title="重命名">📝</button>

          <button v-if="node.type === 'geojson'" class="icon-btn" @click.stop="openInDataWorkbench" title="在数据工作台打开">📊</button>

          <button v-if="node.type !== 'folder'" class="icon-btn setting-btn" @click="$emit('open-settings', node)" title="属性设置">⚙️</button>

          <button v-if="node.type !== 'folder'" class="icon-btn" @click="flyToLayer" title="定位视角">🎯</button>

          <button v-if="mapState.editor.isEditing" class="icon-btn delete-btn" @click.stop="deleteNode" title="永久删除">🗑️</button>
        </div>

        <button
          v-if="mapState.editor.isEditing && node.type === 'geojson' && mapState.editor.selectedLayerId === node.id"
          class="working-layer-btn is-working"
          title="当前工作图层（点击取消）"
          @click.stop="clearWorkingLayer"
        >✏️ 工作中
          🎯 绘制中
        </button>

        <label class="custom-checkbox" title="显示/隐藏">
          <input type="checkbox" v-model="node.show" @change="handleToggleShow" />
          <span class="checkmark"></span>
        </label>
      </div>
    </div>

    <div v-if="node.type === 'folder' && isExpanded" class="node-children">
      <draggable 
        v-model="node.children" 
        :group="{ name: 'layers', pull: true, put: true }" 
        item-key="id" 
        handle=".drag-handle"
        ghost-class="ghost-node"
        :animation="250"
        :fallbackOnBody="true"
        :swapThreshold="0.65"
        @change="handleDragChange"
      >
        <template #item="{ element }">
          <LayerTreeNode 
            :node="element" 
            @open-settings="$emit('open-settings', $event)" 
            @tree-changed="$emit('tree-changed')"
          />
        </template>
      </draggable>
      
      <div v-if="!node.children || node.children.length === 0" class="empty-folder">
        拖入图层到此文件夹
      </div>
    </div>
  </div>
</template>

<script setup>
// 🌟 引入了 nextTick，用于在变成输入框的瞬间自动获取焦点
import { ref, nextTick } from 'vue';
import draggable from 'vuedraggable';
import * as Cesium from 'cesium';
import { toggleLayerVisibility } from '../../core/layers/LayerManager';
import { getViewer } from '../../core/viewer/ViewerSetup';
import { getLayer } from '../../core/layers/LayerManager';
import { mapState, showToast } from '../../store/mapState';
import { apiHeaders } from '../../core/apiClient';

const props = defineProps({
  node: { type: Object, required: true }
});

const emit = defineEmits(['open-settings', 'tree-changed']);

// ==========================================
// 🌟 新增：优雅的内联重命名引擎
// ==========================================
const isRenaming = ref(false);
const editName = ref('');
const renameInputRef = ref(null);

const startRename = async () => {
  // 先检测图层树是否被他人修改
  const { checkTreeStale } = await import('../../core/locks.js');
  const stale = await checkTreeStale();
  if (stale) {
    const { loadLayerConfig: lc } = await import('../../store/mapState.js');
    await lc();
    alert('图层列表已被他人修改，请刷新后重试。');
    return;
  }
  editName.value = props.node.name;
  isRenaming.value = true;
  // 等待 Vue 把 span 渲染成 input 后，强行聚焦，让用户直接打字
  nextTick(() => {
    if (renameInputRef.value) {
      renameInputRef.value.focus();
      renameInputRef.value.select(); // 自动全选文字，体验拉满
    }
  });
};

const finishRename = async () => {
  if (!isRenaming.value) return;
  isRenaming.value = false;
  const trimmedName = editName.value.trim();
  if (!trimmedName || trimmedName === props.node.name) return;

  const originalName = props.node.name;
  props.node.name = trimmedName;
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  try {
    const res = await fetch(`/api/layers/${props.node.id}`, {
      method: 'PATCH', headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: trimmedName })
    });
    if (!res.ok) { const d = await res.json().catch(()=>({})); showToast(d.error || '重命名失败', 'error'); props.node.name = originalName; return; }
  } catch (_) { showToast('网络错误，重命名失败', 'error'); props.node.name = originalName; return; }
  try { const { checkTreeStale } = await import('../../core/locks.js'); await checkTreeStale(); } catch (_) {}
};

const cancelRename = () => {
  isRenaming.value = false;
};
// ==========================================

const deleteNode = async () => {
  const msg = props.node.type === 'folder'
    ? `⚠️ 确定要彻底删除文件夹【${props.node.name}】及其内部所有图层吗？`
    : `⚠️ 确定要删除图层【${props.node.name}】吗？`;

  if (!confirm(msg)) return;

  // 检查图层树是否被他人修改（在修改任何状态之前）
  const { checkTreeStale } = await import('../../core/locks.js');
  if (await checkTreeStale()) {
    const { loadLayerConfig: lc } = await import('../../store/mapState.js');
    await lc();
    alert('图层列表已被他人修改，请刷新后重试。');
    return;
  }

  // 先调 API 删除
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const res = await fetch(`/api/layers/${props.node.id}`, {
    method: 'DELETE',
    headers: apiHeaders({ 'Content-Type': 'application/json' })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || '删除失败，请重试', 'error');
    return;
  }

  // API 成功后再隐藏图层 + 移除树节点
  if (props.node.type !== 'folder') {
    toggleLayerVisibility(props.node.id, false);
  } else {
    const hideAll = (nodes) => {
      for (const n of nodes) {
        if (n.type !== 'folder') toggleLayerVisibility(n.id, false);
        if (n.children) hideAll(n.children);
      }
    };
    hideAll(props.node.children || []);
  }

  const removeById = (nodes, targetId) => {
    const idx = nodes.findIndex(n => n.id === targetId);
    if (idx > -1) {
      nodes.splice(idx, 1);
      return true;
    }
    for (const node of nodes) {
      if (node.children && removeById(node.children, targetId)) return true;
    }
    return false;
  };
  removeById(mapState.layerTree, props.node.id);
  try { await checkTreeStale(); } catch (_) {}
};

const setWorkingLayer = (layerId) => {
  if (!mapState.editor.isEditing) {
    alert("请先在顶部点击【开启编辑模式】！");
    return;
  }
  if (!props.node.show) {
    showToast('该图层未显示，请先开启图层可见性（👁）', 'error');
    return;
  }
  mapState.editor.selectedLayerId = layerId;
};

const clearWorkingLayer = () => {
  mapState.editor.selectedLayerId = null;
};

const openInDataWorkbench = () => {
  mapState.ui.currentView = 'table';
  // 先切视图，等 DataTablePanel 挂载后再设目标图层 ID（watch 能捕获到变化）
  import('vue').then(({ nextTick }) => nextTick(() => { mapState.ui.pendingTableLayerId = props.node.id; }));
};

const flyToLayer = async () => {
  if (props.node.type === 'folder') return;
  const viewer = getViewer();
  if (!viewer) return;

  try {
    let targetObject = null;
    if (props.node.type === 'geojson') {
      targetObject = getLayer(props.node.id);
    } else if (props.node.type === '3dtiles') {
      const featId = props.node.features?.[0]?.id || props.node.id + '_feature';
      targetObject = getLayer(featId);
    }
    if (targetObject) {
      // Model entity 直接用 position 定位
      if (targetObject._isBuildingModel) {
        const pos = targetObject.position?.getValue?.(Cesium.JulianDate.now());
        if (pos) viewer.camera.flyTo({ destination: Cesium.Cartesian3.add(pos, new Cesium.Cartesian3(0,0,200), new Cesium.Cartesian3()), duration: 1.5 });
        else alert("模型尚未加载完成，请稍后再试。");
        return;
      }
      await viewer.flyTo(targetObject, { duration: 1.5 });
    } else {
      alert("未能锁定地图元素，请确认该图层的数据是否有效或已开启小眼睛加载。");
    }
  } catch (error) {
    console.error("飞行定位失败:", error);
  }
};

const storageKey = `folder_expand_${props.node.id}`;
const isExpanded = ref((() => { try { const u = JSON.parse(sessionStorage.getItem('cesium_mvp_user')||'{}').username||''; return localStorage.getItem(u + '_' + storageKey); } catch(_) { return null; } })() !== 'false');
const _persistExpand = (val) => { try { const u = JSON.parse(sessionStorage.getItem('cesium_mvp_user')||'{}').username||''; localStorage.setItem(u + '_' + storageKey, val); } catch(_) {} };

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
  _persistExpand(String(isExpanded.value));
};

const _userLayerKey = (base) => { try { const u = JSON.parse(sessionStorage.getItem('cesium_mvp_user')||'{}').username||''; return u + '_' + base; } catch(_) { return base; } };

const handleToggleShow = () => {
  toggleLayerVisibility(props.node.id, props.node.show);
  localStorage.setItem(_userLayerKey(`layer_show_${props.node.id}`), props.node.show);
};

if (props.node.type !== 'folder') {
  const savedShow = localStorage.getItem(_userLayerKey(`layer_show_${props.node.id}`));
  if (savedShow !== null) props.node.show = savedShow === 'true';
}

const getTypeIcon = (node) => {
  if (node.type === 'folder') return '📁';
  if (node.type === '3dtiles') return '🏢';
  if (node.type === 'geojson') {
    if (node.geometryType === 'point') return '📍';
    if (node.geometryType === 'polyline') return '〰️';
    return '⬟';
  }
  return '📄';
};

const handleDragChange = () => emit('tree-changed');
</script>

<style scoped>
.layer-tree-node { margin-bottom: 2px; }
.node-main { display: flex; align-items: center; padding: 4px 6px; background: rgba(255, 255, 255, 0.03); border-radius: 4px; transition: background 0.2s; cursor: grab; }
.node-main:hover { background: rgba(255, 255, 255, 0.08); }
.node-main:active { cursor: grabbing; }
.node-main.is-folder { background: rgba(56, 189, 248, 0.1); border-left: 2px solid #38bdf8; }

.drag-handle { color: #475569; font-size: 14px; margin-right: 4px; cursor: grab; }
.icon-btn { background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0 2px; font-size: 12px; }
.icon-btn:hover { color: #38bdf8; }
.delete-btn:hover { color: #ef4444; transform: scale(1.1); }

.indent-spacer { width: 16px; }
.type-icon { margin-right: 4px; font-size: 14px; }

/* 🌟 补充 text-align: left 强制文本靠左 */
.node-name {
  flex: 1;
  text-align: left;
  font-size: 13px;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-right: 4px;
  user-select: none;
}

/* 重命名输入框也加上左对齐，保证双击切换时文字不跳动 */
.rename-input { 
  flex: 1; 
  text-align: left; /* 🌟 强制左对齐 */
  background: #0f172a; 
  border: 1px solid #38bdf8; 
  color: #fff; 
  border-radius: 3px; 
  padding: 2px 4px; 
  font-size: 13px; 
  margin-right: 10px; 
  outline: none; 
  box-shadow: 0 0 5px rgba(56, 189, 248, 0.5);
}

/* 把工作图层按钮多余的边距清理掉，让它融入新布局 */
.working-layer-btn { 
  font-size: 11px; 
  padding: 2px 6px; 
  background: transparent; 
  border: 1px solid #475569; 
  color: #94a3b8; 
  border-radius: 4px; 
  cursor: pointer; 
  transition: all 0.2s; 
  white-space: nowrap; 
}
.working-layer-btn:hover { border-color: #38bdf8; color: #38bdf8; background: rgba(56, 189, 248, 0.1); }
.working-layer-btn.is-working { background: rgba(16, 185, 129, 0.2); border-color: #10b981; color: #10b981; font-weight: bold; box-shadow: 0 0 8px rgba(16, 185, 129, 0.3); }

/* 🌟 右侧动作组的大容器 */
.node-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.hover-actions {
  display: none;
  align-items: center;
  gap: 1px;
}

/* 🌟 当鼠标进入这一整行时，悬浮按钮组出现 */
.node-main:hover .hover-actions {
  display: flex;
}

/* 模型加载徽章与呼吸动画 */
.loading-badge {
  font-size: 10px;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.4);
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: 6px;
  display: inline-block;
  animation: pulse-loading 1.5s infinite;
}

@keyframes pulse-loading {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}

.custom-checkbox { display: flex; align-items: center; cursor: pointer; position: relative; width: 16px; height: 16px; flex-shrink: 0; }
.custom-checkbox input { position: absolute; opacity: 0; cursor: pointer; height: 0; width: 0; }
.checkmark { position: absolute; top: 0; left: 0; height: 16px; width: 16px; background-color: #1e293b; border: 1px solid #475569; border-radius: 3px; }
.custom-checkbox input:checked ~ .checkmark { background-color: #10b981; border-color: #10b981; }
.checkmark:after { content: ""; position: absolute; display: none; left: 5px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.custom-checkbox input:checked ~ .checkmark:after { display: block; }

.node-children { margin-left: 14px; padding-left: 4px; border-left: 1px dashed #334155; margin-top: 4px; min-height: 40px; padding-bottom: 8px; }
.node-children:empty::after, .empty-folder { content: '📥 拖拽图层到此嵌套'; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #475569; font-style: italic; border: 1px dashed #334155; border-radius: 4px; min-height: 30px; background: rgba(0,0,0,0.2); }
.ghost-node { opacity: 0.8; background: rgba(56, 189, 248, 0.2); border: 1px dashed #38bdf8; }
</style>