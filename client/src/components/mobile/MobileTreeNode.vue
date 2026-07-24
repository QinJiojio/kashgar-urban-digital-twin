<template>
  <div class="tree-node">
    <div class="node-row" :style="{ paddingLeft: (depth * 16 + 8) + 'px' }" @click="toggleFolder">
      <span v-if="node.type === 'folder'" class="expand-icon">{{ expanded ? '▼' : '▶' }}</span>
      <span v-else class="expand-icon-spacer"></span>
      <span class="type-icon">{{ node.type === 'folder' ? '📁' : (node.type === '3dtiles' ? '🏢' : '📐') }}</span>
      <span class="node-name">{{ node.name }}</span>

      <template v-if="node.type !== 'folder'">
        <button class="btn-gear" @click.stop="$emit('open-settings', node)" title="样式设置">⚙</button>
        <button v-if="mapState.editor.isEditing" class="btn-work"
          :class="{ active: node.id === mapState.editor.selectedLayerId }"
          @click.stop="setWorking(node.id)">
          {{ node.id === mapState.editor.selectedLayerId ? '✓' : '选' }}
        </button>
        <label class="vis-check" @click.stop><input type="checkbox" :checked="node.show" @change="toggleVis" /></label>
      </template>
      <template v-else>
        <label class="vis-check" @click.stop><input type="checkbox" :checked="node.show" @change="toggleVis" /></label>
      </template>
    </div>

    <div v-if="node.type === 'folder' && expanded" class="children">
      <MobileTreeNode v-for="child in node.children" :key="child.id" :node="child" :depth="depth + 1" @open-settings="$emit('open-settings', $event)" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { mapState, getLayerState } from '../../store/mapState';
import { toggleLayerVisibility } from '../../core/layers/LayerManager';

const props = defineProps({ node: Object, depth: Number });
defineEmits(['open-settings']);
const expanded = ref(false);

const toggleFolder = () => {
  if (props.node.type === 'folder') expanded.value = !expanded.value;
};

const toggleVis = () => { toggleLayerVisibility(props.node.id, !props.node.show); };
const setWorking = (id) => { mapState.editor.selectedLayerId = id; };
</script>

<style scoped>
.tree-node { font-size: 13px; }
.node-row { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(51,65,85,0.4); gap: 6px; cursor: pointer; min-height: 44px; }
.expand-icon { width: 16px; text-align: center; color: #94a3b8; font-size: 10px; flex-shrink: 0; }
.expand-icon-spacer { width: 16px; flex-shrink: 0; }
.type-icon { width: 20px; text-align: center; flex-shrink: 0; font-size: 14px; }
.node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e8f0; }
.btn-work { padding: 3px 10px; background: #1e293b; border: 1px solid #475569; color: #94a3b8; border-radius: 4px; font-size: 11px; cursor: pointer; flex-shrink: 0; min-width: 30px; }
.btn-gear { width: 28px; height: 28px; padding: 0; background: #1e293b; border: 1px solid #475569; color: #94a3b8; border-radius: 4px; font-size: 14px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.btn-work.active { border-color: #38bdf8; color: #38bdf8; background: rgba(56,189,248,0.1); }
.vis-check input { width: 18px; height: 18px; accent-color: #38bdf8; }
.children { /* nested */ }
</style>