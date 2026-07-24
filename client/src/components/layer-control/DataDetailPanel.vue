<template>
  <transition name="slide-right">
    <div class="detail-panel" v-if="mapState.interaction.selectedFeatureId" @click.stop>
      <div class="panel-header">
        <div class="header-info">
          <span class="icon">📄</span>
          <h3>{{ currentLayerInfo?.name || '' }} · 属性信息</h3>
        </div>
        <button class="close-btn" @click.stop="deselect" title="关闭面板">×</button>
      </div>

      <div class="panel-body custom-scrollbar" ref="panelBodyRef">
        <div v-if="lockedByOther" class="lock-notice">✏️ {{ lockedByOther }} 正在编辑要素几何形态</div>
        <div v-if="mapState.editor.isEditing" class="add-field-row">
          <input type="text" v-model="newFieldKey" placeholder="新字段名" class="field-key-input" @keyup.enter="handleAddField" />
          <button class="action-btn add-field" @click="handleAddField">+ 添加字段</button>
        </div>
        <div class="property-table">
          <!-- OBJECTID 始终在最前 -->
          <div class="prop-row">
            <div class="prop-key"><span>OBJECTID</span></div>
            <div class="prop-val">
              <div class="prop-val-inner">
                <input v-if="mapState.editor.isEditing" type="text" :value="props['OBJECTID']" class="prop-input readonly" disabled title="系统主键" />
                <span v-else class="prop-text">{{ props['OBJECTID'] || '--' }}</span>
              </div>
            </div>
          </div>
          <!-- 分组渲染 -->
          <template v-for="group in fieldGroups" :key="group.key">
            <div class="group-header" @click="toggleGroup(group.key)">
              <span class="group-toggle">{{ collapsedGroups.has(group.key) ? '▶' : '▼' }}</span>
              <span class="group-header-label">{{ group.label }}</span>
              <span v-if="getHeaderBoolKey(group)" class="group-header-bool">
                <input type="checkbox" :checked="props[getHeaderBoolKey(group)] === 'True'" @click.stop @change="e => { const k = getHeaderBoolKey(group); focusedField = { key: k, original: props[k] }; props[k] = e.target.checked ? 'True' : 'False'; handleDataChange(k, props[k]); handlePropBlur(k); }" :disabled="!mapState.editor.isEditing" />
                <span v-if="fieldErrors[getHeaderBoolKey(group)]" class="field-error-tip" style="position:static;margin-left:6px;">{{ fieldErrors[getHeaderBoolKey(group)] }}</span>
              </span>
              <span v-else-if="group.parentField" class="group-header-val">{{ props[group.parentField] || '--' }}</span>
            </div>
            <!-- 折叠时：标题行已有勾选框/父字段值的组不再显示首子字段 -->
            <template v-if="collapsedGroups.has(group.key)">
              <div v-if="!group.parentField && !getHeaderBoolKey(group) && group.children.length > 0" class="prop-row" :key="group.children[0].key">
                <div class="prop-key"><span :title="group.children[0].key">{{ group.children[0].key }}</span></div>
                <div class="prop-val"><div class="prop-val-inner">
                  <span v-if="group.children[0].config?.format === 'boolean'" class="bool-cell"><input type="checkbox" :checked="props[group.children[0].key] === 'True'" disabled /></span>
                  <span v-else class="prop-text">{{ group.children[0].config?.format === 'image' ? '🖼 ' + parsePhotos(props[group.children[0].key]).length + '张' : (props[group.children[0].key] || '--') }}</span>
                </div></div>
              </div>
            </template>
            <!-- 展开时只显示子字段，父字段已在标题行 -->
            <template v-else>
              <div v-for="field in group.children.filter(f => f.key !== group.parentField && f.key !== getHeaderBoolKey(group))" :key="field.key" class="prop-row">
                <div class="prop-key"><span :title="field.key">{{ field.key }}</span></div>
                <div class="prop-val">
                  <div class="prop-val-inner" :class="{ 'has-error': fieldErrors[field.key] }">
                    <template v-if="mapState.editor.isEditing && field.config?.format === 'select'">
                      <div v-if="isSelectCustom(props[field.key], field.config.options)" style="display:flex;gap:4px;">
                        <select :value="selectDisplayVal(props[field.key], field.config.options)"
                          @change="onSelectPick(field.key, $event.target.value, field.config.options)"
                          @focus="focusedField = { key: field.key, original: props[field.key] }" class="prop-input" style="flex:1;">
                          <option v-for="opt in field.config.options" :key="opt" :value="opt">{{ opt }}</option>
                          <option value="__other__">其他</option>
                        </select>
                        <input type="text"
                          :value="getCustomPart(props[field.key])"
                          @input="e => { props[field.key] = '其他: ' + (e.target.value || ''); handleDataChange(field.key, props[field.key]); }"
                          @focus="handlePropFocus(field.key)" @blur="handlePropBlur(field.key)" class="prop-input"
                          placeholder="输入自定义值" style="flex:1.5;" />
                      </div>
                      <select v-else :value="selectDisplayVal(props[field.key], field.config.options)"
                        @change="onSelectPick(field.key, $event.target.value, field.config.options)"
                        @focus="focusedField = { key: field.key, original: props[field.key] }" class="prop-input">
                        <option v-for="opt in field.config.options" :key="opt" :value="opt">{{ opt }}</option>
                        <option value="__other__">其他</option>
                      </select>
                    </template>
                    <span v-else-if="!mapState.editor.isEditing && field.config?.format === 'boolean'" class="bool-cell"><input type="checkbox" :checked="props[field.key] === 'True'" disabled /></span>
                    <template v-else-if="field.config?.format === 'image'">
                      <span v-if="!mapState.editor.isEditing" class="image-inline">
                        <span v-for="(p, i) in parsePhotos(props[field.key])" :key="i" class="image-thumb" :title="p.n || ''" @click="viewPhoto(p.u, parsePhotos(props[field.key]), i, field.key)">
                          <img :src="safeThumbUrl(p.u)" @error="e => { markThumbFailed(p.u); e.target.onerror = null; }" />
                        </span>
                        <span v-if="!(props[field.key] || '')" class="prop-text">--</span>
                      </span>
                      <span v-else class="image-edit">
                        <span v-for="(p, i) in parsePhotos(props[field.key])" :key="i" class="image-item" :title="p.n || ''" @click="viewPhoto(p.u, parsePhotos(props[field.key]), i, field.key)">
                          <img :src="safeThumbUrl(p.u)" @error="e => { markThumbFailed(p.u); e.target.onerror = null; }" />
                          <button @click.stop="removePhoto(field.key, p.u, i)" class="img-del-btn">×</button>
                        </span>
                        <span v-for="(st, sk) in uploadState" :key="sk">
                          <span v-if="st.fieldKey === field.key && st.featureId === currentFeatureId" class="image-thumb image-thumb-prog">{{ st.progress }}%</span>
                        </span>
                        <div class="image-upload-row">
                          <button @click="uploadPhoto(field.key)" class="img-upload-btn">📷 上传照片</button>
                          <label class="keep-orig-label"><input type="checkbox" v-model="keepOriginal" /> 保留原图</label>
                        </div>
                      </span>
                    </template>
                    <label v-else-if="mapState.editor.isEditing && field.config?.format === 'boolean'" class="bool-label">
                      <input type="checkbox" :checked="props[field.key] === 'True'" @change="e => { focusedField = { key: field.key, original: props[field.key] }; props[field.key] = e.target.checked ? 'True' : 'False'; handleDataChange(field.key, props[field.key]); handlePropBlur(field.key); }" />
                      {{ props[field.key] === 'True' ? '是' : '否' }}
                    </label>
                    <input v-else-if="mapState.editor.isEditing && field.config?.format === 'date'" type="date" min="1900-01-01" max="2099-12-31"
                      v-model="props[field.key]" @input="handleDataChange(field.key, $event.target.value)" @focus="handlePropFocus(field.key)" @blur="handlePropBlur(field.key)" class="prop-input" />
                    <span v-else-if="mapState.editor.isEditing && field.config?.format === 'daterange'"
                      class="prop-text" style="color:#38bdf8;cursor:pointer;"
                      @click="openDrPanel(field.key)">{{ props[field.key] || '点击设置时间段...' }}</span>
                    <input v-else-if="mapState.editor.isEditing" type="text" v-model="props[field.key]" @input="handleDataChange(field.key, $event.target.value)" @focus="handlePropFocus(field.key)" @blur="handlePropBlur(field.key)" class="prop-input" />
                    <span v-else class="prop-text" :title="props[field.key]">{{ props[field.key] || '--' }}</span>
                    <button v-if="mapState.editor.isEditing" class="del-field-btn" @click="handleDeleteField(field.key)" title="删除此字段">×</button>
                    <span v-if="fieldErrors[field.key]" class="field-error-tip">{{ fieldErrors[field.key] }}</span>
                    <span v-if="fieldSuccess[field.key]" class="field-success-tip">已保存</span>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>

      <div class="panel-footer">
        <button class="action-btn locate" @click="zoomTo">🎯 在地图上居中锁定</button>
        <button v-if="mapState.editor.isEditing" class="action-btn edit-spatial" :class="{ active: mapState.editor.activeTool === 'vertex' }" @click="toggleSpatialEdit" style="margin-top: 10px;">
          <span v-if="mapState.editor.activeTool === 'vertex'">✅ 完成保存</span>
          <span v-else>{{ currentGeomType === 'polyline' ? '〰️ 调整线段节点' : (currentGeomType === 'point' ? '📍 移动坐标位置' : '📐 调整多边形边界') }}</span>
        </button>
        <button v-if="mapState.editor.isEditing" class="action-btn delete-feature" @click="deleteFeature" style="margin-top: 10px;">🗑️ 删除该要素</button>
      </div>
    </div>
  </transition>

  <!-- 照片备注确认面板 -->
  <Teleport to="body">
    <div v-if="photoConfirm.visible" class="note-mask" @click.self="cancelPhotoConfirm">
      <div class="note-panel">
        <img :src="photoConfirm.preview" class="note-img" />
        <input v-model="photoConfirm.note" placeholder="添加备注说明（可选）" class="note-input" @keyup.enter="confirmPhotoUpload" />
        <div class="note-btns">
          <button @click="confirmPhotoUpload" class="note-ok">确认上传</button>
          <button @click="cancelPhotoConfirm" class="note-cancel">取消</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 照片查看器 lightbox -->
  <Teleport to="body">
    <div v-if="lightbox.visible" class="lightbox-mask" @click="closeLightbox" @keydown.esc="closeLightbox">
      <button class="lightbox-close" @click.stop="closeLightbox">✕</button>
      <div class="lightbox-img-wrap" @click.stop>
        <img v-for="(url, i) in lightbox.urls" :key="i" :src="url" :style="{ display: i === lightbox.index ? 'block' : 'none' }" />
      </div>
      <div class="lightbox-bar" @click.stop>
        <button v-if="lightbox.urls.length > 1" class="lightbox-nav" @click.stop="lightboxNav(-1)">◀</button>
        <span class="lightbox-counter">{{ lightbox.index + 1 }} / {{ lightbox.urls.length }}</span>
        <button v-if="lightbox.urls.length > 1" class="lightbox-nav" @click.stop="lightboxNav(1)">▶</button>
        <button v-if="mapState.editor.isEditing" class="lightbox-del" @click.stop="deleteCurrentPhoto">🗑️ 删除</button>
      </div>
      <!-- 备注展示/编辑（备注文本始终可见，编辑按钮仅编辑模式） -->
      <div class="lightbox-note" @click.stop>
        <template v-if="editingLightboxNote">
          <input v-model="lightboxNoteDraft" class="lightbox-note-input" placeholder="输入备注说明" @keyup.enter="saveLightboxNote" @keyup.escape="cancelEditLightboxNote" />
          <button @click="saveLightboxNote" class="lightbox-note-save">✓</button>
          <button @click="cancelEditLightboxNote" class="lightbox-note-cancel">✕</button>
        </template>
        <template v-else>
          <span v-if="currentPhotoNote" class="lightbox-note-text" :title="currentPhotoNote">{{ currentPhotoNote }}</span>
          <button v-if="mapState.editor.isEditing" @click="startEditLightboxNote" class="lightbox-note-btn">{{ currentPhotoNote ? '✏️' : '➕ 添加备注' }}</button>
        </template>
      </div>
    </div>
  </Teleport>

  <!-- 时间段弹窗选择器 -->
  <Teleport to="body">
    <div v-if="drPanel.open" class="date-editor-backdrop" @click.self="cancelDrPanel">
      <div class="dr-dialog" @click.stop>
        <div class="dr-header">时间段</div>
        <div class="dr-body">
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="date" v-model="drPanel.startVal" min="1900-01-01" max="2099-12-31" class="dr-input" />
            <span style="color:#94a3b8;">~</span>
            <input type="date" v-model="drPanel.endVal" min="1900-01-01" max="2099-12-31" class="dr-input" />
          </div>
        </div>
        <div class="dr-actions">
          <button class="action-btn secondary" @click="cancelDrPanel">取消</button>
          <button class="action-btn" @click="confirmDrPanel">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, reactive } from 'vue';
import * as Cesium from 'cesium';
import { mapState, fieldSchema, fieldGroupsMeta, getLayerState, getFlatLayers, showToast, hideToast, getThumbUrl, safeThumbUrl, markThumbFailed, parsePhotos } from '../../store/mapState';
import { isDecoupledLayer, persistNewFieldMeta } from '../../core/fieldSchemaOps';
import { compressImage } from '../../core/imageUtils';
import { getViewer, clearSelectionHighlight } from '../../core/viewer/ViewerSetup';
import { spatialEditor } from '../../core/viewer/SpatialEditor';
import { getLayer, reloadLayer } from '../../core/layers/LayerManager';
import { acquireSchemaLock, releaseSchemaLock, checkLayerStale, fetchLayerLocks } from '../../core/locks';
import { parseFieldGroups, getGroupFieldKeys, getHeaderBoolKey } from '../../core/fieldGroups';
import { validateFieldValue, isSelectCustom, getCustomPart, selectDisplayVal } from '../../core/fieldValidation';
import { saveFeature } from '../../core/saveFeature';

const newFieldKey = ref('');
const lastAddedKey = ref('');
const lastAddedRow = ref(null);
const panelBodyRef = ref(null);
const lockedByOther = ref('');
const _dirtyFields = new Map(); // 脏字段追踪：key→original值

// 选中要素变化时查询锁定状态
watch(() => mapState.interaction.selectedFeatureId, async (fid) => {
  releasePropLock();
  lockedByOther.value = '';
  if (!fid) return;
  const layerInfo = currentLayerInfo.value;
  if (!layerInfo) return;
  const layerId = layerInfo.id;
  const locks = await fetchLayerLocks(layerId);
  const myObjId = mapState.interaction.selectedFeatureProps?.OBJECTID;
  const myLock = locks.features?.find(l => String(l.featureId) === String(myObjId || fid));
  if (myLock && myLock.username !== mapState.auth.username) {
    lockedByOther.value = myLock.username;
  }
  // 仅在编辑模式下检测图层变更
  if (mapState.editor.isEditing) {
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到图层有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      const myObjId = mapState.interaction.selectedFeatureProps?.OBJECTID;
      if (myObjId) await refreshSelectedProps(String(myObjId), layerId);
      hideToast();
    }
  }
});

const currentLayerInfo = computed(() => {
  let targetId = mapState.interaction.selectedLayerId;
  const featureId = mapState.interaction.selectedFeatureId;
  if (!targetId && featureId) {
    const allLayers = getFlatLayers(['geojson']);
    const foundLayer = allLayers.find(l => l.features?.some(f => f.id === featureId));
    if (foundLayer) { targetId = foundLayer.id; mapState.interaction.selectedLayerId = targetId; }
  }
  if (!targetId) targetId = 'polygon-blocks';
  return getLayerState(targetId);
});

const currentGeomType = computed(() => currentLayerInfo.value ? (currentLayerInfo.value.geometryType || 'polygon') : 'polygon');

// props 仍然绑定 selectedFeatureProps 用于 v-model
const props = computed(() => mapState.interaction.selectedFeatureProps || {});

// 字段列表优先从 fieldSchema 读取，schema 为空时从要素 properties 降级构建
const displayFields = computed(() => {
  const schema = fieldSchema[currentLayerInfo.value?.id] || {};
  const fields = { OBJECTID: { label: 'OBJECTID', type: 'number' } };
  for (const key in schema) fields[key] = schema[key];
  // schema 为空时：从当前选中要素的 properties 动态生成字段列表
  if (Object.keys(fields).length === 1) {
    const props = mapState.interaction.selectedFeatureProps || {};
    for (const key in props) {
      if (key.toUpperCase() === 'OBJECTID') continue;
      if (!fields[key]) fields[key] = { label: key, type: typeof props[key] === 'number' ? 'number' : 'string' };
    }
  }
  return fields;
});

// 分组折叠状态
const collapsedGroups = ref(new Set());
const toggleGroup = (gk) => {
  if (collapsedGroups.value.has(gk)) collapsedGroups.value.delete(gk);
  else collapsedGroups.value.add(gk);
  collapsedGroups.value = new Set(collapsedGroups.value);
};
const fieldGroups = computed(() => {
  const schema = fieldSchema[currentLayerInfo.value?.id];
  if (!schema) return [];
  return parseFieldGroups(schema, fieldGroupsMeta[currentLayerInfo.value?.id]);
});


// 返回应从标题行展示的布尔字段 key（覆盖新旧两种分组模型），否则 null
// 旧模型：parentField 为布尔 → 返回 parentField

// 父字段布尔值为 True 时自动展开分组，False 时自动折叠
watch(() => props.value, (newProps) => {
  if (!newProps) return;
  let changed = false;
  for (const group of fieldGroups.value) {
    const hdrKey = getHeaderBoolKey(group);
    if (hdrKey && newProps[hdrKey] === 'True') {
      // 布尔值为 True → 自动展开
      collapsedGroups.value.delete(group.key);
      changed = true;
    } else if (hdrKey) {
      // 布尔值为 False → 自动折叠
      if (!collapsedGroups.value.has(group.key)) {
        collapsedGroups.value.add(group.key);
        changed = true;
      }
    }
  }
  if (changed) collapsedGroups.value = new Set(collapsedGroups.value);
}, { deep: true });

const editingField = ref(null);
const fieldErrors = reactive({});// 字段错误提示（红色）
const fieldSuccess = reactive({});// 字段保存成功提示（绿色）
const photoConfirm = reactive({ visible: false, preview: '', note: '', fieldKey: '', file: null });
const cancelPhotoConfirm = () => { photoConfirm.visible = false; photoConfirm.file = null; };
const photoNote = (val) => { const p = parsePhotos(val); return p.length ? p[0].n || '' : ''; };

// 要素锁是否由 SpatialEditor 持有（控制点编辑中）
const isVertexEditing = () => mapState.editor.activeTool === 'vertex';

// 刷新 selectedFeatureProps：reloadLayer 后 entity 数据已更新，面板需要同步
const refreshSelectedProps = async (stableId, layerId) => {
  const viewer = getViewer();
  const ds = getLayer(layerId);
  const entities = (ds instanceof Cesium.GeoJsonDataSource) ? ds.entities.values : (viewer?.entities?.values || []);
  for (const e of entities) {
    const p = e.properties?.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
    if (p && String(p.OBJECTID) === String(stableId)) {
      const cur = mapState.interaction.selectedFeatureProps;
      if (cur) {
        // 原地更新避免整面板重渲染闪烁
        for (const k of Object.keys(cur)) { if (!(k in p)) delete cur[k]; }
        Object.assign(cur, p);
      } else {
        mapState.interaction.selectedFeatureProps = p;
      }
      mapState.interaction.selectedFeatureId = e.id; // reload 后更新 Cesium entity ID
      return;
    }
  }
};

const handlePropFocus = async (key) => {
  if (key.toUpperCase() === 'OBJECTID') return;
  const layerId = currentLayerInfo.value?.id;
  if (!layerId) return;

  // 同一要素锁已持有，无需重复获取
  if (editingField.value) return;

  // 上一次保存仍在进行中：跳过 stale 检测（saveFeature 完成后的 markSaved 会同步版本号）
  if (savingBlur) { editingField.value = stableId; return; }

  // 控制点编辑中（SpatialEditor 已持有锁）：仅做 stale 检测，不重复获取/释放锁
  const props = mapState.interaction.selectedFeatureProps;
  const stableId = (props && props.OBJECTID) ? String(props.OBJECTID) : mapState.interaction.selectedFeatureId;
  if (isVertexEditing()) {
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      // 刷新后面板显示的是旧 props，需要从 entity 重新读取
      await refreshSelectedProps(stableId, layerId);
      hideToast();
    }
    return;
  }

  // 检测图层/要素是否有远端更新（await 期间用户可能已开始键入）
  const stale = await checkLayerStale(layerId);
  if (stale) {
    const userStartedTyping = mapState.editor.isDirty;
    const typedValue = props ? props[key] : undefined;
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    await reloadLayer(layerId);
    await refreshSelectedProps(stableId, layerId);
    hideToast();
    // 若用户在 stale 检测期间已开始键入 → 自动合并到刷新后的数据
    if (userStartedTyping && typedValue !== undefined) {
      const refreshed = mapState.interaction.selectedFeatureProps;
      if (refreshed) {
        refreshed[key] = typedValue;
        const v = getViewer();
        const d = getLayer(layerId);
        for (const e of (d ? d.entities.values : (v ? v.entities.values : []))) {
          if (!e.properties) continue;
          const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
          if (ep && String(ep.OBJECTID) === String(stableId)) { e.properties[key] = typedValue; break; }
        }
      }
    }
  }
  // 记住聚焦字段的原始值（冲突自动合并用）
  const propsForFocus = mapState.interaction.selectedFeatureProps;
  focusedField.value = { key, original: propsForFocus ? propsForFocus[key] : undefined };
  _dirtyFields.set(key, focusedField.value.original);
  editingField.value = stableId;
};

// 释放当前持有的要素锁（切换要素/关闭面板时调用）
const releasePropLock = () => {
  if (!editingField.value) return;
  if (isVertexEditing()) return;
  editingField.value = null;
};

let savingBlur = false; // 防止快速连续勾选导致并发 saveFeature
const focusedField = ref({ key: '', original: undefined }); // 冲突自动合并用：记住聚焦时的原始值

// 时间段弹窗选择器
const drPanel = reactive({ open: false, fieldKey: '', startVal: '', endVal: '' });
const openDrPanel = (fieldKey) => {
  handlePropFocus(fieldKey);
  const val = props.value[fieldKey] || '';
  const parts = val.split(' ~ ');
  drPanel.fieldKey = fieldKey;
  drPanel.startVal = parts[0]?.trim() || '';
  drPanel.endVal = parts[1]?.trim() || '';
  drPanel.open = true;
};
const confirmDrPanel = () => {
  const s = drPanel.startVal.trim();
  const e = drPanel.endVal.trim();
  props.value[drPanel.fieldKey] = (s && e) ? `${s} ~ ${e}` : '';
  handleDataChange(drPanel.fieldKey, props.value[drPanel.fieldKey]);
  drPanel.open = false;
  handlePropBlur(drPanel.fieldKey);
};
const cancelDrPanel = () => { drPanel.open = false; };

// 下拉"其他"组合框 —— 选中"其他"时清空当前值等待自定义输入，选中预设值时立即保存
const onSelectPick = (fieldKey, newVal, options) => {
  focusedField.value = { key: fieldKey, original: props.value[fieldKey] };
  if (newVal === '__other__') {
    props.value[fieldKey] = '其他: ';
  } else {
    props.value[fieldKey] = newVal;
    handleDataChange(fieldKey, newVal);
    handlePropBlur(fieldKey);
  }
};

const handlePropBlur = async (editedKey) => {
  // 门控之前捕获 focusedField 快照并记录脏字段（门控跳过的字段也需要追踪）
  const _ok = focusedField.value.key;
  const _ov = focusedField.value.original;
  if (_ok) _dirtyFields.set(_ok, _ov);
  if (savingBlur) return; // 上一次保存尚未完成，跳过本次（handleDataChange 已更新 entity 属性，下一次 blur 会补保存）
  const layerId = currentLayerInfo.value?.id;
  const props = mapState.interaction.selectedFeatureProps;
  const stableId = editingField.value || ((props && props.OBJECTID) ? String(props.OBJECTID) : mapState.interaction.selectedFeatureId);
  if (!layerId || !stableId) return;

  if (mapState.editor.isDirty) {
    savingBlur = true;
    // 在 await 之前捕获 focusedField 快照（await 期间 A 可能聚焦其他字段导致覆盖）
    const origKey = _ok;
    const origVal = _ov;
    try {
      const { checkLayerConflict } = await import('../../core/locks.js');
      const conflict = await checkLayerConflict(layerId, stableId);
      if (conflict.stale && !isVertexEditing()) {
        const userValue = props ? props[editedKey] : undefined;
        // reload 前快照所有脏字段
        const pendingDirty = {};
        for (const [k, orig] of _dirtyFields) {
          if (k !== editedKey) pendingDirty[k] = { original: orig, current: props[k] };
        }
        showToast('检测到图层有更新，正在刷新...', 'info', 0);
        await reloadLayer(layerId);
        await refreshSelectedProps(stableId, layerId);
        hideToast();
        // 冲突自动合并：若服务端该字段未被他人修改，则重新应用用户输入
        const refreshed = mapState.interaction.selectedFeatureProps;
        let _canContinue = true;
        if (refreshed && editedKey && origKey === editedKey && origVal !== undefined) {
          const serverVal = refreshed[editedKey];
          if (serverVal === origVal) {
            refreshed[editedKey] = userValue;
            _dirtyFields.delete(editedKey);
            const v = getViewer();
            const d = getLayer(layerId);
            const candidates = d ? d.entities.values : (v ? v.entities.values : []);
            for (const e of candidates) {
              if (!e.properties) continue;
              const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
              if (ep && String(ep.OBJECTID) === String(stableId)) {
                e.properties[editedKey] = userValue; break;
              }
            }
            mapState.editor.isDirty = true;
            // 不 return，继续走到下面的 saveFeature
          } else {
            _dirtyFields.delete(editedKey);
            await nextTick();
            fieldErrors[editedKey] = conflict.modifier;
            showToast(conflict.modifier, 'warning', 2500);
            setTimeout(() => delete fieldErrors[editedKey], 2000);
            mapState.editor.isDirty = false;
            _canContinue = false;
          }
        } else {
          if (editedKey) { await nextTick(); fieldErrors[editedKey] = conflict.modifier; showToast(conflict.modifier, 'warning', 2500); setTimeout(() => delete fieldErrors[editedKey], 2000); }
          mapState.editor.isDirty = false;
          _canContinue = false;
        }
        // 恢复其他脏字段（即使当前字段冲突也需恢复，保持UI与用户操作一致）
        const v2 = getViewer(); const d2 = getLayer(layerId);
        for (const [k, edit] of Object.entries(pendingDirty)) {
          const sv = refreshed[k];
          if (sv === edit.original) {
            refreshed[k] = edit.current;
            for (const e of (d2 ? d2.entities.values : (v2 ? v2.entities.values : []))) {
              if (!e.properties) continue;
              const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
              if (ep && String(ep.OBJECTID) === String(stableId)) { e.properties[k] = edit.current; break; }
            }
          } else {
            _dirtyFields.delete(k);
          }
        }
        if (!_canContinue) return;
      }
      if (editedKey && editedKey.toUpperCase() !== 'OBJECTID') {
        const fmt = fieldSchema[currentLayerInfo.value?.id]?.[editedKey]?.format;
        const opts = fieldSchema[currentLayerInfo.value?.id]?.[editedKey]?.options || [];
        const error = validateFieldValue(props[editedKey], fmt, opts);
        if (error) { fieldErrors[editedKey] = error; setTimeout(() => delete fieldErrors[editedKey], 2000); return; }
      }
      const saveResult = await saveFeature(layerId, stableId);
      if (!saveResult) { showToast('保存失败，请检查网络', 'error'); return; }
      if (saveResult?.conflict) {
        // 409 自动合并
        const userValue = props ? props[editedKey] : undefined;
        // reload 前快照所有脏字段
        const pendingDirty409 = {};
        for (const [k, orig] of _dirtyFields) {
          if (k !== editedKey) pendingDirty409[k] = { original: orig, current: props[k] };
        }
        if (!isVertexEditing()) {
          await reloadLayer(layerId);
          await refreshSelectedProps(stableId, layerId);
        }
        const refreshed = mapState.interaction.selectedFeatureProps;
        if (refreshed && editedKey && origKey === editedKey && origVal !== undefined) {
          const serverVal = refreshed[editedKey];
          if (serverVal === origVal) {
            refreshed[editedKey] = userValue;
            _dirtyFields.delete(editedKey);
            const v = getViewer(); const d = getLayer(layerId);
            for (const e of (d ? d.entities.values : (v ? v.entities.values : []))) {
              if (!e.properties) continue;
              const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
              if (ep && String(ep.OBJECTID) === String(stableId)) { e.properties[editedKey] = userValue; break; }
            }
            mapState.editor.isDirty = true;
            // 恢复其他脏字段
            const v409 = getViewer(); const d409 = getLayer(layerId);
            for (const [k, edit] of Object.entries(pendingDirty409)) {
              const sv = refreshed[k];
              if (sv === edit.original) {
                refreshed[k] = edit.current;
                for (const e of (d409 ? d409.entities.values : (v409 ? v409.entities.values : []))) {
                  if (!e.properties) continue;
                  const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
                  if (ep && String(ep.OBJECTID) === String(stableId)) { e.properties[k] = edit.current; break; }
                }
              } else { _dirtyFields.delete(k); }
            }
            // 重试保存
            const retryResult = await saveFeature(layerId, stableId);
            if (!retryResult) { showToast('自动重试保存失败，请检查网络', 'error', 3000); return; }
            if (retryResult?.conflict) {
              _dirtyFields.delete(editedKey);
              fieldErrors[editedKey] = retryResult.modifiedBy ? `已被 ${retryResult.modifiedBy} 修改` : '已被他人修改';
              setTimeout(() => delete fieldErrors[editedKey], 2000);
            } else if (retryResult?.success) {
              fieldSuccess[editedKey] = true;
              setTimeout(() => delete fieldSuccess[editedKey], 1500);
              showToast('已保存', 'success', 800);
            }
          } else {
            _dirtyFields.delete(editedKey);
            await nextTick();
            fieldErrors[editedKey] = saveResult.modifiedBy ? `已被 ${saveResult.modifiedBy} 修改` : '已被他人修改';
            showToast(fieldErrors[editedKey], 'warning', 2500);
            setTimeout(() => delete fieldErrors[editedKey], 2000);
          }
        } else {
          _dirtyFields.delete(editedKey);
          await nextTick();
          fieldErrors[editedKey] = saveResult.modifiedBy ? `已被 ${saveResult.modifiedBy} 修改` : '已被他人修改';
          showToast(fieldErrors[editedKey], 'warning', 2500);
          setTimeout(() => delete fieldErrors[editedKey], 2000);
        }
      } else if (saveResult?.success) {
        _dirtyFields.delete(editedKey);
        fieldSuccess[editedKey] = true;
        setTimeout(() => delete fieldSuccess[editedKey], 1500);
        showToast('已保存', 'success', 800);
      } else {
        showToast('保存异常: ' + (saveResult?.error || '未知错误'), 'error');
      }
      mapState.editor.isDirty = false;
    } finally {
      savingBlur = false;
    }
  }
  releasePropLock();
};


const handleDataChange = (fieldName, newValue) => {
  if (!mapState.editor.isDirty) mapState.editor.isDirty = true;
  const viewer = getViewer();
  const id = mapState.interaction.selectedFeatureId;
  if (!viewer || !id) return;
  const layerInfo = currentLayerInfo.value;
  // 优先从图层专属 DataSource 查找，避免跨图层 ID 碰撞
  let entity = null;
  if (layerInfo) {
    const ds = getLayer(layerInfo.id);
    if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(id);
  }
  if (!entity) entity = viewer.entities.getById(id);
  if (!entity) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      entity = viewer.dataSources.get(i).entities.getById(id);
      if (entity) break;
    }
  }
  if (entity && entity.properties) {
    if (entity.properties.hasProperty(fieldName)) entity.properties[fieldName] = newValue;
    else entity.properties.addProperty(fieldName, newValue);
  }
};

const handleAddField = async () => {
  const key = newFieldKey.value.trim();
  if (!key) return;
  const layerInfo = currentLayerInfo.value;
  if (!layerInfo || !layerInfo.url) return;
  if (fieldSchema[layerInfo.id] && key in fieldSchema[layerInfo.id]) { alert('字段已存在'); return; }

  const lockRes = await acquireSchemaLock(layerInfo.id);
  if (lockRes.error) { alert(lockRes.error); return; }

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${layerInfo.id}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: layerInfo.url, action: 'add', field: { key } })
  });

  // 更新 fieldSchema（前端 state）。新模型图层：写干净名 + 分组元数据（详情面板无分组选择器，归入"基本信息"=group:null）
  if (!fieldSchema[layerInfo.id]) fieldSchema[layerInfo.id] = {};
  const decoupled = isDecoupledLayer(layerInfo.id);
  if (decoupled) {
    let order = 0;
    for (const k in fieldSchema[layerInfo.id]) { if (k.toUpperCase() !== 'OBJECTID' && (fieldSchema[layerInfo.id][k]?.group ?? null) === null) order++; }
    fieldSchema[layerInfo.id][key] = { label: key, type: 'string', group: null, order };
    try { await persistNewFieldMeta(layerInfo.id, key, undefined, null, order, fieldGroupsMeta[layerInfo.id]); }
    catch (e) { showToast('分组元数据保存失败：' + e.message, 'error'); }
  } else {
    fieldSchema[layerInfo.id][key] = { label: key, type: 'string' };
  }

  // 更新当前选中要素的 properties
  if (mapState.interaction.selectedFeatureProps && !(key in mapState.interaction.selectedFeatureProps)) {
    mapState.interaction.selectedFeatureProps[key] = '';
  }
  // 更新 layer.features 中所有要素
  if (layerInfo.features) {
    layerInfo.features.forEach(f => { if (f.properties && !(key in f.properties)) f.properties[key] = ''; });
  }
  lastAddedKey.value = key;
  newFieldKey.value = '';
  mapState.editor.isDirty = true;
  await nextTick();
  if (lastAddedRow.value) lastAddedRow.value.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await checkLayerStale(layerInfo.id); // 回正本地版本，避免下次操作自我误判 stale
  releaseSchemaLock(layerInfo.id);
};

// ---- 照片上传 ----
const keepOriginal = ref(false);
const uploadState = ref({}); // { [key]: { featureId, fieldKey, seq, status, progress } }
const currentFeatureId = computed(() => {
  const fid = mapState.interaction.selectedFeatureId;
  const lid = mapState.interaction.selectedLayerId;
  return fid && lid ? lid + '_' + fid : '';
});


const uploadPhoto = async (fieldKey) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 弹出备注确认面板
    const reader = new FileReader();
    reader.onload = () => { photoConfirm.preview = reader.result; photoConfirm.note = ''; photoConfirm.fieldKey = fieldKey; photoConfirm.file = file; photoConfirm.visible = true; };
    reader.readAsDataURL(file);
    return;
  };
  input.click();
};

const confirmPhotoUpload = async () => {
  const fieldKey = photoConfirm.fieldKey;
  const note = photoConfirm.note.trim();
  const file = photoConfirm.file;
  photoConfirm.visible = false;
  if (!file) return;
  // 以下为原 uploadPhoto 逻辑
  (async () => {
    const layerId = currentLayerInfo.value?.id;
    const propsData = mapState.interaction.selectedFeatureProps;
    if (!layerId || !propsData) return;
    const capturedFeatureId = mapState.interaction.selectedFeatureId;
    const objId = propsData.OBJECTID || '';
    const seq = parsePhotos(propsData[fieldKey]).length + 1;

    // 压缩：默认 1920px + 800KB；保留原图模式下 4096px + 5MB
    const maxKb = keepOriginal.value ? 5000 : 800;
    const maxPx = keepOriginal.value ? 4096 : 1920;
    const minKb = keepOriginal.value ? 2000 : 0;
    const blob = keepOriginal.value && file.size <= 5000 * 1024 ? file : await compressImage(file, maxKb, maxPx, minKb);
    const form = new FormData();
    form.append('photo', blob, file.name);
    form.append('layerId', layerId);
    form.append('objectId', String(objId));
    form.append('fieldKey', fieldKey);
    form.append('seq', String(seq));
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
    const stateKey = fieldKey + '_' + Date.now();
    const featId = currentFeatureId.value;
    uploadState.value = { ...uploadState.value, [stateKey]: { featureId: featId, fieldKey, seq, status: 'uploading', progress: 0 } };
    try {
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], progress: Math.round(ev.loaded / ev.total * 100) } };
          }
        };
        xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('解析响应失败')); } };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.ontimeout = () => reject(new Error('上传超时'));
        xhr.timeout = 120000;
        xhr.open('POST', apiBase + '/api/upload/photo');
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(form);
      });
    if (!data.success) {
      showToast('上传失败: ' + (data.error || '未知错误'), 'error', 3000);
      return;
      return;
    }
    showToast('上传成功', 'success', 1500);
    // 重新读取最新值再拼接（防止并发上传覆盖）
    const curProps = mapState.interaction.selectedFeatureProps;
    if (curProps) {
      const curExisting = parsePhotos(curProps[fieldKey]);
      const insPos = seq - 1;
      curExisting.push({ u: data.url, n: note }); // JSON 格式追加
      curProps[fieldKey] = JSON.stringify(curExisting); // 新格式
    }
    // 同步 entity + 保存
    if (mapState.interaction.selectedFeatureId === capturedFeatureId) {
      handleDataChange(fieldKey, curProps ? curProps[fieldKey] : '');
      handlePropBlur(fieldKey);
      // 冲突兜底：reloadLayer 后 photo URL 丢失 → 补回并重试
      if (fieldErrors[fieldKey]) {
        const refreshed = mapState.interaction.selectedFeatureProps;
        if (refreshed) {
          const rPhotos = parsePhotos(refreshed[fieldKey]);
          rPhotos.push({ u: data.url, n: note });
          refreshed[fieldKey] = JSON.stringify(rPhotos);
          handleDataChange(fieldKey, refreshed[fieldKey]);
          try { const { saveFeature: _sf } = await import('../../core/saveFeature'); await _sf(layerId, String(objId)); } catch (_) {}
        }
      }
      const layer = currentLayerInfo.value;
      if (layer?.features) {
        const feat = layer.features.find(f => String(f.properties?.OBJECTID) === String(objId));
        if (feat?.properties) feat.properties[fieldKey] = curProps ? curProps[fieldKey] : '';
      }
    } else {
      // 面板已切换，后台保存到原要素
      const ds = getLayer(layerId);
      let entity = null;
      if (ds instanceof Cesium.GeoJsonDataSource) {
        for (const e of ds.entities.values) {
          const p = e.properties?.getValue?.(Cesium.JulianDate.now());
          if (p && String(p.OBJECTID) === String(objId)) { entity = e; break; }
        }
      }
      if (entity?.properties && curProps) {
        entity.properties[fieldKey] = curProps[fieldKey];
      }
      try { (await import('../../core/saveFeature')).saveFeature(layerId, String(objId)); } catch (_) { showToast('照片信息保存失败，请刷新后确认', 'error'); }
    }
    const s = { ...uploadState.value }; delete s[stateKey]; uploadState.value = s;
    } catch (err) {
      uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'error', progress: 0, msg: err.message || '网络错误' } };
      setTimeout(() => { const s = { ...uploadState.value }; delete s[stateKey]; uploadState.value = s; }, 3000);
    }
  })(); // end IIFE
};

const removePhoto = async (fieldKey, url, index) => {
  const propsData = mapState.interaction.selectedFeatureProps;
  if (!propsData) return;
  const existing = parsePhotos(propsData[fieldKey]);
  existing.splice(index, 1);
  propsData[fieldKey] = JSON.stringify(existing);
  handleDataChange(fieldKey, propsData[fieldKey]);
  handlePropBlur(fieldKey);
  // 同步 layer.features
  const layer = currentLayerInfo.value;
  const objId = propsData.OBJECTID;
  if (layer?.features && objId) {
    const feat = layer.features.find(f => String(f.properties?.OBJECTID) === String(objId));
    if (feat?.properties) feat.properties[fieldKey] = propsData[fieldKey];
  }
  // 删除服务器文件
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
  fetch(apiBase + '/api/upload/photo/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ url })
  }).catch(() => { showToast('照片删除失败', 'error'); });
};

// ---- 照片查看器 ----
const lightbox = ref({ visible: false, urls: [], photos: [], index: 0, fieldKey: '' });

const viewPhoto = (url, photos, idx, fieldKey) => {
  const urls = photos.map(p => p.u);
  lightbox.value = { visible: true, urls, photos, index: idx >= 0 ? idx : 0, fieldKey: fieldKey || '' };
};
const closeLightbox = () => { lightbox.value.visible = false; };
const lightboxNav = (dir) => {
  const n = lightbox.value.urls.length;
  lightbox.value.index = (lightbox.value.index + dir + n) % n;
};
const deleteCurrentPhoto = () => {
  const lb = lightbox.value;
  const photo = lb.photos[lb.index];
  if (!photo || !lb.fieldKey) return;
  removePhoto(lb.fieldKey, photo.u, lb.index);
  lb.urls.splice(lb.index, 1);
  lb.photos.splice(lb.index, 1);
  if (lb.urls.length === 0) { closeLightbox(); return; }
  if (lb.index >= lb.urls.length) lb.index = lb.urls.length - 1;
};

// 键盘导航：方向键切换，ESC 关闭
watch(() => lightbox.value.visible, (v) => {
  if (v) {
    const onKey = (e) => {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') lightboxNav(-1);
      else if (e.key === 'ArrowRight') lightboxNav(1);
    };
    document.addEventListener('keydown', onKey);
    lightbox._onKey = onKey;
  } else if (lightbox._onKey) {
    document.removeEventListener('keydown', lightbox._onKey);
    lightbox._onKey = null;
  }
});

// ---- lightbox 备注编辑 ----
const editingLightboxNote = ref(false);
const lightboxNoteDraft = ref('');
const currentPhotoNote = computed(() => {
  const lb = lightbox.value;
  return lb.photos[lb.index]?.n || '';
});

const startEditLightboxNote = () => {
  lightboxNoteDraft.value = currentPhotoNote.value;
  editingLightboxNote.value = true;
  nextTick(() => {
    const inp = document.querySelector('.lightbox-note-input');
    if (inp) inp.focus();
  });
};

const saveLightboxNote = async () => {
  const lb = lightbox.value;
  const note = lightboxNoteDraft.value.trim();
  const layerId = currentLayerInfo.value?.id;
  const propsData = mapState.interaction.selectedFeatureProps;
  const objId = propsData?.OBJECTID;

  if (!lb.fieldKey || !lb.photos[lb.index] || !layerId || !objId) {
    editingLightboxNote.value = false;
    return;
  }

  // 1. 版本冲突预检（与 handlePropBlur 一致）
  const { checkLayerConflict } = await import('../../core/locks.js');
  const conflict = await checkLayerConflict(layerId, String(objId));
  if (conflict.stale) {
    editingLightboxNote.value = false;
    showToast('数据已被他人修改，请关闭大图后重试', 'warning', 3000);
    return;
  }

  // 2. 更新内存状态 + 直接同步 entity（用 OBJECTID 查找，与 saveFeature 保持一致）
  // 注意：不能用 handleDataChange（它按 selectedFeatureId/Cesium entity ID 查找，
  // 可能与 saveFeature 按 OBJECTID 遍历找到的 entity 不同——数据丢失）。
  lb.photos[lb.index].n = note;
  const newVal = JSON.stringify(lb.photos);
  propsData[lb.fieldKey] = newVal;
  // 直接更新 entity 属性（与 saveFeature 相同的 OBJECTID 匹配逻辑）
  const viewer = getViewer();
  const ds = getLayer(layerId);
  const candidates = ds ? ds.entities.values : (viewer ? viewer.entities.values : []);
  for (const e of candidates) {
    if (!e.properties) continue;
    const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
    if (ep && String(ep.OBJECTID) === String(objId)) {
      e.properties[lb.fieldKey] = newVal;
      break;
    }
  }
  editingLightboxNote.value = false;

  // 3. 持久化 + 检查返回值
  const saveResult = await saveFeature(layerId, String(objId));
  if (!saveResult) {
    showToast('备注保存失败，请检查网络', 'error', 3000);
    return;
  }
  if (saveResult?.conflict) {
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(layerId);
    await refreshSelectedProps(String(objId), layerId);
    showToast('备注保存冲突，已刷新', 'warning', 2500);
    return;
  }
  showToast('备注已保存', 'success', 1000);
};

const cancelEditLightboxNote = () => {
  editingLightboxNote.value = false;
};

const handleDeleteField = async (key) => {
  if (!confirm(`确定要删除字段"${key}"吗？此操作将从该图层所有要素中永久移除此字段。`)) return;

  const lockRes = await acquireSchemaLock(currentLayerInfo.value.id);
  if (lockRes.error) { alert(lockRes.error); return; }

  const layerInfo = currentLayerInfo.value;
  if (!layerInfo || !layerInfo.url) return;

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${layerInfo.id}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: layerInfo.url, action: 'delete', field: { key } })
  });

  // 更新 fieldSchema
  if (fieldSchema[layerInfo.id]) delete fieldSchema[layerInfo.id][key];
  // 更新选中要素 properties
  if (mapState.interaction.selectedFeatureProps) delete mapState.interaction.selectedFeatureProps[key];
  // 更新 layer.features
  if (layerInfo.features) layerInfo.features.forEach(f => { if (f.properties) delete f.properties[key]; });
  mapState.editor.isDirty = true;
  await checkLayerStale(layerInfo.id); // 回正本地版本，避免下次操作自我误判 stale
  releaseSchemaLock(layerInfo.id);
};

const zoomTo = () => {
  const viewer = getViewer();
  const id = mapState.interaction.selectedFeatureId;
  if (!viewer || !id) return;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const entity = viewer.dataSources.get(i).entities.getById(id);
    if (entity) {
      viewer.zoomTo(entity);
      break;
    }
  }
};

// 🌟 触发空间编辑的开关逻辑
const toggleSpatialEdit = async () => {
  const id = mapState.interaction.selectedFeatureId;
  const layerId = currentLayerInfo.value?.id;
  if (!id || !layerId) return;

  if (mapState.editor.activeTool === 'vertex') {
    const saved = await spatialEditor.deactivate();
    if (!saved) return;
  }
  spatialEditor.activate(id, layerId);
};

// 彻底删除当前选中的要素
const deleteFeature = async () => {
  const confirmDelete = confirm("⚠️ 确定要永久删除该要素吗？此操作不可撤销。");
  if (!confirmDelete) return;

  const viewer = getViewer();
  const id = mapState.interaction.selectedFeatureId;
  const layerId = currentLayerInfo.value?.id;
  if (!viewer || !id || !layerId) return;

  // 获取 OBJECTID 用于服务端删除
  // 从所有 DataSource 中查找 entity（viewer.entities 不一定能找到 GeoJsonDataSource 内的 entity）
  let entity = viewer.entities.getById(id);
  if (!entity) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      entity = viewer.dataSources.get(i).entities.getById(id);
      if (entity) break;
    }
  }
  let stableId = String(id);
  if (entity && entity.properties) {
    const objId = entity.properties.OBJECTID?.getValue ? entity.properties.OBJECTID.getValue(Cesium.JulianDate.now()) : null;
    if (objId != null && objId !== undefined) stableId = String(objId);
  }

  if (mapState.editor.activeTool === 'vertex') {
    const saved = await spatialEditor.deactivate();
    if (!saved) return; // 几何保存失败，中断删除操作
  }

  // 清理 Outline 残影：ThematicRenderer 为每个多边形创建了独立 _outline Polyline
  if (entity && entity._outline) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds instanceof Cesium.GeoJsonDataSource && ds.entities.contains(entity._outline)) {
        ds.entities.remove(entity._outline);
        break;
      }
    }
  }

  // 冲突预检：若图层有更新先刷新，确认要素仍存在再删
  const layerInfo = getLayerState(layerId);
  const stale = await checkLayerStale(layerId);
  if (stale) {
    showToast('检测到图层有更新，正在刷新...', 'info', 0);
    await reloadLayer(layerId);
    await refreshSelectedProps(stableId, layerId);
    // reload 后 selectedFeatureId 已更新（refreshSelectedProps 同步），重新读取
    id = mapState.interaction.selectedFeatureId;
    hideToast();
    const lAfter = getLayerState(layerId);
    if (!lAfter?.features?.some(f => String(f.properties?.OBJECTID) === stableId || f.id === id)) {
      showToast('该要素已被他人删除', 'warning', 2500);
      deselect();
      return;
    }
  }
  // 先调 API 删除（必须在 Cesium 移除之前，防网络/协作冲突导致数据不一致）
  if (layerInfo?.url) {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const deleteRes = await fetch('/api/features', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filePath: layerInfo.url, featureId: stableId, layerId })
    });
    if (deleteRes.status === 404) {
      showToast('该要素已被他人删除', 'warning', 2500);
      deselect();
      return;
    }
  }

  // 清理高亮轮廓线（ViewerSetup 左键拾取时创建，否则 entity 销毁后残留）
  clearSelectionHighlight();

  // API 成功后从 Cesium 移除
  let removed = viewer.entities.removeById(id);
  if (!removed) {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      if (viewer.dataSources.get(i).entities.removeById(id)) {
        removed = true;
        break;
      }
    }
  }
  viewer.scene.requestRender();

  // 从内存状态移除
  const layer = getLayerState(layerId);
  if (layer && layer.features) {
    layer.features = layer.features.filter(f => f.id !== id);
  }

  mapState.editor.isDirty = true;
  await checkLayerStale(layerId); // 删要素后服务端 bump 了 layerVersion，回正本地避免下次自我误判 stale
  deselect();
};

// 🌟 关闭面板时执行清理
const deselect = () => {
  _dirtyFields.clear();
  if (mapState.editor.activeTool === 'vertex') spatialEditor.deactivate();
  releasePropLock();
  mapState.interaction.selectedFeatureId = null;
};
</script>

<style scoped>
.detail-panel { position: absolute; right: 20px; top: 80px; bottom: 30px; width: 380px; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(12px); border: 1px solid #38bdf866; border-radius: 8px; box-shadow: -10px 0 40px rgba(0,0,0,0.6); display: flex; flex-direction: column; z-index: 2000; color: #fff; pointer-events: auto; }
.panel-header { padding: 15px 20px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.5); }
.header-info { display: flex; align-items: center; gap: 8px; }
.header-info h3 { margin: 0; font-size: 18px; color: #38bdf8; }
.close-btn { background: none; border: none; color: #94a3b8; font-size: 32px; cursor: pointer; line-height: 1; padding: 0 5px; transition: 0.2s; }
.close-btn:hover { color: #ef4444; }
.panel-body { flex: 1; overflow-y: auto; padding: 20px; pointer-events: auto; }
.id-tag { font-size: 11px; color: #64748b; margin-bottom: 15px; font-family: monospace; }
.property-table { display: flex; flex-direction: column; gap: 1px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(56, 189, 248, 0.1); }
.prop-row { display: grid; grid-template-columns: 110px 1fr; min-height: 36px; background: rgba(15, 23, 42, 0.6); align-items: center; position: relative; }
.prop-key { padding: 8px 12px; background: rgba(56, 189, 248, 0.05); color: #38bdf8; font-size: 13px; font-weight: bold; border-right: 1px solid rgba(56, 189, 248, 0.1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prop-val { padding: 8px 12px; font-size: 13px; color: #e2e8f0; overflow: hidden; }
.prop-text { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bool-display { cursor: default; }
.bool-true { color: #10b981; font-weight: bold; }
.bool-label { display: flex; align-items: center; gap: 4px; color: #cbd5e1; font-size: 13px; cursor: pointer; }
.bool-label input[type="checkbox"] { width: 16px; height: 16px; accent-color: #38bdf8; }
.bool-cell input[type="checkbox"] { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border: 2px solid #475569; border-radius: 3px; background: transparent; cursor: default; position: relative; }
.bool-cell input[type="checkbox"]:checked { background: #38bdf8; border-color: #38bdf8; }
.bool-cell input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 3px; top: 0px; width: 5px; height: 9px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.group-header { display: flex; align-items: center; gap: 6px; padding: 8px 12px; margin: 4px 0; background: #1a2332; border-left: 3px solid #38bdf8; color: #38bdf8; font-size: 13px; font-weight: bold; cursor: pointer; user-select: none; border-radius: 2px; position: relative; }
.group-header:hover { background: #243447; }
.group-header .group-header-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-toggle { font-size: 10px; margin-right: 6px; }
.group-header-bool { margin-left: auto; display: flex; align-items: center; }
.group-header-bool input[type="checkbox"] { width: 16px; height: 16px; accent-color: #38bdf8; cursor: pointer; }
.group-header-bool input[type="checkbox"]:disabled { cursor: default; }
.group-header-val { margin-left: auto; color: #94a3b8; font-size: 13px; font-weight: normal; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-inline { display: flex; flex-wrap: wrap; gap: 4px; }
.image-thumb { width: 60px; height: 60px; overflow: hidden; border-radius: 4px; cursor: pointer; border: 1px solid #334155; flex-shrink: 0; }
.image-thumb img { width: 100%; height: 100%; object-fit: cover; }
.image-thumb-prog { display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold; color: #38bdf8; background: #0f172a; cursor: default; }
.image-thumb:hover { border-color: #38bdf8; }
.image-edit { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-start; }
.image-item { position: relative; width: 60px; height: 60px; border-radius: 4px; overflow: hidden; border: 1px solid #334155; }
.image-item img { width: 100%; height: 100%; object-fit: cover; }
.img-del-btn { position: absolute; top: 0; right: 0; width: 18px; height: 18px; background: #ef4444; color: #fff; border: none; border-radius: 0 4px 0 4px; font-size: 12px; cursor: pointer; line-height: 1; padding: 0; }
.img-upload-btn { padding: 6px 12px; background: #1e293b; border: 1px dashed #38bdf8; color: #38bdf8; border-radius: 4px; cursor: pointer; font-size: 12px; }
.img-upload-btn:hover { background: rgba(56,189,248,0.1); }
.image-upload-row { display: flex; align-items: center; gap: 8px; }
.keep-orig-label { font-size: 11px; color: #64748b; cursor: pointer; display: flex; align-items: center; gap: 2px; }
.keep-orig-label input { width: 14px; height: 14px; accent-color: #38bdf8; }
.lightbox-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.lightbox-close { position: absolute; top: 16px; right: 16px; width: 40px; height: 40px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 20px; cursor: pointer; z-index: 1; }
.lightbox-img-wrap { max-width: 90vw; max-height: 80vh; display: flex; align-items: center; justify-content: center; }
.lightbox-img-wrap img { max-width: 100%; max-height: 80vh; object-fit: contain; }
.lightbox-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.lightbox-nav { width: 40px; height: 40px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.lightbox-nav:active { background: rgba(56,189,248,0.3); border-color: #38bdf8; }
.lightbox-counter { color: #94a3b8; font-size: 14px; min-width: 48px; text-align: center; }
.lightbox-del { padding: 8px 18px; background: rgba(239,68,68,0.7); border: 1px solid #ef4444; color: #fff; border-radius: 20px; font-size: 14px; cursor: pointer; margin-left: auto; }
.lightbox-del:active { background: rgba(239,68,68,0.9); }
.prop-input { width: 100%; background: #020617; border: 1px solid #334145; color: #38bdf8; padding: 4px 8px; border-radius: 4px; font-size: 13px; outline: none; }
.prop-input:focus { border-color: #38bdf8; }
.has-error .prop-input { border-color: #ef4444; }
.prop-val-inner { position: relative; }
.field-error-tip { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: #ef4444; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; z-index: 10; animation: fadeIn 0.2s; pointer-events: none; }
.field-success-tip { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: rgba(16,185,129,0.18); color: #10b981; font-size: 10px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; z-index: 9; animation: fadeIn 0.2s; pointer-events: none; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
.panel-footer { padding: 15px 20px; border-top: 1px solid #334155; }
.action-btn { width: 100%; padding: 10px; background: #38bdf811; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; transition: all 0.2s; }
.action-btn:hover { background: #38bdf8; color: #000; }
.custom-scrollbar::-webkit-scrollbar { width: 8px; }
.custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
.custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #38bdf8; }
.slide-right-enter-active, .slide-right-leave-active { transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.slide-right-enter-from, .slide-right-leave-to { transform: translateX(110%); opacity: 0; }

.action-btn.edit-spatial { background: #10b98122; border-color: #10b981; color: #10b981; }
.action-btn.edit-spatial:hover { background: #10b981; color: #fff; }
.action-btn.edit-spatial.active { background: #ef4444; border-color: #ef4444; color: #fff; }

.action-btn.delete-feature { 
  background: rgba(239, 68, 68, 0.1); 
  border-color: #ef4444; 
  color: #ef4444; 
}
.action-btn.delete-feature:hover { 
  background: #ef4444; 
  color: #fff; 
}

.prop-input.readonly {
  background: rgba(255, 255, 255, 0.05);
  color: #94a3b8; 
  cursor: not-allowed;
  border: 1px dashed #475569; 
}
</style>
.del-field-btn { background: none; border: none; color: #ef4444; font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; opacity: 0.6; }
.del-field-btn:hover { opacity: 1; }
.prop-key { display: flex; align-items: center; justify-content: space-between; }
.add-field-row { display: flex; gap: 8px; margin-top: 12px; }
.field-key-input { flex: 1; background: #020617; border: 1px solid #475569; color: #38bdf8; padding: 6px 10px; border-radius: 4px; font-size: 12px; outline: none; }
.field-key-input:focus { border-color: #38bdf8; }
.action-btn.add-field { width: auto; padding: 6px 14px; font-size: 12px; white-space: nowrap; }

<style scoped>
.prop-val-inner { display: flex; align-items: center; gap: 4px; }
.prop-val-inner .prop-input, .prop-val-inner .prop-text { flex: 1; min-width: 0; }
.del-field-btn { flex-shrink: 0; background: none; border: none; color: #ef4444; font-size: 11px; cursor: pointer; padding: 0 2px; line-height: 1; opacity: 0.4; width: 12px; text-align: center; }
.del-field-btn:hover { opacity: 1; }
.prop-key { display: flex; align-items: center; justify-content: space-between; }
.add-field-row { display: flex; gap: 6px; margin-bottom: 10px; flex-shrink: 0; }
.field-key-input { flex: 1; background: #020617; border: 1px solid #475569; color: #38bdf8; padding: 4px 8px; border-radius: 4px; font-size: 11px; outline: none; }
.field-key-input:focus { border-color: #38bdf8; }
.action-btn.add-field { width: auto; padding: 4px 10px; font-size: 11px; white-space: nowrap; }
</style>
<style scoped>
.lock-notice { background: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444; padding: 8px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 10px; text-align: center; }
</style>
<style>
/* 照片备注确认面板（Teleport to body，必须非 scoped） */
.note-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 100000; display: flex; align-items: center; justify-content: center; }
.note-panel { background: #1e293b; border: 1px solid #38bdf8; border-radius: 12px; padding: 24px; max-width: 420px; width: 90vw; text-align: center; }
.note-img { max-width: 100%; max-height: 35vh; border-radius: 8px; margin-bottom: 14px; object-fit: contain; }
.note-input { width: 100%; box-sizing: border-box; padding: 10px 14px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; font-size: 14px; outline: none; }
.note-input:focus { border-color: #38bdf8; }
.note-btns { display: flex; gap: 10px; margin-top: 12px; }
.note-ok { flex: 1; padding: 10px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 6px; color: #fff; font-size: 14px; font-weight: bold; cursor: pointer; }
.note-ok:hover { background: #0284c7; }
.note-cancel { flex: 1; padding: 10px; background: transparent; border: 1px solid #475569; border-radius: 6px; color: #94a3b8; font-size: 14px; cursor: pointer; }
/* lightbox 备注区域 */
.lightbox-note { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgba(0,0,0,0.6); border-top: 1px solid rgba(255,255,255,0.08); max-width: 90vw; margin: 0 auto; }
.lightbox-note-text { flex: 1; color: #94a3b8; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lightbox-note-input { flex: 1; padding: 5px 10px; background: #0f172a; border: 1px solid #38bdf8; border-radius: 4px; color: #e2e8f0; font-size: 13px; outline: none; min-width: 0; }
.lightbox-note-btn { flex-shrink: 0; padding: 4px 10px; background: rgba(56,189,248,0.12); border: 1px solid #38bdf8; border-radius: 4px; color: #38bdf8; font-size: 12px; cursor: pointer; white-space: nowrap; }
.lightbox-note-btn:hover { background: rgba(56,189,248,0.25); }
.lightbox-note-save { flex-shrink: 0; padding: 5px 10px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 4px; color: #fff; font-size: 13px; cursor: pointer; }
.lightbox-note-save:hover { background: #0284c7; }
.lightbox-note-cancel { flex-shrink: 0; padding: 5px 10px; background: transparent; border: 1px solid #475569; border-radius: 4px; color: #94a3b8; font-size: 13px; cursor: pointer; }
</style>
<style>
.date-editor-backdrop { position: fixed; inset: 0; z-index: 100005; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.25); }
.dr-dialog { background: #0f172a; border: 1px solid #334155; border-radius: 12px; width: 340px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.dr-header { padding: 14px 20px 0; font-size: 14px; color: #94a3b8; }
.dr-body { padding: 16px 20px; }
.dr-input { width: 100%; max-width: 100%; box-sizing: border-box; padding: 8px 10px; background: #020617; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; font-size: 15px; outline: none; color-scheme: dark; }
.dr-input:focus { border-color: #38bdf8; }
.dr-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid #1e293b; }
.dr-actions .action-btn { padding: 6px 16px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none; }
.dr-actions .action-btn.secondary { background: #334155; color: #94a3b8; }
.dr-actions .action-btn:not(.secondary) { background: #38bdf8; color: #000; }
</style>
