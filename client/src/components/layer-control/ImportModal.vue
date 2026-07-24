<template>
  <Teleport to="body">
    <!-- 隐藏文件输入 -->
    <input type="file" ref="fileInputEl" accept=".xlsx,.xls" style="display:none" @change="onFileSelected" @click.stop />

    <div v-if="visible" class="lightbox-mask" style="z-index:100000; display:flex; align-items:center; justify-content:center;" @click="onMaskClick">
      <div class="import-modal" @click.stop>
        <div class="import-modal-header">
          <h3>📤 导入 Excel 数据</h3>
          <button class="import-modal-close" @click="$emit('close')">✕</button>
        </div>

        <div class="import-modal-body">
          <!-- ============ 导入方式选择 ============ -->
          <div class="import-field-row">
            <label>导入方式：</label>
            <label class="mode-radio"><input type="radio" v-model="mode" value="new" /> 创建新图层</label>
            <label class="mode-radio"><input type="radio" v-model="mode" value="merge" /> 合并到已有图层</label>
          </div>

          <!-- ============ 新建模式：图层名称 + 选项 ============ -->
          <div class="import-field-row" v-if="mode === 'new'">
            <label>图层名称：</label>
            <input type="text" v-model="state.layerName" class="tech-input" style="width:200px;" placeholder="输入图层名称" />
          </div>
          <div class="import-field-row" v-if="mode === 'new'">
            <label>所属文件夹：</label>
            <select v-model="state.targetFolder" class="tech-select" style="width:200px;">
              <option value="">-- 默认（自动） --</option>
              <option v-for="f in folderOptions" :key="f" :value="f">{{ f }}</option>
            </select>
            <label style="margin-left:12px;">要素类型：</label>
            <select v-model="state.geometryType" class="tech-select" style="width:130px;">
              <option value="">暂不指定</option>
              <option value="point">点要素</option>
              <option value="polyline">线要素</option>
              <option value="polygon">面要素</option>
            </select>
          </div>

          <!-- ============ 合并模式：目标图层 ============ -->
          <div class="import-field-row" v-if="mode === 'merge'">
            <label>目标图层：</label>
            <select v-model="state.targetLayerId" class="tech-select" style="width:260px;">
              <option value="">-- 选择图层 --</option>
              <option v-for="l in geojsonLayers" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select>
          </div>

          <!-- ============ 文件选择 / 重新选择 ============ -->
          <div class="import-field-row">
            <label>选择文件：</label>
            <button type="button" class="import-file-btn" @click="triggerFileInput">
              {{ state.parsed ? '📤 重新选择 Excel 文件' : '📤 选择 Excel 文件' }}
            </button>
            <span class="merge-file-info" v-if="state.parsed">
              📋 {{ state.parsed.sheetName }} · {{ state.parsed.fields.length }} 字段 · {{ state.parsed.totalRows }} 行
            </span>
          </div>

          <!-- ============ 已解析：摘要 ============ -->
          <div class="import-summary" v-if="state.parsed">
            <span class="summary-chip">📋 {{ { 'double-row': '双行表头', 'prefix': '前缀编码', 'flat': '单行平铺' }[state.parsed.mode] || state.parsed.mode }}</span>
            <span class="summary-chip" v-if="state.parsed.groups.length">📁 {{ state.parsed.groups.length }} 个分组</span>
            <span class="summary-chip">📝 {{ state.parsed.fields.length }} 个字段</span>
            <span class="summary-chip">📊 {{ state.parsed.totalRows }} 行数据</span>
          </div>

          <!-- ============ 警告 ============ -->
          <div v-if="state.warnings.length" class="import-warnings">
            <div v-for="(w, i) in state.warnings" :key="i" class="import-warning-item">⚠️ {{ w }}</div>
          </div>

          <!-- ============ 新建模式：字段预览表格（含类型编辑） ============ -->
          <template v-if="mode === 'new' && state.parsed">
            <div class="import-preview-table-wrap">
              <table class="import-preview-table">
                <thead>
                  <tr>
                    <th style="width:30px;">#</th>
                    <th>字段名</th>
                    <th style="width:80px;">分组</th>
                    <th style="width:70px;">类型</th>
                    <th style="width:160px;">示例值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, fi) in state.parsed.fields" :key="fi" :class="{ 'oid-row': f.isOid }">
                    <td class="center">{{ fi + 1 }}</td>
                    <td>
                      <span class="field-name-text">{{ f.key }}</span>
                      <span v-if="f.isOid" class="oid-tag">🔒主键</span>
                    </td>
                    <td>
                      <span class="group-tag" v-if="f.group" :style="{ background: groupColor(f.group) }">
                        {{ getGroupLabel(f.group) }}
                      </span>
                      <span v-else class="group-tag-ungrouped">基本信息</span>
                    </td>
                    <td>
                      <select v-model="f.inferredType" class="type-sel-mini">
                        <option v-for="t in TYPE_OPTIONS" :key="t" :value="t">{{ TYPE_LABELS[t] }}</option>
                      </select>
                    </td>
                    <td class="sample-cell"><span class="sample-value">{{ getSampleValue(fi) }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- ============ 合并模式：匹配字段 + 分组映射 ============ -->
          <template v-if="mode === 'merge' && state.parsed">
            <!-- 匹配字段选择 -->
            <div class="merge-section merge-match-highlight" :class="{ 'merge-match-active': !state.targetMatchField || !state.importMatchField }">
              <label class="section-label">匹配字段（用于关联两张表）：</label>
              <div class="match-row">
                <span class="match-label">目标图层字段</span>
                <select v-model="state.targetMatchField" class="tech-select" style="width:170px;">
                  <option value="">-- 选择 --</option>
                  <option v-for="k in targetFieldKeys" :key="k" :value="k">{{ k }}</option>
                </select>
                <span class="match-arrow">=</span>
                <span class="match-label">导入表格字段</span>
                <select v-model="state.importMatchField" class="tech-select" style="width:170px;">
                  <option value="">-- 选择 --</option>
                  <option v-for="f in state.parsed.fields" :key="f.key" :value="f.key" :disabled="f.isOid && f.key !== state.importMatchField">{{ f.key }}</option>
                </select>
              </div>
              <div class="match-row" style="margin-top:6px;">
                <span class="match-label">匹配方式：</span>
                <select v-model="state.matchMode" class="tech-select" style="width:140px;">
                  <option value="exact">精确匹配</option>
                  <option value="contains">包含匹配</option>
                </select>
                <span class="merge-file-info" v-if="state.matchMode === 'contains'">（A包含B 或 B包含A）</span>
              </div>
              <div v-if="!state.targetMatchField || !state.importMatchField" class="merge-match-hint">
                👆 请选择两侧的匹配字段，确定用哪个字段关联两张表
              </div>
            </div>

            <!-- 辅助匹配字段（可选，用于精确区分） -->
            <div class="merge-section" v-if="state.targetMatchField && state.importMatchField">
              <label class="section-label">辅助匹配字段（可选）：</label>
              <div class="match-row" style="margin-bottom:4px;">
                <span class="match-label">匹配模式：</span>
                <select v-model="state.auxMatchMode" class="tech-select" style="width:130px;">
                  <option value="exact">严格匹配</option>
                  <option value="firstlast">首末字相同</option>
                </select>
                <span class="merge-file-info" v-if="state.auxMatchMode === 'firstlast'">（忽略中间差异）</span>
              </div>
              <div class="match-row">
                <span class="match-label">目标字段</span>
                <select v-model="state.secondaryTargetField" class="tech-select" style="width:150px;">
                  <option value="">-- 不启用 --</option>
                  <option v-for="k in targetFieldKeys.filter(x => x !== state.targetMatchField && x !== state.tertiaryTargetField)" :key="k" :value="k">{{ k }}</option>
                </select>
                <span class="match-arrow">+</span>
                <span class="match-label">导入字段</span>
                <select v-model="state.secondaryImportField" class="tech-select" style="width:150px;">
                  <option value="">-- 不启用 --</option>
                  <option v-for="f in state.parsed.fields.filter(x => x.key !== state.importMatchField && x.key !== state.tertiaryImportField)" :key="f.key" :value="f.key">{{ f.key }}</option>
                </select>
              </div>
              <div class="match-row" style="margin-top:4px;" v-if="state.secondaryTargetField || state.secondaryImportField">
                <span class="match-label">目标字段2</span>
                <select v-model="state.tertiaryTargetField" class="tech-select" style="width:150px;">
                  <option value="">-- 不启用 --</option>
                  <option v-for="k in targetFieldKeys.filter(x => x !== state.targetMatchField && x !== state.secondaryTargetField)" :key="k" :value="k">{{ k }}</option>
                </select>
                <span class="match-arrow">+</span>
                <span class="match-label">导入字段2</span>
                <select v-model="state.tertiaryImportField" class="tech-select" style="width:150px;">
                  <option value="">-- 不启用 --</option>
                  <option v-for="f in state.parsed.fields.filter(x => x.key !== state.importMatchField && x.key !== state.secondaryImportField)" :key="f.key" :value="f.key">{{ f.key }}</option>
                </select>
              </div>
            </div>

            <!-- 重复统计 -->
            <div class="merge-section preview-stats-box" v-if="state.targetMatchField && state.importMatchField && dupStats">
              <label class="section-label">匹配统计：</label>
              <div class="preview-stats">
                <span class="preview-stat matched">✓ 匹配成功：{{ preview.matchedCount }} 行</span>
                <span class="preview-stat unmatched" v-if="preview.unmatchedCount > 0">⚠ 未匹配：{{ preview.unmatchedCount }} 行</span>
                <span class="preview-stat skipped" v-if="preview.skippedCount > 0">⊘ 空值跳过：{{ preview.skippedCount }} 行</span>
                <span class="preview-stat dup" v-if="dupStats.importDups > 0">🔁 导入表主键重复：{{ dupStats.importDups }} 个值</span>
                <span class="preview-stat info" v-for="n in dupStats.importDupNames" :key="'i'+n" style="padding-left:16px;">· {{ n }}</span>
                <span class="preview-stat info" v-if="dupStats.importHasMore" style="padding-left:16px;">· …还有更多</span>
                <span class="preview-stat dup" v-if="dupStats.targetDups > 0">🔁 目标表主键重复：{{ dupStats.targetDups }} 个值</span>
                <span class="preview-stat info" v-for="n in dupStats.targetDupNames" :key="'t'+n" style="padding-left:16px;">· {{ n }}</span>
                <span class="preview-stat info" v-if="dupStats.targetHasMore" style="padding-left:16px;">· …还有更多</span>
                <span class="preview-stat toggle" v-if="dupStats.importDups + dupStats.targetDups > 5" @click="showAllDups = !showAllDups" style="cursor:pointer; padding-left:16px;">
                  {{ showAllDups ? '▲ 收起' : '▼ 显示全部（' + dupStats.totalBoth + ' 项）' }}
                </span>
                <span class="preview-stat hint" v-if="dupStats.importDups > 0 && !state.secondaryImportField">💡 建议启用二级匹配字段以精确区分</span>
              </div>
            </div>

            <!-- 字段选择 + 分组映射 -->
            <div class="merge-section" v-if="state.targetMatchField && state.importMatchField">
              <label class="section-label">选择要合并的字段及其目标分组：</label>
              <div class="all-select-row">
                <button type="button" class="all-select-btn" @click="toggleAllFields(true)">全选</button>
                <button type="button" class="all-select-btn" @click="toggleAllFields(false)">取消全选</button>
                <span class="all-select-count">{{ state.selectedImportFields.length }}/{{ importFieldsTotal }} 个字段</span>
              </div>
              <div class="field-group-grid">
                <template v-for="g in importGroupsWithFields" :key="g.id">
                  <div class="fg-group-header">
                    📁 {{ g.label }}
                  </div>
                  <div v-for="f in g.fields" :key="f.key" class="fg-field-row"
                       :class="{ 'fg-conflict': isConflictField(f.key), 'fg-skipped': skipFields.has(f.key) }">
                    <label class="fg-checkbox">
                      <input type="checkbox" :value="f.key" v-model="state.selectedImportFields" />
                      <span class="fg-field-name">{{ f.key }}</span>
                      <select v-model="f.inferredType" class="fg-type-sel">
                        <option v-for="t in TYPE_OPTIONS" :key="t" :value="t">{{ TYPE_LABELS[t] }}</option>
                      </select>
                      <span v-if="isConflictField(f.key)" class="conflict-tag">⚠冲突</span>
                      <span v-if="skipFields.has(f.key)" class="skip-tag">已跳过</span>
                    </label>
                    <span class="fg-arrow">→</span>
                    <select v-model="groupAssignments[f.key]" class="tech-select fg-group-sel">
                      <option v-for="tg in targetGroupOptions" :key="tg.value" :value="tg.value">{{ tg.label }}</option>
                      <option value="__new__">+ 新建分组...</option>
                    </select>
                    <input v-if="groupAssignments[f.key] === '__new__'" v-model="newGroupNames[f.key]"
                           class="tech-input" style="width:120px;" placeholder="分组名" />
                  </div>
                </template>
              </div>
            </div>

            <!-- 冲突处理 -->
            <div class="merge-section" v-if="fieldConflicts.length > 0">
              <label class="section-label">字段名冲突处理：</label>
              <!-- 全局快捷设置 -->
              <div class="conflict-global-row" v-if="fieldConflicts.length > 0">
                <span class="conflict-global-label">全局设置：</span>
                <select v-model="globalConflictResolution" @change="applyGlobalConflict" class="tech-select" style="width:140px;">
                  <option value="">-- 逐字段设置 --</option>
                  <option value="__overwrite__">全部覆盖现有字段</option>
                  <option value="__skip__">全部跳过不导入</option>
                  <option value="__rename__">全部重命名（原名后加_import）</option>
                </select>
                <span class="conflict-global-hint" v-if="globalConflictResolution">已全局应用，可单独调整</span>
              </div>
              <div v-for="key in activeConflicts" :key="key" class="conflict-row" :class="{ 'conflict-skipped': conflictResolutions[key] === '__skip__' }">
                <span class="conflict-name">
                  {{ conflictResolutions[key] === '__skip__' ? `"${key}" 已跳过（恢复：切换处理方式）` : `"${key}" 已存在于目标图层` }}
                </span>
                <select v-model="conflictResolutions[key]" class="tech-select" style="width:130px;">
                  <option value="">-- 处理方式 --</option>
                  <option value="__overwrite__">覆盖现有</option>
                  <option value="__skip__">跳过不导入</option>
                  <option value="__rename__">重命名为</option>
                </select>
                <input v-if="conflictResolutions[key] === '__rename__'" v-model="renameValues[key]"
                       class="tech-input" style="width:150px;" placeholder="新字段名" />
              </div>
            </div>

            <!-- 未匹配行选项 -->
            <div class="merge-section">
              <label class="cb-label">
                <input type="checkbox" v-model="state.createUnmatched" />
                为未匹配的导入行创建新要素（geometry 为空，仅作为表格数据行）
              </label>
              <label class="cb-label cb-warn" style="margin-top:6px;">
                <input type="checkbox" v-model="state.deleteUnmatched" />
                ⚠ 删除目标表中未匹配的要素（将不可恢复，自动备份）
              </label>
            </div>

            <!-- 匹配预览 -->
            <div class="merge-section preview-section" v-if="preview">
              <label class="section-label">匹配预览：</label>
              <div class="preview-stats">
                <span class="preview-stat matched">✓ 匹配成功：{{ preview.matchedCount }} 行</span>
                <span class="preview-stat unmatched" v-if="preview.unmatchedCount > 0">⚠ 未匹配：{{ preview.unmatchedCount }} 行</span>
                <span class="preview-stat created" v-if="state.createUnmatched && preview.unmatchedCount > 0">
                  → 将创建 {{ preview.unmatchedCount }} 条新要素
                </span>
                <span class="preview-stat skipped" v-if="preview.skippedCount > 0">⊘ 空值跳过：{{ preview.skippedCount }} 行</span>
              </div>
            </div>
          </template>
        </div>

        <div class="import-modal-footer">
          <button type="button" class="import-cancel-btn" @click="$emit('close')">取消</button>
          <button type="button" class="import-confirm-btn" @click="confirm" :disabled="!canConfirm || state.importing">
            {{ state.importing ? '处理中...' : mode === 'new' ? '✓ 创建新图层' : '✓ 确认合并' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, reactive, computed, nextTick } from 'vue';
import { mapState, fieldSchema, fieldGroupsMeta, getLayerState, showToast } from '../../store/mapState';
import { parseExcelFile, validateParseResult, TYPE_LABELS, TYPE_OPTIONS } from '../../core/excelImporter';
import { acquireSchemaLock, releaseSchemaLock, checkLayerStale } from '../../core/locks';
import { parseFieldGroups, getGroupFieldKeys } from '../../core/fieldGroups';

const props = defineProps({
  visible: Boolean,
  activeLayerId: String
});
const emit = defineEmits(['close', 'imported', 'merged']);

const fileInputEl = ref(null);

// ---- 核心状态 ----
const mode = ref('new'); // 'new' | 'merge'
const state = reactive({
  parsed: null,
  warnings: [],
  layerName: '',
  targetFolder: '',
  geometryType: '',
  targetLayerId: '',
  targetMatchField: '',
  importMatchField: '',
  matchMode: 'exact',
  secondaryTargetField: '',
  secondaryImportField: '',
  tertiaryTargetField: '',
  tertiaryImportField: '',
  auxMatchMode: 'exact',
  selectedImportFields: [],
  createUnmatched: false,
  deleteUnmatched: false,
  importing: false
});

// 公共子串检测：两字符串是否存在 ≥minLen 的连续匹配片段
const _hasCommonSubstring = (a, b, minLen) => {
  if (a.length < minLen || b.length < minLen) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const seen = new Set();
  for (let i = 0; i <= shorter.length - minLen; i++) {
    seen.add(shorter.substring(i, i + minLen));
  }
  for (const sub of seen) {
    if (longer.includes(sub)) return true;
  }
  return false;
};

// 组件初始化（依赖 :key 重建保证每次打开都是全新状态）
state.targetLayerId = props.activeLayerId || '';

// ---- 文件夹列表 ----
const folderOptions = computed(() => {
  const names = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'folder') names.push(n.name);
      if (n.children) walk(n.children);
    }
  };
  walk(mapState.layerTree || []);
  return names;
});

// ---- 图层列表 ----
const geojsonLayers = computed(() => {
  const result = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'geojson') result.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(mapState.layerTree || []);
  return result;
});

// ---- 目标图层字段 ----
const targetFieldKeys = computed(() => {
  const schema = fieldSchema[state.targetLayerId];
  if (!schema) return [];
  const meta = fieldGroupsMeta[state.targetLayerId];
  const groups = parseFieldGroups(schema, meta);
  const ordered = [];
  const seen = new Set();
  for (const g of groups) {
    for (const k of getGroupFieldKeys(g)) {
      ordered.push(k);
      seen.add(k);
    }
  }
  // 补充不在任何分组中的字段
  for (const k of Object.keys(schema)) {
    if (!seen.has(k)) ordered.push(k);
  }
  return ordered;
});

// ---- 目标图层分组选项（合并模式） ----
const targetGroupOptions = computed(() => {
  const opts = [{ value: '', label: '基本信息（无分组）' }];
  const meta = fieldGroupsMeta[state.targetLayerId];
  if (Array.isArray(meta)) {
    for (const g of meta) {
      opts.push({ value: g.id, label: g.label });
    }
  }
  return opts;
});

// 可选字段总数（包含匹配字段，用户可自行选择是否保留）
const importFieldsTotal = computed(() => {
  if (!state.parsed) return 0;
  return state.parsed.fields.filter(f => !f.skip).length;
});

const toggleAllFields = (select) => {
  if (!state.parsed) return;
  if (select) {
    state.selectedImportFields = state.parsed.fields
      .filter(f => !f.skip)
      .map(f => f.key);
  } else {
    state.selectedImportFields = [];
  }
};

// ---- 导入分组 + 字段（用于合并模式展示） ----
const importGroupsWithFields = computed(() => {
  if (!state.parsed) return [];
  const allFields = state.parsed.fields.filter(f => !f.skip);
  const groups = state.parsed.groups || [];

  const result = [];
  const ungrouped = allFields.filter(f => !f.group);
  if (ungrouped.length) {
    result.push({ id: '__ungrouped__', label: '基本信息', fields: ungrouped });
  }
  for (const g of groups) {
    const fields = allFields.filter(f => f.group === g.id);
    if (fields.length) {
      result.push({ id: g.id, label: g.label, fields });
    }
  }
  return result;
});

// ---- 冲突字段 ----
const isConflictField = (key) => {
  return new Set(targetFieldKeys.value).has(key);
};
// 所有存在冲突的导入字段名（无论是否已处理）
const fieldConflicts = computed(() => {
  if (!state.parsed) return [];
  const target = new Set(targetFieldKeys.value);
  return state.parsed.fields.filter(f => target.has(f.key)).map(f => f.key);
});

// 冲突处理状态
const conflictResolutions = ref({}); // { [key]: '__overwrite__'|'__skip__'|'__rename__'|'' }
const renameValues = ref({});        // { [key]: 'newName' }
const globalConflictResolution = ref('');
// 已标记为跳过的字段（用于视觉标记，不影响 checkbox 可用性）
const skipFields = computed(() => {
  const set = new Set();
  for (const [k, v] of Object.entries(conflictResolutions.value)) {
    if (v === '__skip__') set.add(k);
  }
  return set;
});

const applyGlobalConflict = () => {
  const mode = globalConflictResolution.value;
  if (!mode) return;
  for (const key of fieldConflicts.value) {
    conflictResolutions.value[key] = mode;
    if (mode === '__rename__') {
      renameValues.value[key] = key + '_import';
    }
  }
};

// 所有冲突字段（含已跳过的，保留以便用户恢复）
const activeConflicts = computed(() => {
  return state.selectedImportFields.filter(k => isConflictField(k));
});

// 是否所有冲突都已处理
const conflictsResolved = computed(() => {
  const conflictKeys = state.selectedImportFields.filter(k => isConflictField(k));
  return conflictKeys.every(k => {
    const r = conflictResolutions.value[k];
    if (!r) return false;
    if (r === '__rename__' && !renameValues.value[k]?.trim()) return false;
    return true;
  });
});

// 字段名最终映射
const finalFieldNameResolutions = computed(() => {
  const map = {};
  for (const [key, r] of Object.entries(conflictResolutions.value)) {
    if (r === '__rename__' && renameValues.value[key]?.trim()) {
      map[key] = renameValues.value[key].trim();
    }
  }
  return map;
});

// ---- 分组映射 ----
const groupAssignments = ref({});  // { [fieldKey]: targetGroupId | '__new__' | '' }
const newGroupNames = ref({});     // { [fieldKey]: 'new group name' }

// 构建最终的分组分配（供提交用）
const buildGroupAssignments = () => {
  const result = {};
  for (const key of state.selectedImportFields) {
    const ga = groupAssignments.value[key];
    if (!ga) {
      result[key] = { group: null };
    } else if (ga.startsWith('__new__')) {
      // `__new__label` → 自动创建分组
      result[key] = { group: null, newGroup: ga.slice(7) };
    } else {
      result[key] = { group: ga };
    }
  }
  return result;
};

// ---- 客户端匹配预览 ----
// 重复统计展开/收起
const showAllDups = ref(false);

// 重复统计：检查主键在两张表中的重复情况
const dupStats = computed(() => {
  if (!state.parsed || !state.targetMatchField || !state.importMatchField) return null;
  const layer = getLayerState(state.targetLayerId);
  const features = layer?.features || [];

  const importCounts = new Map();
  for (const row of state.parsed.rows) {
    const v = String(row[state.importMatchField] ?? '').trim();
    if (v) importCounts.set(v, (importCounts.get(v) || 0) + 1);
  }
  const importDupEntries = [...importCounts.entries()].filter(([, c]) => c > 1);
  const importDupAll = importDupEntries.map(([k, c]) => `${k}(${c}次)`);

  const targetCounts = new Map();
  for (const f of features) {
    const v = String(f.properties?.[state.targetMatchField] ?? '').trim();
    if (v) targetCounts.set(v, (targetCounts.get(v) || 0) + 1);
  }
  const targetDupEntries = [...targetCounts.entries()].filter(([, c]) => c > 1);
  const targetDupAll = targetDupEntries.map(([k, c]) => `${k}(${c}次)`);

  const totalBoth = importDupEntries.length + targetDupEntries.length;

  return {
    importDups: importDupEntries.length,
    importDupNames: showAllDups.value ? importDupAll : importDupAll.slice(0, 5),
    importHasMore: importDupEntries.length > 5 && !showAllDups.value,
    targetDups: targetDupEntries.length,
    targetDupNames: showAllDups.value ? targetDupAll : targetDupAll.slice(0, 5),
    targetHasMore: targetDupEntries.length > 5 && !showAllDups.value,
    totalBoth,
    expanded: showAllDups.value,
  };
});

const preview = computed(() => {
  if (!state.parsed || !state.targetMatchField || !state.importMatchField) return null;

  const layer = getLayerState(state.targetLayerId);
  const features = layer?.features || [];

  // 辅助字段值归一化（首末字模式时只取首尾字符）
  const _normAux = (v) => {
    const s = String(v ?? '').trim();
    if (!s || state.auxMatchMode !== 'firstlast') return s;
    return s.length === 1 ? s : s[0] + s[s.length - 1];
  };

  // 构建匹配键：主键 + 可选辅助键
  const makeTargetKey = (f) => {
    const pk = String(f.properties?.[state.targetMatchField] ?? '').trim();
    if (!pk) return null;
    const parts = [pk];
    if (state.secondaryTargetField) parts.push(_normAux(f.properties?.[state.secondaryTargetField]));
    if (state.tertiaryTargetField) parts.push(_normAux(f.properties?.[state.tertiaryTargetField]));
    return parts.join('||');
  };

  const targetIndex = new Map();
  for (const f of features) {
    const key = makeTargetKey(f);
    if (key) {
      if (!targetIndex.has(key)) targetIndex.set(key, []);
      targetIndex.get(key).push(f);
    }
  }

  const matchMode = state.matchMode || 'exact';
  let matchedCount = 0, unmatchedCount = 0, skippedCount = 0;
  for (const row of state.parsed.rows) {
    const pk = String(row[state.importMatchField] ?? '').trim();
    if (!pk) { skippedCount++; continue; }
    const importParts = [pk];
    if (state.secondaryImportField) importParts.push(_normAux(row[state.secondaryImportField]));
    if (state.tertiaryImportField) importParts.push(_normAux(row[state.tertiaryImportField]));
    const importKey = importParts.join('||');

    let matched = targetIndex.has(importKey);
    if (!matched && matchMode === 'contains') {
      // 包含匹配：A包含B / B包含A / 公共子串≥5个字符（仅无辅助键时使用）
      if (!state.secondaryImportField) {
        for (const targetVal of targetIndex.keys()) {
          if (targetVal.includes(pk) || pk.includes(targetVal) || _hasCommonSubstring(targetVal, pk, 5)) {
            matched = true; break;
          }
        }
      }
    }
    if (matched) { matchedCount++; }
    else { unmatchedCount++; }
  }
  return { matchedCount, unmatchedCount, skippedCount };
});

// ---- 是否可确认 ----
const canConfirm = computed(() => {
  if (!state.parsed || state.importing) return false;
  if (mode.value === 'new') {
    return !!state.layerName.trim();
  }
  // merge mode
  return state.targetLayerId
    && state.targetMatchField
    && state.importMatchField
    && state.selectedImportFields.length > 0
    && conflictsResolved.value;
});

// ---- 方法 ----
// 防误关：文件对话框打开/关闭期间浏览器可能触发异常事件，
// 用时间戳忽略 800ms 内的遮罩点击
let _lastFileTriggerTime = 0;
const triggerFileInput = () => {
  _lastFileTriggerTime = Date.now();
  fileInputEl.value?.click();
};

const onMaskClick = (e) => {
  // 只响应直接点击遮罩（非子元素冒泡）
  if (e.target !== e.currentTarget) return;
  // 文件选择器触发的 800ms 内忽略（防浏览器焦点反弹）
  if (Date.now() - _lastFileTriggerTime < 800) return;
  emit('close');
};

const onFileSelected = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  try {
    const parsed = await parseExcelFile(file);
    const warnings = validateParseResult(parsed);
    state.parsed = parsed;
    state.warnings = warnings;
    state.layerName = file.name.replace(/\.(xlsx|xls)$/i, '');
    state.selectedImportFields = [];
    state.targetMatchField = '';
    state.importMatchField = '';
    conflictResolutions.value = {};
    renameValues.value = {};
    globalConflictResolution.value = '';
    showAllDups.value = false;
    groupAssignments.value = {};
    newGroupNames.value = {};

    // 默认分组分配：同名自动匹配，无同名则自动创建（同源字段指向同一ID）
    if (mode.value === 'merge' && state.targetLayerId) {
      const targetGroups = fieldGroupsMeta[state.targetLayerId];
      const targetLabels = new Map();
      const createdAutoIds = new Map(); // importGroupLabel → 自建ID
      if (Array.isArray(targetGroups)) {
        for (const g of targetGroups) targetLabels.set(g.label, g.id);
      }
      for (const f of parsed.fields) {
        if (!f.group) continue;
        const g = parsed.groups.find(x => x.id === f.group);
        if (!g || g.label === '基本信息') continue; // 基本信息是保留名，不创建分组
        if (targetLabels.has(g.label)) {
          groupAssignments.value[f.key] = targetLabels.get(g.label);
        } else if (createdAutoIds.has(g.label)) {
          groupAssignments.value[f.key] = createdAutoIds.get(g.label);
        } else {
          const autoId = '__new__' + g.label;
          createdAutoIds.set(g.label, autoId);
          groupAssignments.value[f.key] = autoId;
          newGroupNames.value[f.key] = g.label;
        }
      }
    }

    // 合并模式：文件解析后自动滚动到匹配字段区域
    if (mode.value === 'merge') {
      await nextTick();
      const matchEl = document.querySelector('.merge-match-highlight');
      if (matchEl) matchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    showToast(`已加载：${parsed.sheetName}，${parsed.fields.length} 字段，${parsed.totalRows} 行`, 'info', 2000);
  } catch (err) {
    showToast('解析 Excel 失败：' + err.message, 'error');
  }
};

// ---- 确认 ----
const confirm = () => {
  console.log('[ImportModal] confirm called, mode:', mode.value, 'canConfirm:', canConfirm.value, 'parsed:', !!state.parsed, 'targetMatchField:', state.targetMatchField, 'importMatchField:', state.importMatchField, 'selectedFields:', state.selectedImportFields.length);
  if (!canConfirm.value) return;
  if (mode.value === 'new') confirmNew();
  else confirmMerge();
};

// 新建图层
const confirmNew = async () => {
  state.importing = true;
  try {
    const features = state.parsed.rows.map(props => ({
      type: 'Feature', geometry: null, properties: { ...props }
    }));

    const fields = {};
    for (const f of state.parsed.fields) {
      if (f.skip) continue;
      fields[f.key] = {
        label: f.key,
        type: ['int', 'float', 'percent'].includes(f.inferredType) ? 'number' : 'string',
        ...(f.inferredType && f.inferredType !== 'text' ? { format: f.inferredType } : {}),
        ...(f.inferredType === 'select' && f.inferredOptions ? { options: f.inferredOptions } : {}),
        group: f.group ?? null,
        order: f.order ?? 0
      };
    }

    const groups = (state.parsed.groups || []).map(g => ({ id: g.id, label: g.label, order: g.order }));

    const res = await fetch('/api/layers/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (sessionStorage.getItem('cesium_mvp_token') || '')
      },
      body: JSON.stringify({
        layerName: state.layerName.trim(), features, schema: { fields, groups },
        targetFolder: state.targetFolder || undefined,
        geometryType: state.geometryType || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) { showToast(data.error || '导入失败', 'error'); return; }

    showToast(`导入完成：图层 "${data.layerName}"，${data.featureCount} 条要素`, 'info', 4000);
    emit('imported', data);
  } catch (err) {
    showToast('导入请求失败：' + err.message, 'error');
  } finally {
    state.importing = false;
  }
};

// 合并到已有图层
const confirmMerge = async () => {
  const layerId = state.targetLayerId;
  const layer = getLayerState(layerId);
  if (!layer?.url) { showToast('目标图层无 URL', 'error'); return; }

  state.importing = true;

  try {
    await acquireSchemaLock(layerId);
    const stale = await checkLayerStale(layerId);
    if (stale) {
      // 版本不一致 → 刷新数据，但保留用户已做的所有设置
      showToast('⚠ 检测到图层已被他人修改，正在刷新数据...', 'info', 2000);
      const { reloadLayer } = await import('../../core/layers/LayerManager');
      await reloadLayer(layerId);
      await checkLayerStale(layerId); // 规则 #452 回正本地版本
      hideToast();

      // 重新校验：匹配字段是否还存在
      const currentSchema = fieldSchema[layerId];
      if (currentSchema && !currentSchema[state.targetMatchField]) {
        showToast(`目标匹配字段 "${state.targetMatchField}" 已被删除，请重新选择`, 'error', 4000);
        state.targetMatchField = '';
      } else {
        showToast('数据已刷新，你的合并配置已保留，请检查匹配字段后重新确认', 'info', 3000);
      }

      // 不自动继续合并——让用户检查后再次点击确认
      releaseSchemaLock(layerId);
      state.importing = false;
      return;
    }

    const res = await fetch('/api/layers/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (sessionStorage.getItem('cesium_mvp_token') || '')
      },
      body: JSON.stringify({
        url: layer.url,
        layerId,
        importRows: state.parsed.rows,
        importFields: state.parsed.fields,
        targetMatchField: state.targetMatchField,
        importMatchField: state.importMatchField,
        matchMode: state.matchMode,
        auxMatchMode: state.auxMatchMode,
        secondaryTargetField: state.secondaryTargetField || undefined,
        secondaryImportField: state.secondaryImportField || undefined,
        tertiaryTargetField: state.tertiaryTargetField || undefined,
        tertiaryImportField: state.tertiaryImportField || undefined,
        selectedImportFields: state.selectedImportFields,
        fieldNameResolutions: finalFieldNameResolutions.value,
        groupAssignments: buildGroupAssignments(),
        createUnmatched: state.createUnmatched,
        deleteUnmatched: state.deleteUnmatched
      })
    });

    const data = await res.json();
    if (!res.ok) { showToast(data.error || '合并失败', 'error'); return; }

    showToast(`✓ 合并完成：匹配 ${data.matchedCount} 行${data.createdCount ? '，新建 ' + data.createdCount + ' 条' : ''}${data.newFields?.length ? '，新增 ' + data.newFields.length + ' 个字段' : ''}`, 'info', 4000);
    await checkLayerStale(layerId);
    emit('merged', { layerId, ...data });
  } catch (err) {
    showToast('合并请求失败：' + err.message, 'error');
  } finally {
    state.importing = false;
    releaseSchemaLock(layerId);
  }
};

// ---- 辅助（复用 import modal 的展示函数） ----
const getGroupLabel = (groupId) => {
  if (!state.parsed) return groupId;
  const g = state.parsed.groups.find(x => x.id === groupId);
  return g ? g.label : groupId;
};

const groupColorCache = {};
const GROUP_COLORS = ['#1e3a5f', '#2d4a3e', '#5c3d2e', '#4a1e5f', '#3e4a5f', '#5f3d4a', '#2d5f5a', '#5f552d'];
const groupColor = (groupId) => {
  if (!groupColorCache[groupId]) {
    const idx = state.parsed?.groups?.findIndex(g => g.id === groupId) ?? 0;
    groupColorCache[groupId] = GROUP_COLORS[idx % GROUP_COLORS.length];
  }
  return groupColorCache[groupId];
};

const getSampleValue = (fieldIdx) => {
  if (!state.parsed?.rows?.length) return '--';
  const row = state.parsed.rows[0];
  const field = state.parsed.fields[fieldIdx];
  if (!field) return '--';
  let val = row[field.key];
  if (val === undefined || val === null || val === '') return '--';
  if (val.length > 30) val = val.slice(0, 30) + '…';
  return val;
};
</script>

<style scoped>
/* ==========================================
   统一导入 Modal（新建 + 合并）
   ========================================== */
.import-modal {
  background: #0f172a; border: 2px solid #38bdf8; border-radius: 12px;
  width: 760px; max-width: 95vw; max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.6);
}
.import-modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px; border-bottom: 1px solid #1e293b;
}
.import-modal-header h3 { margin: 0; color: #38bdf8; font-size: 18px; }
.import-modal-close { background: none; border: none; color: #ef4444; font-size: 22px; cursor: pointer; padding: 0 4px; }
.import-modal-close:hover { color: #fca5a5; }
.import-modal-body { padding: 20px; overflow-y: auto; flex: 1; min-height: 0; }
.import-modal-footer { padding: 14px 20px; border-top: 1px solid #1e293b; display: flex; justify-content: flex-end; gap: 12px; }

/* 导入方式 */
.import-field-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.import-field-row label { color: #94a3b8; font-size: 13px; white-space: nowrap; }
.mode-radio { display: flex; align-items: center; gap: 4px; color: #cbd5e1; font-size: 13px; cursor: pointer; }
.mode-radio input { accent-color: #38bdf8; }

/* 摘要 */
.import-summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.summary-chip { display: inline-block; padding: 3px 10px; background: #1e293b; border: 1px solid #475569; border-radius: 12px; font-size: 12px; color: #94a3b8; }
.import-warnings { margin-bottom: 12px; }
.import-warning-item { color: #facc15; font-size: 12px; padding: 4px 0; }

/* 字段预览表（新建模式） */
.import-preview-table-wrap { max-height: 360px; overflow: auto; border: 1px solid #1e293b; border-radius: 8px; margin-bottom: 8px; }
.import-preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.import-preview-table th { position: sticky; top: 0; background: #1e293b; color: #38bdf8; padding: 8px 6px; text-align: left; border-bottom: 1px solid #38bdf8; z-index: 1; }
.import-preview-table td { padding: 5px 6px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
.import-preview-table tr:hover td { background: rgba(56,189,248,0.05); }
.import-preview-table .oid-row td { background: rgba(239,68,68,0.06); }
.center { text-align: center !important; }
.field-name-text { color: #e2e8f0; font-weight: 500; }
.oid-tag { font-size: 10px; color: #ef4444; margin-left: 4px; }
.group-tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; color: #fff; }
.group-tag-ungrouped { font-size: 11px; color: #64748b; }
.type-sel-mini { background: #020617; border: 1px solid #475569; color: #38bdf8; border-radius: 3px; padding: 2px 4px; font-size: 11px; }
.sample-cell { max-width: 160px; }
.sample-value { color: #64748b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }

/* ============ 合并模式 ============ */
.merge-section { margin-bottom: 12px; }
.section-label { display: block; color: #38bdf8; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.merge-file-info { color: #94a3b8; font-size: 12px; margin-left: 6px; }

.match-row { display: flex; align-items: center; gap: 8px; }
.match-label { color: #64748b; font-size: 12px; min-width: 90px; text-align: right; }
.match-arrow { color: #38bdf8; font-weight: bold; font-size: 16px; }
.merge-match-highlight.merge-match-active {
  background: rgba(56,189,248,0.04); border: 1px dashed #38bdf8;
  border-radius: 8px; padding: 10px; margin-bottom: 12px;
}
.merge-match-hint {
  color: #f59e0b; font-size: 12px; margin-top: 6px; text-align: center;
}

/* 字段分组表格 */
.field-group-grid { max-height: 320px; overflow-y: auto; border: 1px solid #1e293b; border-radius: 6px; }
.fg-group-header { padding: 6px 10px; background: #1a2332; color: #38bdf8; font-size: 12px; font-weight: 600; border-bottom: 1px solid #1e293b; }
.fg-field-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid #0f172a; }
.fg-field-row:hover { background: rgba(56,189,248,0.03); }
.fg-field-row.fg-conflict { border-left: 3px solid #f59e0b; }
.fg-field-row.fg-skipped { opacity: 0.35; }
.fg-checkbox { display: flex; align-items: center; gap: 4px; flex: 1; cursor: pointer; font-size: 12px; color: #cbd5e1; }
.fg-field-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fg-type-sel {
  background: #020617; border: 1px solid #334155; color: #38bdf8;
  border-radius: 3px; padding: 1px 4px; font-size: 10px; min-width: 0;
}
.fg-type-sel:disabled { color: #475569; border-color: #1e293b; }
.fg-arrow { color: #64748b; font-size: 11px; }
.fg-group-sel { min-width: 130px; }

.conflict-tag { font-size: 10px; color: #f59e0b; margin-left: 4px; }
.skip-tag { font-size: 10px; color: #64748b; }

.conflict-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px;
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2);
  border-radius: 6px; font-size: 12px;
}
.conflict-name { color: #f59e0b; flex: 1; font-size: 12px; }
.conflict-row.conflict-skipped { opacity: 0.5; }
.conflict-row.conflict-skipped .conflict-name { color: #64748b; }
.conflict-global-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; margin-bottom: 8px;
  background: rgba(56,189,248,0.06); border: 1px solid rgba(56,189,248,0.15);
  border-radius: 6px; font-size: 12px;
}
.conflict-global-label { color: #38bdf8; font-weight: 600; }
.conflict-global-hint { color: #64748b; font-size: 11px; font-style: italic; }

.preview-section { padding: 12px; background: #020617; border-radius: 8px; border: 1px solid #1e293b; }
.preview-stats { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.preview-stat.matched { color: #10b981; }
.preview-stat.unmatched { color: #f59e0b; }
.preview-stat.created { color: #38bdf8; }
.preview-stat.skipped { color: #64748b; }
.preview-stat.dup { color: #f59e0b; font-size: 13px; }
.preview-stat.info { color: #64748b; font-size: 12px; }
.preview-stat.hint { color: #38bdf8; font-size: 12px; margin-top: 4px; }

/* 按钮 */
.import-cancel-btn { background: #1e293b; border: 1px solid #475569; color: #94a3b8; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.import-cancel-btn:hover { border-color: #ef4444; color: #ef4444; }
.import-file-btn {
  background: #1e293b; border: 1px solid #475569; color: #94a3b8;
  padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.import-file-btn:hover { border-color: #38bdf8; color: #38bdf8; }
.import-confirm-btn { background: #38bdf811; border: 1px solid #38bdf8; color: #38bdf8; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; }
.import-confirm-btn:hover:not(:disabled) { background: #38bdf8; color: #000; }
.import-confirm-btn:disabled { border-color: #475569; color: #475569; cursor: not-allowed; background: transparent; }

.tech-select { background: #020617; border: 1px solid #475569; color: #38bdf8; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.tech-input { background: #020617; border: 1px solid #475569; color: #cbd5e1; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.cb-label { font-size: 12px; color: #94a3b8; display: flex; align-items: center; gap: 6px; }
.cb-warn { color: #f59e0b; }
.all-select-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.all-select-btn {
  background: #1e293b; border: 1px solid #475569; color: #38bdf8; font-size: 11px;
  padding: 2px 10px; border-radius: 4px; cursor: pointer;
}
.all-select-btn:hover { border-color: #38bdf8; background: #243447; }
.all-select-count { color: #64748b; font-size: 11px; margin-left: 6px; }
</style>
