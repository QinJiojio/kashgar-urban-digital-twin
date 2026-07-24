<template>
  <div class="mobile-schema-editor">
    <div class="toolbar">
      <button class="btn-save" @click="save">保存</button>
    </div>
    <h4>字段编辑 - {{ layerName }}</h4>

    <div class="field-list">
      <div v-for="(cfg, key) in fields" :key="key" class="field-row">
        <div class="field-key">{{ key }}</div>
        <select v-model="cfg.type" class="sel-sm">
          <option value="text">文本</option><option value="number">数值</option><option value="date">日期</option><option value="daterange">时间段</option><option value="select">下拉</option><option value="boolean">布尔</option>
        </select>
        <button class="btn-del" @click="removeField(key)">✕</button>
      </div>
    </div>

    <div class="add-field">
      <input v-model="newKey" placeholder="新字段名" class="inp-sm" />
      <button @click="addField">＋ 新增</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { mapState, getLayerState, fieldSchema, fieldGroupsMeta, loadFieldFormat, saveFieldFormat } from '../../store/mapState';
import { acquireSchemaLock, releaseSchemaLock, checkLayerStale } from '../../core/locks';

const props = defineProps({ layerId: String });
const emit = defineEmits(['close']);

const newKey = ref('');
const fields = ref({});

const layerName = computed(() => {
  const l = getLayerState(props.layerId);
  return l ? l.name : props.layerId;
});

onMounted(async () => {
  const fmt = await loadFieldFormat(props.layerId);
  const schema = fieldSchema[props.layerId] || {};
  fields.value = JSON.parse(JSON.stringify({ ...schema, ...fmt }));
  await acquireSchemaLock(props.layerId);
});

onUnmounted(async () => {
  await releaseSchemaLock(props.layerId);
});

const addField = async () => {
  const k = newKey.value.trim();
  if (!k || fields.value[k]) return;
  fields.value[k] = { type: 'text' };
  newKey.value = '';

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${props.layerId}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: getLayerState(props.layerId)?.url, action: 'add', field: { key: k } })
  });
};

const removeField = async (key) => {
  if (!confirm(`删除字段 "${key}"？`)) return;
  delete fields.value[key];
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${props.layerId}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: getLayerState(props.layerId)?.url, action: 'delete', field: { key } })
  });
};

const save = async () => {
  // 新模型图层：把分组元数据(groups)一并存回（fields.value 已含各字段 group/order）；旧模型 undefined 自然降级
  await saveFieldFormat(props.layerId, fields.value, fieldGroupsMeta[props.layerId]);
  await checkLayerStale(props.layerId); // 回正本地版本，避免本图层后续操作自我误判 stale
  await releaseSchemaLock(props.layerId);
  emit('close');
};
</script>

<style scoped>
.mobile-schema-editor { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.btn-save { padding: 8px 20px; background: #10b981; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
h4 { color: #38bdf8; margin: 0 0 12px; }

.field-list { flex: 1; overflow-y: auto; }
.field-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #1e293b; }
.field-key { flex: 1; font-size: 13px; }
.sel-sm { padding: 4px 8px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; font-size: 12px; width: 80px; }
.btn-del { padding: 2px 8px; background: none; border: 1px solid #ef4444; color: #ef4444; border-radius: 4px; cursor: pointer; font-size: 12px; }

.add-field { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #334155; }
.inp-sm { flex: 1; padding: 8px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; font-size: 13px; }
.add-field button { padding: 8px 16px; background: #38bdf811; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 4px; font-size: 13px; cursor: pointer; }
</style>
