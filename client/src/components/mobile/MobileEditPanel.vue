<template>
  <div class="mobile-edit-panel">
    <h4>✏️ 编辑面板</h4>

    <!-- 工作图层选择 -->
    <div class="section">
      <label>工作图层</label>
      <select v-model="workingLayerId" @change="onLayerChange" class="sel">
        <option value="">-- 选择图层 --</option>
        <option v-for="l in vectorLayers" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
    </div>

    <div v-if="workingLayerId" class="section">
      <label>{{ workingGeomType === 'polygon' ? '⬟ 面要素' : (workingGeomType === 'polyline' ? '〰️ 线要素' : '📍 点要素') }}</label>

      <button class="dr-btn" :class="{ active: drawingAs === workingGeomType }" @click="startDraw">
        {{ workingGeomType === 'point' ? '📍 画点' : (workingGeomType === 'polyline' ? '〰️ 画线' : '⬟ 画面') }}
      </button>

      <p class="hint">点击地图放置顶点，双指缩放平移。长按控制点可删除。</p>
    </div>

    <div v-if="!workingLayerId" class="hint-empty">请先在「图层」标签选择工作图层</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { mapState, getFlatLayers, getLayerState } from '../../store/mapState';
import { drawEngine } from '../../core/viewer/DrawEngine';
import { checkLayerStale } from '../../core/locks';
import { showToast } from '../../store/mapState';

const emit = defineEmits(['draw-state', 'close']);
const workingLayerId = ref(mapState.editor.selectedLayerId || '');
const drawingAs = ref(null);

const vectorLayers = computed(() => getFlatLayers(['geojson']));
const workingGeomType = computed(() => {
  const l = getLayerState(workingLayerId.value);
  return l ? (l.geometryType || 'polygon') : null;
});

watch(() => mapState.editor.selectedLayerId, (v) => { if (v) workingLayerId.value = v; });

const onLayerChange = () => {
  mapState.editor.selectedLayerId = workingLayerId.value;
  if (drawEngine.isDrawing) { drawEngine.stop(); emit('draw-state', 'idle'); drawingAs.value = null; }
};

const startDraw = async () => {
  if (!workingLayerId.value) return;
  if (drawEngine.isDrawing) { drawEngine.stop(); }

  const stale = await checkLayerStale(workingLayerId.value);
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(workingLayerId.value);
    showToast('已刷新', 'info', 1000);
  }

  const geomType = workingGeomType.value;
  if (geomType === 'point') {
    await drawEngine.start(workingLayerId.value, { passivePoint: true });
    drawingAs.value = geomType;
    emit('draw-state', 'point-place');
  } else {
    await drawEngine.start(workingLayerId.value, { screenPreview: true });
    drawingAs.value = geomType;
    emit('draw-state', 'drawing');
  }
};

let _unlisten = null;
onMounted(() => {
  _unlisten = drawEngine.onDrawStateChange((isDrawing) => {
    if (!isDrawing) { drawingAs.value = null; emit('draw-state', 'idle'); }
  });
});
onUnmounted(() => { if (_unlisten) _unlisten(); });
</script>

<style scoped>
.mobile-edit-panel { display: flex; flex-direction: column; gap: 16px; }
h4 { color: #38bdf8; margin: 0; }
.section { background: rgba(30,41,59,0.5); padding: 12px; border-radius: 8px; }
.section label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.sel { width: 100%; padding: 8px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; font-size: 14px; }
.dr-btn { width: 100%; padding: 12px; background: #1e293b; border: 1px solid #475569; color: #94a3b8; border-radius: 6px; font-size: 14px; cursor: pointer; margin-top: 8px; }
.dr-btn.active { border-color: #38bdf8; color: #38bdf8; background: rgba(56,189,248,0.1); }
.hint { font-size: 11px; color: #64748b; margin-top: 8px; }
.hint-empty { text-align: center; padding: 40px 0; color: #64748b; font-size: 14px; }
</style>
