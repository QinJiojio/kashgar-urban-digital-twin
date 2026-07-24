<template>
  <div class="mobile-layout">
    <!-- 加载中 -->
    <div v-if="!mapState.system.isViewerReady || mapState.layerTree.length === 0" class="loading-overlay">
      <div class="loading-spinner"></div>
      <p>地图数据加载中...</p>
    </div>

    <!-- 全屏 Cesium 地图 -->
    <div id="cesiumContainer"></div>

    <!-- Toast 提示（Teleport 到 body 避免被 .mobile-layout 的 stacking context 困住） -->
    <Teleport to="body">
      <div v-if="mapState.ui.toast" class="mobile-toast" :class="mapState.ui.toast.type">{{ mapState.ui.toast.message }}</div>
    </Teleport>

    <!-- GPS 浮钮：面板打开时隐藏，不悬浮在面板上方 -->
    <Teleport to="body">
      <div v-if="!activePanel" class="fab gps-fab" :class="{ active: gpsActive }" @click.stop="toggleMobileGPS" :title="gpsActive ? 'GPS 已开启 (点击关闭)' : 'GPS 定位 (点击开启)'">
        🧭
      </div>
      <div v-if="!activePanel" class="fab edit-fab" :class="{ active: mapState.editor.isEditing }" @click.stop="toggleMobileEdit" :title="mapState.editor.isEditing ? '退出编辑模式' : '开启编辑模式'">
        {{ mapState.editor.isEditing ? '✏️' : '🛠️' }}
      </div>
      <div v-if="pointPlaceMode && !activePanel" class="fab draw-fab draw-done" @click.stop="finishPointMode" title="完成新增">✓</div>
      <div v-if="!activePanel && mapState.editor.isEditing" class="fab draw-fab draw-point" :class="{ active: activeDrawType === 'point' }" @click.stop="startDrawFromFab('point')" title="新增点要素">📍</div>
      <div v-if="!activePanel && mapState.editor.isEditing" class="fab draw-fab draw-line" :class="{ active: activeDrawType === 'polyline' }" @click.stop="startDrawFromFab('polyline')" title="新增线要素">〰️</div>
      <div v-if="!activePanel && mapState.editor.isEditing" class="fab draw-fab draw-poly" :class="{ active: activeDrawType === 'polygon' }" @click.stop="startDrawFromFab('polygon')" title="新增面要素">⬟</div>
      <div v-if="!activePanel" class="fab nav-fab view2d3d" @click.stop="toggle2D3D" :title="isMobile2D ? '切换 3D 视角' : '切换 2D 视角'">{{ isMobile2D ? '3D' : '2D' }}</div>
      <div v-if="!activePanel" class="fab nav-fab home" @click.stop="zoomToHome" title="缩放到所有要素">⌂</div>
    </Teleport>

    <!-- 顶部信息栏 -->
    <div v-if="!activePanel" class="top-bar">
      <div class="top-bar-title">喀什市城市体检更新平台</div>
      <div class="top-bar-sub">
        <span class="top-bar-layer"><span v-if="mapState.editor.isEditing" class="edit-dot"></span>当前工作图层：<span class="layer-name-link" @click.stop="pendingDrawType = null; showLayerPicker = true">{{ workingLayerName || '点击选择' }}</span></span>
        <span class="top-bar-user">👤 {{ currentUser }} <span class="logout-btn" @click.stop="showLogoutConfirm = true">退出</span></span>
      </div>
    </div>

    <!-- 十字准星覆盖层 (点放置 / 顶点放置 / 点移动 共用) -->
    <div v-if="crosshairMode" class="crosshair-overlay">
      <div class="crosshair-icon" :class="{ 'move-mode': moveMode }">{{ moveMode ? '⌖' : '⊕' }}</div>
      <div class="crosshair-hint">{{ crosshairHint }}</div>
      <div class="crosshair-actions">
        <button @click.stop="confirmCrosshair" class="fs-btn primary">✅ 确认位置</button>
        <button v-if="pointPlaceMode" @click.stop="locateToGPS" class="fs-btn">🧭 GPS定位</button>
        <button @click.stop="cancelCrosshair" class="fs-btn">取消</button>
      </div>
    </div>

    <!-- 线/面绘制工具栏 -->
    <div v-if="editState === 'drawing'" class="draw-toolbar">
      <button class="dt-btn undo" @click="undoPoint">↩ 撤销</button>
      <button class="dt-btn finish" @click="finishDraw">✅ 完成</button>
      <button class="dt-btn cancel" @click="cancelDraw">❌ 取消</button>
    </div>

    <div v-if="opHint" class="op-hint-bar">{{ opHint }}</div>

    <!-- 全屏面板覆盖 -->
    <div v-if="activePanel" class="panel-overlay">
      <div class="panel-header">
        <span class="panel-title">{{ panelTitle }}</span>
        <button class="panel-close" @click="closePanel">✕</button>
      </div>
      <div class="panel-body">
        <keep-alive>
          <SearchPanel v-if="activePanel === 'search'" @close="closePanel" />
        </keep-alive>
        <DataTablePanel v-if="activePanel === 'table'" />
        <MobileLayerPanel v-if="activePanel === 'layers'" @edit-schema="openSchemaEditor" @close="closePanel" />
        <MobileSchemaEditor
          v-if="activePanel === 'schema'"
          :layerId="schemaLayerId"
          @close="activePanel = 'layers'"
        />
        <MobileEditPanel
          v-if="activePanel === 'edit'"
          @draw-state="onDrawState"
          @close="closePanel"
        />
      </div>
    </div>

    <!-- 底部 Tab Bar -->
    <Teleport to="body">
    <div v-if="featurePanel && (!crosshairMode || pointPlaceMode)" class="feature-sheet" @click.stop>
      <div class="fs-header">
        <span class="fs-title">{{ featurePanel.layerName }} - {{ featurePanel.name || '要素 #' + featurePanel.objId }}</span>
        <button @click="closeFeaturePanel" class="fs-close">✕</button>
      </div>
      <div v-if="lockedByOtherMobile" class="fs-lock-notice">✏️ {{ lockedByOtherMobile }} 正在编辑要素几何形态</div>
      <div class="fs-body">
        <template v-for="group in fpGroups" :key="group.key">
          <div class="fs-group-hdr" @click="toggleFpGroup(group.key)">
            <span class="fs-group-toggle">{{ fpCollapsed.has(group.key) ? '▶' : '▼' }}</span>
            {{ group.label }}
            <span v-if="getHeaderBoolKey(group)" class="fs-group-hdr-check">
              <label v-if="featurePanel.editing" class="fs-check" @click.stop>
                <input type="checkbox" :checked="featurePanel.props[getHeaderBoolKey(group)] === 'True'" @change="e => { const k = getHeaderBoolKey(group); focusedField = { key: k, original: featurePanel.props[k] }; featurePanel.props[k] = e.target.checked ? 'True' : 'False'; saveFieldBlur(k); }" />
              </label>
              <span v-else class="fs-val" @click.stop><input type="checkbox" :checked="featurePanel.props[getHeaderBoolKey(group)] === 'True'" disabled /></span>
              <span v-if="fieldErrors[getHeaderBoolKey(group)]" class="fs-error-tip">{{ fieldErrors[getHeaderBoolKey(group)] }}</span>
            </span>
          </div>
          <!-- 折叠时：仅非 merged 且无 parentField 的组显示首子字段预览 -->
          <template v-if="fpCollapsed.has(group.key)">
            <div v-if="!group.parentField && !getHeaderBoolKey(group) && group.children.length > 0" class="fs-row" :key="group.children[0].key">
              <span class="fs-key">{{ group.children[0].key }}</span>
              <span v-if="group.children[0].config?.format === 'boolean'" class="fs-val"><input type="checkbox" :checked="featurePanel.props[group.children[0].key] === 'True'" disabled /></span>
              <span v-else class="fs-val">{{ group.children[0].config?.format === 'image' ? '🖼 ' + parsePhotos(featurePanel.props[group.children[0].key]).length + '张' : (featurePanel.props[group.children[0].key] || '--') }}</span>
            </div>
          </template>
          <!-- 展开时：父字段已在标题行展示则跳过 -->
          <template v-else>
            <div v-if="group.parentField && !getHeaderBoolKey(group)" class="fs-row">
              <span class="fs-key">{{ group.parentField }}</span>
              <label v-if="featurePanel.editing && group.config?.format === 'boolean'" class="fs-check">
                <input type="checkbox" :checked="featurePanel.props[group.parentField] === 'True'" @change="e => { focusedField = { key: group.parentField, original: featurePanel.props[group.parentField] }; featurePanel.props[group.parentField] = e.target.checked ? 'True' : 'False'; saveFieldBlur(group.parentField); }" />
              </label>
              <template v-else-if="featurePanel.editing && group.config?.format === 'select'">
                <div v-if="isSelectCustom(featurePanel.props[group.parentField], group.config?.options)" style="display:flex;gap:4px;">
                  <select :value="selectDisplayVal(featurePanel.props[group.parentField], group.config?.options)" class="fs-input"
                    @change="onMobileSelectPick(group.parentField, $event.target.value, group.config?.options)"
                    @focus="handleFocusMobile(group.parentField)" style="flex:1;">
                    <option v-for="opt in (group.config?.options || [])" :key="opt" :value="opt">{{ opt }}</option>
                    <option value="__other__">其他</option>
                  </select>
                  <input type="text"
                    :value="getCustomPart(featurePanel.props[group.parentField])"
                    @input="e => { featurePanel.props[group.parentField] = '其他: ' + (e.target.value || ''); }"
                    @focus="handleFocusMobile(group.parentField)" @blur="saveFieldBlur(group.parentField)" class="fs-input"
                    :class="{ 'has-error': fieldErrors[group.parentField] }" placeholder="自定义" style="flex:1.5;" />
                </div>
                <select v-else :value="selectDisplayVal(featurePanel.props[group.parentField], group.config?.options)" class="fs-input"
                  @change="onMobileSelectPick(group.parentField, $event.target.value, group.config?.options)"
                  @focus="handleFocusMobile(group.parentField)">
                  <option v-for="opt in (group.config?.options || [])" :key="opt" :value="opt">{{ opt }}</option>
                  <option value="__other__">其他</option>
                </select>
              </template>
              <input v-else-if="featurePanel.editing && group.config?.format === 'date'" type="date" min="1900-01-01" max="2099-12-31" v-model="featurePanel.props[group.parentField]" class="fs-input" :class="{ 'has-error': fieldErrors[group.parentField] }" @blur="saveFieldBlur(group.parentField)" @focus="handleFocusMobile(group.parentField)" />
              <input v-else-if="featurePanel.editing && group.config?.format === 'daterange'" v-model="featurePanel.props[group.parentField]" class="fs-input" :class="{ 'has-error': fieldErrors[group.parentField] }" @blur="saveFieldBlur(group.parentField)" @focus="handleFocusMobile(group.parentField)" placeholder="开始 ~ 结束" />
              <input v-else-if="featurePanel.editing" v-model="featurePanel.props[group.parentField]" class="fs-input" :class="{ 'has-error': fieldErrors[group.parentField] }" @blur="saveFieldBlur(group.parentField)" @focus="handleFocusMobile(group.parentField)" />
              <span v-else class="fs-val">{{ featurePanel.props[group.parentField] }}</span>
            </div>
            <div v-for="field in group.children.filter(f => f.key !== group.parentField && f.key !== getHeaderBoolKey(group))" :key="field.key" class="fs-row">
              <span class="fs-key">{{ field.key }}</span>
              <template v-if="field.config?.format === 'image'">
                <span class="fs-val">
                  <span class="fs-images">
                    <span v-for="(p, i) in parsePhotos(featurePanel.props[field.key])" :key="i" class="fs-img-wrap" :title="p.n || ''">
                      <img :src="safeThumbUrl(p.u)" @error="e => { markThumbFailed(p.u); e.target.onerror = null; }" @click.stop="viewPhoto(p.u, parsePhotos(featurePanel.props[field.key]), i, field.key)" class="fs-thumb" />
                      <button v-if="featurePanel.editing" @click.stop="removeMobilePhoto(field.key, p.u, i)" class="fs-img-del">×</button>
                    </span>
                    <span v-for="(st, sk) in uploadState" :key="sk">
                      <span v-if="st.fieldKey === field.key && st.featureId === currentFeatureId" class="fs-thumb fs-thumb-prog">
                        <template v-if="st.status === 'done'">✓</template>
                        <template v-else-if="st.status === 'error'">✗</template>
                        <template v-else>{{ st.progress }}%</template>
                      </span>
                    </span>
                    <span v-if="!featurePanel.props[field.key] && !hasUploading(field.key)" class="fs-empty">--</span>
                  </span>
                  <button v-if="featurePanel.editing" @click="uploadMobilePhoto(field.key)" class="fs-upload">📷 拍照/选图</button>
                  <label v-if="featurePanel.editing" class="fs-keep"><input type="checkbox" v-model="keepOriginalMobile" /> 保留原图</label>
                </span>
              </template>
              <template v-else>
                <label v-if="featurePanel.editing && field.config?.format === 'boolean'" class="fs-check">
                  <input type="checkbox" :checked="featurePanel.props[field.key] === 'True'" @change="e => { focusedField = { key: field.key, original: featurePanel.props[field.key] }; featurePanel.props[field.key] = e.target.checked ? 'True' : 'False'; saveFieldBlur(field.key); }" />
                </label>
                <template v-else-if="featurePanel.editing && field.config?.format === 'select'">
                  <div v-if="isSelectCustom(featurePanel.props[field.key], field.config?.options)" style="display:flex;gap:4px;">
                    <select :value="selectDisplayVal(featurePanel.props[field.key], field.config?.options)" class="fs-input"
                      @change="onMobileSelectPick(field.key, $event.target.value, field.config?.options)"
                      @focus="handleFocusMobile(field.key)" style="flex:1;">
                      <option v-for="opt in (field.config?.options || [])" :key="opt" :value="opt">{{ opt }}</option>
                      <option value="__other__">其他</option>
                    </select>
                    <input type="text"
                      :value="getCustomPart(featurePanel.props[field.key])"
                      @input="e => { featurePanel.props[field.key] = '其他: ' + (e.target.value || ''); }"
                      @focus="handleFocusMobile(field.key)" @blur="saveFieldBlur(field.key)" class="fs-input"
                      :class="{ 'has-error': fieldErrors[field.key] }" placeholder="自定义" style="flex:1.5;" />
                  </div>
                  <select v-else :value="selectDisplayVal(featurePanel.props[field.key], field.config?.options)" class="fs-input"
                    @change="onMobileSelectPick(field.key, $event.target.value, field.config?.options)"
                    @focus="handleFocusMobile(field.key)">
                    <option v-for="opt in (field.config?.options || [])" :key="opt" :value="opt">{{ opt }}</option>
                    <option value="__other__">其他</option>
                  </select>
                </template>
                <input v-else-if="featurePanel.editing && field.config?.format === 'date'" type="date" min="1900-01-01" max="2099-12-31" v-model="featurePanel.props[field.key]" class="fs-input" :class="{ 'has-error': fieldErrors[field.key] }" @blur="saveFieldBlur(field.key)" @focus="handleFocusMobile(field.key)" />
                <input v-else-if="featurePanel.editing && field.config?.format === 'daterange'" v-model="featurePanel.props[field.key]" class="fs-input" :class="{ 'has-error': fieldErrors[field.key] }" @blur="saveFieldBlur(field.key)" @focus="handleFocusMobile(field.key)" placeholder="开始 ~ 结束" />
                <input v-else-if="featurePanel.editing" v-model="featurePanel.props[field.key]" class="fs-input" :class="{ 'has-error': fieldErrors[field.key] }" @blur="saveFieldBlur(field.key)" @focus="handleFocusMobile(field.key)" />
                <span v-if="fieldErrors[field.key]" class="fs-error-tip">{{ fieldErrors[field.key] }}</span>
                <span v-if="fieldSuccess[field.key]" class="fs-success-tip">已保存</span>
                <span v-else-if="!featurePanel.editing && field.config?.format === 'boolean'" class="fs-val"><input type="checkbox" :checked="featurePanel.props[field.key] === 'True'" disabled /></span>
                <span v-else-if="!featurePanel.editing" class="fs-val">{{ featurePanel.props[field.key] }}</span>
              </template>
            </div>
          </template>
        </template>
      </div>
      <div class="fs-actions">
        <template v-if="!featurePanel.editing">
          <button @click="startEditProps" class="fs-btn primary">✏️ 编辑属性</button>
        </template>
        <template v-else>
          <button @click="saveAndClose" class="fs-btn primary">💾 保存</button>
          <button v-if="featurePanel.geomType === 'point'" @click="startMovePoint" class="fs-btn">📍 移动点位</button>
          <button v-else @click="editVertices" class="fs-btn">📐 控制点编辑</button>
          <button @click="deleteFeature" class="fs-btn del" :class="{ confirm: deletePending?.objId === String(featurePanel.objId) }">{{ deletePending?.objId === String(featurePanel.objId) ? '⚠️ 确认删除' : '🗑️ 删除' }}</button>
        </template>
      </div>
    </div>
    </Teleport>

    <!-- 图层选择弹窗 -->
    <Teleport to="body">
      <div v-if="showLayerPicker" class="layer-picker-mask" @click.self="closeLayerPicker">
        <div class="layer-picker-box">
          <div class="picker-title">{{ layerPickerTitle }}</div>
          <div class="picker-list">
            <template v-for="item in pickerItems" :key="item.id">
              <div class="picker-item" :class="{ folder: item.type === 'folder', collapsed: item.collapsed }" :style="{ paddingLeft: 12 + item.depth * 16 + 'px' }" @click="item.type === 'folder' ? togglePickerFolder(item) : pickLayer(item.id)">
                <span class="picker-eye" :class="{ off: !item.show }" @click.stop="togglePickerLayer(item)" :title="item.show ? '隐藏' : '显示'">👁</span>
                <span v-if="item.type === 'folder'" class="picker-folder-toggle">{{ item.collapsed ? '▶' : '▼' }}</span>
                <span class="picker-icon">{{ item.type === 'folder' ? '📁' : (item.geometryType === 'point' ? '📍' : (item.geometryType === 'polyline' ? '〰️' : '⬟')) }}</span>
                {{ item.name }}
              </div>
            </template>
            <div v-if="pickerItems.length === 0" class="picker-empty">没有可用的图层</div>
          </div>
          <button class="picker-cancel" @click="closeLayerPicker">取消</button>
        </div>
      </div>
    </Teleport>

    <!-- 照片备注确认面板（移动端底部 Sheet） -->
    <Teleport to="body">
      <div v-if="photoConfirm.visible" class="note-mask" @click.self="cancelPhotoConfirm">
        <div class="note-panel-m">
          <img :src="photoConfirm.preview" class="note-img-m" />
          <input v-model="photoConfirm.note" placeholder="添加备注说明（可选）" class="note-input-m" @keyup.enter="confirmMobilePhoto" />
          <div class="note-btns">
            <button @click="confirmMobilePhoto" class="note-ok-m">确认上传</button>
            <button @click="cancelPhotoConfirm" class="note-cancel-m">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 退出登录确认弹窗 -->
    <Teleport to="body">
      <div v-if="showLogoutConfirm" class="confirm-mask" @click.self="showLogoutConfirm = false">
        <div class="confirm-dialog">
          <p class="confirm-text">确定要退出登录吗？</p>
          <div class="confirm-actions">
            <button class="confirm-btn cancel" @click="showLogoutConfirm = false">取消</button>
            <button class="confirm-btn ok" @click="handleLogout">确认退出</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 照片查看器 lightbox -->
    <Teleport to="body">
      <div v-if="lightbox.visible" class="lightbox-mask" @touchstart="onTouchStart" @touchend="onTouchEnd">
        <button class="lightbox-close" @click.stop="closeLightbox">✕</button>
        <div class="lightbox-img-wrap" @click.stop>
          <img v-for="(url, i) in lightbox.urls" :key="i" :src="url" :style="{ display: i === lightbox.index ? 'block' : 'none' }" />
        </div>
        <div class="lightbox-bar" @click.stop>
          <button v-if="lightbox.urls.length > 1" class="lightbox-nav" @click.stop="lightboxNav(-1)">◀</button>
          <span class="lightbox-counter">{{ lightbox.index + 1 }} / {{ lightbox.urls.length }}</span>
          <button v-if="lightbox.urls.length > 1" class="lightbox-nav" @click.stop="lightboxNav(1)">▶</button>
          <button v-if="featurePanel?.editing" class="lightbox-del" @click.stop="deleteCurrentPhoto">🗑️ 删除</button>
        </div>
        <div class="lightbox-note" @click.stop>
          <template v-if="editingLightboxNote">
            <input v-model="lightboxNoteDraft" class="lightbox-note-input" placeholder="输入备注说明" @keyup.enter="saveLightboxNote" @keyup.escape="cancelEditLightboxNote" />
            <button @click="saveLightboxNote" class="lightbox-note-save">✓</button>
            <button @click="cancelEditLightboxNote" class="lightbox-note-cancel">✕</button>
          </template>
          <template v-else>
            <span v-if="currentPhotoNote" class="lightbox-note-text" :title="currentPhotoNote">{{ currentPhotoNote }}</span>
            <button v-if="featurePanel?.editing" @click="startEditLightboxNote" class="lightbox-note-btn">{{ currentPhotoNote ? '✏️' : '➕ 添加备注' }}</button>
          </template>
        </div>
      </div>
    </Teleport>

    <div class="bottom-bar">
      <div class="tab" :class="{ active: activePanel === 'layers' }" @click="togglePanel('layers')">
        <span class="tab-icon">🗺️</span><span class="tab-label">图层</span>
      </div>
      <div class="tab" :class="{ active: activePanel === 'edit' }" @click="togglePanel('edit')">
        <span class="tab-icon">✏️</span><span class="tab-label">编辑</span>
      </div>
      <div class="tab" :class="{ active: activePanel === 'search' }" @click="togglePanel('search')">
        <span class="tab-icon">🔎</span><span class="tab-label">搜索</span>
      </div>
      <div class="tab" :class="{ active: activePanel === 'table' }" @click="togglePanel('table')">
        <span class="tab-icon">🗄️</span><span class="tab-label">表格</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, reactive, onBeforeUnmount, nextTick } from 'vue';
import * as Cesium from 'cesium';
import { mapState, getLayerState, getFlatLayers, showToast, hideToast, fieldSchema, fieldGroupsMeta, getThumbUrl, safeThumbUrl, markThumbFailed, parsePhotos } from '../../store/mapState';
import { getViewer, zoomToPoint } from '../../core/viewer/ViewerSetup';
import { drawEngine } from '../../core/viewer/DrawEngine';
import { compressImage } from '../../core/imageUtils';
import { spatialEditor } from '../../core/viewer/SpatialEditor';
import { getLayer } from '../../core/layers/LayerManager';
import { startTracking, stopTracking, flyToUser } from '../../core/GeolocationTracker';
import { saveFeature } from '../../core/saveFeature';
import { checkLayerStale, checkTreeStale, acquireFeatureLock, releaseFeatureLock, releaseAllMyLocks, fetchLayerLocks } from '../../core/locks';
import { parseFieldGroups, getHeaderBoolKey } from '../../core/fieldGroups';
import { validateFieldValue, isSelectCustom, getCustomPart, selectDisplayVal } from '../../core/fieldValidation';
import SearchPanel from '../search/SearchPanel.vue';
import DataTablePanel from '../layer-control/DataTablePanel.vue';
import MobileLayerPanel from '../mobile/MobileLayerPanel.vue';
import MobileSchemaEditor from '../mobile/MobileSchemaEditor.vue';
import MobileEditPanel from '../mobile/MobileEditPanel.vue';

const activePanel = ref(null);
const gpsActive = ref(false);
const featurePanel = ref(null);
const fieldErrors = reactive({});
const fieldSuccess = reactive({});
const _dirtyFields = new Map(); // 脏字段追踪：key→original值，防多字段编辑时reload冲掉其他字段的修改
const lockedByOtherMobile = ref('');
const moveMode = ref(false);
const pointPlaceMode = ref(false);
const keepOriginalMobile = ref(false);
// 照片备注确认面板
const photoConfirm = reactive({ visible: false, preview: '', note: '', fieldKey: '', file: null });
const cancelPhotoConfirm = () => { photoConfirm.visible = false; photoConfirm.file = null; };
const isMobile2D = ref(true);

const opHint = computed(() => {
  if (pointPlaceMode.value) return '拖拽地图瞄准位置 · 点击 ✓ 确认';
  if (editState.value === 'drawing') return '点击放置顶点 · 拖动调整 · ✓ 完成 · ↩ 撤销';
  if (moveMode.value) return '拖动地图调整位置 · 点击确认';
  if (mapState.editor.activeTool === 'vertex') return '拖动绿点移动 · 长按绿点删除 · 点击黄点新增 · 点击空白完成';
  return '';
});

const crosshairMode = computed(() => moveMode.value || pointPlaceMode.value);
const crosshairHint = computed(() => {
  if (pointPlaceMode.value) return '拖拽地图，将十字准星对准目标位置';
  return '拖拽地图调整位置，将十字准星对准目标';
});

const schemaLayerId = ref('');
const editState = ref('idle');
const activeDrawGeom = ref(null); // 当前活跃的绘制类型（响应式）

const activeDrawType = computed(() => {
  if (pendingDrawType.value) return pendingDrawType.value; // 已点FAB但尚未选图层
  return activeDrawGeom.value;
});

// 追踪绘制状态变化（drawEngine.isDrawing 非响应式，需手动同步）
watch(editState, (val) => {
  if (val === 'drawing') activeDrawGeom.value = drawEngine.activeGeometryType || null;
  else if (val === 'idle') activeDrawGeom.value = null;
});
watch(pointPlaceMode, (val) => {
  activeDrawGeom.value = val ? 'point' : null;
});
const showLayerPicker = ref(false);
const uploadState = ref({}); // { [key]: { featureId, fieldKey, status, progress } }
const currentFeatureId = computed(() => {
  if (!featurePanel.value) return '';
  return featurePanel.value.layerId + '_' + featurePanel.value.objId;
});

const hasUploading = (fieldKey) => {
  const fid = currentFeatureId.value;
  return Object.values(uploadState.value).some(s => s.featureId === fid && s.fieldKey === fieldKey);
};
const pendingDrawType = ref(null); // 用户选择图层后要触发的绘制类型

const layerPickerTitle = computed(() => {
  if (pendingDrawType.value) {
    const label = pendingDrawType.value === 'point' ? '点' : (pendingDrawType.value === 'polyline' ? '折线' : '面');
    return `选择${label}要素图层`;
  }
  return '选择工作图层';
});
const pickerCollapsed = ref(new Set());

const togglePickerFolder = (item) => {
  if (pickerCollapsed.value.has(item.id)) {
    pickerCollapsed.value.delete(item.id);
  } else {
    pickerCollapsed.value.add(item.id);
  }
  pickerCollapsed.value = new Set(pickerCollapsed.value);
};

const pickerItems = computed(() => {
  const filterType = pendingDrawType.value || null;
  const result = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (node.type === 'folder') {
        result.push({
          id: node.id, name: node.name, type: 'folder', show: node.show, depth,
          collapsed: pickerCollapsed.value.has(node.id)
        });
        if (!pickerCollapsed.value.has(node.id) && node.children) {
          walk(node.children, depth + 1);
        }
      } else if (node.type === 'geojson') {
        if (!filterType || node.geometryType === filterType) {
          result.push({
            id: node.id, name: node.name, type: 'geojson',
            geometryType: node.geometryType, show: node.show, depth
          });
        }
      }
    }
  };
  walk(mapState.layerTree, 0);
  return result;
});

const closeLayerPicker = () => {
  showLayerPicker.value = false;
  pendingDrawType.value = null;
};

const findTreeNode = (nodes, id) => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder' && n.children) {
      const r = findTreeNode(n.children, id);
      if (r) return r;
    }
  }
  return null;
};

const findHiddenParents = (nodes, targetId, path = []) => {
  for (const n of nodes) {
    if (n.id === targetId) return path;
    if (n.type === 'folder' && n.children) {
      const r = findHiddenParents(n.children, targetId, [...path, n]);
      if (r) return r;
    }
  }
  return null;
};

const togglePickerLayer = async (l) => {
  const node = findTreeNode(mapState.layerTree, l.id);
  if (!node) return;
  const newShow = !node.show;
  const { toggleLayerVisibility } = await import('../../core/layers/LayerManager');
  if (newShow) {
    const hiddenParents = findHiddenParents(mapState.layerTree, l.id);
    if (hiddenParents) {
      for (const p of hiddenParents) {
        if (!p.show) { p.show = true; await toggleLayerVisibility(p.id, true); }
      }
    }
  }
  node.show = newShow;
  await toggleLayerVisibility(node.id, newShow);
};

const fpCollapsed = ref(new Set());
const toggleFpGroup = (gk) => {
  if (fpCollapsed.value.has(gk)) fpCollapsed.value.delete(gk);
  else fpCollapsed.value.add(gk);
  fpCollapsed.value = new Set(fpCollapsed.value);
};

const viewPhoto = (url, photos, idx, fieldKey) => {
  const urls = photos.map(p => p.u);
  lightbox.value = { visible: true, urls, photos, index: idx >= 0 ? idx : 0, fieldKey: fieldKey || '' };
};
const closeLightbox = () => { lightbox.value.visible = false; };
const lightboxNav = (dir) => {
  const n = lightbox.value.urls.length;
  lightbox.value.index = (lightbox.value.index + dir + n) % n;
};
const lightbox = ref({ visible: false, urls: [], photos: [], index: 0, fieldKey: '' });

// 触屏滑动
let touchStartX = 0;
const onTouchStart = (e) => { touchStartX = e.touches[0].clientX; };
const onTouchEnd = (e) => {
  const delta = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(delta) > 50) { lightboxNav(delta > 0 ? -1 : 1); return; }
  // 仅当点击在 mask 背景上时关闭（按钮由各自的 @click.stop 处理）
  if (e.target.classList.contains('lightbox-mask')) closeLightbox();
};

const deleteCurrentPhoto = async () => {
  const lb = lightbox.value;
  const photo = lb.photos[lb.index];
  if (!photo || !lb.fieldKey || !featurePanel.value) return;
  const fp = featurePanel.value;
  const existing = parsePhotos(fp.props[lb.fieldKey]);
  const idx = existing.findIndex(p => p.u === photo.u);
  if (idx >= 0) existing.splice(idx, 1);
  fp.props[lb.fieldKey] = JSON.stringify(existing);
  lb.urls.splice(lb.index, 1);
  lb.photos.splice(lb.index, 1);
  if (lb.urls.length === 0) { closeLightbox(); } else if (lb.index >= lb.urls.length) { lb.index = lb.urls.length - 1; }
  // 后端删除文件
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
  fetch(apiBase + '/api/upload/photo/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ url: photo.u })
  }).catch(() => { showToast('照片删除失败', 'error'); });
  // 持久化保存
  if (savingFieldMobile) return;
  savingFieldMobile = true;
  try {
    const { saveFeature } = await import('../../core/saveFeature');
    const result = await saveFeature(fp.layerId, String(fp.objId));
    if (result?.conflict) {
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(fp.layerId);
      showToast('数据已被他人修改，已刷新', 'warning', 2500);
    }
  } finally {
    savingFieldMobile = false;
  }
};

// ---- lightbox 备注编辑（移动端） ----
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
  const fp = featurePanel.value;

  if (!lb.fieldKey || !lb.photos[lb.index] || !fp) {
    editingLightboxNote.value = false;
    return;
  }
  if (savingFieldMobile) { showToast('请等待上次保存完成', 'warning'); return; }

  // 1. 版本冲突预检
  const { checkLayerConflict } = await import('../../core/locks');
  const conflict = await checkLayerConflict(fp.layerId, String(fp.objId));
  if (conflict.stale) {
    editingLightboxNote.value = false;
    showToast('数据已被他人修改，请关闭大图后重试', 'warning', 3000);
    return;
  }

  // 2. 更新内存状态 + 直接同步 entity（用 OBJECTID 查找，与 saveFeature 保持一致）
  lb.photos[lb.index].n = note;
  const newVal = JSON.stringify(lb.photos);
  fp.props[lb.fieldKey] = newVal;
  // 直接更新 entity（避免 handleDataChange 按 Cesium ID 查找与 saveFeature 按 OBJECTID 查找不一致）
  const viewer = getViewer();
  const ds = getLayer(fp.layerId);
  const candidates = ds ? ds.entities.values : (viewer ? viewer.entities.values : []);
  for (const e of candidates) {
    if (!e.properties) continue;
    const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
    if (ep && String(ep.OBJECTID) === String(fp.objId)) {
      e.properties[lb.fieldKey] = newVal;
      break;
    }
  }
  editingLightboxNote.value = false;

  // 3. 持久化 + 检查返回值
  savingFieldMobile = true;
  try {
    const saveResult = await saveFeature(fp.layerId, String(fp.objId));
    if (!saveResult) { showToast('备注保存失败，请检查网络', 'error', 3000); return; }
    if (saveResult?.conflict) {
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(fp.layerId);
      showToast('备注保存冲突，已刷新', 'warning', 2500);
      return;
    }
    showToast('备注已保存', 'success', 1000);
  } finally {
    savingFieldMobile = false;
  }
};

const cancelEditLightboxNote = () => {
  editingLightboxNote.value = false;
};

const panelTitle = computed(() => {
  const map = { layers: '图层管理', edit: '编辑面板', search: '搜索定位', table: '数据工作台', schema: '字段编辑' };
  return map[activePanel.value] || '';
});

const fpGroups = computed(() => {
  if (!featurePanel.value?.layerId) return [];
  const schema = fieldSchema[featurePanel.value.layerId];
  if (!schema) return [];
  return parseFieldGroups(schema, fieldGroupsMeta[featurePanel.value.layerId]);
});


// 布尔父字段值变更时自动展开/折叠
watch(() => featurePanel.value?.props, (newProps) => {
  if (!newProps) return;
  let changed = false;
  for (const group of fpGroups.value) {
    const hdrKey = getHeaderBoolKey(group);
    if (hdrKey && newProps[hdrKey] === 'True') {
      fpCollapsed.value.delete(group.key);
      changed = true;
    } else if (hdrKey) {
      if (!fpCollapsed.value.has(group.key)) {
        fpCollapsed.value.add(group.key);
        changed = true;
      }
    }
  }
  if (changed) fpCollapsed.value = new Set(fpCollapsed.value);
}, { deep: true });

const workingLayerName = computed(() => {
  const id = mapState.editor.selectedLayerId;
  if (!id) return '';
  const layer = getLayerState(id);
  return layer ? layer.name : '';
});
const currentUser = computed(() => {
  try {
    const raw = sessionStorage.getItem('cesium_mvp_user');
    if (raw) return JSON.parse(raw).username || '未登录';
  } catch {}
  return '未登录';
});

const togglePanel = (name) => {
  if (activePanel.value === name) {
    if (editState.value === 'drawing') {
      drawEngine.stop();
      editState.value = 'idle';
    }
    activePanel.value = null;
  } else {
    if (editState.value === 'drawing') {
      drawEngine.stop();
      editState.value = 'idle';
    }
    if (pointPlaceMode.value) {
      drawEngine.stop();
      pointPlaceMode.value = false;
    }
    activePanel.value = name;
    if (name === 'edit') editState.value = 'idle';
  }
};

const closePanel = () => {
  if (editState.value === 'drawing') {
    drawEngine.stop();
    editState.value = 'idle';
  }
  if (pointPlaceMode.value) {
    drawEngine.stop();
    pointPlaceMode.value = false;
  }
  activePanel.value = null;
};

const openSchemaEditor = (layerId) => {
  schemaLayerId.value = layerId;
  activePanel.value = 'schema';
};

const onDrawState = (state) => {
  if (state === 'point-place') {
    pointPlaceMode.value = true;
  } else {
    editState.value = state;
  }
};

drawEngine.onDrawStateChange((isDrawing) => {
  if (!isDrawing) {
    if (pointPlaceMode.value) pointPlaceMode.value = false;
    else editState.value = 'idle';
    activeDrawGeom.value = null;
  }
});

// 线/面绘制完成时自动弹出属性面板（与点新增行为一致）
drawEngine.onDrawComplete(async ({ layerId, featureId, entityId }) => {
  const viewer = getViewer();
  if (!viewer) return;
  const ds = getLayer(layerId);
  const coll = (ds instanceof Cesium.GeoJsonDataSource) ? ds.entities : viewer.entities;
  const entity = coll.getById(entityId);
  if (!entity) return;
  const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
  const stableId = String(props.OBJECTID || featureId);
  featurePanel.value = {
    entityId: entity.id, layerId,
    layerName: getLayerState(layerId)?.name || '',
    geomType: getLayerState(layerId)?.geometryType || 'polygon',
    name: props.Name || props.name || '',
    objId: stableId,
    props: { ...props },
    editing: true
  };
  const lockRes = await acquireFeatureLock(layerId, stableId);
  if (lockRes?.locked) {
    showToast('要素已被 ' + (lockRes.lockedBy || '其他用户') + ' 锁定', 'warning');
    featurePanel.value.editing = false;
  } else if (lockRes?.stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(layerId);
    showToast('已刷新', 'info', 1000);
    releaseFeatureLock(layerId, stableId, false);
    featurePanel.value = null;
  }
});

const undoPoint = () => { drawEngine.undoLastPoint(); };

const finishDraw = () => { if (drawEngine.finishDrawing()) editState.value = 'idle'; };
const cancelDraw = () => { drawEngine.stop(); editState.value = 'idle'; };

const startDrawFromFab = async (geomType) => {
  const layerId = mapState.editor.selectedLayerId;
  const layer = getLayerState(layerId);
  if (!layer || layer.geometryType !== geomType) {
    pendingDrawType.value = geomType;
    showLayerPicker.value = true;
    return;
  }
  await doStartDraw(geomType);
};

const pickLayer = async (layerId) => {
  const layerState = getLayerState(layerId);
  if (layerState && !layerState.show) {
    showToast('该图层未显示，请点击左侧 👁 图标开启可见性', 'error', 2000);
    return;
  }
  mapState.editor.selectedLayerId = layerId;
  showLayerPicker.value = false;
  const type = pendingDrawType.value;
  pendingDrawType.value = null;
  if (type) await doStartDraw(type);
};

const doStartDraw = async (geomType) => {
  const layerId = mapState.editor.selectedLayerId;
  if (!layerId) return;
  if (drawEngine.isDrawing) { drawEngine.stop(); }
  const stale = await checkLayerStale(layerId);
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(layerId);
    showToast('已刷新', 'info', 1000);
  }
  if (geomType === 'point') {
    await drawEngine.start(layerId, { passivePoint: true });
    pointPlaceMode.value = true;
  } else {
    await drawEngine.start(layerId, { screenPreview: true });
    editState.value = 'drawing';
    activeDrawGeom.value = geomType;
  }
};

let savingFieldMobile = false; // 防快速连续输入导致并发 saveFeature
let _pendingFieldMobile = null; // 上一次 PATCH 飞行中，此字段值已更新到 entity 但尚未保存
const focusedField = ref({ key: '', original: undefined }); // 冲突自动合并用

// 聚焦时版本预检 + 记录原始值（与桌面 handlePropFocus 对齐）
const handleFocusMobile = async (key) => {
  if (!featurePanel.value?.editing) return;
  const fp = featurePanel.value;
  // 记录原始值 + 清除旧错误
  focusedField.value = { key, original: fp.props[key] };
  _dirtyFields.set(key, fp.props[key]); // 脏字段追踪
  delete fieldErrors[key];
  // 版本预检
  const stale = await checkLayerStale(fp.layerId);
  if (stale) {
    const typedValue = fp.props[key];
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(fp.layerId);
    await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
    const found = refreshFeaturePanel(fp.layerId, fp.objId);
    hideToast();
    if (!found) {
      showToast('要素可能已被删除', 'warning', 2000);
      featurePanel.value = null;
      return;
    }
    // 若用户在等待期间已开始键入 → 自动合并（仅当值确实被用户改变过）
    const refreshed = featurePanel.value;
    if (refreshed && typedValue !== undefined
        && typedValue !== focusedField.value.original) {
      refreshed.props[key] = typedValue;
    }
  }
};

// 下拉"其他"组合框：选中预设选项立即保存，选中"其他"等待自定义输入
const onMobileSelectPick = (fieldKey, newVal, options) => {
  const fp = featurePanel.value;
  if (!fp) return;
  if (newVal === '__other__') {
    fp.props[fieldKey] = '其他: ';
  } else {
    fp.props[fieldKey] = newVal;
    saveFieldBlur(fieldKey);
  }
};

const saveFieldBlur = async (fieldKey) => {
  if (!featurePanel.value?.editing) return;
  const fp = featurePanel.value;
  // 先同步 entity（必须在 savingFieldMobile 门控之前，确保快速连击不丢值）
  const ds = getLayer(fp.layerId);
  let entity = null;
  if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(fp.entityId);
  if (!entity) entity = getViewer()?.entities.getById(fp.entityId);
  if (entity?.properties?.hasProperty(fieldKey)) {
    entity.properties[fieldKey] = fp.props[fieldKey];
  }
  // 门控之前捕获 focusedField 快照并记录脏字段（门控跳过的字段也需要追踪）
  const _ok = focusedField.value.key;
  const _ov = focusedField.value.original;
  if (_ok) _dirtyFields.set(_ok, _ov);
  if (savingFieldMobile) {
    _pendingFieldMobile = fieldKey;
    return;
  }
  const origKey = _ok;   // await 之前捕获快照
  const origVal = _ov;
  // 格式校验
  const fmt = fieldSchema[fp.layerId]?.[fieldKey]?.format;
  const opts = fieldSchema[fp.layerId]?.[fieldKey]?.options || [];
  const valError = validateFieldValue(fp.props[fieldKey], fmt, opts);
  if (valError) { fieldErrors[fieldKey] = valError; setTimeout(() => delete fieldErrors[fieldKey], 2000); return; }
  delete fieldErrors[fieldKey];
  savingFieldMobile = true;
  try {
    const { checkLayerConflict } = await import('../../core/locks');
    const conflict = await checkLayerConflict(fp.layerId, String(fp.objId));
    if (conflict.stale) {
      // 记住用户输入值
      const userValue = fp.props[fieldKey];
      // reload 前快照所有脏字段（当前字段由已有逻辑处理，其他字段需恢复）
      const pendingDirty = {};
      for (const [k, orig] of _dirtyFields) {
        if (k !== fieldKey) pendingDirty[k] = { original: orig, current: fp.props[k] };
      }
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      showToast('检测到图层有更新，正在刷新...', 'info', 0);
      await reloadLayer(fp.layerId);
      await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
      const found = refreshFeaturePanel(fp.layerId, fp.objId);
      hideToast();
      if (!found) {
        fieldErrors[fieldKey] = '要素可能已被删除';
        setTimeout(() => delete fieldErrors[fieldKey], 2000);
        return;
      }
      // 冲突自动合并：若服务端该字段未被他人修改，则重新应用用户输入
      const refreshed = featurePanel.value;
      let _canContinue = true;
      if (refreshed && origKey === fieldKey && origVal !== undefined) {
        const serverVal = refreshed.props[fieldKey];
        if (serverVal === origVal) {
          refreshed.props[fieldKey] = userValue;
          _dirtyFields.delete(fieldKey);
          // 同步 entity（reload 后 entity 已重建，按 OBJECTID 查找）
          const ds2 = getLayer(fp.layerId);
          for (const e of (ds2 ? ds2.entities.values : (getViewer()?.entities.values || []))) {
            if (!e.properties) continue;
            const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
            if (ep && String(ep.OBJECTID) === String(fp.objId)) {
              e.properties[fieldKey] = userValue; break;
            }
          }
          // 不 return，继续保存
        } else {
          _dirtyFields.delete(fieldKey);
          fieldErrors[fieldKey] = conflict.modifier; setTimeout(() => delete fieldErrors[fieldKey], 2000);
          _canContinue = false;
        }
      } else {
        fieldErrors[fieldKey] = conflict.modifier; setTimeout(() => delete fieldErrors[fieldKey], 2000);
        _canContinue = false;
      }
      // 恢复其他脏字段（即使当前字段冲突也需恢复，保持UI与用户操作一致）
      const v0 = getViewer(); const d0 = getLayer(fp.layerId);
      for (const [k, edit] of Object.entries(pendingDirty)) {
        const sv = refreshed.props[k];
        if (sv === edit.original) {
          refreshed.props[k] = edit.current;
          for (const e of (d0 ? d0.entities.values : (v0 ? v0.entities.values : []))) {
            if (!e.properties) continue;
            const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
            if (ep && String(ep.OBJECTID) === String(fp.objId)) { e.properties[k] = edit.current; break; }
          }
        } else {
          _dirtyFields.delete(k);
          fieldErrors[k] = conflict.modifier || '已被他人修改';
          setTimeout(() => delete fieldErrors[k], 2000);
        }
      }
      if (!_canContinue) return;
      const v = getViewer(); const d = getLayer(fp.layerId);
      for (const [k, edit] of Object.entries(pendingDirty)) {
        const sv = refreshed.props[k];
        if (sv === edit.original) {
          refreshed.props[k] = edit.current;
          for (const e of (d ? d.entities.values : (v ? v.entities.values : []))) {
            if (!e.properties) continue;
            const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
            if (ep && String(ep.OBJECTID) === String(fp.objId)) {
              e.properties[k] = edit.current; break;
            }
          }
        } else {
          // 他人修改了此字段 → 展示冲突
          _dirtyFields.delete(k);
          fieldErrors[k] = conflict.modifier || '已被他人修改';
          setTimeout(() => delete fieldErrors[k], 2000);
        }
      }
    }
    const result = await saveFeature(fp.layerId, String(fp.objId), { keepLock: true });
    if (!result) { showToast('保存失败，请检查网络', 'error'); return; }
    if (result?.conflict) {
      // 409 自动合并
      const userValue = fp.props[fieldKey];
      // reload 前快照所有脏字段
      const pendingDirty409 = {};
      for (const [k, orig] of _dirtyFields) {
        if (k !== fieldKey) pendingDirty409[k] = { original: orig, current: fp.props[k] };
      }
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(fp.layerId);
      await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
      const found = refreshFeaturePanel(fp.layerId, fp.objId);
      if (!found) {
        fieldErrors[fieldKey] = '要素可能已被删除';
        setTimeout(() => delete fieldErrors[fieldKey], 2000);
        return;
      }
      const refreshed = featurePanel.value;
      if (refreshed && origKey === fieldKey && origVal !== undefined) {
        const serverVal = refreshed.props[fieldKey];
        if (serverVal === origVal) {
          refreshed.props[fieldKey] = userValue;
          _dirtyFields.delete(fieldKey);
          const ds2 = getLayer(fp.layerId);
          for (const e of (ds2 ? ds2.entities.values : (getViewer()?.entities.values || []))) {
            if (!e.properties) continue;
            const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
            if (ep && String(ep.OBJECTID) === String(fp.objId)) { e.properties[fieldKey] = userValue; break; }
          }
          // 恢复其他脏字段
          const v409 = getViewer(); const d409 = getLayer(fp.layerId);
          for (const [k, edit] of Object.entries(pendingDirty409)) {
            const sv = refreshed.props[k];
            if (sv === edit.original) {
              refreshed.props[k] = edit.current;
              for (const e of (d409 ? d409.entities.values : (v409 ? v409.entities.values : []))) {
                if (!e.properties) continue;
                const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
                if (ep && String(ep.OBJECTID) === String(fp.objId)) { e.properties[k] = edit.current; break; }
              }
            } else { _dirtyFields.delete(k); }
          }
          const retryResult = await saveFeature(fp.layerId, String(fp.objId), { keepLock: true });
          if (!retryResult) { showToast('自动重试保存失败，请检查网络', 'error', 3000); return; }
          if (retryResult?.conflict) {
            _dirtyFields.delete(fieldKey);
            fieldErrors[fieldKey] = retryResult.modifiedBy ? `已被 ${retryResult.modifiedBy} 修改` : '已被他人修改';
            setTimeout(() => delete fieldErrors[fieldKey], 2000);
            showToast('数据已被他人修改', 'warning', 2500);
          } else if (retryResult?.success) {
            fieldSuccess[fieldKey] = true;
            setTimeout(() => delete fieldSuccess[fieldKey], 1500);
            showToast('已保存', 'success', 800);
          }
        } else {
          _dirtyFields.delete(fieldKey);
          fieldErrors[fieldKey] = result.modifiedBy ? `已被 ${result.modifiedBy} 修改` : '已被他人修改';
          setTimeout(() => delete fieldErrors[fieldKey], 2000);
          showToast('数据已被他人修改', 'warning', 2500);
        }
      } else {
        _dirtyFields.delete(fieldKey);
        fieldErrors[fieldKey] = result.modifiedBy ? `已被 ${result.modifiedBy} 修改` : '已被他人修改';
        setTimeout(() => delete fieldErrors[fieldKey], 2000);
        showToast('数据已被他人修改，已更新为最新值', 'warning', 2500);
      }
    } else if (result?.success) {
      _dirtyFields.delete(fieldKey);
      fieldSuccess[fieldKey] = true;
      setTimeout(() => delete fieldSuccess[fieldKey], 1500);
      showToast('已保存', 'success', 800);
    }
  } finally {
    savingFieldMobile = false;
    // 飞行期间若有新的操作更新了 entity，补保存
    if (_pendingFieldMobile) {
      const pk = _pendingFieldMobile;
      _pendingFieldMobile = null;
      saveFieldBlur(pk);
    }
  }
};


const uploadMobilePhoto = (fieldKey) => {
  if (!featurePanel.value) return;
  const fp = featurePanel.value;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.position = 'absolute';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { input.remove(); return; }
    const reader = new FileReader();
    reader.onload = () => { photoConfirm.preview = reader.result; photoConfirm.note = ''; photoConfirm.fieldKey = fieldKey; photoConfirm.file = file; photoConfirm.visible = true; };
    reader.readAsDataURL(file);
  };
  input.click();
};

const confirmMobilePhoto = async () => {
  const fieldKey = photoConfirm.fieldKey;
  const note = photoConfirm.note.trim();
  const file = photoConfirm.file;
  photoConfirm.visible = false;
  if (!file) return;
  const fp = featurePanel.value;
  if (!fp) return;
  const stateKey = fieldKey + '_' + Date.now();
    const featId = fp.layerId + '_' + fp.objId;
    uploadState.value = { ...uploadState.value, [stateKey]: { featureId: featId, fieldKey, seq: 0, status: 'uploading', progress: 0 } };
    try {
      const existingCount = parsePhotos(fp.props[fieldKey]).length;
      // 算上已在排队的上传（含自身），确保并发时 seq 不重复
      const pendingCount = Object.values(uploadState.value).filter(s => s.featureId === featId && s.fieldKey === fieldKey).length;
      const seq = existingCount + pendingCount;
      uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], seq } };
      // 压缩参数与桌面端对齐
      const maxKb = keepOriginalMobile.value ? 5000 : 800;
      const maxPx = keepOriginalMobile.value ? 4096 : 1920;
      const minKb = keepOriginalMobile.value ? 2000 : 0;
      const blob = keepOriginalMobile.value && file.size <= 5000 * 1024 ? file : await compressImage(file, maxKb, maxPx, minKb);
      const form = new FormData();
      form.append('photo', blob, file.name || 'photo.jpg');
      form.append('layerId', fp.layerId);
      form.append('objectId', String(fp.objId));
      form.append('fieldKey', fieldKey);
      form.append('seq', String(seq));
      uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'uploading', progress: 0 } };
      const token = sessionStorage.getItem('cesium_mvp_token') || '';
      const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'uploading', progress: Math.round(ev.loaded / ev.total * 100) } };
          }
        };
        xhr.onload = () => {
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('解析响应失败')); }
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.ontimeout = () => reject(new Error('上传超时'));
        xhr.timeout = 120000;
        xhr.open('POST', apiBase + '/api/upload/photo');
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(form);
      });
      if (!data.success) {
        uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'error', progress: 0, msg: data.error || '失败' } };
        setTimeout(() => { const s = { ...uploadState.value }; delete s[stateKey]; uploadState.value = s; }, 3000);
        input.remove();
        return;
      }
      // 按 seq 插入正确位置（保证并发上传的最终顺序与开始顺序一致）
      const curExisting = parsePhotos(fp.props[fieldKey]);
      const insPos = uploadState.value[stateKey]?.seq || curExisting.length;
      curExisting.push({ u: data.url, n: note }); // JSON 格式
      const newVal = JSON.stringify(curExisting); // 新格式
      fp.props[fieldKey] = newVal;
      // 仅当仍查看同一 feature 时更新面板 UI
      // 始终同步到 Cesium entity + 后台保存（不依赖面板状态）
      const viewer = getViewer();
      const ds = getLayer(fp.layerId);
      let entity = null;
      if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(fp.entityId);
      if (!entity) entity = viewer?.entities.getById(fp.entityId);
      if (entity?.properties) {
        entity.properties[fieldKey] = newVal;
      }
      uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'done', progress: 100 } };
      if (savingFieldMobile) { showToast('请等待上次保存完成', 'warning'); return; }
      savingFieldMobile = true;
      try {
        const { checkLayerConflict } = await import('../../core/locks');
        const conflict = await checkLayerConflict(fp.layerId, String(fp.objId));
        if (conflict.stale) {
          const { reloadLayer: rl } = await import('../../core/layers/LayerManager');
          await rl(fp.layerId);
          await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
          const found = refreshFeaturePanel(fp.layerId, fp.objId);
          if (!found) {
            showToast('要素可能已被删除，照片已上传但保存失败', 'warning', 3000);
            return;
          }
          const refreshed = featurePanel.value;
          if (refreshed && refreshed.layerId === fp.layerId && String(refreshed.objId) === String(fp.objId)) {
            const reExisting = parsePhotos(refreshed.props[fieldKey]);
            reExisting.push({ u: data.url, n: note });
            refreshed.props[fieldKey] = JSON.stringify(reExisting);
            const v = getViewer(); const d = getLayer(fp.layerId);
            for (const e of (d ? d.entities.values : (v ? v.entities.values : []))) {
              if (!e.properties) continue;
              const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
              if (ep && String(ep.OBJECTID) === String(fp.objId)) { e.properties[fieldKey] = refreshed.props[fieldKey]; break; }
            }
          } else {
            showToast('数据已被他人修改，照片已上传但需刷新', 'warning', 3000);
            return;
          }
        }
        const photoSave = await saveFeature(fp.layerId, String(fp.objId));
        if (!photoSave) { showToast('保存失败，请检查网络', 'error'); return; }
        if (photoSave?.conflict) {
          const { reloadLayer: rl2 } = await import('../../core/layers/LayerManager');
          await rl2(fp.layerId);
          const curFp = featurePanel.value;
          if (curFp && curFp.layerId === fp.layerId && String(curFp.objId) === String(fp.objId)) {
            const reExisting = parsePhotos(curFp.props[fieldKey]);
            reExisting.push({ u: data.url, n: note });
            curFp.props[fieldKey] = JSON.stringify(reExisting);
            const v = getViewer(); const d = getLayer(fp.layerId);
            for (const e of (d ? d.entities.values : (v ? v.entities.values : []))) {
              if (!e.properties) continue;
              const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
              if (ep && String(ep.OBJECTID) === String(fp.objId)) { e.properties[fieldKey] = curFp.props[fieldKey]; break; }
            }
            const retry = await saveFeature(fp.layerId, String(fp.objId));
            if (!retry) { showToast('自动重试保存失败', 'error', 3000); return; }
            if (retry?.conflict) { showToast('数据已被他人修改，请刷新后重试', 'warning', 3000); return; }
            showToast('照片已保存', 'success', 1000);
          } else {
            showToast('数据已被他人修改，照片已保存但需刷新', 'warning', 3000);
          }
        } else {
          showToast('照片已保存', 'success', 1000);
        }
      } finally {
        savingFieldMobile = false;
      }
      setTimeout(() => { const s = { ...uploadState.value }; delete s[stateKey]; uploadState.value = s; }, 600);
    } catch (err) {
      uploadState.value = { ...uploadState.value, [stateKey]: { ...uploadState.value[stateKey], status: 'error', progress: 0, msg: err.message || '网络错误' } };
      setTimeout(() => { const s = { ...uploadState.value }; delete s[stateKey]; uploadState.value = s; }, 3000);
    }
};

const removeMobilePhoto = async (fieldKey, url, index) => {
  if (!featurePanel.value) return;
  const fp = featurePanel.value;
  const existing = parsePhotos(fp.props[fieldKey]);
  existing.splice(index, 1);
  const newVal = JSON.stringify(existing);
  fp.props[fieldKey] = newVal;
  // 同步到 Cesium entity
  const ds = getLayer(fp.layerId);
  let entity = null;
  if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(fp.entityId);
  if (!entity) entity = getViewer()?.entities.getById(fp.entityId);
  if (entity?.properties?.hasProperty(fieldKey)) {
    entity.properties[fieldKey] = newVal;
  }
  if (savingFieldMobile) { showToast('请等待上次保存完成', 'warning'); return; }
  savingFieldMobile = true;
  try {
    const removeSave = await saveFeature(fp.layerId, String(fp.objId));
	    if (!removeSave) { showToast('保存失败，请检查网络', 'error'); savingFieldMobile = false; return; }
	    if (removeSave?.conflict) {
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(fp.layerId);
      showToast('数据已被他人修改，请刷新后重试', 'warning', 3000);
    }
  } finally {
    savingFieldMobile = false;
  }
  // 删除服务器文件
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
  fetch(apiBase + '/api/upload/photo/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ url })
  }).catch(() => { showToast('照片删除失败', 'error'); });
};

// stale 刷新后按 OBJECTID 重找 entity 并更新 featurePanel（reload 后旧 entityId 已失效）
// 原地更新 props 和必要字段，避免整个 featurePanel 对象替换导致 Vue v-for DOM 重建（可能使滚动条复位）
const refreshFeaturePanel = (layerId, objId, keepEditing = true) => {
  const ds = getLayer(layerId);
  const viewer = getViewer();
  const coll = (ds instanceof Cesium.GeoJsonDataSource) ? ds.entities : viewer?.entities;
  if (!coll) { console.warn('[refreshFeaturePanel] no collection for', layerId); return false; }
  const fp = featurePanel.value;
  if (!fp) return false;
  for (const e of coll.values) {
    const p = e.properties?.getValue?.(Cesium.JulianDate.now());
    if (p && String(p.OBJECTID) === String(objId)) {
      fp.entityId = e.id;
      fp.layerId = layerId;
      fp.layerName = getLayerState(layerId)?.name || fp.layerName || '';
      fp.geomType = getLayerState(layerId)?.geometryType || fp.geomType || 'polygon';
      fp.name = p.Name || p.name || '';
      fp.objId = String(p.OBJECTID || objId);
      fp.editing = keepEditing;
      // 原地更新 props：删除旧 key、合并新 key，保持对象引用不变
      const oldProps = fp.props || {};
      for (const k of Object.keys(oldProps)) { if (!(k in p)) delete oldProps[k]; }
      Object.assign(oldProps, p);
      return true;
    }
  }
  console.warn('[refreshFeaturePanel] entity not found for objId', objId);
  return false;
};

const getFlatLayersFromStore = () => getFlatLayers(['geojson']);

const startEditProps = async () => {
  if (!featurePanel.value) return;
  const fp = featurePanel.value;
  const stale = await checkLayerStale(fp.layerId);
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(fp.layerId);
    await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
    const found = refreshFeaturePanel(fp.layerId, fp.objId);
    if (!found) {
      showToast('刷新后未能定位要素，请重新选择', 'warning', 2000);
      featurePanel.value = null;
    } else {
      showToast('已刷新', 'info', 1000);
    }
    return;
  }
  featurePanel.value.editing = true;
};

const safeClearFeaturePanel = async () => {
  _dirtyFields.clear();
  if (featurePanel.value) {
    if (moveMode.value) {
      await releaseFeatureLock(featurePanel.value.layerId, String(featurePanel.value.objId), false);
    }
    featurePanel.value = null;
  }
  moveMode.value = false;
};

const cancelEditProps = () => {
  if (!featurePanel.value) return;
  featurePanel.value.editing = false;
};

const saveAndClose = async () => {
  if (featurePanel.value) {
    if (savingFieldMobile) { showToast('请等待上次保存完成', 'warning'); return; }
    savingFieldMobile = true;
    try {
      const fp = featurePanel.value;
      // 冲突预检（与 saveFieldBlur 对齐）
      const { checkLayerConflict } = await import('../../core/locks');
      const conflict = await checkLayerConflict(fp.layerId, String(fp.objId));
      if (conflict.stale) {
        showToast('检测到数据有更新，正在刷新...', 'info', 0);
        const { reloadLayer } = await import('../../core/layers/LayerManager');
        await reloadLayer(fp.layerId);
        await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
        refreshFeaturePanel(fp.layerId, fp.objId);
        hideToast();
      }
      const result = await saveFeature(fp.layerId, String(fp.objId));
      if (!result) { showToast('保存失败，请检查网络', 'error'); return; }
      if (result?.conflict) {
        // 409 自动重试
        const { reloadLayer } = await import('../../core/layers/LayerManager');
        await reloadLayer(fp.layerId);
        await import('../../core/locks').then(m => m.syncVersions(fp.layerId));
        refreshFeaturePanel(fp.layerId, fp.objId);
        const retry = await saveFeature(fp.layerId, String(fp.objId));
        if (!retry || retry?.conflict) {
          showToast('数据已被他人修改，已刷新', 'warning', 2000);
          featurePanel.value = null;
          return;
        }
      }
      featurePanel.value.editing = false;
    } finally {
      savingFieldMobile = false;
    }
  }
};

const closeFeaturePanel = async () => {
  // 等待飞行中的 PATCH 完成，防止保存被丢弃
  if (savingFieldMobile) {
    showToast('正在保存...', 'info', 0);
    let waited = 0;
    while (savingFieldMobile && waited < 10000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    hideToast();
  }
  lockedByOtherMobile.value = '';
  await safeClearFeaturePanel();
};

const startMovePoint = async () => {
  if (!featurePanel.value || featurePanel.value.geomType !== 'point') return;
  const viewer = getViewer();
  if (!viewer) return;
  const fp = featurePanel.value;
  const stableId = String(fp.objId);
  const [lockRes, stale] = await Promise.all([
    acquireFeatureLock(fp.layerId, stableId),
    checkLayerStale(fp.layerId)
  ]);
  if (lockRes?.error) { showToast(lockRes.error, 'warning'); return; }
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(fp.layerId);
    showToast('已刷新', 'info', 1000);
    releaseFeatureLock(fp.layerId, stableId, false);
    featurePanel.value = null;
    return;
  }
  const ds = getLayer(fp.layerId);
  let entity = null;
  if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(fp.entityId);
  if (!entity) entity = viewer.entities.getById(fp.entityId);
  if (!entity?.position) return;
  const pos = entity.position.getValue(Cesium.JulianDate.now());
  if (!pos) return;
  const camH = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
  const ptCarto = Cesium.Cartographic.fromCartesian(pos);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      Cesium.Math.toDegrees(ptCarto.longitude),
      Cesium.Math.toDegrees(ptCarto.latitude),
      Math.max(camH, 100)
    ),
    duration: 0.5
  });
  moveMode.value = true;
};

const confirmCrosshair = async () => {
  const viewer = getViewer();
  if (!viewer) return;
  // 取十字准星 DOM 元素的真实屏幕位置，确保拾取和视觉完全对齐
  const iconEl = document.querySelector('.crosshair-icon');
  if (!iconEl) { showToast('系统错误', 'error'); return; }
  const iconRect = iconEl.getBoundingClientRect();
  const screenCX = iconRect.left + iconRect.width / 2;
  const screenCY = iconRect.top + iconRect.height / 2;
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const center = new Cesium.Cartesian2(screenCX - canvasRect.left, screenCY - canvasRect.top);
  const cartesian = viewer.scene.globe.pick(viewer.camera.getPickRay(center), viewer.scene);
  if (!cartesian) { showToast('无法定位地面', 'warning'); return; }

  if (pointPlaceMode.value) {
    // 等待上一次属性保存完成再创建新点，防止并发覆盖
    while (savingFieldMobile) await new Promise(r => setTimeout(r, 50));
    const _layerId = mapState.editor.selectedLayerId;
    await drawEngine.addPassivePoint(cartesian);
    viewer.scene.requestRender();
    showToast('点位已添加', 'success', 1500);
    // 自动弹出属性面板，保持准星
    const _tempId = drawEngine._lastPointTempId;
    if (_tempId && _layerId) {
      const _ds = getLayer(_layerId);
      const _coll = (_ds instanceof Cesium.GeoJsonDataSource) ? _ds.entities : viewer.entities;
      const _entity = _coll.getById(_tempId);
      if (_entity) {
        const _p = _entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
        const _stableId = String(_p.OBJECTID || _tempId);
        featurePanel.value = {
          entityId: _entity.id, layerId: _layerId,
          layerName: getLayerState(_layerId)?.name || '',
          geomType: 'point',
          name: _p.Name || _p.name || '',
          objId: _stableId,
          props: { ..._p },
          editing: true
        };
      }
    }
  } else if (moveMode.value && featurePanel.value) {
    // 移动已有点位
    const fp = featurePanel.value;
    const ds = getLayer(fp.layerId);
    let entity = null;
    if (ds instanceof Cesium.GeoJsonDataSource) entity = ds.entities.getById(fp.entityId);
    if (!entity) entity = viewer.entities.getById(fp.entityId);
    if (entity) {
      const oldPosition = entity.position?.getValue?.(Cesium.JulianDate.now());
      // 先设新位置，saveFeature 才能提取并持久化新坐标
      entity.position = cartesian;
      viewer.scene.requestRender();
      let moveResult = null;
      try {
        moveResult = await saveFeature(fp.layerId, String(fp.objId));
      } catch (e) { /* 网络错误 */ }
      if (moveResult?.success) {
        showToast('点位已移动', 'success', 1500);
        moveMode.value = false;
        featurePanel.value = null;
      } else {
        // 失败：回滚到旧位置
        if (oldPosition) entity.position = oldPosition;
        viewer.scene.requestRender();
        if (moveResult?.conflict) {
          showToast('数据已被他人修改，正在刷新...', 'warning', 0);
          const { reloadLayer } = await import('../../core/layers/LayerManager.js');
          await reloadLayer(fp.layerId);
          hideToast();
        } else {
          showToast('保存失败，请检查网络后重试', 'error', 3000);
        }
      }
    } else {
      moveMode.value = false;
      featurePanel.value = null;
    }
  }
};

const finishPointMode = () => {
  if (featurePanel.value) safeClearFeaturePanel();
  drawEngine.stop();
};

const cancelCrosshair = async () => {
  if (pointPlaceMode.value) {
    drawEngine.stop();
    pointPlaceMode.value = false;
  } else if (moveMode.value) {
    await safeClearFeaturePanel();
  } else {
    moveMode.value = false;
  }
};

// 从 entity 打开要素面板（tap 和 非编辑模式长按共用）
const openFeaturePanel = async (entity) => {
  let layerId = entity._layerId || null;
const props = entity.properties ? entity.properties.getValue(Cesium.JulianDate.now()) : {};
  if (!layerId) {
    layerId = entity._layerId || null;
    if (!layerId) {
      const allLayers = getFlatLayersFromStore();
      for (const l of allLayers) {
        if (l.features && l.features.some(f => f.id === entity.id || (entity.properties && String(f.id) === String(entity.properties.OBJECTID?.getValue?.(Cesium.JulianDate.now()))))) { layerId = l.id; break; }
      }
    }
  }
  const layerState = getLayerState(layerId);
  const autoEdit = mapState.editor.isEditing;
  featurePanel.value = {
    entityId: entity.id, layerId,
    layerName: layerState?.name || '',
    geomType: layerState?.geometryType || 'polygon',
    name: (props && props.Name) || (props && props.name) || '',
    objId: (props && props.OBJECTID) || entity.id,
    props: { ...(props || {}) },
    editing: autoEdit
  };
  if (autoEdit) {
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(layerId);
      const found = refreshFeaturePanel(layerId, featurePanel.value.objId);
      if (!found) {
        showToast('刷新后未能定位要素，请重新选择', 'warning', 2000);
        featurePanel.value = null;
      } else {
        showToast('已刷新', 'info', 1000);
      }
      return;
    }
  }
  mapState.interaction.selectedFeatureId = entity.id;
  mapState.interaction.selectedLayerId = layerId;
  mapState.interaction.selectedFeatureProps = { ...(props || {}) };

  // 查询是否有人在编辑几何形态
  fetchLayerLocks(layerId).then(locks => {
    const myObjId = featurePanel.value?.objId;
    const myLock = locks.features?.find(l => String(l.featureId) === String(myObjId));
    if (myLock && myLock.username !== mapState.auth.username) {
      lockedByOtherMobile.value = myLock.username;
    } else {
      lockedByOtherMobile.value = '';
    }
  }).catch(() => { /* 锁状态查询失败不影响操作 */ });
};

// 编辑模式长按 → 点要素进入移动模式
const longPressMovePoint = async (entity, layerId) => {
  await safeClearFeaturePanel();
  const objId = entity.properties?.OBJECTID?.getValue?.(Cesium.JulianDate.now()) || entity.id;
  const [lockRes, stale] = await Promise.all([
    acquireFeatureLock(layerId, String(objId)),
    checkLayerStale(layerId)
  ]);
  if (lockRes?.error) { showToast(lockRes.error, 'warning'); return; }
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(layerId);
    showToast('已刷新', 'info', 1000);
    releaseFeatureLock(layerId, String(objId), false);
    return;
  }
  const viewer = getViewer();
  if (!viewer) return;
  const pos = entity.position?.getValue(Cesium.JulianDate.now());
  if (!pos) return;
  const camH = Cesium.Cartographic.fromCartesian(viewer.camera.position).height;
  const ptCarto = Cesium.Cartographic.fromCartesian(pos);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(Cesium.Math.toDegrees(ptCarto.longitude), Cesium.Math.toDegrees(ptCarto.latitude), Math.max(camH, 100)),
    duration: 0.5
  });
  featurePanel.value = {
    entityId: entity.id, layerId,
    layerName: getLayerState(layerId)?.name || '',
    geomType: 'point',
    name: entity.properties?.Name?.getValue?.(Cesium.JulianDate.now()) || '',
    objId, props: {},
    editing: false
  };
  moveMode.value = true;
};

// 编辑模式长按 → 线/面要素进入控制点编辑（锁+stale 在 SpatialEditor.activate 内统一处理）
const longPressVertexEdit = async (entity, layerId) => {
  const { spatialEditor } = await import('../../core/viewer/SpatialEditor');
  await spatialEditor.activate(entity.id, layerId);
  if (spatialEditor.isActive) {
    safeClearFeaturePanel();
    featurePanel.value = null;
  }
};

const locateToGPS = async () => {
  const gl = mapState.geolocation;
  if (!gl.lat || !gl.lon) {
    if (!gpsActive.value) {
      showToast('正在请求定位...', 'info', 0);
      startTracking(() => { flyToUser(); }, () => { gpsActive.value = false; stopTracking(); });
      gpsActive.value = true;
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (mapState.geolocation.lat) break;
    }
    hideToast();
    if (!mapState.geolocation.lat) {
      showToast('GPS 定位超时', 'warning');
      return;
    }
  }
  flyToUser();
};

const editVertices = async () => {
  if (!featurePanel.value) return;
  const layerId = featurePanel.value.layerId;
  const entityId = featurePanel.value.entityId;
  const { spatialEditor } = await import('../../core/viewer/SpatialEditor.js');
  await spatialEditor.activate(entityId, layerId);
  if (spatialEditor.isActive) {
    safeClearFeaturePanel();
  }
};

const deletePending = ref(null);

// 退出登录 — 二次确认弹窗
const showLogoutConfirm = ref(false);
const handleLogout = () => {
  showLogoutConfirm.value = false;
  releaseAllMyLocks();
  sessionStorage.removeItem('cesium_mvp_token');
  sessionStorage.removeItem('cesium_mvp_user');
  location.reload();
};

const deleteFeature = async () => {
  if (!featurePanel.value) return;
  const { layerId, entityId, objId } = featurePanel.value;

  // 二次确认：首次点击设置待确认状态，3秒内再次点击才执行
  if (!deletePending.value || deletePending.value.objId !== String(objId)) {
    deletePending.value = { layerId, entityId, objId: String(objId) };
    showToast('再次点击删除按钮确认删除', 'warning', 3000);
    setTimeout(() => { if (deletePending.value?.objId === String(objId)) deletePending.value = null; }, 3000);
    return;
  }
  deletePending.value = null;
  const stableId = String(objId);

  // 协同检测：获取锁确保独占
  const lockRes = await acquireFeatureLock(layerId, stableId);
  if (lockRes?.locked) {
    showToast(`要素已被 ${lockRes.lockedBy || '其他用户'} 锁定，无法删除`, 'warning');
    return;
  }
  if (lockRes.stale) {
    releaseFeatureLock(layerId, stableId, false);
    showToast('检测到图层有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(layerId);
    hideToast();
    const lAfter = getLayerState(layerId);
    if (!lAfter?.features?.some(f => String(f.properties?.OBJECTID) === stableId || f.id === entityId)) {
      showToast('该要素已被他人删除', 'warning', 2500);
      featurePanel.value = null;
      return;
    }
    showToast('已刷新，请再次确认删除', 'info', 2000);
    return;
  }

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const layer = getLayerState(layerId);
  try {
    const deleteRes = await fetch('/api/features', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filePath: layer?.url, featureId: String(objId), layerId })
    });
    if (deleteRes.status === 404) {
      showToast('该要素已被他人删除', 'warning', 2500);
      featurePanel.value = null;
      return;
    }
    const viewer = getViewer();
    // 清理 Outline 残影
    const ds = getLayer(layerId);
    if (ds instanceof Cesium.GeoJsonDataSource) {
      const entity = ds.entities.getById(entityId);
      if (entity && entity._outline) {
        ds.entities.remove(entity._outline);
      }
      ds.entities.removeById(entityId);
    }
    if (viewer) { viewer.entities.removeById(entityId); viewer.scene.requestRender(); }
    if (layer?.features) layer.features = layer.features.filter(f => f.id !== entityId);
    await checkLayerStale(layerId); // 删要素后服务端 bump 了 layerVersion，回正本地避免下次自我误判 stale
    showToast('要素已删除', 'success', 1500);
  } catch (e) {
    showToast('删除失败: ' + (e.message || '网络错误'), 'error');
  } finally {
    // DELETE 已 bump featureVersion，释放锁不再重复 bump（saved:false）
    await releaseFeatureLock(layerId, stableId, false);
    featurePanel.value = null;
  }
};

// 2D/3D 视角切换
const toggle2D3D = () => {
  const viewer = getViewer();
  if (!viewer) return;
  const center = new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
  const pos = viewer.scene.pickPosition(center) || viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid);
  if (pos) {
    const dist = Cesium.Cartesian3.distance(viewer.camera.position, pos);
    const to2D = isMobile2D.value;
    const pitch = to2D ? Cesium.Math.toRadians(-60) : Cesium.Math.toRadians(-90);
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(pos, 0),
      { offset: new Cesium.HeadingPitchRange(0, pitch, Math.max(dist, 100)), duration: 0.6 }
    );
    // 切换 3D 时启用手势旋转/倾斜，切回 2D 时禁用
    viewer.scene.screenSpaceCameraController.enableRotate = to2D;
    viewer.scene.screenSpaceCameraController.enableTilt = to2D;
  }
  isMobile2D.value = !isMobile2D.value;
};

// Home：缩放到所有要素，2D 顶视图，正北朝上
const zoomToHome = () => {
  const viewer = getViewer();
  if (!viewer) return;
  isMobile2D.value = true;
  viewer.scene.screenSpaceCameraController.enableRotate = false;
  viewer.scene.screenSpaceCameraController.enableTilt = false;
  import('../../core/layers/LayerManager').then(({ zoomToVisibleLayers }) => {
    zoomToVisibleLayers({ to2D: true });
  });
};

let _gpsToggling = false;
const toggleMobileGPS = async () => {
  if (_gpsToggling) return;
  _gpsToggling = true;
  if (gpsActive.value) {
    stopTracking();
    gpsActive.value = false;
  } else {
    showToast('正在请求定位...', 'info', 0);
    startTracking(
      () => { hideToast(); setTimeout(() => flyToUser(), 300); },
      () => {
        gpsActive.value = false;
        stopTracking();
      }
    );
    gpsActive.value = true;
  }
  setTimeout(() => { _gpsToggling = false; }, 800);
};

const toggleMobileEdit = async () => {
  if (mapState.editor.isEditing) {
    await safeClearFeaturePanel();
    const { spatialEditor } = await import('../../core/viewer/SpatialEditor');
    await spatialEditor.deactivate();
    drawEngine.stop();
    mapState.editor.isEditing = false;
    if (editState.value !== 'idle') editState.value = 'idle';
    if (pointPlaceMode.value) pointPlaceMode.value = false;
  } else {
    const stale = await checkTreeStale();
    if (stale) {
      const { loadLayerConfig } = await import('../../store/mapState');
      const { syncTreeLayers } = await import('../../core/layers/LayerManager');
      await loadLayerConfig();
      syncTreeLayers();
      showToast('检测到图层结构变更，已刷新', 'info', 1500);
    }
    mapState.editor.isEditing = true;
    const { spatialEditor } = await import('../../core/viewer/SpatialEditor');
    spatialEditor.init();
  }
};

watch(() => mapState.ui.currentView, (v) => {
  if (v === 'map' && activePanel.value === 'table') closePanel();
});

// 手机单指拖动 = 平移地图
let _touchAbort = null; // AbortController 用于清理 canvas 事件监听器
watch(() => mapState.system.isViewerReady, (ready) => {
  if (!ready) return;
  const viewer = getViewer();
  if (!viewer) return;
  const canvas = viewer.canvas;
  _touchAbort = new AbortController();
                          let _touchStart = null, _touchMoved = false, _touchOrigin = null, _longPressTimer = null, _longPressFired = false;
  let _lastTapTime = 0, _lastTapX = 0, _lastTapY = 0;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { _touchStart = null; return; }
    // 触摸在 feature-sheet 面板内部时不做处理（让面板内部滚动等操作正常进行）
    if (e.target.closest('.feature-sheet')) return;
    if (featurePanel.value && !moveMode.value) closeFeaturePanel();
    _touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    _touchOrigin = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    _touchMoved = false;
    _longPressFired = false;
    // 绘制模式或顶点编辑模式下不启动长按定时器
    if (editState.value === 'drawing' || crosshairMode.value || mapState.editor.activeTool === 'vertex') return;
    _longPressTimer = setTimeout(() => {
      if (!_touchMoved && _touchStart) {
        _longPressFired = true;
        const pick = viewer.scene.pick(new Cesium.Cartesian2(_touchStart.x, _touchStart.y));
        if (pick && pick.id && pick.id.id && !pick.id._isSpatialNode) {
          const entity = pick.id._outlineParent || pick.id;
          if (mapState.editor.isEditing) {
            const layerId = entity._layerId || null;
            if (!layerId) return;
            const layerState = getLayerState(layerId);
            if (layerState?.geometryType === 'point') {
              longPressMovePoint(entity, layerId);
            } else {
              longPressVertexEdit(entity, layerId);
            }
          } else {
            openFeaturePanel(entity);
          }
        }
      }
      _longPressTimer = null;
    }, 500);
  }, { passive: false, signal: _touchAbort.signal });

  canvas.addEventListener('touchmove', (e) => {
    // 顶点编辑中：仅当 SpatialEditor 未拖拽控制点时允许平移地图
    if (mapState.editor.activeTool === 'vertex') {
      if (spatialEditor.draggedPoint) return;
    }
    if (!_touchStart || e.touches.length !== 1) return;
    if (!_touchStart || e.touches.length !== 1) return;
    // 用原始触摸位置判断是否产生了拖动（不会被逐帧 _touchStart 重置干扰）
    const totalDx = e.touches[0].clientX - (_touchOrigin ? _touchOrigin.x : _touchStart.x);
    const totalDy = e.touches[0].clientY - (_touchOrigin ? _touchOrigin.y : _touchStart.y);
    if (Math.abs(totalDx) > 10 || Math.abs(totalDy) > 10) {
      _touchMoved = true;
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    }
    const dx = e.touches[0].clientX - _touchStart.x;
    const dy = e.touches[0].clientY - _touchStart.y;
    // 绘制/顶点编辑模式用 1px 容差（减少缓慢拖动时的卡顿），其他模式用 2px 防误触
    const deadzone = (editState.value === 'drawing' || mapState.editor.activeTool === 'vertex') ? 1 : 2;
    if (Math.abs(dx) > deadzone || Math.abs(dy) > deadzone) {
      e.preventDefault();
      const camH = Cesium.Cartographic.fromCartesian(viewer.scene.camera.position).height || 500;
      const pxToMeter = camH * 0.0015;
      viewer.scene.camera.moveLeft(dx * pxToMeter);
      viewer.scene.camera.moveUp(dy * pxToMeter);
      _touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: false, signal: _touchAbort.signal });

  canvas.addEventListener('touchend', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    if (_longPressFired) { _touchStart = null; return; }
    if (_touchMoved) {
      // moveMode 下拖动地图是正常操作（调整准星位置），不关面板
      if (featurePanel.value && !moveMode.value) {
        if (featurePanel.value.editing) {
          releaseFeatureLock(featurePanel.value.layerId, String(featurePanel.value.objId), false);
        }
        featurePanel.value = null;
      }
      mapState.interaction.selectedFeatureId = null;
      mapState.interaction.selectedLayerId = null;
      mapState.interaction.selectedFeatureProps = null;
      _touchStart = null;
      return;
    }
    if (!_touchStart) return;
    // 双击检测：300ms 内同位置再次 tap → 放大 2x（非线面绘制模式）
    if (editState.value !== 'drawing' || crosshairMode.value) {
      const now = Date.now();
      if (now - _lastTapTime < 300 && Math.abs(_touchStart.x - _lastTapX) < 30 && Math.abs(_touchStart.y - _lastTapY) < 30) {
        // 仅在双击空白处时缩放（与桌面端 LEFT_DOUBLE_CLICK 行为一致），双击要素时不缩放避免竞态
        const pick2 = viewer.scene.pick(new Cesium.Cartesian2(_touchStart.x, _touchStart.y));
        if (!pick2 || !pick2.id) zoomToPoint(viewer, new Cesium.Cartesian2(_touchStart.x, _touchStart.y));
        _lastTapTime = 0; _touchStart = null; return;
      }
      _lastTapTime = now; _lastTapX = _touchStart.x; _lastTapY = _touchStart.y;
    }
    // 屏幕锁定绘制模式：轻点 = 放置/锁定顶点
    if (editState.value === 'drawing' && drawEngine.isDrawing && !crosshairMode.value) {
      drawEngine.handleScreenTap(_touchOrigin.x, _touchOrigin.y);
      _drawTapHandled = true;
      _touchStart = null;
      return;
    }
    // 绘制模式下不弹出要素面板
    if (editState.value === 'drawing' || crosshairMode.value) { _touchStart = null; return; }
    // 单击 → 弹出要素面板
    const pick = viewer.scene.pick(new Cesium.Cartesian2(_touchStart.x, _touchStart.y));
    if (pick && pick.id && pick.id.id && !pick.id._isSpatialNode) {
      openFeaturePanel(pick.id._outlineParent || pick.id);
    } else {
      featurePanel.value = null;
      mapState.interaction.selectedFeatureId = null;
      mapState.interaction.selectedLayerId = null;
      mapState.interaction.selectedFeatureProps = null;
    }
    _touchStart = null;
  }, { signal: _touchAbort.signal });

  canvas.addEventListener('touchcancel', () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    _touchStart = null;
    _touchMoved = false;
  }, { signal: _touchAbort.signal });

  // 兜底：click 事件在移动端 touchend 后才触发，部分设备 touchend 不可靠时确保落点
  let _drawTapHandled = false;
  canvas.addEventListener('click', (e) => {
    if (editState.value !== 'drawing' || !drawEngine.isDrawing || crosshairMode.value) return;
    if (_drawTapHandled) { _drawTapHandled = false; return; }
    drawEngine.handleScreenTap(e.clientX, e.clientY);
  }, { signal: _touchAbort.signal });




});

onBeforeUnmount(() => { drawEngine.destroy(); if (_touchAbort) { _touchAbort.abort(); _touchAbort = null; } });

</script>

<style scoped>
.mobile-layout { position: fixed; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
#cesiumContainer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; }

.fab { position: fixed; right: 12px; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; z-index: 1000; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.5); touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.gps-fab { bottom: 180px; background: rgba(15,23,42,0.85); border: 2px solid #475569; color: #64748b; }
.gps-fab.active { border-color: #38bdf8; color: #38bdf8; box-shadow: 0 0 12px rgba(56,189,248,0.4); }

.edit-fab { bottom: 224px; background: rgba(15,23,42,0.85); border: 2px solid #475569; color: #64748b; }
.edit-fab.active { border-color: #10b981; color: #10b981; box-shadow: 0 0 12px rgba(16,185,129,0.4); }

.draw-fab { width: 32px; height: 32px; font-size: 14px; position: fixed; right: 14px; background: rgba(15,23,42,0.85); border: 2px solid #475569; color: #64748b; transition: all .15s; }
.draw-fab:active { border-color: #38bdf8; color: #38bdf8; }
.draw-fab.active { border-color: #38bdf8; color: #38bdf8; background: rgba(56,189,248,0.2); box-shadow: 0 0 8px rgba(56,189,248,0.4); }
.draw-done { bottom: 379px; background: #10b981; border-color: #10b981; color: #fff; }
.draw-point { bottom: 268px; }
.draw-line { bottom: 305px; }
.draw-poly { bottom: 342px; }

.nav-fab { font-size: 13px; font-weight: bold; background: rgba(15,23,42,0.85); border: 2px solid #475569; color: #94a3b8; }
.view2d3d { bottom: 420px; }
.home { bottom: 462px; font-size: 18px; }

.layer-name-link { color: #38bdf8; text-decoration: underline; cursor: pointer; }

.top-bar { position: fixed; top: 0; left: 0; right: 0; background: rgba(15,23,42,0.9); border-bottom: 1px solid #1e293b; padding: 6px 12px; z-index: 1000; }
.top-bar-title { font-size: 12px; color: #64748b; text-align: center; }
.top-bar-sub { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; margin-top: 2px; }
.top-bar-layer { color: #94a3b8; display: flex; align-items: center; gap: 4px; }
.edit-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; display: inline-block; animation: breathe 1.5s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; box-shadow: 0 0 4px #10b981; } 50% { opacity: 0.3; box-shadow: 0 0 1px #10b981; } }
.top-bar-user { color: #64748b; }

.op-hint-bar { position: fixed; top: 54px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.65); color: rgba(255,255,255,0.85); font-size: 11px; padding: 4px 14px; border-radius: 12px; z-index: 5000; white-space: nowrap; pointer-events: none; }
.mobile-toast { position: fixed; top: 25%; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 8px; font-size: 13px; z-index: 100001; pointer-events: none; white-space: nowrap; }
.mobile-toast.info { background: rgba(56,189,248,0.70); color: #fff; }
.mobile-toast.warning { background: rgba(245,158,11,0.70); color: #fff; }
.mobile-toast.error { background: rgba(239,68,68,0.70); color: #fff; }
.mobile-toast.success { background: rgba(16,185,129,0.70); color: #fff; }
.logout-btn { margin-left: 4px; font-size: 12px; cursor: pointer; opacity: 0.7; }

.draw-toolbar { position: fixed; bottom: 56px; left: 0; right: 0; display: flex; gap: 8px; justify-content: center; padding: 8px 16px; background: rgba(15,23,42,0.92); border-top: 1px solid #334155; z-index: 2000; }
.dt-btn { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: bold; border: none; cursor: pointer; }
.dt-btn.undo { background: #1e293b; color: #f59e0b; border: 1px solid #f59e0b; }
.dt-btn.finish { background: #10b981; color: #fff; }
.dt-btn.cancel { background: #1e293b; color: #ef4444; border: 1px solid #ef4444; }


.panel-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #0f172a; z-index: 5000; display: flex; flex-direction: column; }
.panel-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #1e293b; border-bottom: 1px solid #334155; flex-shrink: 0; }
.panel-title { color: #38bdf8; font-size: 16px; font-weight: bold; }
.panel-close { width: 36px; height: 36px; background: none; border: 1px solid #475569; color: #94a3b8; border-radius: 50%; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.panel-body { flex: 1; overflow-y: auto; padding: 16px; color: #e2e8f0; }

.bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; height: 48px; background: rgba(15,23,42,0.95); border-top: 1px solid #334155; display: flex; z-index: 4000; }
.tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #64748b; cursor: pointer; transition: color 0.15s; }
.tab.active { color: #38bdf8; }
.tab-icon { font-size: 18px; line-height: 1; }
.tab-label { font-size: 10px; margin-top: 1px; }
.loading-overlay { position: fixed; top:0;left:0;width:100%;height:100%;background:#0f172a;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-size:14px; }
.loading-spinner { width:36px;height:36px;border:3px solid #334155;border-top-color:#38bdf8;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:12px; }
@keyframes spin { to { transform: rotate(360deg); } }

.feature-sheet { position:fixed; bottom:48px; left:8%; width:84%; max-height:50vh; background:rgba(15,23,42,0.97); border:1px solid #38bdf8; border-radius:12px 12px 0 0; z-index:9999; display:flex; flex-direction:column; pointer-events:auto; }
.fs-header { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid #334155; }
.fs-title { color:#38bdf8; font-size:14px; font-weight:bold; }
.fs-close { width:28px; height:28px; background:none; border:1px solid #475569; color:#94a3b8; border-radius:50%; font-size:14px; cursor:pointer; }
.fs-lock-notice { padding: 6px 14px; background: rgba(245,158,11,0.12); border-bottom: 1px solid rgba(245,158,11,0.3); color: #f59e0b; font-size: 11px; text-align: center; }
.fs-body { flex:1; overflow-y:auto; padding:8px 14px; max-height:30vh; }
.fs-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid rgba(51,65,85,0.3); font-size:12px; position:relative; }
.fs-group-hdr { display: flex; align-items: center; position: relative; padding: 8px 0; margin-top: 4px; font-size: 13px; font-weight: bold; color: #38bdf8; cursor: pointer; border-bottom: 1px solid #38bdf8; }
.fs-group-toggle { font-size: 10px; margin-right: 4px; flex-shrink: 0; }
.fs-group-hdr-check { margin-left: auto; flex-shrink: 0; }
.fs-check { display: flex; align-items: center; }
.fs-check input[type="checkbox"] { width: 20px; height: 20px; accent-color: #38bdf8; }
.fs-val input[type="checkbox"] { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border: 2px solid #475569; border-radius: 3px; background: transparent; cursor: default; position: relative; }
.fs-val input[type="checkbox"]:checked { background: #38bdf8; border-color: #38bdf8; }
.fs-val input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 3px; top: 1px; width: 5px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.bool-true { color: #10b981; font-weight: bold; }
.fs-images { display: flex; flex-wrap: wrap; gap: 4px; }
.fs-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #334155; }
.fs-img-wrap { position: relative; display: inline-block; }
.fs-img-del { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; background: #ef4444; color: #fff; border: none; border-radius: 50%; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.fs-empty { color: #64748b; font-size: 12px; }
.fs-upload { width: 100%; padding: 8px; margin-top: 4px; background: #1e293b; border: 1px dashed #475569; color: #38bdf8; border-radius: 6px; font-size: 12px; cursor: pointer; }
.fs-keep { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #64748b; margin-top: 4px; cursor: pointer; }
.fs-thumb-prog { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; color: #38bdf8; background: #0f172a; }
.lightbox-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.92); z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.lightbox-close { position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 18px; cursor: pointer; z-index: 1; }
.lightbox-img-wrap { max-width: 95vw; max-height: 75vh; display: flex; align-items: center; justify-content: center; }
.lightbox-img-wrap img { max-width: 100%; max-height: 75vh; object-fit: contain; }
.lightbox-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.lightbox-nav { width: 40px; height: 40px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.lightbox-counter { color: #94a3b8; font-size: 14px; min-width: 48px; text-align: center; }
.lightbox-del { padding: 8px 18px; background: rgba(239,68,68,0.7); border: 1px solid #ef4444; color: #fff; border-radius: 20px; font-size: 14px; cursor: pointer; margin-left: auto; }
.fs-key { color:#94a3b8; flex-shrink:0; max-width:40%; overflow:hidden; text-overflow:ellipsis; }
.fs-val { color:#e2e8f0; text-align:right; max-width:55%; overflow:hidden; text-overflow:ellipsis; }
.fs-input { width:55%; padding:4px 6px; background:#0f172a; border:1px solid #475569; color:#e2e8f0; border-radius:3px; font-size:12px; }
.fs-input.has-error { border-color: #ef4444; }
.fs-error-tip { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: #ef4444; color: #fff; font-size: 9px; padding: 1px 5px; border-radius: 3px; white-space: nowrap; z-index: 10; pointer-events: none; }
.fs-success-tip { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: rgba(16,185,129,0.18); color: #10b981; font-size: 9px; padding: 1px 5px; border-radius: 3px; white-space: nowrap; z-index: 9; pointer-events: none; }
.fs-actions { display:flex; gap:6px; padding:10px 14px; border-top:1px solid #334155; flex-wrap:wrap; }
.fs-btn { flex:1; padding:8px; border:1px solid #475569; background:#1e293b; color:#94a3b8; border-radius:6px; font-size:12px; cursor:pointer; min-width:0; }
.fs-btn.primary { border-color:#38bdf8; color:#38bdf8; }
.fs-btn.del { border-color:#ef4444; color:#ef4444; }
.fs-btn.del.confirm { background:#ef4444; color:#fff; font-weight:bold; }

.crosshair-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999; pointer-events: none; }
.crosshair-icon { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 48px; color: #f59e0b; text-shadow: 0 0 8px rgba(245,158,11,0.6); }
.crosshair-icon.move-mode { color: #38bdf8; text-shadow: 0 0 12px rgba(56,189,248,0.6); font-size: 56px; }
.crosshair-hint { position: absolute; top: calc(50% + 40px); left: 50%; transform: translateX(-50%); color: #fff; font-size: 13px; background: rgba(0,0,0,0.7); padding: 6px 16px; border-radius: 20px; white-space: nowrap; }
.crosshair-actions { position: fixed; bottom: 64px; left: 0; right: 0; display: flex; gap: 12px; justify-content: center; padding: 12px 24px; pointer-events: auto; }
.crosshair-actions .fs-btn { flex: 1; max-width: 160px; padding: 12px; text-align: center; }

.layer-picker-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 60000; display: flex; align-items: center; justify-content: center; }
.layer-picker-box { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 16px; width: 280px; max-height: 60vh; display: flex; flex-direction: column; }
.picker-title { color: #38bdf8; font-size: 14px; margin-bottom: 12px; text-align: center; }
.picker-list { flex: 1; overflow-y: auto; margin-bottom: 12px; }
.picker-item { padding: 8px 12px; color: #e2e8f0; font-size: 13px; border-bottom: 1px solid #334155; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.picker-item:active { background: rgba(56,189,248,0.1); }
.picker-item.folder { font-weight: bold; color: #38bdf8; font-size: 12px; padding: 6px 12px; }
.picker-item.collapsed { color: #64748b; }
.picker-eye { font-size: 15px; cursor: pointer; flex-shrink: 0; transition: opacity 0.15s; position: relative; }
.picker-eye.off { opacity: 0.25; }
.picker-eye.off::after { content: ''; position: absolute; top: 50%; left: -2px; right: -2px; height: 2px; background: #ef4444; transform: translateY(-50%) rotate(-45deg); border-radius: 1px; }
.picker-folder-toggle { font-size: 10px; flex-shrink: 0; width: 12px; }
.picker-icon { font-size: 13px; flex-shrink: 0; }
.picker-type { color: #64748b; margin-left: auto; flex-shrink: 0; }
.picker-empty { color: #64748b; text-align: center; padding: 20px 0; }
.picker-cancel { width: 100%; padding: 10px; background: #0f172a; border: 1px solid #475569; color: #94a3b8; border-radius: 8px; font-size: 14px; cursor: pointer; }

/* 退出登录确认弹窗 */
.confirm-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 100000; display: flex; align-items: center; justify-content: center; }
.confirm-dialog { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 24px; width: 260px; text-align: center; }
.confirm-text { color: #e2e8f0; font-size: 15px; margin: 0 0 20px 0; }
.confirm-actions { display: flex; gap: 12px; }
.confirm-btn { flex: 1; padding: 10px 0; border-radius: 8px; font-size: 14px; cursor: pointer; border: none; }
.confirm-btn.cancel { background: #334155; color: #94a3b8; }
.confirm-btn.ok { background: #ef4444; color: #fff; }
</style>
<style>
/* Teleport 组件样式（非 scoped） */

/* 照片备注确认面板（底部 Sheet） */
.note-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 100000; display: flex; align-items: flex-end; justify-content: center; }
.note-panel-m { background: #0f172a; border: 1px solid #38bdf8; border-radius: 16px 16px 0 0; max-width: 500px; width: 100vw; padding: 20px; box-sizing: border-box; }
.note-img-m { max-width: 100%; max-height: 30vh; border-radius: 8px; margin-bottom: 12px; object-fit: contain; display: block; margin-left: auto; margin-right: auto; }
.note-input-m { width: 100%; box-sizing: border-box; padding: 12px 14px; background: #020617; border: 1px solid #475569; border-radius: 8px; color: #e2e8f0; font-size: 15px; outline: none; }
.note-input-m:focus { border-color: #38bdf8; }
.note-btns { display: flex; gap: 10px; margin-top: 14px; }
.note-ok-m { flex: 1; padding: 12px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 8px; color: #fff; font-size: 15px; font-weight: bold; cursor: pointer; }
.note-ok-m:hover { background: #0284c7; }
.note-cancel-m { flex: 1; padding: 12px; background: transparent; border: 1px solid #475569; border-radius: 8px; color: #94a3b8; font-size: 15px; cursor: pointer; }

/* lightbox 备注区域 */
.lightbox-note { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgba(0,0,0,0.6); border-top: 1px solid rgba(255,255,255,0.08); }
.lightbox-note-text { flex: 1; color: #94a3b8; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lightbox-note-input { flex: 1; padding: 5px 10px; background: #0f172a; border: 1px solid #38bdf8; border-radius: 4px; color: #e2e8f0; font-size: 13px; outline: none; min-width: 0; }
.lightbox-note-btn { flex-shrink: 0; padding: 4px 10px; background: rgba(56,189,248,0.12); border: 1px solid #38bdf8; border-radius: 4px; color: #38bdf8; font-size: 12px; cursor: pointer; white-space: nowrap; }
.lightbox-note-btn:hover { background: rgba(56,189,248,0.25); }
.lightbox-note-save { flex-shrink: 0; padding: 5px 10px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 4px; color: #fff; font-size: 13px; cursor: pointer; }
.lightbox-note-save:hover { background: #0284c7; }
.lightbox-note-cancel { flex-shrink: 0; padding: 5px 10px; background: transparent; border: 1px solid #475569; border-radius: 4px; color: #94a3b8; font-size: 13px; cursor: pointer; }
</style>
