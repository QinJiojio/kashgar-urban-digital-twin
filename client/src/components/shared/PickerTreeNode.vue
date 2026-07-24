<template>
  <div>
    <div class="ptn-row" :style="{ paddingLeft: (depth * 16 + 8) + 'px' }"
      :class="{ active: node.id === mapState.editor.selectedLayerId }">
      <!-- 文件夹：展开/折叠 + 可见性 -->
      <template v-if="node.type === 'folder'">
        <span class="ptn-expand" @click="expanded = !expanded">{{ expanded ? '▼' : '▶' }}</span>
        <label class="ptn-check" @click.stop>
          <input type="checkbox" :checked="node.show" @change="e => toggleLayerVisibility(node.id, e.target.checked)" />
        </label>
        <span class="ptn-icon">📁</span>
        <span class="ptn-name">{{ node.name }}</span>
      </template>
      <!-- 图层：点击设为工作 -->
      <template v-else>
        <span class="ptn-expand" style="visibility:hidden">▶</span>
        <label class="ptn-check" @click.stop>
          <input type="checkbox" :checked="node.show" @change="e => toggleLayerVisibility(node.id, e.target.checked)" />
        </label>
        <span class="ptn-icon">{{ node.geometryType === 'point' ? '📍' : node.geometryType === 'polyline' ? '〰️' : '⬟' }}</span>
        <span class="ptn-name" @click="pickNode(node)">{{ node.name }}</span>
      </template>
    </div>
    <template v-if="node.type === 'folder' && expanded && node.children">
      <PickerTreeNode v-for="child in node.children" :key="child.id" :node="child" :depth="depth + 1" />
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { mapState } from '../../store/mapState';
import { toggleLayerVisibility } from '../../core/layers/LayerManager';

const props = defineProps({ node: Object, depth: { type: Number, default: 0 } });
const expanded = ref(true);

const pickNode = (node) => {
  mapState.editor.selectedLayerId = node.id;
  if (!node.show) toggleLayerVisibility(node.id, true);
  // emit close signal
  window.dispatchEvent(new CustomEvent('layerpicker:close'));
};
</script>

<style scoped>
.ptn-row { display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: default; font-size: 12px; transition: background .15s; }
.ptn-row:hover { background: rgba(56,189,248,0.08); }
.ptn-row.active { background: rgba(56,189,248,0.12); }
.ptn-expand { color: #64748b; cursor: pointer; width: 14px; text-align: center; font-size: 10px; flex-shrink: 0; }
.ptn-check { flex-shrink: 0; }
.ptn-check input { cursor: pointer; }
.ptn-icon { flex-shrink: 0; font-size: 12px; }
.ptn-name { color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.ptn-row.active .ptn-name { color: #38bdf8; }
</style>
