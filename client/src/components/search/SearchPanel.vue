<template>
  <div class="search-panel">
    <div class="header"><h4>🔎 要素搜索定位</h4></div>

    <div class="control-group">
      <label>搜索图层</label>
      <select v-model="selectedLayerId" @change="onLayerChange" class="block-select">
        <option value="">-- 选择图层 --</option>
        <option v-for="l in searchableLayers" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
    </div>

    <div class="control-group" v-if="selectedLayerId">
      <label>搜索字段</label>
      <select v-model="selectedField" @change="onFieldChange" class="block-select">
        <option value="">-- 选择字段 --</option>
        <option v-for="f in searchableFields" :key="f" :value="f">{{ f }}</option>
      </select>
    </div>

    <div class="search-row" v-if="selectedField">
      <input
        ref="searchInput"
        v-model="searchText"
        @input="onSearchInput"
        @keyup.enter="doFullSearch"
        placeholder="输入关键字搜索..."
        class="search-input"
      />
      <button class="search-btn" @click="doFullSearch" :disabled="!searchText.trim()">🔍</button>
    </div>

    <div class="results-area" v-if="searchText.trim()">
      <!-- 自动下拉建议 (≤5项，输入时实时显示) -->
      <div v-if="suggestions.length > 0 && !showFullResults" class="suggestions">
        <div
          v-for="r in suggestions" :key="r.featureId"
          class="suggestion-item"
          @click="flyTo(r)"
        >
          <span class="sug-text">{{ r.matchValue }}</span>
          <span class="sug-btn">🎯</span>
        </div>
      </div>

      <!-- 完整搜索结果列表 -->
      <div v-if="showFullResults" class="full-results">
        <div class="results-header">
          <span>共 {{ allResults.length }} 条匹配</span>
          <button @click="showFullResults = false" class="back-btn">收起</button>
        </div>
        <div
          v-for="r in allResults" :key="r.featureId"
          class="result-item"
          @click="flyTo(r)"
        >
          <span class="res-text">{{ r.matchValue }}</span>
          <span class="res-btn">🎯 定位</span>
        </div>
        <div v-if="allResults.length === 0" class="empty-hint">无匹配结果</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import { getSearchableLayers, getSearchableFields, searchByField, flyToFeatureById } from '../../core/searchFeatures';

const emit = defineEmits(['close']);
const selectedLayerId = ref('');
const selectedField = ref('');
const searchText = ref('');
const searchInput = ref(null);
const suggestions = ref([]);
const allResults = ref([]);
const showFullResults = ref(false);

const searchableLayers = computed(() => getSearchableLayers());

const searchableFields = computed(() => {
  if (!selectedLayerId.value) return [];
  return getSearchableFields(selectedLayerId.value);
});

const onLayerChange = () => {
  selectedField.value = '';
  searchText.value = '';
  suggestions.value = [];
  allResults.value = [];
  showFullResults.value = false;
};

const onFieldChange = () => {
  searchText.value = '';
  suggestions.value = [];
  allResults.value = [];
  showFullResults.value = false;
  nextTick(() => searchInput.value?.focus());
};

const onSearchInput = () => {
  showFullResults.value = false;
  const term = searchText.value;
  if (!term.trim() || !selectedField.value) {
    suggestions.value = [];
    return;
  }
  const results = searchByField(selectedLayerId.value, selectedField.value, term, 5);
  // 仅当 ≤5 条时显示下拉建议，>5 条由用户点搜索查看
  suggestions.value = results.length <= 5 ? results : [];
};

const doFullSearch = () => {
  const term = searchText.value;
  if (!term.trim() || !selectedField.value) return;
  allResults.value = searchByField(selectedLayerId.value, selectedField.value, term);
  showFullResults.value = true;
  suggestions.value = [];
};

const flyTo = (result) => {
  flyToFeatureById(selectedLayerId.value, result.featureId);
  emit('close');
};
</script>

<style scoped>
.search-panel { width: 100%; color: white; display: flex; flex-direction: column; }
.header { margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
h4 { margin: 0; color: #38bdf8; font-size: 16px; }

.control-group { margin-bottom: 12px; font-size: 13px; }
.block-select { width: 100%; margin-top: 4px; padding: 6px; background: #1e293b; color: white; border: 1px solid #475569; border-radius: 4px; outline: none; }

.search-row { display: flex; gap: 6px; margin-top: 16px; }
.search-input { flex: 1; padding: 8px 10px; background: #1e293b; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; font-size: 13px; outline: none; }
.search-input:focus { border-color: #38bdf8; }
.search-btn { padding: 8px 14px; background: #38bdf811; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 4px; cursor: pointer; font-size: 13px; }
.search-btn:hover { background: #38bdf8; color: #000; }
.search-btn:disabled { opacity: 0.4; cursor: default; }

.results-area { margin-top: 14px; }
.suggestions { background: rgba(30,41,59,0.8); border: 1px solid #334155; border-radius: 4px; overflow: hidden; }
.suggestion-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #1e293b; transition: background 0.15s; }
.suggestion-item:hover { background: rgba(56,189,248,0.1); }
.suggestion-item:last-child { border-bottom: none; }
.sug-text { font-size: 13px; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.sug-btn { font-size: 14px; flex-shrink: 0; }

.full-results { background: rgba(30,41,59,0.8); border: 1px solid #334155; border-radius: 4px; overflow: hidden; }
.results-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(56,189,248,0.08); font-size: 12px; color: #94a3b8; }
.back-btn { background: none; border: 1px solid #475569; color: #94a3b8; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; }
.back-btn:hover { color: #38bdf8; border-color: #38bdf8; }
.result-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #1e293b; transition: background 0.15s; }
.result-item:hover { background: rgba(56,189,248,0.1); }
.result-item:last-child { border-bottom: none; }
.res-text { font-size: 13px; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.res-btn { font-size: 12px; color: #38bdf8; flex-shrink: 0; }
.empty-hint { padding: 20px; text-align: center; font-size: 13px; color: #64748b; }
</style>
