import { reactive } from 'vue';

export const fieldSchema = reactive({});
// 解耦：按 layerId 存分组元数据（groups 列表）。空/无则渲染回退到名字前缀解析。
export const fieldGroupsMeta = reactive({});

// 从当前 token 恢复登录态（不使用遗留 key）
const savedToken = sessionStorage.getItem('cesium_mvp_token');
let savedUser = null;
if (savedToken) {
  try {
    const raw = sessionStorage.getItem('cesium_mvp_user');
    if (raw) savedUser = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

// 用户命名空间：防止同浏览器不同账号的 localStorage 冲突
const _getUsername = () => {
  try {
    const raw = sessionStorage.getItem('cesium_mvp_user');
    if (raw) return JSON.parse(raw).username || 'guest';
  } catch (_) {}
  return 'guest';
};
export const uk = (baseKey) => `${_getUsername()}_${baseKey}`;
export const saveUserSetting = (key, value) => { try { localStorage.setItem(uk(key), value); } catch (_) {} };
export const loadUserSetting = (key) => { try { return localStorage.getItem(uk(key)); } catch (_) { return null; } };

export const mapState = reactive({
  system: {
    currentQuality: 2.0,
    isViewerReady: false,
    baseMap: localStorage.getItem(uk('cesium_baseMap')) || "google-tianditu",
    baseMapOpacity: Number(localStorage.getItem(uk('cesium_baseMapOpacity'))) || 1.0,
    backgroundColor: localStorage.getItem(uk('cesium_backgroundColor')) || '#000000'
  },

  layerTree: [],

  filter: { targetLayerId: '', logicalOp: 'AND', rules: [] },
  symbology: { targetLayerId: '', activeField: '', renderType: 'none', customMin: null, customMax: null, colorRamp: [], colorMap: {}, currentStats: [] },
  geolocation: { enabled: false, lat: null, lon: null, accuracy: 0, heading: null, followMode: false, error: null, timestamp: 0 },
  interaction: { selectedFeatureId: null, selectedLayerId: null, selectedFeatureProps: null },

  auth: {
    isLoggedIn: !!savedUser,
    role: savedUser?.role || '',
    username: savedUser?.displayName || (savedUser?.role === 'admin' ? '管理员' : '')
  },

  ui: {
    currentView: 'map',
    activeMenu: 'layers',
    isPanelOpen: true,
    toast: null,  // { message: string, type: 'info'|'error' }
    pendingTableLayerId: null  // 图层面板跳转数据工作台信号：目标 layerId
  },

  editor: {
    isEditing: false,         
    isDirty: false,           
    activeTool: null,         
    selectedLayerId: null, 
    selectedFeatureId: null,  
    selectedFeatureProps: null 
  }
});

export const getLayerState = (layerId) => {
  let target = null;
  const traverse = (nodes) => {
    for (const node of nodes) {
      if (node.id === layerId) { target = node; return; }
      if (node.type === 'folder' && node.children) traverse(node.children);
    }
  };
  traverse(mapState.layerTree);
  return target;
};

export const getFlatLayers = (allowedTypes = ['geojson', '3dtiles']) => {
  const flatList = [];
  const traverse = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'folder' && node.children) {
        traverse(node.children); 
      } else if (allowedTypes.includes(node.type)) {
        flatList.push(node); 
      }
    }
  };
  traverse(mapState.layerTree);
  return flatList;
};

window.mapState = mapState;

export const loadLayerConfig = async () => {
  try {
    const response = await fetch('/api/layer-config');
    const data = await response.json();
    if (data && data.layerTree) {
      mapState.layerTree = data.layerTree;
      applyPersonalVisibility();
      applyPersonalStyles();
    }
    // 同步树版本，避免首次 checkTreeStale 误判
    await import('../core/locks.js').then(m => m.syncTreeVersion());
  } catch (error) {
    console.error('❌ 获取图层配置失败:', error);
  }
};

// 从 localStorage 读取个人 visibility 覆盖并应用到 layerTree
const applyPersonalVisibility = () => {
  try {
    const raw = localStorage.getItem(uk('cesium_mvp_vis_overrides'));
    if (!raw) return;
    const overrides = JSON.parse(raw);
    const traverse = (nodes) => {
      for (const node of nodes) {
        if (overrides.hasOwnProperty(node.id)) {
          node.show = overrides[node.id];
        }
        if (node.type === 'folder' && node.children) traverse(node.children);
      }
    };
    traverse(mapState.layerTree);
  } catch (e) { /* ignore */ }
};

// 保存单个图层/文件夹的 visibility 到 localStorage（仅存与服务器默认不同的）
export const savePersonalVisibility = (layerId, show) => {
  try {
    let overrides = {};
    const key = uk('cesium_mvp_vis_overrides');
    const raw = localStorage.getItem(key);
    if (raw) overrides = JSON.parse(raw);
    overrides[layerId] = show;
    localStorage.setItem(key, JSON.stringify(overrides));
  } catch (e) { /* ignore */ }
};

let toastTimer = null;
export const showToast = (message, type = 'info', duration = 3000) => {
  if (mapState.ui.toast) {
    // 已有 toast 在显示，只更新消息不清除计时器（去重防抖）
    mapState.ui.toast = { message, type };
    if (duration > 0) { clearTimeout(toastTimer); toastTimer = setTimeout(() => { mapState.ui.toast = null; }, duration); }
    return;
  }
  mapState.ui.toast = { message, type };
  if (duration > 0) toastTimer = setTimeout(() => { mapState.ui.toast = null; }, duration);
};
export const hideToast = () => { clearTimeout(toastTimer); mapState.ui.toast = null; };

// 统一解析照片字段值：兼容旧逗号分隔字符串 + 新 JSON 数组格式 [{u,n}]
// 注意：JSON 数组存入 GeoJSON 后读回时是 string 形态（不是 Array），必须在 string 分支探测
export const parsePhotos = (val) => {
  if (!val) return [];
  if (typeof val === 'string') {
    // 新格式：JSON 数组字符串（从 GeoJSON 属性读回时为此形态）
    if (val.startsWith('[')) {
      try {
        const arr = JSON.parse(val);
        if (Array.isArray(arr)) return arr.filter(p => p && p.u);
      } catch { /* 解析失败回退到旧格式逗号拆分 */ }
    }
    // 旧格式：逗号分隔 URL（向后兼容）
    return val.split(',').filter(Boolean).map(s => ({ u: s.trim(), n: '' }));
  }
  // 新格式：内存中的原生数组（UI 状态中尚未 stringify 时的瞬态）
  if (Array.isArray(val)) return val.filter(p => p && p.u);
  return [];
};

export const getThumbUrl = (url) => {
  // 兼容纯 URL 字符串 / {u,n} 对象 / 数组（parsePhotos 输出）
  let pure = url;
  if (Array.isArray(url) && url.length) pure = url[0].u || url[0];
  else if (typeof url === 'object' && url !== null && url.u) pure = url.u;
  if (!pure || typeof pure !== 'string') return '';
  const dot = pure.lastIndexOf('.');
  if (dot === -1) return pure;
  return pure.slice(0, dot) + '_thumb' + pure.slice(dot);
};

const _thumbFailed = new Map(); // url → 失败次数
export const safeThumbUrl = (url) => {
  const n = _thumbFailed.get(url) || 0;
  if (n >= 4) return '';       // 彻底放弃
  if (n >= 3) return url;      // 降级到原图
  return getThumbUrl(url);     // 尝试缩略图
};
export const markThumbFailed = (url) => _thumbFailed.set(url, (_thumbFailed.get(url) || 0) + 1);

const stripFeatures = (nodes) => {
  if (!Array.isArray(nodes)) return;
  for (const n of nodes) {
    delete n.features;
    // 个人偏好设置存 localStorage，不入共享 layer-config
    delete n.showLabel;
    delete n.labelField;
    delete n.labelFontSize;
    delete n.labelFontFamily;
    delete n.labelBold;
    delete n.labelColor;
    delete n.opacity;
    delete n.style;       // fillOpacity / outlineColor / fillColor 等个人视觉偏好
    delete n.heightOffset;
    if (n.children) stripFeatures(n.children);
  }
};


// 标签设置：每个用户独立，存 localStorage
export const saveLabelSettings = (layerId, settings) => {
  try {
    let all = {};
    const key = uk('cesium_mvp_label_settings');
    const raw = localStorage.getItem(key);
    if (raw) all = JSON.parse(raw);
    all[layerId] = settings;
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* ignore */ }
};

export const loadLabelSettings = (layerId) => {
  try {
    const raw = localStorage.getItem(uk('cesium_mvp_label_settings'));
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[layerId] || null;
  } catch (e) { return null; }
};

// 图层个人样式持久化（透明度/填充颜色/边线/高度偏移——每个用户独立）
export const saveLayerStyle = (layerId, settings) => {
  try {
    let all = {};
    const key = uk('cesium_layer_style');
    const raw = localStorage.getItem(key);
    if (raw) all = JSON.parse(raw);
    all[layerId] = settings;
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* ignore */ }
};

// 恢复单图层的个人样式为服务端默认值
export const resetLayerStyle = (layerId) => {
  try {
    const key = uk('cesium_layer_style');
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const all = JSON.parse(raw);
    delete all[layerId];
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* ignore */ }
};

export const loadLayerStyle = (layerId) => {
  try {
    const raw = localStorage.getItem(uk('cesium_layer_style'));
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[layerId] || null;
  } catch (e) { return null; }
};

// 页面加载后恢复所有已保存的个人样式
const applyPersonalStyles = () => {
  try {
    const raw = localStorage.getItem(uk('cesium_layer_style'));
    if (!raw) return;
    const all = JSON.parse(raw);
    const traverse = (nodes) => {
      for (const node of nodes) {
        const saved = all[node.id];
        if (saved) {
          if (saved.opacity !== undefined) node.opacity = saved.opacity;
          if (saved.heightOffset !== undefined) node.heightOffset = saved.heightOffset;
          if (saved.style) node.style = { ...(node.style || {}), ...saved.style };
        }
        if (node.type === 'folder' && node.children) traverse(node.children);
      }
    };
    traverse(mapState.layerTree);
  } catch (e) { /* ignore */ }
};

// 符号化设置持久化（填充透明度、边线颜色、分级/分类配色等）
export const saveSymbologySettings = (layerId, settings) => {
  try {
    let all = {};
    const key = uk('cesium_symbology');
    const raw = localStorage.getItem(key);
    if (raw) all = JSON.parse(raw);
    // 不存 currentStats（运行时计算值）
    const { currentStats, ...clean } = settings;
    all[layerId] = clean;
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* ignore */ }
};

export const loadSymbologySettings = (layerId) => {
  try {
    const raw = localStorage.getItem(uk('cesium_symbology'));
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[layerId] || null;
  } catch (e) { return null; }
};

export const saveLayerConfig = async () => {
	  try {
	    const cleanTree = JSON.parse(JSON.stringify(mapState.layerTree));
	    stripFeatures(cleanTree);
	    const payload = {
	      project: "Kashgar_GIS_Base",
	      version: "1.0",
	      layerTree: cleanTree
	    };
	    const token = sessionStorage.getItem('cesium_mvp_token') || '';
	    const response = await fetch('/api/layer-config', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
	      body: JSON.stringify(payload)
	    });
	    const result = await response.json();
	    if (result.success) {
      // 写配置后服务端 bump treeVersion；回正本地 knownTreeVersion，避免下次 checkTreeStale 自我误判
      // 用 checkTreeStale 而非 syncTreeVersion 固定+1：一次操作可能 bump 多次
      try { const { checkTreeStale } = await import("../core/locks.js"); await checkTreeStale(); } catch (_) {}
    }
	  } catch (error) {
	    console.error('❌ 保存图层配置失败:', error);
	  }
	};


export const loadFieldFormat = async (layerId) => {
  try {
    const res = await fetch(`/api/schemas/${layerId}`);
    if (!res.ok) return {};
    const data = await res.json();
    return data.fields || {};
  } catch (e) { return {}; }
};

// 解耦：读取分组元数据（groups 列表）。与 loadFieldFormat 分开，不影响其现有调用方。
export const loadFieldGroupsMeta = async (layerId) => {
  try {
    const res = await fetch(`/api/schemas/${layerId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.groups) ? data.groups : null;
  } catch (e) { return null; }
};

export const saveFieldFormat = async (layerId, fields, groups = undefined) => {
  const token = sessionStorage.getItem('cesium_mvp_token') || '';
  const body = Array.isArray(groups) ? { fields, groups } : { fields };
  const res = await fetch(`/api/schemas/${layerId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return res.json();
};

// 页面加载时验证 token 是否仍有效（防同账号并发登录后旧设备继续使用）
export const verifyAuth = async () => {
  const token = sessionStorage.getItem('cesium_mvp_token');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.valid) {
      sessionStorage.removeItem('cesium_mvp_token');
      sessionStorage.removeItem('cesium_mvp_user');
      mapState.auth.isLoggedIn = false;
      mapState.auth.role = '';
      mapState.auth.username = '';
      if (data.reason === 'kicked') {
        console.warn('[auth] 账号已在其他设备登录，强制下线');
      }
    }
  } catch (e) { /* 网络错误时保留现有登录态 */ }
};