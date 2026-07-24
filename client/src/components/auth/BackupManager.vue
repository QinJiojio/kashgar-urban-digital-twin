<template>
  <div class="admin-overlay" @click.self="$emit('close')">
    <div class="admin-panel">
      <div class="panel-header">
        <h2>📂 备份管理</h2>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>

      <!-- 统计概览 -->
      <div class="stats-bar">
        <div class="stat-item">📊 {{ layers.length }} 图层</div>
        <div class="stat-item">📦 {{ totalBackups }} 备份</div>
        <div class="stat-item">💾 {{ totalSize }}</div>
      </div>

      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="filter-group">
          <label class="filter-label">类型：</label>
          <select v-model="typeFilter" class="tool-select">
            <option value="">全部图层</option>
            <option value="polygon">⬟ 面要素</option>
            <option value="polyline">〰️ 线要素</option>
            <option value="point">📍 点要素</option>
            <option value="config">⚙️ 配置文件</option>
            <option value="schema">📋 Schema</option>
            <option value="deleted">🗑 已删除</option>
          </select>
        </div>
        <input v-model="searchText" class="tool-search" placeholder="搜索图层名..." />
      </div>

      <!-- 主区域：左右分栏 -->
      <div class="main-area">
        <!-- 左：图层列表 -->
        <div class="layer-list">
          <div v-if="filteredLayers.length === 0" class="empty-hint">无匹配图层</div>
          <div
            v-for="layer in filteredLayers"
            :key="layer.filePath"
            class="layer-item"
            :class="{ active: selectedLayer === layer.filePath }"
            @click="selectLayerPath(layer.filePath)"
          >
            <span class="layer-icon">{{ layerIcon(layer) }}</span>
            <div class="layer-info">
              <span class="layer-name">{{ layer.label || layer.layerName }}</span>
              <span class="layer-meta">
                <span class="layer-count">{{ layer.backups.length }} 备份</span>
                <span v-if="layer.latestTime" class="layer-time">{{ formatTime(layer.latestTime) }}</span>
              </span>
            </div>
            <span v-if="selectedLayer === layer.filePath" class="layer-arrow">▶</span>
          </div>
        </div>

        <!-- 右：备份详情 -->
        <div class="backup-detail">
          <template v-if="!selectedLayer">
            <div class="empty-hint">← 选择左侧图层查看备份</div>
          </template>
          <template v-else-if="currentBackups.length === 0">
            <div class="empty-hint">该条目暂无备份</div>
          </template>
          <template v-else>
            <div class="detail-header">
              <span class="detail-title">{{ selectedLayerLabel }}</span>
              <span class="detail-count">{{ currentBackups.length }} 备份</span>
            </div>

            <!-- 全选 + 清理 -->
            <div class="detail-toolbar">
              <label class="keep-label">
                <input type="checkbox" @change="toggleAllKeeps" :checked="keepSet.size === currentBackups.length && currentBackups.length > 0" />
                全选 {{ keepSet.size }}/{{ currentBackups.length }}
              </label>
              <button class="btn-cleanup" @click="cleanupBackups" :disabled="keepSet.size === 0 || keepSet.size === currentBackups.length">
                🗑 删除未勾选
              </button>
            </div>

            <!-- 备份列表 -->
            <div class="backup-list">
              <div v-for="(b, idx) in currentBackups" :key="idx" class="backup-row">
                <input type="checkbox" :checked="keepSet.has(idx)" @change="toggleKeep(idx)" />
                <span class="bk-time">{{ formatTime(b.time) }}</span>
                <span class="bk-trigger">{{ triggerLabel(b.trigger) }}</span>
                <span class="bk-user">{{ b.username || '—' }}</span>
                <span class="bk-size">{{ (b.size / 1024).toFixed(1) }} KB</span>
                <button class="btn-restore" @click="restoreBackup(b.file)" :disabled="restoring">恢复</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits(['close']);

const layers = ref([]);
const selectedLayer = ref('');
const backups = ref({});
const restoring = ref(false);
const keepSet = ref(new Set());
const typeFilter = ref('');
const searchText = ref('');

const token = () => sessionStorage.getItem('cesium_mvp_token') || '';
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` });

// 加载数据
const loadBackups = async () => {
  const res = await fetch('/api/backups', { headers: authHeaders() });
  if (res.ok) {
    const data = await res.json();
    const list = data.entries || data; // 兼容新旧 API 格式
    totalBackupSize.value = data.totalSize || 0;
    const enhanced = list.map(l => ({
      ...l,
      label: labelForEntry(l),
      type: classifyEntry(l),
      latestTime: l.backups[0]?.time || null
    }));
    layers.value = enhanced;
    backups.value = {};
    enhanced.forEach(l => { backups.value[l.filePath] = l; });
  }
};

// 分类
const classifyEntry = (entry) => {
  if (entry.deleted) return 'deleted';
  if (entry.filePath === 'layer-config.json') return 'config';
  if (entry.filePath.startsWith('schemas/')) return 'schema';
  return entry.geometryType || 'geojson';
};

const labelForEntry = (entry) => {
  if (entry.filePath === 'layer-config.json') return '⚙️ 图层配置文件';
  if (entry.filePath.startsWith('schemas/')) return '📋 Schema - ' + entry.layerName;
  if (entry.deleted) return '🗑 ' + (entry.layerName || '已删除的图层');
  return entry.layerName || entry.filePath;
};

const layerIcon = (layer) => {
  if (layer.deleted) return '🗑';
  if (layer.type === 'config') return '⚙️';
  if (layer.type === 'schema') return '📋';
  if (layer.type === 'point') return '📍';
  if (layer.type === 'polyline') return '〰️';
  if (layer.type === 'polygon') return '⬟';
  return '📄';
};

const filteredLayers = computed(() => {
  let result = layers.value;
  if (typeFilter.value) {
    result = result.filter(l => l.type === typeFilter.value);
  }
  if (searchText.value.trim()) {
    const q = searchText.value.trim().toLowerCase();
    result = result.filter(l => (l.label || l.layerName || '').toLowerCase().includes(q));
  }
  // 已删除的始终排在最后
  return [...result.filter(l => !l.deleted), ...result.filter(l => l.deleted)];
});

const currentBackups = computed(() => {
  return backups.value[selectedLayer.value]?.backups || [];
});

const selectedLayerLabel = computed(() => {
  return backups.value[selectedLayer.value]?.label || '';
});

const totalBackupSize = ref(0);
const totalBackups = computed(() => layers.value.reduce((s, l) => s + l.backups.length, 0));
const totalSize = computed(() => {
  // 优先用 API 返回的总大小，兜底本地计算
  const bytes = totalBackupSize.value || layers.value.reduce((s, l) => s + l.backups.reduce((ss, b) => ss + (b.size || 0), 0), 0);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
});

// 选择图层
const selectLayerPath = (fp) => {
  selectedLayer.value = fp;
  keepSet.value = new Set(currentBackups.value.map((_, i) => i));
};

const toggleKeep = (idx) => {
  const next = new Set(keepSet.value);
  next.has(idx) ? next.delete(idx) : next.add(idx);
  keepSet.value = next;
};
const toggleAllKeeps = () => {
  keepSet.value = keepSet.value.size === currentBackups.value.length
    ? new Set()
    : new Set(currentBackups.value.map((_, i) => i));
};

const formatTime = (t) => {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const triggerLabel = (t) => {
  const map = { auto: '自动', session_end: '会话结束', schema: '字段变更', migrate: '迁移', merge: '合并', cleanup: '清理碎片', renumber: '更新序号', restore: '恢复前', config: '配置变更', 'schema-delete': 'Schema删除' };
  return map[t] || t;
};

const cleanupBackups = async () => {
  const toDelete = currentBackups.value.filter((_, i) => !keepSet.value.has(i)).map(b => b.file);
  if (toDelete.length === 0) return;
  if (!confirm(`确定删除 ${toDelete.length} 个未勾选的备份吗？此操作不可撤销。`)) return;
  const res = await fetch('/api/backups/cleanup', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ filePath: selectedLayer.value, keepFiles: [...keepSet.value].map(i => currentBackups.value[i].file) })
  });
  const data = await res.json();
  if (data.success) {
    keepSet.value = new Set();
    loadBackups();
  } else {
    alert('清理失败: ' + (data.error || ''));
  }
};

const restoreBackup = async (fileName) => {
  if (!confirm('确定恢复到此备份版本吗？当前版本会自动备份。')) return;
  restoring.value = true;
  const res = await fetch('/api/backups/restore', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ filePath: selectedLayer.value, backupFile: fileName })
  });
  const data = await res.json();
  restoring.value = false;
  if (data.success) {
    alert('备份已恢复，请刷新图层查看。');
    loadBackups();
  } else {
    alert('恢复失败: ' + (data.error || ''));
  }
};

onMounted(loadBackups);
</script>

<style scoped>
.admin-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: flex-start; padding-top: 8vh; z-index: 10000; }
.admin-panel { width: 780px; height: 85vh; min-height: 500px; background: #0f172a; border: 1px solid #38bdf8; border-radius: 8px; padding: 20px 24px; display: flex; flex-direction: column; overflow: hidden; }
.panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.panel-header h2 { color: #fff; margin: 0; font-size: 18px; }
.close-btn { background: none; border: none; color: #64748b; font-size: 22px; cursor: pointer; }

/* 统计条 */
.stats-bar { display: flex; gap: 20px; padding: 8px 12px; background: #1e293b; border-radius: 6px; margin-bottom: 12px; }
.stat-item { color: #94a3b8; font-size: 13px; }

/* 工具栏 */
.toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.filter-group { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.filter-label { color: #94a3b8; font-size: 12px; }
.tool-select { background: #1e293b; border: 1px solid #475569; color: #e2e8f0; padding: 4px 8px; border-radius: 4px; font-size: 12px; outline: none; }
.tool-select:focus { border-color: #38bdf8; }
.tool-search { flex: 1; background: #1e293b; border: 1px solid #475569; color: #e2e8f0; padding: 5px 10px; border-radius: 4px; font-size: 12px; outline: none; }
.tool-search:focus { border-color: #38bdf8; }
.tool-search::placeholder { color: #475569; }

/* 主区域 */
.main-area { display: flex; gap: 16px; flex: 1; min-height: 0; }

/* 左：图层列表 */
.layer-list { width: 260px; flex-shrink: 0; overflow-y: auto; border: 1px solid #1e293b; border-radius: 6px; padding: 4px; background: #0a0f1a; }
.layer-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; transition: background .15s; }
.layer-item:hover { background: rgba(56,189,248,0.08); }
.layer-item.active { background: rgba(56,189,248,0.15); border: 1px solid #38bdf8; padding: 5px 7px; }
.layer-icon { font-size: 14px; flex-shrink: 0; }
.layer-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.layer-name { color: #e2e8f0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.layer-meta { display: flex; gap: 8px; }
.layer-count { color: #38bdf8; font-size: 10px; }
.layer-time { color: #64748b; font-size: 10px; }
.layer-arrow { color: #38bdf8; font-size: 10px; }

/* 右：备份详情 */
.backup-detail { flex: 1; overflow-y: auto; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; background: #0a0f1a; display: flex; flex-direction: column; }
.detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #1e293b; }
.detail-title { color: #e2e8f0; font-size: 14px; font-weight: bold; }
.detail-count { color: #64748b; font-size: 12px; }

.detail-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.keep-label { color: #94a3b8; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px; }

/* 备份列表 */
.backup-list { flex: 1; overflow-y: auto; }
.backup-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; background: #1e293b; border-radius: 4px; margin-bottom: 3px; }
.bk-time { flex: 1; color: #e2e8f0; font-size: 12px; }
.bk-trigger { color: #64748b; font-size: 11px; width: 65px; text-align: center; }
.bk-user { color: #38bdf8; font-size: 11px; width: 55px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bk-size { color: #94a3b8; font-size: 11px; width: 55px; text-align: right; }
.btn-restore { padding: 3px 10px; background: #0e7490; border: 1px solid #38bdf8; border-radius: 4px; color: #fff; cursor: pointer; font-size: 11px; flex-shrink: 0; }
.btn-restore:hover { background: #0284c7; }
.btn-restore:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-cleanup { padding: 3px 10px; background: transparent; border: 1px solid #ef4444; color: #ef4444; border-radius: 4px; cursor: pointer; font-size: 11px; }
.btn-cleanup:hover { background: #ef4444; color: #fff; }
.btn-cleanup:disabled { opacity: 0.3; cursor: not-allowed; }

.empty-hint { color: #475569; text-align: center; padding: 24px; font-size: 13px; }
</style>
