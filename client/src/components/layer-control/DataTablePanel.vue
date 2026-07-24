<template>
  <div class="data-table-panel">
    <div class="panel-header">
      <div class="header-left">
        <span class="icon">🗄️</span>
        <h2 class="title">喀什城市体检-更新数据工作台</h2>
        <div class="role-badge" :class="mapState.auth.role">
          {{ mapState.auth.role === 'admin' ? '🛡️ 管理员' : '✏️ 数据专员' }}
        </div>
      </div>
      
      <div class="header-right">
        <div class="result-count">
          匹配结果：<span>{{ filteredFeatures.length }}</span> / {{ totalCount }}
        </div>
         <button class="export-btn" @click="exportExcel" title="导出当前筛选结果为 Excel">📥 Excel</button>
        <button class="export-btn" @click="exportGeoJson" title="导出该图层 GeoJSON 文件">📥 GeoJSON</button>
        <button v-if="mapState.editor.isEditing" class="export-btn" @click="triggerImportExcel" title="从 Excel 导入数据：可选择新建图层或按字段匹配合并到已有图层">📤 导入Excel</button>
        <button v-if="mapState.editor.isEditing" class="export-btn" @click="cleanupLayerFragments" title="清理退化碎片(MultiPolygon 中面积<1m² 的子部件)并规范化 OBJECTID">🧹 清理碎片</button>
        <button v-if="mapState.editor.isEditing" class="export-btn" @click="migrateGrouping" title="把分组从字段名前缀迁移为独立元数据（字段名变干净，分组/格式不变）">🔧 迁移分组</button>
        <button v-if="mapState.editor.isEditing" class="export-btn" @click="renumberOids" title="按当前排序和筛选顺序重新编号所有要素的 OBJECTID">🔢 更新序号</button>
        <button class="close-btn" @click="closeTable">退出工作台</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="tool-group">
        <label>分析图层：</label>
        <select v-model="activeLayerId" class="tech-select" @change="resetFilters">
          <option v-for="layer in geojsonLayers" :key="layer.id" :value="layer.id">{{ layer.name }}</option>
        </select>
      </div>

      <div class="tool-group logic-group">
        <select v-model="logicalMode" class="tech-select mini-mode">
          <option value="OR">满足任一 (OR)</option>
          <option value="AND">满足所有 (AND)</option>
        </select>
      </div>

      <template v-if="currentSchema">
        <div class="divider"></div>
        <div class="tool-group">
          <label>精确筛选：</label>
          <select v-model="filter1.field" class="tech-select" @change="filter1.value = ''">
            <option value="">-- 选择字段 --</option>
            <option v-for="(config, key) in currentSchema" :key="key" :value="key">{{ key }}</option>
          </select>
          <select v-if="filter1.field" v-model="filter1.value" class="tech-select mini">
            <option value="">-- 不限 --</option>
            <option v-for="opt in currentSchema[filter1.field]?.options || []" :key="opt" :value="opt">{{ opt }}</option>
          </select>
        </div>

        <div class="tool-group search-group">
          <label>关键词搜索：</label>
          <select v-model="search.field" class="tech-select" @change="search.keyword = ''">
            <option value="">-- 选择搜索字段 --</option>
            <option v-for="(config, key) in currentSchema" :key="key" :value="key">{{ key }}</option>
          </select>
          <div class="autocomplete-wrapper" v-if="search.field">
            <input 
              type="text" 
              v-model="search.keyword" 
              class="tech-input search-input" 
              placeholder="输入并选择..." 
              @focus="showSuggestions = true"
            />
            <ul class="suggestions-list" v-show="showSuggestions && searchSuggestions.length > 0">
              <li v-for="sug in searchSuggestions" :key="sug" @mousedown="selectSuggestion(sug)">{{ sug }}</li>
            </ul>
          </div>
        </div>

        <template v-if="mapState.editor.isEditing">
          <div class="divider"></div>
          <div class="tool-group">
            <label>添加字段：</label>
            <input type="text" v-model="newFieldKey" :placeholder="addFieldHint ? '↑ 在此输入新字段名，点添加' : '字段名'" class="field-key-input add-field-key" :class="{ 'hint-active': addFieldHint }" @keyup.enter="handleAddField" @blur="onAddFieldBlur" />
            <select v-model="newFieldType" class="field-type-sel">
              <option value="text">文本</option>
              <option value="int">整数</option>
              <option value="float">小数</option>
              <option value="percent">百分比</option>
              <option value="date">日期</option>
              <option value="daterange">时间段</option>
              <option value="select">下拉选项</option>
              <option value="boolean">布尔/勾选</option>
              <option value="image">图片</option>
            </select>
            <select v-model="newFieldGroup" class="field-group-sel">
              <option value="">基本信息</option>
              <option v-for="g in addFieldGroups" :key="g.key" :value="g.key">{{ g.label }}</option>
              <option value="__new__">＋新分组</option>
            </select>
            <input v-if="newFieldGroup === '__new__'" v-model="newFieldGroupLabel" placeholder="分组名称" class="field-group-name-input" @keyup.enter="handleAddField" />
            <button class="add-field-btn" @click="handleAddField">+ 添加</button>
            <button v-if="isDecoupledLayer(activeLayerId)" class="sort-panel-btn" @click="showSortPanel = true" title="打开字段排序面板">↕ 排序</button>
          </div>
        </template>
      </template>
    </div>

    <div class="table-container" @click="showSuggestions = false">
      <div class="table-scroll" ref="tableScrollEl" @scroll="onTableScroll">
      <table class="tech-table" :class="{ 'is-editing': mapState.editor.isEditing, grouped: fieldGroups.length > 1 }" v-if="currentSchema">
      <!-- colgroup 控制列折叠，浏览器原生支持 -->
      <colgroup>
        <col class="locate-col">
        <col class="oid-col">
        <col v-for="key in orderedFieldKeys" :key="key"
          :class="{ 'col-collapsed': collapsedGroups.has(fieldGroupMap[key]) && !groupParentKeys.has(key) }">
      </colgroup>
      <thead>
        <!-- 分组标题行 -->
        <tr v-if="fieldGroups.length > 1" class="group-header-row">
          <th class="sticky-col center"></th>
          <th class="oid-cell"></th>
          <th v-for="group in fieldGroups" :key="group.key"
            :colspan="getGroupFieldKeys(group).length"
            class="group-header-cell"
            :class="{ collapsed: collapsedGroups.has(group.key), 'frz-group': group.key === fieldGroups[0]?.key }"
            @click="toggleGroup(group.key)">
            <span class="group-toggle">{{ collapsedGroups.has(group.key) ? '▶' : '▼' }}</span>
            <input v-if="renamingGroup === group.key" v-model="groupRenameValue" class="group-rename-input" @blur="finishGroupRename(group)" @keyup.enter="finishGroupRename(group)" @keyup.escape="renamingGroup = null" @click.stop />
            <span v-else>{{ group.label }}</span>
            <button v-if="renamingGroup !== group.key && isDecoupledLayer(activeLayerId) && mapState.editor.isEditing" class="group-rename-btn" @click.stop="startGroupRename(group)" title="重命名分组">✏️</button>
            <button v-if="renamingGroup !== group.key && !isDecoupledLayer(activeLayerId) && mapState.editor.isEditing" class="group-migrate-btn" @click.stop="repairGrouping" title="迁移字段分组（将前缀编码转为元数据）">🔧</button>
          </th>
        </tr>
        <!-- 字段名行 -->
        <tr class="field-name-row">
          <th class="sticky-col center">定位</th>
          <th class="field-header oid-cell" title="业务主键">
            <div class="readonly-header"><span>OBJECTID</span></div>
            <div class="oid-bottom-row">
              <span class="oid-lock">🔒</span>
              <span class="sort-indicator oid-sort sortable" :class="{ active: sortField === 'OBJECTID' }" @click.stop="toggleSort('OBJECTID')">{{ sortField === 'OBJECTID' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅' }}</span>
            </div>
            <button v-if="mapState.editor.isEditing && isDecoupledLayer(activeLayerId)"
              class="col-insert-handle" @click.stop="startInlineAddHead" title="在最前面新增字段">＋</button>
          </th>
          
          <th v-for="key in orderedFieldKeys" :key="key" class="field-header"
            :class="{ 'frz-first': key === orderedFieldKeys[0], 'th-collapsed': collapsedGroups.has(fieldGroupMap[key]) && !groupParentKeys.has(key), 'drag-over': dragOverKey === key }"
            :draggable="mapState.editor.isEditing && isDecoupledLayer(activeLayerId)"
            @dragstart="onFieldDragStart($event, key)"
            @dragover.prevent="onFieldDragOver($event, key)"
            @dragleave="onFieldDragLeave(key)"
            @drop="onFieldDrop($event, key)"
            @dragend="onFieldDragEnd"
            :data-group="fieldGroupMap[key]">
            <span v-if="mapState.editor.isEditing && isDecoupledLayer(activeLayerId)" class="drag-handle" title="拖拽调整列顺序">⋮⋮</span>
            <span class="sort-indicator head-sort sortable" :class="{ active: sortField === key }" @click.stop="toggleSort(key)">{{ sortField === key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅' }}</span>
            <button v-if="mapState.editor.isEditing && key.toUpperCase() !== 'OBJECTID' && isDecoupledLayer(activeLayerId)"
              class="col-insert-handle" @click.stop="startInlineAdd(key)" title="在此列之后新增字段">＋</button>
            <div v-if="mapState.editor.isEditing && key.toUpperCase() === 'OBJECTID'" class="readonly-header" title="系统主键，禁止重命名">{{ key }} 🔒</div>
            <div v-else-if="mapState.editor.isEditing" class="header-edit-group" @click.stop>
              <textarea :value="key" @change="handleHeaderEdit(key, $event.target.value)" @input="autoResizeTextarea" @click.stop class="header-edit-input" title="修改字段名称 (回车生效)" rows="1"></textarea>
              <div class="header-edit-row2">
                <button class="header-del-btn" @click="handleDeleteField(key)" title="删除此字段">×</button>
                <button v-if="key.toUpperCase() !== 'OBJECTID'"
                  class="header-format-btn" @click.stop="openFormatPanel(key)"
                  title="设置字段格式">⚙</button>
                <span v-if="fieldSchema[activeLayerId]?.[key]?.format" class="format-tag">
                  {{ {text:'文本',int:'整数',float:'小数',percent:'百分比',date:'日期',daterange:'时间段',select:'下拉选项',boolean:'布尔/勾选',image:'图片'}[fieldSchema[activeLayerId][key].format] || fieldSchema[activeLayerId][key].format }}
                </span>
                <div v-if="showFormatPanel === key" class="format-dropdown" @click.stop>
                <div class="format-option" v-for="fmt in ['text','int','float','percent','date','daterange','select','boolean','image']" :key="fmt"
                  :class="{ active: (fieldSchema[activeLayerId]?.[key]?.format || 'text') === fmt }"
                  @click="fmt === 'select' ? openOptionsEditor(key) : setFieldFormat(key, fmt)">
                  {{ {text:'文本',int:'整数',float:'小数',percent:'百分比',date:'日期',daterange:'时间段',select:'下拉选项',boolean:'布尔/勾选',image:'图片'}[fmt] }}
                </div>
              </div>
              </div>
            </div>
            <div v-else class="header-view-group">
              <span>{{ key }}</span>
              <span v-if="fieldSchema[activeLayerId]?.[key]?.format" class="format-tag">
                {{ {text:'文本',int:'整数',float:'小数',percent:'百分比',date:'日期',daterange:'时间段',select:'下拉选项',boolean:'布尔/勾选',image:'图片'}[fieldSchema[activeLayerId][key].format] || fieldSchema[activeLayerId][key].format }}
              </span>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="displayFeatures.length === 0">
          <td :colspan="orderedFieldKeys.length + 2" style="text-align:center;color:#64748b;padding:32px 0;">
            📝 该图层暂无要素（请在地图界面编辑模式中添加）
          </td>
        </tr>
        <template v-else>
        <tr v-for="(feature, idx) in displayFeatures" :key="feature.id + '_' + idx">
          <td class="sticky-col action-cell center">
            <button class="action-btn" @click="flyToFeature(feature)" title="定位到地图">⌖</button>
            <button v-if="mapState.editor.isEditing" class="action-btn bind-btn" @click="startBindDraw(feature)" title="绘制/重绘图形">✏️</button>
          </td>
          
          <td class="data-cell oid-cell">
            <span class="table-text readonly-text" title="业务主键">
              {{ feature.properties?.OBJECTID || feature.properties?.FID || feature.id }}
            </span>
          </td>

          <td v-for="key in orderedFieldKeys" :key="key" class="data-cell"
            :class="{ 'frz-first': key === orderedFieldKeys[0], 'th-collapsed': collapsedGroups.has(fieldGroupMap[key]) && !groupParentKeys.has(key) }"
            :data-group="fieldGroupMap[key]"
            @dblclick="startCellEdit(feature.id, key)">
            
            <template v-if="key.toUpperCase() === 'OBJECTID'">
               <span class="table-text readonly-text" title="系统主键，不可修改">
                 {{ feature.properties?.[key] }}
               </span>
            </template>

            <template v-else-if="fieldSchema[activeLayerId]?.[key]?.format === 'image'">
               <span class="image-cell" @click.stop="viewTablePhotos(feature.properties?.[key], key, feature.properties?.OBJECTID, activeLayerId)" style="cursor:pointer">
                 <template v-if="feature.properties?.[key]">
                   <span class="image-count">🖼 {{ parsePhotos(feature.properties[key]).length }}张</span>
                 </template>
                 <span v-else class="image-empty">--</span>
               </span>
            </template>

            <template v-else-if="fieldSchema[activeLayerId]?.[key]?.format === 'boolean'">
               <span class="bool-cell">
                 <input type="checkbox" :checked="feature.properties?.[key] === 'True'" :disabled="!mapState.editor.isEditing" @click.stop="mapState.editor.isEditing && toggleBoolean(feature, key)" />
               </span>
            </template>

            <template v-else-if="activeEditCell.id === feature.id && activeEditCell.field === key">
              <template v-if="fieldSchema[activeLayerId]?.[key]?.format === 'select'">
                <div v-if="isSelectCustom(feature.properties[key], fieldSchema[activeLayerId][key].options)" style="display:flex;gap:2px;position:absolute;inset:0;">
                  <select :value="selectDisplayVal(feature.properties[key], fieldSchema[activeLayerId][key].options)"
                    @change="onCellSelectPick(feature, key, $event.target.value)"
                    class="excel-edit-input" style="flex:1;position:static;background:#020617;color:#fff;border:2px solid #38bdf8;">
                    <option v-for="opt in fieldSchema[activeLayerId][key].options" :key="opt" :value="opt">{{ opt }}</option>
                    <option value="__other__">其他</option>
                  </select>
                  <input type="text"
                    :value="getCustomPart(feature.properties[key])"
                    @input="e => { feature.properties[key] = '其他: ' + (e.target.value || ''); }"
                    @blur="saveAndCloseCell(feature.id, key)" @keyup.enter="$event.target.blur()"
                    class="excel-edit-input" style="flex:1.5;position:static;" />
                </div>
                <select v-else :value="selectDisplayVal(feature.properties[key], fieldSchema[activeLayerId][key].options)"
                  @change="onCellSelectPick(feature, key, $event.target.value)"
                  class="excel-edit-input" style="background:#020617;color:#fff;border:2px solid #38bdf8;">
                  <option v-for="opt in fieldSchema[activeLayerId][key].options" :key="opt" :value="opt">{{ opt }}</option>
                  <option value="__other__">其他</option>
                </select>
              </template>
              <input v-else type="text" v-model="feature.properties[key]"
                @blur="saveAndCloseCell(feature.id, key)" @keyup.enter="$event.target.blur()"
                class="excel-edit-input" v-focus />
            </template>

            <template v-else>
              <span class="table-text" :class="{ 'editable-text': mapState.editor.isEditing }"
                :style="(fieldSchema[activeLayerId]?.[key]?.format === 'date' || fieldSchema[activeLayerId]?.[key]?.format === 'daterange') ? 'color:#38bdf8;' : ''"
                :title="mapState.editor.isEditing ? '双击修改' : (feature.properties?.[key] || '')">
                {{ feature.properties?.[key] || '--' }}
              </span>
            </template>
            
          </td>
        </tr>
        </template>
      </tbody>
    </table>

    <div v-else-if="filteredFeatures.length === 0" class="empty-state">
      <div class="warning-box">
        <h3 v-if="totalCount === 0">📝 该图层暂无要素</h3>
        <p v-if="totalCount === 0">请在地图界面进入编辑模式后添加要素</p>
        <h3 v-else>🔎 暂无匹配数据</h3>
      </div>
    </div>
    </div>

    <div class="pagination-controls" v-if="filteredFeatures.length > 0">
      <div class="page-info">
        共 <span>{{ filteredFeatures.length }}</span> 条记录，
        当前显示第 {{ (currentPage - 1) * pageSize + 1 }} - {{ Math.min(currentPage * pageSize, filteredFeatures.length) }} 条
      </div>

      <div class="page-buttons">
        <button class="page-btn" :disabled="currentPage === 1" @click="currentPage--">◀ 上一页</button>
        <span class="page-current">第 <b>{{ currentPage }}</b> / {{ totalPages }} 页</span>
        <button class="page-btn" :disabled="currentPage === totalPages" @click="currentPage++">下一页 ▶</button>
      </div>
    </div>
    </div>
  </div>

  <!-- 照片 lightbox -->
  <Teleport to="body">
    <div v-if="photoBox.visible" class="lightbox-mask" @click="closePhotoBox" @keydown.esc="closePhotoBox">
      <button class="lightbox-close" @click.stop="closePhotoBox">✕</button>
      <div class="lightbox-img-wrap" @click.stop>
        <img v-for="(url, i) in photoBox.urls" :key="i" :src="url" :style="{ display: i === photoBox.index ? 'block' : 'none' }" />
      </div>
      <div class="lightbox-bar" @click.stop>
        <button v-if="photoBox.urls.length > 1" class="lightbox-nav" @click.stop="photoBoxNav(-1)">◀</button>
        <span class="lightbox-counter">{{ photoBox.index + 1 }} / {{ photoBox.urls.length }}</span>
        <button v-if="photoBox.urls.length > 1" class="lightbox-nav" @click.stop="photoBoxNav(1)">▶</button>
        <button v-if="mapState.editor.isEditing" class="lightbox-del" @click.stop="deleteTablePhoto">🗑️ 删除</button>
      </div>
      <div class="lightbox-note" @click.stop>
        <template v-if="editingPhotoBoxNote">
          <input v-model="photoBoxNoteDraft" class="lightbox-note-input" placeholder="输入备注说明" @keyup.enter="savePhotoBoxNote" @keyup.escape="cancelEditPhotoBoxNote" />
          <button @click="savePhotoBoxNote" class="lightbox-note-save">✓</button>
          <button @click="cancelEditPhotoBoxNote" class="lightbox-note-cancel">✕</button>
        </template>
        <template v-else>
          <span v-if="currentPhotoBoxNote" class="lightbox-note-text" :title="currentPhotoBoxNote">{{ currentPhotoBoxNote }}</span>
          <button v-if="mapState.editor.isEditing" @click="startEditPhotoBoxNote" class="lightbox-note-btn">{{ currentPhotoBoxNote ? '✏️' : '➕ 添加备注' }}</button>
        </template>
      </div>
    </div>
  </Teleport>

  <!-- 统一导入 Modal（新建 + 合并） -->
  <ImportModal :key="importModalKey" :visible="importModalVisible" :active-layer-id="activeLayerId"
               @close="importModalVisible = false"
               @imported="onImportComplete" @merged="onMergeComplete" />

  <!-- 清理碎片预览弹窗 -->
  <Teleport to="body">
    <div v-if="cleanupPreview.lines" class="lightbox-mask" style="z-index:100001; display:flex; align-items:center; justify-content:center;" @click.self="cleanupPreview.resolve(false)">
      <div class="cleanup-dialog" @click.stop>
        <div class="cleanup-title">🧹 清理预览</div>
        <div class="cleanup-body">
          <div v-for="(line, i) in cleanupPreview.lines" :key="i" class="cleanup-line" :class="{ 'cleanup-warn': line.includes('异常'), 'cleanup-info': line.includes('示例'), 'cleanup-muted': line.includes('退化') || line.includes('重复') }">{{ line }}</div>
        </div>
        <div class="cleanup-footer">
          <button class="cleanup-btn cancel" @click="cleanupPreview.resolve(false)">取消</button>
          <button class="cleanup-btn confirm" @click="cleanupPreview.resolve(true)">✓ 确认执行（自动备份可回滚）</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 几何类型选择弹窗（替换浏览器原生 prompt） -->
  <Teleport to="body">
    <div v-if="bindGeomVisible" class="lightbox-mask" style="z-index:100001; display:flex; align-items:center; justify-content:center;" @click.self="selectBindGeom(null)">
      <div class="geom-select-dialog" @click.stop>
        <div class="geom-select-title">选择几何要素类型</div>
        <div class="geom-select-subtitle">首次设置后不可更改</div>
        <div class="geom-select-options">
          <button class="geom-option" @click="selectBindGeom('point')">
            <span class="geom-icon">🔵</span><span>点要素</span>
          </button>
          <button class="geom-option" @click="selectBindGeom('polyline')">
            <span class="geom-icon">📏</span><span>线要素</span>
          </button>
          <button class="geom-option" @click="selectBindGeom('polygon')">
            <span class="geom-icon">⬡</span><span>面要素</span>
          </button>
        </div>
        <button class="geom-cancel" @click="selectBindGeom(null)">取消</button>
      </div>
    </div>

    <!-- 下拉选项编辑弹窗 -->
    <div v-if="showOptionsEditor" class="lightbox-mask" style="z-index:100002; display:flex; align-items:center; justify-content:center;" @click.self="cancelOptionsEditor">
      <div class="options-editor-dialog" @click.stop>
        <div class="options-editor-title">编辑下拉选项 — "{{ optionsEditorFieldKey }}"</div>
        <textarea v-model="formatOptions[optionsEditorFieldKey]" placeholder="每行一个选项" rows="10"
          class="options-editor-textarea"></textarea>
        <p class="options-editor-hint">每行一个选项，空行会被忽略</p>
        <div class="options-editor-actions">
          <button class="action-btn secondary" @click="cancelOptionsEditor">取消</button>
          <button class="action-btn" @click="confirmOptionsEditor">确认</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 字段排序面板 -->
  <Teleport to="body">
    <div v-if="showSortPanel" class="lightbox-mask" style="z-index:100003; display:flex; align-items:center; justify-content:center;" @click.self="showSortPanel = false">
      <div class="sort-panel-dialog" @click.stop>
        <div class="sort-panel-header">
          <h4>↕ 字段排序</h4>
          <button class="close-btn" @click="showSortPanel = false">✖</button>
        </div>
        <div class="sort-panel-body">
          <p class="sort-panel-hint">拖拽字段调整顺序，可在同组内或跨组移动。完成后点"应用"保存。</p>
          <div v-for="group in sortPanelGroups" :key="group.key" class="sort-group">
            <div class="sort-group-label">{{ group.label }}</div>
            <draggable v-model="group.children" item-key="key" :group="{ name: 'sortFields', pull: true, put: true }"
              class="sort-field-list" ghost-class="sort-ghost" @change="onSortPanelChange">
              <template #item="{ element: field }">
                <div class="sort-field-item">
                  <span class="sort-field-drag">⋮⋮</span>
                  <span class="sort-field-name">{{ field.key }}</span>
                  <span v-if="field.config?.format" class="sort-field-tag">{{ {text:'T',int:'#',float:'#.#',percent:'%',date:'📅',daterange:'📅~',select:'📋',boolean:'☑',image:'🖼'}[field.config.format] || field.config.format }}</span>
                </div>
              </template>
            </draggable>
          </div>
        </div>
        <div class="sort-panel-actions">
          <button class="action-btn secondary" @click="showSortPanel = false">取消</button>
          <button class="action-btn" @click="applySortPanel">✅ 应用</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 日期/时间段弹窗选择器 -->
  <Teleport to="body">
    <div v-if="dateEditor.open" class="date-editor-backdrop" @click.self="dateEditorCancel">
      <div class="date-editor-dialog" @click.stop>
        <div class="date-editor-header">{{ dateEditor.fieldKey }}</div>
        <div class="date-editor-body">
          <template v-if="dateEditor.type === 'date'">
            <input type="date" v-model="dateEditor.val" min="1900-01-01" max="2099-12-31" class="date-editor-input" />
          </template>
          <template v-else>
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="date" v-model="dateEditor.startVal" min="1900-01-01" max="2099-12-31" class="date-editor-input" />
              <span style="color:#94a3b8;">~</span>
              <input type="date" v-model="dateEditor.endVal" min="1900-01-01" max="2099-12-31" class="date-editor-input" />
            </div>
          </template>
        </div>
        <div class="date-editor-actions">
          <button class="action-btn secondary" @click="dateEditorCancel">取消</button>
          <button class="action-btn" @click="dateEditorConfirm">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, reactive, watch, toRaw, nextTick, onActivated } from 'vue';
import draggable from 'vuedraggable';
import * as Cesium from 'cesium';
import { mapState, fieldSchema, fieldGroupsMeta, getFlatLayers, getLayerState, showToast, hideToast, loadFieldFormat, parsePhotos } from '../../store/mapState';
import { getViewer } from '../../core/viewer/ViewerSetup';
import { getLayer, loadGeoJsonLayer, reloadLayer, toggleLayerVisibility, refreshExtrudedHeight } from '../../core/layers/LayerManager';
import { acquireSchemaLock, releaseSchemaLock, acquireFeatureLock, releaseFeatureLock, checkLayerStale, checkTreeStale } from '../../core/locks';
import { saveFeature } from '../../core/saveFeature';
import { parseFieldGroups, getGroupFieldKeys, shouldAutoExpand } from '../../core/fieldGroups';
import { isDecoupledLayer, resolveGroupAssignment, persistNewFieldMeta, computeInsertOrder } from '../../core/fieldSchemaOps';
import { validateFieldValue, isSelectCustom, getCustomPart, selectDisplayVal } from '../../core/fieldValidation';
import * as XLSX from 'xlsx';
import ImportModal from './ImportModal.vue';

// ==========================================
// 🌟 核心：Excel级单元格编辑状态管理
// ==========================================
// 1. 记录当前激活的单元格
const activeEditCell = ref({ id: null, field: null });

// 2. 自动聚焦指令
const vFocus = {
  mounted: (el) => el.focus()
};

// 3. 双击触发编辑 + 获取要素锁（日期/时间段走弹窗选择器）
const startCellEdit = async (id, field) => {
  if (!mapState.editor.isEditing || field.toUpperCase() === 'OBJECTID') return;
  const fmt = fieldSchema[activeLayerId.value]?.[field]?.format;
  if (fmt === 'date' || fmt === 'daterange') {
    openDateEditor(id, field, fmt);
    return;
  }
  const layer = getLayerState(activeLayerId.value);
  const feat = layer?.features?.find(f => f.id === id);
  const stableId = (feat?.properties?.OBJECTID) ? String(feat.properties.OBJECTID) : id;
  const lockRes = await acquireFeatureLock(activeLayerId.value, stableId);
  if (lockRes.error) { alert(lockRes.error); return; }
  if (lockRes.stale) {
    releaseFeatureLock(activeLayerId.value, stableId);
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager.js');
    await reloadLayer(activeLayerId.value);
    hideToast();
    await nextTick();
    const layerAfter = getLayerState(activeLayerId.value);
    if (layerAfter?.features) {
      const idx = layerAfter.features.findIndex(f => String(f.properties?.OBJECTID) === stableId || f.id === id);
      if (idx >= 0) currentPage.value = Math.floor(idx / pageSize.value) + 1;
    }
    return;
  }
  activeEditCell.value = { id, field, stableId, origValue: feat?.properties?.[field] };
};
// ==========================================

const activeLayerId = ref('polygon-blocks');
const logicalMode = ref('OR'); 
const showSuggestions = ref(false);
const showFormatPanel = ref(null); // field key of open panel, or null
const formatOptions = reactive({}); // fieldKey → textarea content for select options
const showOptionsEditor = ref(false); // 下拉选项编辑弹窗
const optionsEditorFieldKey = ref(null);

watch(activeLayerId, async (newLayerId) => {
  mapState.editor.selectedLayerId = newLayerId;

  // 检查图层树结构是否有变更
  if (mapState.editor.isEditing) {
    const treeStale = await checkTreeStale();
    if (treeStale) {
      showToast('检测到图层列表有更新...', 'info', 0);
      const { loadLayerConfig: lc } = await import('../../store/mapState.js');
      await lc();
      const { syncTreeLayers: stl } = await import('../../core/layers/LayerManager.js');
      await stl();
      hideToast();
    }
  }

  const layer = getLayerState(newLayerId);
  if (!layer) return;

  // 按需加载：选中隐藏图层时触发 GeoJSON 加载
  if (!getLayer(newLayerId) && layer.type === 'geojson' && layer.url) {
    await loadGeoJsonLayer(layer, getViewer());
  }

  if (!layer || !layer.features) return;
  const viewer = getViewer();
  if (!viewer) return;

  // 👇 下面这些从 Cesium 实体中提取属性的优秀逻辑，一行都不用改！
  layer.features.forEach(f => {
    if (!f.properties) {
      let entity = viewer.entities.getById(f.id);
      if (!entity) {
        for (let i = 0; i < viewer.dataSources.length; i++) {
          entity = viewer.dataSources.get(i).entities.getById(f.id);
          if (entity) break;
        }
      }
      const props = {};
      if (entity && entity.properties) {
        entity.properties.propertyNames.forEach(name => {
          let val = entity.properties[name];
          props[name] = (val && typeof val.getValue === 'function') 
            ? val.getValue(Cesium.JulianDate.now()) 
            : val;
        });
      }
      f.properties = props; 
    }
  });
}, { immediate: true });

// 🌟 修复：直接在组件内进行深度递归，确保 Vue 能 100% 追踪图层树的任何变化
const geojsonLayers = computed(() => {
  const result = [];
  const traverse = (nodes) => {
    if (!nodes || !Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === 'folder' && node.children) {
        traverse(node.children); // 遇到文件夹，钻进去找
      } else if (node.type === 'geojson') {
        result.push(node); // 找到目标，推入数组
      }
    }
  };
  traverse(mapState.layerTree); // 触发响应式收集
  return result;
});
const currentSchema = computed(() => fieldSchema[activeLayerId.value] || null);

// 字段分组
const fieldGroups = computed(() => parseFieldGroups(currentSchema.value, fieldGroupsMeta[activeLayerId.value]));

// 列渲染/导出的唯一顺序来源：先放 parseFieldGroups 未覆盖的 key（如 OBJECTID，保持原序），
// 再按分组序（基本信息→数字组升序）追加各组字段。保证每个 schema key 恰好出现一次，
// 列顺序与分组标题行 colspan 同源，从结构上消除错位。
const orderedFieldKeys = computed(() => {
  const schema = currentSchema.value || {};
  const inGroups = new Set();
  const ordered = [];
  for (const group of fieldGroups.value) {
    for (const k of getGroupFieldKeys(group)) {
      ordered.push(k);
      inGroups.add(k);
    }
  }
  const leftover = Object.keys(schema).filter(k => !inGroups.has(k));
  return [...leftover, ...ordered];
});

const collapsedGroups = ref(new Set());

const toggleGroup = (groupKey) => {
  if (collapsedGroups.value.has(groupKey)) {
    collapsedGroups.value.delete(groupKey);
  } else {
    collapsedGroups.value.add(groupKey);
  }
  // 触发响应式更新
  collapsedGroups.value = new Set(collapsedGroups.value);
};

const repairGrouping = async () => {
  await migrateGrouping();
};

const startGroupRename = (group) => {
  renamingGroup.value = group.key;
  groupRenameValue.value = group.label;
  nextTick(() => {
    const inp = document.querySelector('.group-rename-input');
    if (inp) { inp.focus(); inp.select(); }
  });
};

const finishGroupRename = async (group) => {
  if (renamingGroup.value !== group.key) return;
  renamingGroup.value = null;
  const newLabel = groupRenameValue.value.trim();
  if (!newLabel || newLabel === group.label) return;

  const layerId = activeLayerId.value;
  if (!layerId || !isDecoupledLayer(layerId)) return;

  const lockRes = await acquireSchemaLock(layerId);
  if (lockRes.error) { showToast(lockRes.error, 'error'); return; }
  const stale = await checkLayerStale(layerId);
  if (stale) {
    await releaseSchemaLock(layerId);
    showToast('检测到图层有更新，已刷新，请重试', 'warning');
    const { reloadLayer } = await import('../../core/layers/LayerManager.js');
    await reloadLayer(layerId);
    return;
  }

  let meta = fieldGroupsMeta[layerId];
  // 半迁移状态：groups 数组缺失但从 fieldSchema 的 group 分配中重建
  if (!meta) {
    const schema = fieldSchema[layerId] || {};
    const gmap = {};
    for (const [k, v] of Object.entries(schema)) {
      const gid = v?.group;
      if (gid && !gmap[gid]) { gmap[gid] = { id: gid, label: gid, order: Object.keys(gmap).length, children: [] }; }
    }
    meta = Object.values(gmap).sort((a,b) => a.order - b.order);
    fieldGroupsMeta[layerId] = meta;
  }
  const g = meta.find(m => m.id === group.key);
  if (g) g.label = newLabel;

  try {
    const { saveFieldFormat } = await import('../../store/mapState.js');
    const schema = fieldSchema[layerId] || {};
    const fields = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k.toUpperCase() === 'OBJECTID') continue;
      const entry = {};
      if (v.format) entry.format = v.format;
      if (v.format === 'select' && v.options) entry.options = v.options;
      if (v.group !== undefined) entry.group = v.group;
      if (v.order !== undefined) entry.order = v.order;
      if (Object.keys(entry).length) fields[k] = entry;
    }
    await saveFieldFormat(layerId, fields, meta);
  } catch (e) {
    showToast('保存分组名称失败', 'error');
  }

  await checkLayerStale(layerId);
  releaseSchemaLock(layerId);
};

// 当前显示的要素中，任一行的父字段为 True → 自动展开对应分组
const checkAutoExpand = () => {
  if (!displayFeatures.value) return;
  const autoExpand = new Set();
  for (const group of fieldGroups.value) {
    if (collapsedGroups.value.has(group.key)) continue; // 用户手动折叠过的组不强制展开
    for (const f of displayFeatures.value) {
      if (shouldAutoExpand(group, f.properties)) {
        autoExpand.add(group.key);
        break;
      }
    }
  }
  for (const gk of autoExpand) collapsedGroups.value.delete(gk);
};

// 字段 → 所属分组 key 的映射
const fieldGroupMap = computed(() => {
  const map = {};
  for (const group of fieldGroups.value) {
    const keys = getGroupFieldKeys(group);
    for (const k of keys) map[k] = group.key;
  }
  return map;
});

// 每组第一列（父字段或首个字段），折叠时保留显示，避免表格错位
const groupParentKeys = computed(() => {
  const set = new Set();
  for (const group of fieldGroups.value) {
    if (group.parentField) {
      set.add(group.parentField);
    } else if (group.children.length > 0) {
      set.add(group.children[0].key);
    }
  }
  return set;
});

const filter1 = reactive({ field: '', value: '' });
const search = reactive({ field: '', keyword: '' });

// 🌟 统一的单元格保存与同步流
// 🌟 查找 entity 的统一入口：优先当前图层专属 DataSource，避免跨图层 ID 碰撞
const _findEntity = (entityId) => {
  const viewer = getViewer();
  if (!viewer) return null;
  const ds = getLayer(activeLayerId.value);
  // 优先按 OBJECTID 遍历匹配（reload 后 Cesium ID 变化；saveFeature 后 layer.features[].id 可能已是 OBJECTID）
  const candidates = ds instanceof Cesium.GeoJsonDataSource ? ds.entities.values : viewer.entities.values;
  const sid = String(entityId);
  for (const e of candidates) {
    if (!e.properties) continue;
    const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
    if (ep && String(ep.OBJECTID) === sid) return e;
  }
  // 回退：按 Cesium entity ID 匹配
  const e1 = ds instanceof Cesium.GeoJsonDataSource ? ds.entities.getById(entityId) : null;
  if (e1) return e1;
  let e2 = viewer.entities.getById(entityId);
  if (e2) return e2;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    e2 = viewer.dataSources.get(i).entities.getById(entityId);
    if (e2) return e2;
  }
  return null;
};


// ========== 日期/时间段弹窗选择器 ==========
const dateEditor = reactive({ open: false, type: 'date', featureId: null, fieldKey: null, val: '', startVal: '', endVal: '' });

const openDateEditor = (featureId, fieldKey, fmt) => {
  const layer = getLayerState(activeLayerId.value);
  const feat = layer?.features?.find(f => f.id === featureId);
  const curVal = feat?.properties?.[fieldKey] || '';
  const stableId = (feat?.properties?.OBJECTID) ? String(feat.properties.OBJECTID) : featureId;
  // 设置 activeEditCell 以记录 origValue，供 saveAndCloseCell 中的冲突自动合并使用
  activeEditCell.value = { id: featureId, field: fieldKey, stableId, origValue: curVal };
  dateEditor.featureId = featureId;
  dateEditor.fieldKey = fieldKey;
  dateEditor.type = fmt;
  if (fmt === 'date') {
    dateEditor.val = curVal;
  } else {
    const parts = (curVal || '').split(' ~ ');
    dateEditor.startVal = parts[0]?.trim() || '';
    dateEditor.endVal = parts[1]?.trim() || '';
  }
  dateEditor.open = true;
  nextTick(() => {
    const el = document.querySelector('.date-editor-input');
    if (el) el.focus();
  });
};

const dateEditorConfirm = async () => {
  const layer = getLayerState(activeLayerId.value);
  const feat = layer?.features?.find(f => f.id === dateEditor.featureId);
  if (!feat) { dateEditor.open = false; return; }
  let newVal;
  if (dateEditor.type === 'date') {
    newVal = dateEditor.val || '';
  } else {
    const s = dateEditor.startVal?.trim() || '';
    const e = dateEditor.endVal?.trim() || '';
    newVal = (s && e) ? `${s} ~ ${e}` : '';
  }
  feat.properties[dateEditor.fieldKey] = newVal;
  dateEditor.open = false;
  await saveAndCloseCell(dateEditor.featureId, dateEditor.fieldKey);
};

const dateEditorCancel = () => { dateEditor.open = false; };

let savingCell = false; // 防快速连续操作导致并发 saveFeature（saveAndCloseCell + toggleBoolean 共用）

// 下拉"其他"组合框：选中预设选项立即保存，选中"其他"等待自定义输入
const onCellSelectPick = (feature, key, newVal) => {
  if (newVal === '__other__') {
    feature.properties[key] = '其他: ';
  } else {
    feature.properties[key] = newVal;
    saveAndCloseCell(feature.id, key);
  }
};

// ========== 列头拖拽重排 ==========
const dragOverKey = ref(null);
const dragSourceKey = ref(null);
let _reorderTimer = null;

const onFieldDragStart = (e, key) => {
  dragSourceKey.value = key;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', key);
  // 让拖拽幽灵透明（浏览器默认半透明即可）
};
const onFieldDragOver = (e, key) => {
  if (!dragSourceKey.value || dragSourceKey.value === key) return;
  dragOverKey.value = key;
};
const onFieldDragLeave = (key) => {
  if (dragOverKey.value === key) dragOverKey.value = null;
};
const onFieldDrop = (e, key) => {
  e.preventDefault();
  const src = dragSourceKey.value;
  dragOverKey.value = null;
  if (!src || src === key) return;
  applyFieldReorder(src, key);
};
const onFieldDragEnd = () => {
  dragSourceKey.value = null;
  dragOverKey.value = null;
};

// 本地重排：把 srcKey 移到 targetKey 之后（同 group 内），重新编号后 save
const applyFieldReorder = (srcKey, targetKey) => {
  const layerId = activeLayerId.value;
  if (!layerId || !isDecoupledLayer(layerId)) return;
  const schema = fieldSchema[layerId];
  if (!schema) return;
  const srcCfg = schema[srcKey];
  const tgtCfg = schema[targetKey];
  if (!srcCfg || !tgtCfg) return;
  // 仅同 group 内重排
  if ((srcCfg.group ?? null) !== (tgtCfg.group ?? null)) return;

  const groupId = srcCfg.group ?? null;
  // 收集同组字段并按 order 排序
  const groupFields = Object.entries(schema)
    .filter(([k, c]) => k.toUpperCase() !== 'OBJECTID' && (c?.group ?? null) === groupId)
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
  const srcIdx = groupFields.findIndex(([k]) => k === srcKey);
  const tgtIdx = groupFields.findIndex(([k]) => k === targetKey);
  if (srcIdx < 0 || tgtIdx < 0) return;
  // 把 src 移到 target 之后
  groupFields.splice(srcIdx, 1);
  const newTgtIdx = groupFields.findIndex(([k]) => k === targetKey);
  groupFields.splice(newTgtIdx + 1, 0, [srcKey, srcCfg]);
  // 重新编号
  groupFields.forEach(([, cfg], i) => { cfg.order = i; });

  clearTimeout(_reorderTimer);
  _reorderTimer = setTimeout(() => saveFieldReorder(layerId), 500);
};

const saveFieldReorder = async (layerId) => {
  const lockRes = await acquireSchemaLock(layerId);
  if (lockRes.error) { showToast(lockRes.error, 'error'); return; }
  try {
    const allFormats = {};
    const s = fieldSchema[layerId] || {};
    for (const [k, v] of Object.entries(s)) {
      if (k.toUpperCase() === 'OBJECTID') continue;
      const entry = {};
      if (v.format) entry.format = v.format;
      if (v.format === 'select' && v.options) entry.options = v.options;
      if (v.group !== undefined) entry.group = v.group;
      if (v.order !== undefined) entry.order = v.order;
      if (v.label) entry.label = v.label;
      if (Object.keys(entry).length) allFormats[k] = entry;
    }
    const groups = isDecoupledLayer(layerId) ? fieldGroupsMeta[layerId] : undefined;
    const { saveFieldFormat } = await import('../../store/mapState.js');
    await saveFieldFormat(layerId, allFormats, groups);
    showToast('列顺序已保存', 'success', 1000);
  } catch (e) {
    showToast('保存列顺序失败', 'error');
  }
};

// ========== 字段排序面板 ==========
const showSortPanel = ref(false);
const sortPanelGroups = computed(() => {
  return fieldGroups.value.map(group => {
    const children = [];
    if (group.children) {
      for (const f of group.children) {
        // 跳过虚拟分组字段（parentField）和嵌套子分组——只收集叶子字段
        if (f.children) {
          for (const sub of f.children) {
            children.push({ key: sub.key, config: sub.config, groupId: group.key });
          }
        } else if (!group.parentField || f.key !== group.parentField) {
          children.push({ key: f.key, config: f.config, groupId: group.key });
        }
      }
    }
    return { key: group.key, label: group.label, children };
  });
});

const onSortPanelChange = () => {
  // draggable 已更新 sortPanelGroups 中的 children，无需额外操作
};

const applySortPanel = async () => {
  const layerId = activeLayerId.value;
  if (!layerId || !isDecoupledLayer(layerId)) return;
  const schema = fieldSchema[layerId];
  if (!schema) return;

  const lockRes = await acquireSchemaLock(layerId);
  if (lockRes.error) { showToast(lockRes.error, 'error'); return; }
  try {
    // 根据排序面板的最终位置重新编号所有字段的 group/order
    for (const group of sortPanelGroups.value) {
      const groupId = group.key === '__ungrouped__' ? null : group.key;
      group.children.forEach((f, idx) => {
        const cfg = schema[f.key];
        if (cfg) {
          cfg.group = groupId;
          cfg.order = idx;
        }
      });
    }
    // 同步 groups 元数据：排面板可能有新分组
    const groupsMeta = fieldGroupsMeta[layerId] || [];
    const usedGroupIds = new Set(sortPanelGroups.value.map(g => g.key).filter(k => k !== '__ungrouped__'));
    const updatedGroups = groupsMeta.filter(g => usedGroupIds.has(g.id));
    // 按 panel 中的顺序重新编号 groups
    let gOrder = 0;
    for (const g of sortPanelGroups.value) {
      if (g.key === '__ungrouped__') continue;
      const meta = updatedGroups.find(mg => mg.id === g.key);
      if (meta) meta.order = gOrder++;
    }

    const allFormats = {};
    const s = fieldSchema[layerId] || {};
    for (const [k, v] of Object.entries(s)) {
      if (k.toUpperCase() === 'OBJECTID') continue;
      const entry = {};
      if (v.format) entry.format = v.format;
      if (v.format === 'select' && v.options) entry.options = v.options;
      if (v.group !== undefined) entry.group = v.group;
      if (v.order !== undefined) entry.order = v.order;
      if (v.label) entry.label = v.label;
      if (Object.keys(entry).length) allFormats[k] = entry;
    }
    const { saveFieldFormat } = await import('../../store/mapState.js');
    await saveFieldFormat(layerId, allFormats, updatedGroups.length > 0 ? updatedGroups : undefined);
    showSortPanel.value = false;
    showToast('字段顺序已保存', 'success', 2000);
  } catch (e) {
    showToast('保存失败', 'error');
  }
};

const saveAndCloseCell = async (entityId, fieldName, _stableId) => {
  if (savingCell) return;
  const layer = getLayerState(activeLayerId.value);
  let newValue = '';
  if (layer && layer.features) {
    const feature = layer.features.find(f => f.id === entityId || String(f.properties?.OBJECTID) === String(entityId));
    if (feature && feature.properties) {
      newValue = feature.properties[fieldName];
    }
  }

  mapState.editor.isDirty = true;
  const stableId = _stableId || activeEditCell.value?.stableId || entityId;
  const origVal = activeEditCell.value?.origValue;
  activeEditCell.value = { id: null, field: null };

  savingCell = true;
  try {
    // 先检测图层是否被他人修改（在修改 entity 之前）
    const { checkLayerConflict } = await import('../../core/locks.js');
    const conflict = await checkLayerConflict(activeLayerId.value, stableId);
    if (conflict.stale) {
      const userValue = newValue;
      releaseFeatureLock(activeLayerId.value, stableId, false);
      showToast('检测到图层有更新，正在刷新...', 'info', 0);
      const { reloadLayer: rl } = await import('../../core/layers/LayerManager.js');
      await rl(activeLayerId.value);
      hideToast();
      const lAfter = getLayerState(activeLayerId.value);
      const fAfter = lAfter?.features?.find(f => String(f.properties?.OBJECTID) === stableId || f.id === entityId);
      if (fAfter && origVal !== undefined && fAfter.properties?.[fieldName] === origVal) {
        fAfter.properties[fieldName] = userValue;
        const dsReload = getLayer(activeLayerId.value);
        for (const e of (dsReload ? dsReload.entities.values : (getViewer()?.entities.values || []))) {
          if (!e.properties) continue;
          const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
          if (ep && String(ep.OBJECTID) === stableId) { e.properties[fieldName] = userValue; refreshExtrudedHeight(e); break; }
        }
        const retryResult = await saveFeature(activeLayerId.value, stableId);
        if (!retryResult) { showToast('自动重试保存失败', 'error', 3000); return; }
        if (retryResult?.conflict) { showToast(conflict.modifier, 'warning', 2500); return; }
        showToast('已保存', 'success', 800);
      } else {
        showToast(conflict.modifier, 'warning', 2500);
      }
      return;
    }

    // 格式校验在修改 entity 之前
    const fmt = fieldSchema[activeLayerId.value]?.[fieldName]?.format;
    const opts = fieldSchema[activeLayerId.value]?.[fieldName]?.options || [];
    const error = validateFieldValue(newValue, fmt, opts);
    if (error) {
      showToast(error, 'error');
      activeEditCell.value = { id: entityId, field: fieldName, stableId };
      return;
    }

    // 校验通过后再更新 entity
    const entity = _findEntity(entityId);
    if (entity && entity.properties) {
      if (entity.properties.hasProperty(fieldName)) {
        entity.properties[fieldName] = newValue;
      } else {
        entity.properties.addProperty(fieldName, newValue);
      }
      refreshExtrudedHeight(entity);
    }

    const saveResult = await saveFeature(activeLayerId.value, stableId);
    if (!saveResult) { showToast('保存失败，请检查网络', 'error'); return; }
    if (saveResult?.conflict) {
      showToast('检测到数据冲突，正在刷新...', 'info', 0);
      const { reloadLayer: rl2 } = await import('../../core/layers/LayerManager.js');
      await rl2(activeLayerId.value);
      hideToast();
      const lAfter = getLayerState(activeLayerId.value);
      const fAfter = lAfter?.features?.find(f => String(f.properties?.OBJECTID) === stableId || f.id === entityId);
      if (fAfter && origVal !== undefined && fAfter.properties?.[fieldName] === origVal) {
        fAfter.properties[fieldName] = newValue;
        const dsR = getLayer(activeLayerId.value);
        for (const e of (dsR ? dsR.entities.values : (getViewer()?.entities.values || []))) {
          if (!e.properties) continue;
          const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
          if (ep && String(ep.OBJECTID) === stableId) { e.properties[fieldName] = newValue; refreshExtrudedHeight(e); break; }
        }
        const retry = await saveFeature(activeLayerId.value, stableId);
        if (!retry) { showToast('自动重试保存失败', 'error', 3000); return; }
        if (retry?.conflict) { showToast('数据已被他人修改', 'warning', 2500); return; }
        showToast('已保存', 'success', 800);
      } else {
        showToast('数据已被他人修改', 'warning', 2500);
      }
    } else {
      showToast('已保存', 'success', 800);
    }
  } finally {
    savingCell = false;
  }
};

// 布尔值一键切换：获取锁 → 改值 → 保存 → 释放
// 布尔值一键切换：获取锁 → stale检测 → 改值 → 保存
const toggleBoolean = async (feature, key) => {
  if (!mapState.editor.isEditing) return;
  if (savingCell) return; // 上一次保存未完成，跳过
  const stableId = String(feature.properties?.OBJECTID || feature.id);

  // 1. 获取要素锁（内含版本检测）
  const lockRes = await acquireFeatureLock(activeLayerId.value, stableId);
  if (lockRes.error || lockRes.locked) {
    showToast(lockRes.locked ? `要素已被 ${lockRes.lockedBy || '其他用户'} 锁定` : '无法获取编辑锁', 'warning');
    return;
  }
  if (lockRes.stale) {
    const origVal = feature.properties[key];
    const targetVal = origVal === 'True' ? 'False' : 'True';
    releaseFeatureLock(activeLayerId.value, stableId, false);
    showToast('检测到图层有更新，正在刷新...', 'info', 0);
    const { reloadLayer: rl } = await import('../../core/layers/LayerManager.js');
    await rl(activeLayerId.value);
    hideToast();
    const lAfter = getLayerState(activeLayerId.value);
    const fAfter = lAfter?.features?.find(f => String(f.properties?.OBJECTID) === stableId || f.id === feature.id);
    if (fAfter && fAfter.properties?.[key] === origVal) {
      fAfter.properties[key] = targetVal;
      const dsReload2 = getLayer(activeLayerId.value);
      for (const e of (dsReload2 ? dsReload2.entities.values : (getViewer()?.entities.values || []))) {
        if (!e.properties) continue;
        const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
        if (ep && String(ep.OBJECTID) === stableId) {
          if (e.properties.hasProperty(key)) e.properties[key] = targetVal; else e.properties.addProperty(key, targetVal);
          break;
        }
      }
      const retryResult = await saveFeature(activeLayerId.value, stableId);
      if (!retryResult) { showToast('自动重试保存失败', 'error', 3000); return; }
      if (retryResult?.conflict) { showToast('数据已被他人修改', 'warning', 2500); return; }
      showToast('已保存', 'success', 800);
    } else {
      showToast('数据已被他人修改', 'warning', 2500);
    }
    return;
  }

  savingCell = true;
  try {
    // 2. 改值 + 更新 entity
    const newVal = feature.properties[key] === 'True' ? 'False' : 'True';
    feature.properties[key] = newVal;
    const entity = _findEntity(feature.id);
    if (entity?.properties) {
      if (entity.properties.hasProperty(key)) entity.properties[key] = newVal;
      else entity.properties.addProperty(key, newVal);
    }

    // 3. 保存（saveFeature 内部 markSaved 会释放锁）
    const saveResult = await saveFeature(activeLayerId.value, stableId);
    if (!saveResult) { showToast('保存失败，请检查网络', 'error'); return; }
    if (saveResult?.conflict) {
      const origVal = feature.properties[key] === 'True' ? 'False' : 'True';
      const targetVal = feature.properties[key];
      showToast('检测到数据冲突，正在刷新...', 'info', 0);
      const { reloadLayer: rl2 } = await import('../../core/layers/LayerManager.js');
      await rl2(activeLayerId.value);
      hideToast();
      const lAfter = getLayerState(activeLayerId.value);
      const fAfter = lAfter?.features?.find(f => String(f.properties?.OBJECTID) === stableId || f.id === feature.id);
      if (fAfter && fAfter.properties?.[key] === origVal) {
        fAfter.properties[key] = targetVal;
        const dsR = getLayer(activeLayerId.value);
        for (const e of (dsR ? dsR.entities.values : (getViewer()?.entities.values || []))) {
          if (!e.properties) continue;
          const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
          if (ep && String(ep.OBJECTID) === stableId) {
            if (e.properties.hasProperty(key)) e.properties[key] = targetVal; else e.properties.addProperty(key, targetVal);
            break;
          }
        }
        const retry = await saveFeature(activeLayerId.value, stableId);
        if (!retry) { showToast('自动重试保存失败', 'error', 3000); return; }
        if (retry?.conflict) { showToast('数据已被他人修改', 'warning', 2500); return; }
        showToast('已保存', 'success', 800);
      } else {
        showToast('数据已被他人修改', 'warning', 2500);
      }
    }
  } finally {
    savingCell = false;
  }
};

const photoBox = ref({ visible: false, urls: [], photos: [], index: 0, fieldKey: '', objId: '', layerId: '' });
const viewTablePhotos = (val, fieldKey, objId, layerId) => {
  const photos = parsePhotos(val);
  if (!photos.length) return;
  photoBox.value = { visible: true, urls: photos.map(p => p.u), photos, index: 0, fieldKey: fieldKey || '', objId: objId || '', layerId: layerId || '' };
};
const closePhotoBox = () => { photoBox.value.visible = false; editingPhotoBoxNote.value = false; };
const photoBoxNav = (dir) => {
  const n = photoBox.value.urls.length;
  photoBox.value.index = (photoBox.value.index + dir + n) % n;
};

// photoBox 备注编辑
const editingPhotoBoxNote = ref(false);
const photoBoxNoteDraft = ref('');
const currentPhotoBoxNote = computed(() => {
  const pb = photoBox.value;
  return pb.photos[pb.index]?.n || '';
});
const startEditPhotoBoxNote = () => {
  photoBoxNoteDraft.value = currentPhotoBoxNote.value;
  editingPhotoBoxNote.value = true;
  nextTick(() => {
    const inp = document.querySelector('.lightbox-note-input');
    if (inp) inp.focus();
  });
};
const savePhotoBoxNote = async () => {
  const pb = photoBox.value;
  const note = photoBoxNoteDraft.value.trim();
  editingPhotoBoxNote.value = false;
  if (!pb.fieldKey || !pb.photos[pb.index] || !pb.layerId || !pb.objId) return;
  pb.photos[pb.index].n = note;
  const newVal = JSON.stringify(pb.photos);
  // 直接更新 entity（按 OBJECTID 查找，与 saveFeature 一致）
  const ds = getLayer(pb.layerId);
  if (ds instanceof Cesium.GeoJsonDataSource) {
    for (const e of ds.entities.values) {
      if (!e.properties) continue;
      const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
      if (ep && String(ep.OBJECTID) === String(pb.objId)) {
        e.properties[pb.fieldKey] = newVal;
        break;
      }
    }
  }
  // 同步 layer.features
  const layerInfo = getLayerState(pb.layerId);
  if (layerInfo?.features) {
    const feat = layerInfo.features.find(f => String(f.properties?.OBJECTID) === String(pb.objId));
    if (feat?.properties) feat.properties[pb.fieldKey] = newVal;
  }
  // 冲突预检 + 持久化
  const { checkLayerConflict } = await import('../../core/locks');
  const conflict = await checkLayerConflict(pb.layerId, String(pb.objId));
  if (conflict.stale) {
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(pb.layerId);
    // 补回用户编辑的备注
    const lAfter = getLayerState(pb.layerId);
    const fAfter = lAfter?.features?.find(f => String(f.properties?.OBJECTID) === String(pb.objId));
    if (fAfter?.properties) {
      fAfter.properties[pb.fieldKey] = newVal;
      const dsR = getLayer(pb.layerId);
      for (const e of (dsR ? dsR.entities.values : (getViewer()?.entities.values || []))) {
        if (!e.properties) continue;
        const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
        if (ep && String(ep.OBJECTID) === String(pb.objId)) { e.properties[pb.fieldKey] = newVal; break; }
      }
    }
    showToast('检测到数据有更新，已刷新', 'info', 2000);
  }
  const { saveFeature } = await import('../../core/saveFeature');
  const saveResult = await saveFeature(pb.layerId, String(pb.objId));
  if (!saveResult) { showToast('备注保存失败，请检查网络', 'error', 3000); return; }
  if (saveResult?.conflict) {
    showToast('备注保存冲突，请刷新后重试', 'warning', 2500);
    return;
  }
  showToast('备注已保存', 'success', 1000);
};
const cancelEditPhotoBoxNote = () => { editingPhotoBoxNote.value = false; };
const deleteTablePhoto = async () => {
  const pb = photoBox.value;
  const photo = pb.photos[pb.index];
  if (!photo || !pb.fieldKey || !pb.layerId || !pb.objId) return;
  if (!confirm('确定要删除这张照片吗？')) return;
  const stale = await checkLayerStale(pb.layerId);
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager');
    await reloadLayer(pb.layerId);
    hideToast();
    showToast('已刷新，请重新打开大图后操作', 'info', 2000);
    return;
  }
  pb.photos.splice(pb.index, 1);
  pb.urls.splice(pb.index, 1);
  const newVal = pb.photos.length ? JSON.stringify(pb.photos) : '';
  const ds = getLayer(pb.layerId);
  if (ds instanceof Cesium.GeoJsonDataSource) {
    for (const e of ds.entities.values) {
      if (!e.properties) continue;
      const ep = e.properties.getValue ? e.properties.getValue(Cesium.JulianDate.now()) : e.properties;
      if (ep && String(ep.OBJECTID) === String(pb.objId)) {
        e.properties[pb.fieldKey] = newVal; break;
      }
    }
  }
  if (pb.photos.length === 0) { closePhotoBox(); return; }
  if (pb.index >= pb.photos.length) photoBox.value = { ...pb, index: pb.photos.length - 1 };
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';
  fetch(apiBase + '/api/upload/photo/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ url: photo.u })
  }).catch(() => {});
  const { saveFeature: sf } = await import('../../core/saveFeature');
  const delResult = await sf(pb.layerId, String(pb.objId));
  if (!delResult) { showToast('保存失败，请检查网络', 'error', 3000); }
  else if (delResult?.conflict) { showToast('数据已被他人修改，请刷新', 'warning', 2500); }
};
watch(() => photoBox.value.visible, (v) => {
  if (v) {
    const onKey = (e) => {
      if (e.key === 'Escape') closePhotoBox();
      else if (e.key === 'ArrowLeft') photoBoxNav(-1);
      else if (e.key === 'ArrowRight') photoBoxNav(1);
    };
    document.addEventListener('keydown', onKey);
    photoBox._onKey = onKey;
  } else if (photoBox._onKey) {
    document.removeEventListener('keydown', photoBox._onKey);
    photoBox._onKey = null;
  }
});

const handleHeaderEdit = async (oldKey, newKey) => {
  newKey = newKey.trim();
  if (!newKey || newKey === oldKey) return;
  const schema = fieldSchema[activeLayerId.value];
  if (schema[newKey]) {
    alert(`字段名 "${newKey}" 已存在，请使用其他名称！`);
    return;
  }
  const viewer = getViewer();
  if (!viewer) return;
  const confirmRename = confirm(`确定要将字段 "${oldKey}" 重命名为 "${newKey}" 吗？\n这将修改该图层下所有要素的数据！`);
  if (!confirmRename) return;

  const lockRes = await acquireSchemaLock(activeLayerId.value);
  if (lockRes.error) { alert(lockRes.error); return; }

  const layerNode = getLayerState(activeLayerId.value);
  const layerFeatures = layerNode?.features || [];
  layerFeatures.forEach(f => {
    const entity = _findEntity(f.id);
    if (entity && entity.properties && entity.properties.hasProperty(oldKey)) {
      const val = entity.properties[oldKey]?.getValue ? entity.properties[oldKey].getValue(Cesium.JulianDate.now()) : entity.properties[oldKey];
      if (!entity.properties.hasProperty(newKey)) {
        entity.properties.addProperty(newKey, val);
      }
      entity.properties[newKey] = val;
      entity.properties.removeProperty(oldKey);
    }
    // 🌟 同步更新 layer.features 中的 properties，否则表格显示和保存都会丢数据
    if (f.properties && f.properties[oldKey] !== undefined) {
      f.properties[newKey] = f.properties[oldKey];
      delete f.properties[oldKey];
    }
  });

  // 持久化到磁盘（schema API rename）
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${activeLayerId.value}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: layerNode.url, action: 'rename', field: { key: oldKey, newKey } })
  });

  const newSchemaObj = {};
  for (const key in schema) {
    if (key === oldKey) { newSchemaObj[newKey] = schema[oldKey]; }
    else { newSchemaObj[key] = schema[key]; }
  }
  Object.keys(schema).forEach(k => delete schema[k]);
  for (const key in newSchemaObj) { schema[key] = newSchemaObj[key]; }
  if (filter1.field === oldKey) filter1.field = '';
  if (search.field === oldKey) search.field = '';
  mapState.editor.isDirty = true;
  // 新模型：rename 只改了 GeoJSON 属性名，需把新名的 group/order 持久化到 schema 文件，否则该字段分组丢失
  if (isDecoupledLayer(activeLayerId.value)) {
    const fields = {};
    for (const k in schema) {
      if (k.toUpperCase() === 'OBJECTID') continue;
      const c = schema[k] || {};
      fields[k] = { label: c.label || k, ...(c.format ? { format: c.format } : {}), ...(c.options ? { options: c.options } : {}), group: c.group ?? null, order: c.order ?? 0 };
    }
    const { saveFieldFormat } = await import('../../store/mapState.js');
    try { await saveFieldFormat(activeLayerId.value, fields, fieldGroupsMeta[activeLayerId.value]); } catch (_) {}
  }
  await checkLayerStale(activeLayerId.value); // 回正本地版本，避免下次操作自我误判 stale
  releaseSchemaLock(activeLayerId.value);
};

// ==========================================
// 字段增删
// ==========================================
const newFieldKey = ref('');
const newFieldType = ref('text');
const newFieldGroup = ref('');
const newFieldGroupLabel = ref('');
const renamingGroup = ref(null);
const groupRenameValue = ref('');
const pendingAfterKey = ref(null);   // "列右边界加号"记录的插入锚点列
const addFieldHint = ref(false);     // 输入框红字提示态

// 点某列右边界加号：自动选好该列分组 + 记锚点 + 聚焦工具栏输入框（复用现有添加流程）
const startInlineAdd = async (afterKey) => {
  const layerId = activeLayerId.value;
  if (!isDecoupledLayer(layerId)) return;
  pendingAfterKey.value = afterKey;
  const g = afterKey === '__head__' ? '' : ((fieldSchema[layerId]?.[afterKey]?.group) ?? '');
  newFieldGroup.value = g || ''; // null/基本信息 → ''
  addFieldHint.value = true;
  await nextTick();
  const inp = document.querySelector('.add-field-key');
  if (inp) inp.focus();
};

// 选择"＋新分组"后自动聚焦分组名称输入框
watch(newFieldGroup, (v) => {
  if (v === '__new__') {
    nextTick(() => {
      const inp = document.querySelector('.field-group-name-input');
      if (inp) inp.focus();
    });
  }
});

// 第一列之前插入（基本信息组最前，可替换被冻结的首数据列位置）
const startInlineAddHead = () => startInlineAdd('__head__');

// 输入框失焦且未输入 → 取消本次就地添加，恢复默认（延迟，给"添加"按钮的 click 留出执行窗口）
const onAddFieldBlur = () => {
  setTimeout(() => {
    if (addFieldHint.value && !newFieldKey.value.trim()) {
      pendingAfterKey.value = null;
      addFieldHint.value = false;
      // 不重置 newFieldGroup——startInlineAdd 已设为正确分组，延迟重置会覆盖新选择
    }
  }, 200);
};

// 添加字段时可选的已有分组列表
const addFieldGroups = computed(() => {
  // 旧模型组有 parentField，新模型组（来自元数据）无 parentField；两者都应可选，仅排除虚拟"基本信息"组
  return fieldGroups.value.filter(g => g.key !== '__ungrouped__');
});

const handleAddField = async () => {
  let key = newFieldKey.value.trim();
  if (!key) return;
  const layer = getLayerState(activeLayerId.value);
  if (!layer || !layer.url) return;
  const layerId = activeLayerId.value;
  const schema = fieldSchema[layerId] || {};

  // 统一走元数据路径：字段名保持干净，不再生成数字编号前缀
  // parseFieldGroups 混合兼容：新字段有 group 元数据 → 走元数据模型；旧字段仍按前缀识别
  const groupLabel = newFieldGroupLabel.value.trim();
  let groupId = null;      // null = 基本信息
  let groupOrder = 0;
  let updatedGroups = null; // 新建分组时的 groups 数组

  // 若来自"列右边界加号"：精确插在该列之后（先计算插入位置，再覆盖 groupId/groupOrder）
  if (pendingAfterKey.value) {
    const ins = computeInsertOrder(layerId, pendingAfterKey.value);
    if (ins) { groupId = ins.group; groupOrder = ins.order; }
  }

  if (newFieldGroup.value === '__new__') {
    if (!groupLabel) return;
    const ga = resolveGroupAssignment(layerId, '__new__', groupLabel);
    groupId = ga.groupId;
    updatedGroups = ga.groups;
    // 指定了插入位置：把新建分组排到 afterKey 所在组后面
    if (pendingAfterKey.value) {
      const afterSchema = fieldSchema[layerId]?.[pendingAfterKey.value];
      const afterGroupId = afterSchema?.group ?? null;
      if (afterGroupId && updatedGroups) {
        const afterIdx = updatedGroups.findIndex(g => g.id === afterGroupId);
        const newIdx = updatedGroups.findIndex(g => g.id === groupId);
        if (afterIdx >= 0 && newIdx > afterIdx) {
          // 把新建组移到 afterKey 组后面
          const newGroup = updatedGroups.splice(newIdx, 1)[0];
          newGroup.order = updatedGroups[afterIdx].order + 1;
          updatedGroups.splice(afterIdx + 1, 0, newGroup);
          // 重新编号后续组的 order
          for (let i = afterIdx + 2; i < updatedGroups.length; i++) updatedGroups[i].order = i;
        }
      }
      groupOrder = 0; // 组内第一个字段
    } else {
      groupOrder = ga.order;
    }
  } else if (newFieldGroup.value) {
    if (!pendingAfterKey.value) { // 未指定位置：追加到已有分组末尾
      groupId = newFieldGroup.value;
      const existing = Object.values(fieldSchema[layerId] || {}).filter(s => s.group === groupId).length;
      groupOrder = existing;
    }
    // 已指定位置：group/order 已由 computeInsertOrder 计算，保留
  } else {
    if (!pendingAfterKey.value) { // 基本信息末尾追加
      const basicFields = Object.values(fieldSchema[layerId] || {}).filter(s => s.group === undefined || s.group === null).length;
      groupOrder = basicFields;
    }
  }

  if (key in schema) { alert('字段已存在'); return; }

  const lockRes = await acquireSchemaLock(layerId);
  if (lockRes.error) { alert(lockRes.error); return; }

  const stale = await checkLayerStale(layerId);
  if (stale) {
    await releaseSchemaLock(layerId);
    showToast('检测到图层有更新，已刷新，请重试', 'info', 3000);
    await reloadLayer(layerId);
    return;
  }

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  // 1) 在 GeoJSON 里加干净/前缀属性键
  await fetch(`/api/layers/${layerId}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: layer.url, action: 'add', field: { key } })
  });

  if (!fieldSchema[layerId]) fieldSchema[layerId] = {};
  const baseType = ['int','float','percent'].includes(newFieldType.value) ? 'number' : 'string';
  const fmt = newFieldType.value !== 'text' ? newFieldType.value : undefined;
  const entry = { label: key, type: baseType };
  if (fmt) entry.format = fmt;
  entry.group = groupId;
  entry.order = groupOrder;
  fieldSchema[layerId][key] = entry;

  // 2) 持久化分组元数据到 schema 文件（所有图层统一走元数据路径）
  if (updatedGroups) fieldGroupsMeta[layerId] = updatedGroups;
  try { await persistNewFieldMeta(layerId, key, fmt, groupId, groupOrder, updatedGroups); }
  catch (e) { showToast('分组元数据保存失败：' + e.message, 'error'); }

  if (layer.features) layer.features.forEach(f => { if (f.properties && !(key in f.properties)) f.properties[key] = ''; });
  newFieldKey.value = '';
  newFieldType.value = 'text';
  newFieldGroup.value = '';
  newFieldGroupLabel.value = '';
  addFieldHint.value = false;
  const wasInlineInsert = !!pendingAfterKey.value; // 在 null 之前记下
  pendingAfterKey.value = null;
  mapState.editor.isDirty = true;
  // 同步本地图层版本到服务端真实值（加字段会 bump 1~2 次：action=add + 新模型 saveFieldFormat），
  // 否则下次加字段的前置 checkLayerStale 会误判 stale。checkLayerStale 无条件写回最新版本。
  await checkLayerStale(layerId);
  await nextTick();
  const container = document.querySelector('.table-scroll');
  if (container && !wasInlineInsert) container.scrollLeft = container.scrollWidth; // 只有"添加到末尾"才滚到最后一列
  releaseSchemaLock(layerId);
};

const handleDeleteField = async (key) => {
  if (!confirm(`确定要删除字段"${key}"吗？此操作将从该图层所有要素中永久移除此字段。`)) return;

  const lockRes = await acquireSchemaLock(activeLayerId.value);
  if (lockRes.error) { alert(lockRes.error); return; }

  // 删字段前检测图层是否被他人改过：stale 则刷新后中止（避免基于过时字段集删除）
  const stale = await checkLayerStale(activeLayerId.value);
  if (stale) {
    await releaseSchemaLock(activeLayerId.value);
    showToast('检测到图层有更新，已刷新，请重试', 'info', 3000);
    await reloadLayer(activeLayerId.value);
    return;
  }

  const layer = getLayerState(activeLayerId.value);
  if (!layer || !layer.url) return;

  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  await fetch(`/api/layers/${activeLayerId.value}/schema`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url: layer.url, action: 'delete', field: { key } })
  });

  if (fieldSchema[activeLayerId.value]) delete fieldSchema[activeLayerId.value][key];
  if (layer.features) layer.features.forEach(f => { if (f.properties) delete f.properties[key]; });
  mapState.editor.isDirty = true;
  await checkLayerStale(activeLayerId.value); // 回正本地版本，避免下次操作自我误判 stale
  releaseSchemaLock(activeLayerId.value);
};

const openFormatPanel = async (key) => {
  // 打开格式面板前检测图层是否被他人修改
  const stale = await checkLayerStale(activeLayerId.value);
  if (stale) {
    showToast('检测到图层有更新，正在刷新...', 'info', 0);
    await reloadLayer(activeLayerId.value);
    hideToast();
    return;
  }
  showFormatPanel.value = (showFormatPanel.value === key ? null : key);
};

const setFieldFormat = async (key, fmt) => {
  const layerId = activeLayerId.value;
  const lockRes = await acquireSchemaLock(layerId);
  if (lockRes.error) { alert(lockRes.error); return; }

  const existing = fieldSchema[layerId][key] || {};
  existing.format = fmt;
  if (fmt === 'select') {
    existing.options = (formatOptions[key] || '').split('\n').map(s => s.trim()).filter(Boolean);
  }
  fieldSchema[layerId][key] = { ...existing };

  const allFormats = {};
  for (const [k, v] of Object.entries(fieldSchema[layerId])) {
    if (k.toUpperCase() === 'OBJECTID') continue;
    const entry = {};
    if (v.format) entry.format = v.format;
    if (v.format === 'select' && v.options) entry.options = v.options;
    // 保留新模型的分组元数据，避免整表覆盖时丢失 group/order
    if (v.group !== undefined) entry.group = v.group;
    if (v.order !== undefined) entry.order = v.order;
    if (v.label) entry.label = v.label;
    if (Object.keys(entry).length) allFormats[k] = entry;
  }
  const { saveFieldFormat } = await import('../../store/mapState.js');
  const groups = isDecoupledLayer(layerId) ? fieldGroupsMeta[layerId] : undefined;
  await saveFieldFormat(layerId, allFormats, groups);
  await checkLayerStale(layerId); // 回正本地版本，避免下次操作自我误判 stale
  releaseSchemaLock(layerId);
  showFormatPanel.value = null;
};

// 打开下拉选项编辑弹窗
const openOptionsEditor = (key) => {
  optionsEditorFieldKey.value = key;
  // 已有选项：用换行拼接；否则空
  const existing = fieldSchema[activeLayerId.value]?.[key]?.options;
  if (!formatOptions[key] && existing?.length) {
    formatOptions[key] = existing.join('\n');
  }
  showOptionsEditor.value = true;
};

const confirmOptionsEditor = async () => {
  showOptionsEditor.value = false;
  const key = optionsEditorFieldKey.value;
  if (!key) return;
  const val = (formatOptions[key] || '').trim();
  // 无内容时也允许（退化为文本输入）；但仍保存为 select 格式
  await setFieldFormat(key, 'select');
};

const cancelOptionsEditor = () => {
  showOptionsEditor.value = false;
  optionsEditorFieldKey.value = null;
};

// ==========================================
// 分页与截断显示逻辑
// ==========================================
const currentPage = ref(1);
const pageSize = ref(100); // 🌟 放心地改回 100 条

// keep-alive 切换时保留表格横向/竖向滚动位置（滚动时持续记录，避免 onDeactivated 时 DOM 已脱离读到 0）
const tableScrollEl = ref(null);
let savedScroll = { top: 0, left: 0 };
const onTableScroll = (e) => {
  savedScroll = { top: e.target.scrollTop, left: e.target.scrollLeft };
};
onActivated(() => {
  nextTick(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (tableScrollEl.value) {
        tableScrollEl.value.scrollTop = savedScroll.top;
        tableScrollEl.value.scrollLeft = savedScroll.left;
      }
    }));
  });
});

// 🌟 修复：去掉 toRaw，保持对异步加载数据的响应式监听
const filteredFeatures = computed(() => {
  // 1. 使用 getLayerState 穿透文件夹找到图层
  const layer = getLayerState(activeLayerId.value);
  
  // 2. 如果图层不存在，或者 features 还没加载完，返回空数组
  if (!layer || !layer.features || layer.features.length === 0) return [];
  
  // 3. 保持响应式，直接引用
  const rawFeatures = layer.features;
  
  const f1Active = filter1.field && filter1.value !== '';
  const sActive = search.field && search.keyword.trim() !== '';
  if (!f1Active && !sActive) {
    // 按 OBJECTID 排序，保持编号一致性
    return [...rawFeatures].sort((a, b) => {
      const oa = Number(a.properties?.OBJECTID) || 0;
      const ob = Number(b.properties?.OBJECTID) || 0;
      return oa - ob;
    });
  }
  
  const searchKw = search.keyword.toLowerCase().trim();
  return rawFeatures.filter(f => {
    const props = f.properties || {}; 
    const v1 = f1Active ? String(props[filter1.field] || '') : '';
    const vS = sActive ? String(props[search.field] || '') : '';
    const m1 = f1Active ? (v1 === String(filter1.value)) : false;
    const mS = sActive ? (vS.toLowerCase().includes(searchKw)) : false;
    return (logicalMode.value === 'OR') ? (m1 || mS) : (m1 && mS);
  });
});

// ---- 排序 ----
const sortField = ref(null);   // 当前排序字段名
const sortDir = ref(null);     // 'asc' | 'desc' | null

const toggleSort = (field) => {
  if (sortField.value === field) {
    if (sortDir.value === 'asc') { sortDir.value = 'desc'; }
    else if (sortDir.value === 'desc') { sortField.value = null; sortDir.value = null; }
  } else {
    sortField.value = field;
    sortDir.value = 'asc';
  }
  currentPage.value = 1;
};

const sortedFeatures = computed(() => {
  // 无排序时直接透传引用，避免不必要的数组浅拷贝
  if (!sortField.value || !sortDir.value) return filteredFeatures.value;

  const list = [...filteredFeatures.value];
  const field = sortField.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;

  return list.sort((a, b) => {
    const va = a.properties?.[field];
    const vb = b.properties?.[field];

    // 空值始终排末尾
    const emptyA = va === undefined || va === null || va === '';
    const emptyB = vb === undefined || vb === null || vb === '';
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;

    // 数字排序
    const na = Number(va);
    const nb = Number(vb);
    if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;

    // 字符串排序（中文友好）
    return String(va).localeCompare(String(vb), 'zh-CN') * dir;
  });
});

// 过滤条件变化时只重置页码，不改排序（排序在图层切换时清空）
watch(filteredFeatures, () => {
  currentPage.value = 1;
  checkAutoExpand();
});
// 图层切换时清空排序
watch(activeLayerId, () => {
  sortField.value = null;
  sortDir.value = null;
});

// 响应图层面板「在数据工作台打开」信号
watch(() => mapState.ui.pendingTableLayerId, async (layerId) => {
  if (!layerId) return;
  const layer = getLayerState(layerId);
  // 图层隐藏/未加载时自动开启并加载（toggleLayerVisibility 内部会调 loadGeoJsonLayer）
  if (layer && !layer.show) await toggleLayerVisibility(layerId, true);
  activeLayerId.value = layerId;
  mapState.ui.pendingTableLayerId = null;
});

const totalPages = computed(() => Math.ceil(sortedFeatures.value.length / pageSize.value) || 1);
const totalCount = computed(() => getLayerState(activeLayerId.value)?.features?.length || 0);

const displayFeatures = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return sortedFeatures.value.slice(start, start + pageSize.value);
});

const searchSuggestions = computed(() => {
  if (!search.field || !search.keyword) return [];
  return (currentSchema.value?.[search.field]?.options || [])
    .filter(opt => String(opt).toLowerCase().includes(search.keyword.toLowerCase()))
    .slice(0, 10);
});

const selectSuggestion = (sug) => { search.keyword = String(sug); showSuggestions.value = false; };
const resetFilters = () => { filter1.field = ''; filter1.value = ''; search.field = ''; search.keyword = ''; };
const exportExcel = async () => {
  // 先检查图层版本，有更新则刷新后再导出
  const stale = await checkLayerStale(activeLayerId.value);
  if (stale) {
    showToast('检测到数据有更新，正在刷新...', 'info', 0);
    const { reloadLayer } = await import('../../core/layers/LayerManager.js');
    await reloadLayer(activeLayerId.value);
    hideToast();
  }
  const layer = getLayerState(activeLayerId.value);
  const groups = fieldGroups.value; // parseFieldGroups 结果，保持平台显示顺序

  // 构建双行表头：第1行=分组名，第2行=字段名
  const headerRow1 = [];
  const headerRow2 = [];

  // OBJECTID 列
  headerRow1.push('');
  headerRow2.push('OBJECTID');

  // 剩余字段按分组顺序列出
  for (const group of groups) {
    const keys = getGroupFieldKeys(group);
    for (let i = 0; i < keys.length; i++) {
      headerRow1.push(i === 0 ? group.label : '');
      headerRow2.push(keys[i]);
    }
  }

  // 数据行（字段按格式转换，确保 Excel 可读）
  const schema = fieldSchema[activeLayerId.value] || {};
  const dataRows = sortedFeatures.value.map(f => {
    const row = [];
    row.push(f.properties?.OBJECTID || f.id);
    for (const group of groups) {
      for (const key of getGroupFieldKeys(group)) {
        const raw = f.properties?.[key];
        const fmt = schema[key]?.format;
        if (raw === undefined || raw === null) {
          row.push('');
        } else if (fmt === 'boolean') {
          row.push(String(raw) === 'True' ? '是' : '否');
        } else if (fmt === 'image') {
          // 图片：显示张数而非文件名列表
          const count = parsePhotos(String(raw)).length;
          row.push(count > 0 ? `${count} 张` : '');
        } else {
          row.push(raw);
        }
      }
    }
    return row;
  });

  const allRows = [headerRow1, headerRow2, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);

  // 合并单元格：分组名跨多个字段列
  const merges = [];
  let colIdx = 1; // 跳过 OBJECTID 列
  for (const group of groups) {
    const count = getGroupFieldKeys(group).length;
    if (count > 1) {
      merges.push({ s: { r: 0, c: colIdx }, e: { r: 0, c: colIdx + count - 1 } });
    }
    colIdx += count;
  }
  ws['!merges'] = merges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '数据');
  const name = (layer?.name || 'export') + '.xlsx';
  XLSX.writeFile(wb, name);
};

const exportGeoJson = async () => {
  const layer = getLayerState(activeLayerId.value);
  if (!layer?.url) return;
  const downloadName = (layer.name || 'layer') + '.geojson';
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const res = await fetch(`/api/export/geojson?path=${encodeURIComponent(layer.url)}&name=${encodeURIComponent(downloadName)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) { const d = await res.json().catch(()=>({})); showToast(d.error || '导出失败', 'error'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = downloadName;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// 手动触发：清理退化碎片 + 规范化 OBJECTID（对当前图层）
const cleanupLayerFragments = async () => {
  const layer = getLayerState(activeLayerId.value);
  if (!layer?.url) { showToast('当前图层无关联文件', 'error'); return; }
  const layerId = activeLayerId.value;
  const token = sessionStorage.getItem('cesium_mvp_token') || '';

  try {
    // Step 1: dryRun 预览
    const prevRes = await fetch('/api/layers/normalize-oids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filePath: layer.url, layerId, dryRun: true })
    });
    const prev = await prevRes.json();
    if (!prevRes.ok) { showToast(prev.error || '扫描失败', 'error'); return; }

    const { cleaned, updated, dupFixed, brokenOids } = prev;
    const totalChanges = (cleaned || 0) + (updated || 0) + (dupFixed || 0);
    if (totalChanges === 0) {
      showToast('扫描完成：无需清理，数据状态良好', 'info', 3000);
      return;
    }

    // Step 2: 展示预览，用户确认
    const lines = [
      `扫描结果：`,
      cleaned ? `  · 退化碎片：${cleaned} 个（将被清理）` : '',
      updated ? `  · 异常 OBJECTID：${updated} 个（将规范化为整数）` : '',
      brokenOids?.length ? `    示例：${brokenOids.join('、')}` : '',
      dupFixed ? `  · 重复 OBJECTID：${dupFixed} 个（将重新分配）` : '',
      '',
      '确定执行以上清理吗？（将自动备份，可回滚）'
    ].filter(Boolean).join('\n');

    // Step 3: 展示自定义确认弹窗（替代浏览器原生 confirm）
    cleanupPreview.value = { lines, resolve: null };
    const confirmed = await new Promise(resolve => { cleanupPreview.value.resolve = resolve; });
    cleanupPreview.value = { lines: null, resolve: null };
    if (!confirmed) return;

    // Step 4: 执行清理
    await acquireSchemaLock(layerId);
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      await checkLayerStale(layerId);
      hideToast();
    }

    const res = await fetch('/api/layers/normalize-oids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ filePath: layer.url, layerId })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '清理失败', 'error'); return; }
    showToast(`清理完成：碎片 ${data.cleaned || 0} 个，规范化 ${data.updated || 0} 个，去重 ${data.dupFixed || 0} 个`, 'info', 4000);
    if (totalChanges > 0) await reloadLayer(layerId);
    await checkLayerStale(layerId);
  } catch (e) {
    showToast('清理请求失败：' + e.message, 'error');
  } finally {
    releaseSchemaLock(layerId);
  }
};

// 手动触发：把分组从字段名前缀迁移为独立元数据（字段名变干净，分组/格式不变）
const migrateGrouping = async () => {
  const layer = getLayerState(activeLayerId.value);
  if (!layer?.url) { showToast('当前图层无关联文件', 'error'); return; }
  if (!confirm('将把该图层的字段名前缀（如 1-结构）迁移为干净字段名 + 独立分组元数据。\n会改写 GeoJSON 属性名（已自动备份、可回滚）。确定吗？')) return;

  const layerId = activeLayerId.value;
  try {
    // 操作前：获取 schema 锁 + 版本检查（CLAUDE.md 规则 #445 #418）
    await acquireSchemaLock(layerId);
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      await checkLayerStale(layerId); // 规则 #452：无条件回正本地版本
      hideToast();
    }

    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const res = await fetch(`/api/layers/${layerId}/migrate-grouping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ url: layer.url })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '迁移失败', 'error'); return; }
    if (data.skipped) { showToast('该图层无需迁移（字段名已无前缀）', 'info', 3000); return; }
    showToast(`迁移完成：分组 ${data.groups || 0} 个、字段 ${data.migrated || 0} 个`, 'info', 4000);
    // 字段名变更 → 必须 reloadLayer（规则 #452）
    await reloadLayer(layerId);
    await checkLayerStale(layerId);
  } catch (e) {
    showToast('迁移请求失败：' + e.message, 'error');
  } finally {
    releaseSchemaLock(layerId);
  }
};

// 手动触发：按当前排序重新编号 OBJECTID
const renumberOids = async () => {
  const layerId = activeLayerId.value;
  const layer = getLayerState(layerId);
  if (!layer?.url) { showToast('当前图层无关联文件', 'error'); return; }

  // 前置条件 1：无筛选条件
  const hasFilter = (filter1.field && filter1.value !== '') || (search.field && search.keyword.trim() !== '');
  if (hasFilter) {
    showToast('当前有筛选条件，请先清除筛选以显示全部数据后再更新序号', 'error', 4000);
    return;
  }

  // 前置条件 2：检查活跃要素锁
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  try {
    const lockRes = await fetch(`/api/locks/${layerId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const lockData = await lockRes.json();
    if (lockData.features && lockData.features.length > 0) {
      const editors = [...new Set(lockData.features.map(f => f.username))].join('、');
      showToast(`以下用户正在编辑要素，无法更新序号：${editors}`, 'error', 4000);
      return;
    }
  } catch (_) {}

  const total = layer.features?.length || 0;
  if (total === 0) { showToast('图层无数据', 'error'); return; }
  if (!confirm(`将把全部 ${total} 条要素的 OBJECTID 按当前排序重新编号为 1~${total}，确定吗？\n（将自动备份，可回滚）`)) return;

  try {
    await acquireSchemaLock(layerId);
    const stale = await checkLayerStale(layerId);
    if (stale) {
      // 数据已变 → 刷新但保留排序状态，让用户重新确认
      showToast('⚠ 检测到数据有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      await checkLayerStale(layerId);
      hideToast();
      showToast('数据已刷新，排序设置已保留，请检查后重新点击"更新序号"', 'info', 3000);
      releaseSchemaLock(layerId);
      return;
    }

    // 构建 oldOid → newOid 映射（按 sortedFeatures 顺序，MultiPolygon 取首次出现）
    const seen = new Set();
    const mapping = [];
    let nextOid = 1;
    for (const f of sortedFeatures.value) {
      const oid = f.properties?.OBJECTID;
      if (oid === undefined || oid === null) {
        console.warn('[renumberOids] 要素缺少 OBJECTID:', f.id, f.properties);
        continue;
      }
      const oidStr = String(oid);
      if (!oidStr || seen.has(oidStr)) continue;
      seen.add(oidStr);
      mapping.push({ oldOid: oidStr, newOid: nextOid++ });
    }

    if (mapping.length === 0) {
      showToast('未找到有效的 OBJECTID（该图层数据可能不含 OBJECTID 字段），无法更新序号', 'error', 4000);
      releaseSchemaLock(layerId);
      return;
    }

    const res = await fetch('/api/layers/renumber-oids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ url: layer.url, layerId, mapping })
    });
    const data = await res.json();
    if (!res.ok) {
      // 409 = 并发修改导致 oldOid 不存在 → 刷新数据
      if (res.status === 409) {
        showToast(data.error || '序号已被他人修改，正在刷新...', 'error', 3000);
        await reloadLayer(layerId);
        await checkLayerStale(layerId);
      } else {
        showToast(data.error || '重编号失败', 'error');
      }
      return;
    }

    showToast(`序号更新完成：${data.updated} 条要素`, 'info', 4000);
    await reloadLayer(layerId);
    await checkLayerStale(layerId);
  } catch (e) {
    showToast('更新序号失败：' + e.message, 'error');
  } finally {
    releaseSchemaLock(layerId);
  }
};

// ==========================================
// 统一导入（新建 + 合并）
// ==========================================
const importModalKey = ref(0);
const importModalVisible = ref(false);

const triggerImportExcel = () => {
  importModalKey.value++;
  importModalVisible.value = true;
};

const onImportComplete = async (data) => {
  importModalVisible.value = false;
  showToast(`导入完成：图层 "${data.layerName}"，${data.featureCount} 条要素`, 'info', 4000);

  // 刷新图层树 + 切换到新图层
  const { loadLayerConfig } = await import('../../store/mapState.js');
  await loadLayerConfig();
  const { syncTreeLayers } = await import('../../core/layers/LayerManager.js');
  await syncTreeLayers();
  activeLayerId.value = data.layerId;
};

const onMergeComplete = async (result) => {
  importModalVisible.value = false;
  showToast(`合并完成：匹配 ${result.matchedCount} 行`, 'info', 2000);

  // 刷新合并目标图层（用 emit 传来的 layerId，而非当前 activeLayerId）
  const mergedLayerId = result.layerId || activeLayerId.value;
  await reloadLayer(mergedLayerId);

  // 刷新字段格式
  try {
    const fmts = await loadFieldFormat(mergedLayerId);
    if (fieldSchema[mergedLayerId]) {
      Object.assign(fieldSchema[mergedLayerId], fmts);
    }
  } catch (_) {}

  hideToast();
  showToast('图层已刷新', 'info', 2000);
};

// 几何类型选择弹窗
const bindGeomVisible = ref(false);
const bindGeomResolve = ref(null);

// 清理碎片预览弹窗
const cleanupPreview = reactive({ lines: null, resolve: null });
const selectBindGeom = (type) => {
  bindGeomVisible.value = false;
  if (bindGeomResolve.value) bindGeomResolve.value(type);
  bindGeomResolve.value = null;
};

// 绑定绘图：为已有表格行绘制几何图形
const startBindDraw = async (feature) => {
  const layerId = activeLayerId.value;
  const layer = getLayerState(layerId);
  if (!layer) return;
  const objectId = String(feature.properties?.OBJECTID || feature.id);

  // 如果图层未设置 geometryType，弹出选择器
  if (!layer.geometryType) {
    const geomType = await new Promise(resolve => {
      bindGeomResolve.value = resolve;
      bindGeomVisible.value = true;
    });
    if (!geomType) return;
    layer.geometryType = geomType;
    layer.style = layer.style || {};
    if (geomType === 'polygon') {
      layer.style.fillColor = layer.style.fillColor || '#10b981';
      layer.style.fillOpacity = layer.style.fillOpacity ?? 0.4;
      layer.style.outlineColor = layer.style.outlineColor || '#10b981';
      layer.style.outlineWidth = layer.style.outlineWidth || 2;
    } else if (geomType === 'polyline') {
      layer.style.color = layer.style.color || '#38bdf8';
      layer.style.lineWidth = layer.style.lineWidth || 3;
    } else if (geomType === 'point') {
      layer.style.icon = layer.style.icon || 'none';
      layer.style.fillColor = layer.style.fillColor || '#38bdf8';
    }
    // 持久化到 layer-config
    try {
      const { saveLayerConfig } = await import('../../store/mapState.js');
      await saveLayerConfig();
    } catch (_) {}
  }

  try {
    await acquireFeatureLock(layerId, objectId);
    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      await reloadLayer(layerId);
      await checkLayerStale(layerId);
      hideToast();
    }

    // 切换到地图界面
    mapState.ui.currentView = 'map';

    const { drawEngine } = await import('../../core/viewer/DrawEngine.js');
    // 绑定模式：绘制完成后直接 PATCH 到该 OBJECTID
    drawEngine.start(layerId, { bindToObjectId: objectId });

    // 绘制完成后刷新图层 + 更新属性面板
    drawEngine.onDrawComplete(async () => {
      await reloadLayer(layerId);
      await checkLayerStale(layerId);
      releaseFeatureLock(layerId, objectId);

      // 刷新属性面板数据：reloadLayer 销毁了旧 entity，需要重新拉取属性
      const viewer = getViewer();
      const ds = getLayer(layerId);
      const entities = (ds instanceof Cesium.GeoJsonDataSource) ? ds.entities.values : (viewer?.entities?.values || []);
      for (const e of entities) {
        const time = Cesium.JulianDate.now();
        const p = e.properties?.getValue ? e.properties.getValue(time) : e.properties;
        if (p && String(p.OBJECTID) === String(objectId)) {
          mapState.interaction.selectedFeatureProps = p;
          break;
        }
      }

      showToast('图形已绑定', 'info', 2000);
    });
  } catch (e) {
    showToast('绑定绘图失败：' + e.message, 'error');
    releaseFeatureLock(layerId, objectId);
  }
};

const closeTable = () => {
  activeEditCell.value = { id: null, field: null }; 
  mapState.ui.currentView = 'map';
}
const autoResizeTextarea = (e) => {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
};

const flyToFeature = (feature) => {
  const viewer = getViewer();
  if (!viewer || !activeLayerId.value) return;
  const ds = getLayer(activeLayerId.value);
  const entities = ds instanceof Cesium.GeoJsonDataSource ? ds.entities.values : viewer.entities.values;
  const objId = String(feature.properties?.OBJECTID || feature.id);
  const time = Cesium.JulianDate.now();
  for (const e of entities) {
    const p = e.properties ? e.properties.getValue(time) : null;
    if (p && String(p.OBJECTID) === objId) {
      viewer.flyTo(e, { duration: 1 });
      mapState.ui.currentView = 'map';
      return;
    }
  }
};
</script>

<style scoped>
/* 基础布局样式 */
.data-table-panel { width: 100vw; height: 100vh; background: #0b1120; display: flex; flex-direction: column; color: #fff; position: fixed; z-index: 1001; overflow: hidden; }
.panel-header { height: 60px; padding: 0 6px; background: #1e293b; border-bottom: 2px solid #38bdf8; display: flex; justify-content: space-between; align-items: center; flex-wrap: nowrap; }
.header-left, .header-right { display: flex; align-items: center; gap: 15px; flex-shrink: 0; }
.title { margin: 0; font-size: 20px; color: #38bdf8; letter-spacing: 1px; }
.role-badge { font-size: 12px; padding: 3px 10px; border-radius: 20px; border: 1px solid #38bdf8; color: #38bdf8; }
.result-count { font-size: 14px; color: #94a3b8; }
.result-count span { color: #10b981; font-weight: bold; font-size: 20px; }
.toolbar { padding: 12px 6px; background: #0f172a; display: flex; gap: 20px; align-items: center; border-bottom: 1px solid #334155; flex-wrap: nowrap; }
.tool-group { display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; }
.tech-select, .tech-input { background: #1e293b; border: 1px solid #475569; color: #38bdf8; padding: 6px 10px; border-radius: 4px; outline: none; font-size: 12px; }
.tech-select { max-width: 300px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.table-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.table-scroll { flex: 1; overflow: auto; padding: 0 6px; min-height: 0; }
.tech-table { border-collapse: separate; border-spacing: 0; width: max-content; border-right: 1px solid #334155; transition: all 0.3s; }

/* 表头与表格基础 */
.tech-table th { background: #1e293b; color: #38bdf8; padding: 3px 7px; position: sticky; top: 0; z-index: 10; border-bottom: 2px solid #38bdf8; border-right: 1px solid #334155; font-size: 14px; white-space: normal; word-break: break-word; text-align: center; max-width: 200px; min-width: 80px; }
.data-cell { padding: 4px 7px; border-bottom: 1px solid #1e293b; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; position: relative; }
.tech-table th.sticky-col, .tech-table td.sticky-col { min-width: 36px !important; width: 36px !important; padding: 8px 4px !important; }
.sticky-col { position: sticky; left: 0; background: #1e293b; z-index: 11; border-right: 1px solid #334155; }
.tech-table th.sticky-col { z-index: 12; }
.center { text-align: center !important; }
.table-text { display: block; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; color: #cbd5e1; font-size: 13px; }

/* 交互按钮与提示 */
.readonly-header { color: #ef4444; font-size: 13px; user-select: none; display: flex; align-items: center; justify-content: center; gap: 2px; }
.readonly-text { color: #64748b; cursor: not-allowed; user-select: none; }
.action-btn { background: #38bdf822; border: 1px solid #38bdf8; color: #38bdf8; padding: 1px 3px; border-radius: 3px; cursor: pointer; font-size: 10px; line-height: 1; }
.action-btn:hover { background: #38bdf8; color: #000; }
.bind-btn { background: #10b98122; border-color: #10b981; color: #10b981; }
.bind-btn:hover { background: #10b981; color: #000; }

/* 几何类型选择弹窗 */
.geom-select-dialog {
  background: #0f172a; border: 2px solid #38bdf8; border-radius: 12px;
  padding: 28px 32px; text-align: center; max-width: 360px;
}
.geom-select-title { font-size: 18px; color: #38bdf8; font-weight: bold; margin-bottom: 4px; }
.geom-select-subtitle { font-size: 12px; color: #64748b; margin-bottom: 20px; }
.geom-select-options { display: flex; gap: 12px; justify-content: center; margin-bottom: 16px; }
.geom-option {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 16px 20px; background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  color: #cbd5e1; cursor: pointer; font-size: 13px; transition: all 0.15s;
}
.geom-option:hover { border-color: #38bdf8; background: #243447; color: #fff; }
.geom-icon { font-size: 24px; }
.geom-cancel { background: none; border: none; color: #64748b; cursor: pointer; font-size: 12px; }
.geom-cancel:hover { color: #ef4444; }

/* 清理预览弹窗 */
.cleanup-dialog {
  background: #0f172a; border: 2px solid #f59e0b; border-radius: 12px;
  padding: 28px 32px; max-width: 480px; min-width: 360px;
}
.cleanup-title { font-size: 18px; color: #f59e0b; font-weight: bold; margin-bottom: 16px; text-align: center; }
.cleanup-body { margin-bottom: 20px; }
.cleanup-line { font-size: 13px; color: #cbd5e1; padding: 3px 0; line-height: 1.6; }
.cleanup-line.cleanup-warn { color: #f59e0b; }
.cleanup-line.cleanup-info { color: #64748b; font-size: 12px; padding-left: 8px; word-break: break-all; }
.cleanup-line.cleanup-muted { color: #94a3b8; }
.cleanup-footer { display: flex; gap: 12px; justify-content: center; }
.cleanup-btn {
  padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; border: 1px solid #475569;
}
.cleanup-btn.cancel { background: #1e293b; color: #94a3b8; }
.cleanup-btn.cancel:hover { border-color: #ef4444; color: #ef4444; }
.cleanup-btn.confirm { background: #f59e0b11; border-color: #f59e0b; color: #f59e0b; font-weight: bold; }
.cleanup-btn.confirm:hover { background: #f59e0b; color: #000; }
.close-btn { background: #ef444422; border: 1px solid #ef4444; color: #ef4444; padding: 6px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px; }
.export-btn { background: #38bdf822; border: 1px solid #38bdf8; color: #38bdf8; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-right: 8px; }
.export-btn:hover { background: #38bdf8; color: #000; }
.divider { width: 1px; height: 20px; background: #475569; }
.suggestions-list { position: absolute; top: 110%; left: 0; width: 220px; background: #1e293b; border: 1px solid #38bdf8; border-radius: 4px; list-style: none; padding: 0; margin: 0; max-height: 200px; overflow-y: auto; z-index: 2000; }
.suggestions-list li { padding: 10px; cursor: pointer; border-bottom: 1px solid #334155; font-size: 13px; }

/* 表头编辑样式 */
.header-edit-input { box-sizing: border-box; width: 100%; min-width: 0; background: #0f172a; border: 1px dashed #10b981; color: #10b981; font-weight: bold; padding: 4px; text-align: center; outline: none; border-radius: 4px; transition: 0.2s; white-space: normal; word-break: break-word; resize: none; font-family: inherit; font-size: 14px; line-height: 1.3; }
.header-edit-input:focus { background: #020617; border-style: solid; box-shadow: 0 0 8px rgba(16, 185, 129, 0.5); }
.header-edit-group, .header-view-group { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 0 0 18px 0; overflow: visible; }

/* ==========================================
   🌟 核心修复：Excel 级编辑专属样式
   ========================================== */
.is-editing { box-shadow: inset 0 0 20px rgba(16, 185, 129, 0.2); }
.is-editing th { border-bottom: 2px solid #10b981 !important; }
.is-editing .group-header-row th { border-bottom: none !important; }

/* 🌟 只有当外层 table 有 is-editing 类时，里面的文本才会有编辑提示 */
.is-editing .editable-text {
  cursor: cell;
  border-bottom: 1px dashed #475569;
  display: inline-block;
  width: 100%;
  min-height: 15px;
  transition: all 0.2s;
}
.is-editing .editable-text:hover {
  background: rgba(56, 189, 248, 0.1);
  color: #38bdf8;
}

/* 真正的输入框样式 */
.excel-edit-input {
  box-sizing: border-box;
  background: #020617;
  border: 2px solid #38bdf8;
  color: #fff;
  padding: 2px 6px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  border-radius: 0;
  box-shadow: 0 0 6px rgba(56, 189, 248, 0.3);
}
/* 文本输入框用绝对定位覆盖单元格，不改变列宽 */
input.excel-edit-input {
  position: absolute; inset: 0; width: 100%; height: 100%;
}

/* 分页器样式 */
.pagination-controls { display: flex; justify-content: space-between; align-items: center; padding: 9px 6px; background: #1e293b; border-top: 1px solid #334155; flex-shrink: 0; }
.page-info { font-size: 13px; color: #94a3b8; }
.page-info span { color: #10b981; font-weight: bold; }
.page-buttons { display: flex; align-items: center; gap: 15px; }
.page-btn { background: #0f172a; border: 1px solid #38bdf8; color: #38bdf8; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
.page-btn:disabled { border-color: #475569; color: #475569; cursor: not-allowed; background: transparent; }
.page-btn:not(:disabled):hover { background: #38bdf8; color: #000; font-weight: bold; box-shadow: 0 0 10px rgba(56, 189, 248, 0.4); }
.page-current { font-size: 13px; color: #e2e8f0; }
.page-current b { color: #38bdf8; font-size: 15px; }
/* 字段排序面板 */
.sort-panel-dialog { background: #0f172a; border: 1px solid #334155; border-radius: 12px; width: 520px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.sort-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #1e293b; }
.sort-panel-header h4 { margin: 0; font-size: 16px; color: #e2e8f0; }
.sort-panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.sort-panel-hint { font-size: 12px; color: #64748b; margin: 0 0 16px 0; }
.sort-group { margin-bottom: 16px; }
.sort-group-label { font-size: 13px; color: #94a3b8; font-weight: bold; margin-bottom: 6px; padding: 4px 8px; background: #1e293b; border-radius: 4px; }
.sort-field-list { min-height: 20px; display: flex; flex-direction: column; gap: 2px; }
.sort-field-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; cursor: grab; transition: background .15s; }
.sort-field-item:hover { background: #334155; }
.sort-field-item:active { cursor: grabbing; }
.sort-field-drag { color: #475569; font-size: 14px; letter-spacing: -2px; flex-shrink: 0; }
.sort-field-name { flex: 1; font-size: 13px; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sort-field-tag { font-size: 10px; color: #64748b; background: #0f172a; padding: 1px 4px; border-radius: 2px; flex-shrink: 0; }
.sort-ghost { opacity: .4; background: #38bdf822; border-color: #38bdf8; }
.sort-panel-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid #1e293b; }
.sort-panel-actions .action-btn { padding: 6px 16px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none; }
.sort-panel-actions .action-btn.secondary { background: #334155; color: #94a3b8; }
.sort-panel-actions .action-btn:not(.secondary) { background: #7c3aed; color: #fff; }
.sort-panel-actions .action-btn:hover { filter: brightness(1.2); }
/* 日期/时间段弹窗选择器 */
.date-editor-backdrop { position: fixed; inset: 0; z-index: 100005; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.25); }
.date-editor-dialog { background: #0f172a; border: 1px solid #334155; border-radius: 12px; width: 340px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.date-editor-header { padding: 14px 20px 0; font-size: 14px; color: #94a3b8; }
.date-editor-body { padding: 16px 20px; }
.date-editor-input { width: 100%; max-width: 100%; box-sizing: border-box; padding: 8px 10px; background: #020617; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; font-size: 15px; outline: none; color-scheme: dark; }
.date-editor-input:focus { border-color: #38bdf8; }
.date-editor-dialog .date-editor-body > div { max-width: 100%; }
.date-editor-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid #1e293b; }
.date-editor-actions .action-btn { padding: 6px 16px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none; }
.date-editor-actions .action-btn.secondary { background: #334155; color: #94a3b8; }
.date-editor-actions .action-btn:not(.secondary) { background: #38bdf8; color: #000; }
</style><style scoped>
.field-key-input { width: 140px; background: #020617; border: 1px solid #475569; color: #38bdf8; padding: 4px 8px; border-radius: 4px; font-size: 12px; outline: none; }
.field-key-input:focus { border-color: #38bdf8; }
.field-type-sel, .field-group-sel { padding: 4px 6px; background: #020617; border: 1px solid #475569; color: #94a3b8; border-radius: 4px; font-size: 12px; }
.field-type-sel { width: 90px; }
.field-group-sel { width: 120px; }
.field-group-name-input { width: 90px; padding: 4px 6px; background: #020617; border: 1px solid #f59e0b; color: #fbbf24; border-radius: 4px; font-size: 12px; outline: none; }
.field-group-name-input:focus { border-color: #fbbf24; box-shadow: 0 0 4px rgba(251,191,36,.3); }
.field-group-name-input::placeholder { color: #78350f; }
.add-field-btn { padding: 4px 12px; background: #38bdf811; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 4px; cursor: pointer; font-size: 12px; }
.add-field-btn:hover { background: #38bdf8; color: #000; }
.sort-panel-btn { padding: 4px 12px; background: #7c3aed11; border: 1px solid #7c3aed; color: #a78bfa; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 4px; }
.sort-panel-btn:hover { background: #7c3aed; color: #fff; }
.header-edit-row2 { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); white-space: nowrap; display: flex; align-items: center; gap: 2px; z-index: 1; }
.header-del-btn { background: none; border: none; color: #ef4444; font-size: 13px; cursor: pointer; padding: 0 1px; opacity: 0.5; }
.header-del-btn:hover { opacity: 1; }
.header-format-btn { background: none; border: none; color: #facc15; font-size: 12px; cursor: pointer; padding: 0 1px; opacity: 0.5; }
.header-format-btn:hover { opacity: 1; }
.format-tag { white-space: nowrap; padding: 0 3px; background: rgba(56,189,248,0.15); color: #38bdf8; font-size: 10px; border-radius: 3px; }
.header-view-group .format-tag { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); }
.format-dropdown { position: absolute; top: 100%; left: 0; min-width: 120px; background: #0f172a; border: 1px solid #38bdf8; border-radius: 4px; padding: 4px; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
.format-option { padding: 4px 8px; font-size: 12px; color: #94a3b8; cursor: pointer; border-radius: 3px; white-space: nowrap; }
.format-option:hover { background: rgba(56,189,248,0.15); color: #38bdf8; }
.format-option.active { background: rgba(56,189,248,0.2); color: #38bdf8; font-weight: bold; }
.format-tag { display: inline-block; margin-left: 2px; padding: 0 3px; background: rgba(56,189,248,0.15); color: #38bdf8; font-size: 10px; border-radius: 3px; vertical-align: middle; }
.bool-cell { display: flex; justify-content: center; align-items: center; height: 100%; }
.bool-cell input[type="checkbox"] { width: 18px; height: 18px; accent-color: #38bdf8; cursor: pointer; }
.bool-cell input[type="checkbox"]:disabled { -webkit-appearance: none; appearance: none; accent-color: initial; border: 2px solid #475569; border-radius: 3px; background: transparent; cursor: default; position: relative; }
.bool-cell input[type="checkbox"]:disabled:checked { background: #38bdf8; border-color: #38bdf8; }
.bool-cell input[type="checkbox"]:disabled:checked::after { content: ''; position: absolute; left: 3px; top: 1px; width: 5px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.bool-display { cursor: pointer; text-align: center; }
.bool-true { color: #10b981; }
.image-cell { display: flex; align-items: center; justify-content: center; }
.image-count { font-size: 12px; color: #38bdf8; }
.image-empty { color: #64748b; }
.lightbox-mask { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.lightbox-close { position: absolute; top: 16px; right: 16px; width: 40px; height: 40px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 20px; cursor: pointer; z-index: 1; }
.lightbox-img-wrap { max-width: 90vw; max-height: 80vh; display: flex; align-items: center; justify-content: center; }
.lightbox-img-wrap img { max-width: 100%; max-height: 80vh; object-fit: contain; }
.lightbox-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.lightbox-nav { width: 40px; height: 40px; background: rgba(0,0,0,0.5); border: 1px solid #475569; color: #fff; border-radius: 50%; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.lightbox-nav:hover { background: rgba(56,189,248,0.3); border-color: #38bdf8; }
.lightbox-counter { color: #94a3b8; font-size: 14px; min-width: 48px; text-align: center; }
.lightbox-del { padding: 8px 18px; background: rgba(239,68,68,0.7); border: 1px solid #ef4444; color: #fff; border-radius: 20px; font-size: 14px; cursor: pointer; margin-left: auto; }
.lightbox-del:hover { background: rgba(239,68,68,0.9); }
.group-header-row th { padding: 6px 12px; background: #1a2332; border-bottom: none; font-size: 13px; line-height: 16px; color: #38bdf8; cursor: pointer; user-select: none; white-space: nowrap; box-sizing: border-box; height: 30px; }
.tech-table.grouped .field-name-row th { top: 30px; border-top: 2px solid #334155; }
.group-header-row th:hover { background: #243447; }
.group-header-row th.collapsed { color: #64748b; }
.group-toggle { font-size: 10px; margin-right: 4px; }
.group-header-cell .group-rename-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 10px; padding: 0 2px; margin-left: 4px; vertical-align: middle; }
.group-header-cell .group-rename-btn:hover { color: #38bdf8; }
.group-header-cell .group-migrate-btn { background: none; border: none; color: #f59e0b; cursor: pointer; font-size: 10px; padding: 0 2px; margin-left: 4px; vertical-align: middle; }
.group-header-cell .group-migrate-btn:hover { color: #fbbf24; }
.group-header-cell .group-rename-input { background: #0f172a; border: 1px solid #38bdf8; color: #fff; padding: 2px 6px; font-size: 13px; font-weight: bold; border-radius: 3px; outline: none; width: 120px; }
.col-collapsed { visibility: collapse; width: 0; min-width: 0; }
.th-collapsed { overflow: hidden; border-right: 0 !important; padding: 0 !important; }
/* 列右边界"就地插列"加号：默认隐藏，悬停列名时显示 */
.field-header { position: relative; }
.col-insert-handle { position: absolute; bottom: 2px; right: 1px; z-index: 14;
  width: 11px; height: 11px; line-height: 10px; text-align: center; padding: 0;
  background: #10b981; color: #fff; border: none; border-radius: 50%; font-size: 9px;
  cursor: pointer; opacity: 0; transition: opacity .15s; box-shadow: 0 0 5px rgba(16,185,129,.6); }
.sort-indicator.sortable { cursor: pointer; padding: 2px 3px; }
.sort-indicator {
  font-size: 10px; color: #475569; margin-right: 2px;
  opacity: 0; transition: opacity 0.15s; flex-shrink: 0;
}
.field-header:hover .sort-indicator,
.sort-indicator.active { opacity: 1; }
.sort-indicator.active { color: #10b981; }
.sort-indicator.head-sort {
  position: absolute; left: 2px; bottom: 2px; margin: 0; z-index: 1;
}
.field-header:hover .col-insert-handle { opacity: 1; }
.col-insert-handle:hover { background: #059669; }
/* 列头拖拽把手 */
.drag-handle { opacity: 0; cursor: grab; color: #64748b; font-size: 12px; letter-spacing: -2px; user-select: none; padding: 0 2px; transition: opacity .15s; }
.field-header:hover .drag-handle { opacity: 1; }
.field-header[draggable="true"]:active .drag-handle { cursor: grabbing; }
.field-header.drag-over { box-shadow: inset 2px 0 0 0 #38bdf8; }
/* 加字段输入框被加号激活时的红字提示态 */
.field-key-input.hint-active { border-color: #f87171 !important; box-shadow: 0 0 6px rgba(248,113,113,.5); }
.field-key-input.hint-active::placeholder { color: #f87171; }
.locate-col { width: 36px; min-width: 36px; }
.oid-col { width: 70px; min-width: 70px; }
.oid-bottom-row { display: flex; align-items: center; gap: 2px; justify-content: flex-start; padding-left: 2px; }
.oid-lock { font-size: 9px; color: #ef4444; }
.oid-sort { font-size: 10px; }
.oid-cell { width: 70px !important; min-width: 70px !important; max-width: 70px !important; padding-left: 6px !important; padding-right: 6px !important; position: sticky; left: 36px; background: #1e293b; z-index: 11; border-right: 1px solid #334155; }
.tech-table th.oid-cell { z-index: 13; }
.tech-table th.sticky-col { max-width: none; }
.frz-first { position: sticky; left: 106px; background: #1e293b; z-index: 11; border-right: 1px solid #334155; }
.tech-table th.frz-first { z-index: 13; }
.tech-table th.frz-group { position: sticky; top: 0; background: #1a2332; z-index: 12; /* 不冻结横向：避免宽分组遮挡后面分组名 */ }

/* 下拉选项编辑弹窗 */
.options-editor-dialog { background: #1e293b; border: 1px solid #38bdf8; border-radius: 8px; padding: 20px; min-width: 380px; max-width: 480px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
.options-editor-title { font-size: 14px; color: #38bdf8; margin-bottom: 12px; font-weight: bold; }
.options-editor-textarea { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; font-size: 13px; padding: 10px; resize: vertical; outline: none; font-family: inherit; line-height: 1.6; }
.options-editor-textarea:focus { border-color: #38bdf8; }
.options-editor-hint { font-size: 11px; color: #64748b; margin: 4px 0 16px 0; }
.options-editor-actions { display: flex; gap: 8px; justify-content: flex-end; }
.options-editor-actions .action-btn { padding: 8px 20px; font-size: 13px; border-radius: 6px; }
.options-editor-actions .action-btn.secondary { background: #334155; border-color: #475569; color: #94a3b8; }
.options-editor-actions .action-btn.secondary:hover { background: #475569; color: #e2e8f0; }

</style>
