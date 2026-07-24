// 要素锁服务：API 调用封装 + 版本感知

const getToken = () => sessionStorage.getItem('cesium_mvp_token') || '';

const headers = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${getToken()}`
});

const myLocks = new Set();
const knownVersions = new Map(); // `${layerId}:${featureId}` → version
const knownLayerVersions = new Map(); // layerId → version
let knownTreeVersion = 0; // 图层树结构版本

// 要素锁：获取（返回 { success, error, version, stale }）
export const acquireFeatureLock = async (layerId, featureId) => {
  const res = await fetch('/api/locks/feature/acquire', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ layerId, featureId })
  });
  const data = await res.json();
  if (data.success) {
    myLocks.add(`${layerId}:${featureId}`);
    const lockKey = `${layerId}:${featureId}`;
    // 仅在服务端返回版本号时同步（新获取锁；同一用户续期时无 version 字段）
    if (data.version !== undefined) {
      const prevVersion = knownVersions.get(lockKey);
      const currentLayerVer = data.layerVersion || 1;
      const prevLayerVer = knownLayerVersions.get(layerId) || 1;
      if (currentLayerVer > prevLayerVer) {
        data.stale = true;
      }
      if (data.version > 1 && (prevVersion === undefined || data.version > prevVersion)) {
        data.stale = true;
      }
      knownVersions.set(lockKey, data.version);
      knownLayerVersions.set(layerId, currentLayerVer);
    }
  }
  return data;
};

// 要素锁：释放（saved=true 时通知服务器递增版本号）
export const releaseFeatureLock = async (layerId, featureId, saved = false) => {
  myLocks.delete(`${layerId}:${featureId}`);
  await fetch('/api/locks/feature/release', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ layerId, featureId, saved })
  });
};

// Schema 锁
export const acquireSchemaLock = async (layerId) => {
  const res = await fetch('/api/locks/schema/acquire', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ layerId })
  });
  const data = await res.json();
  if (data.success) myLocks.add(`schema:${layerId}`);
  return data;
};

export const releaseSchemaLock = async (layerId) => {
  myLocks.delete(`schema:${layerId}`);
  await fetch('/api/locks/schema/release', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ layerId })
  });
};

export const fetchLayerLocks = async (layerId) => {
  const res = await fetch(`/api/locks/${layerId}`, { headers: headers() });
  return res.json();
};

// 加载图层数据后同步服务器版本号，避免刷新后误判 stale
export const syncVersions = async (layerId) => {
  try {
    const data = await fetchLayerLocks(layerId);
    if (data.versions) {
      for (const [featureId, v] of Object.entries(data.versions)) {
        knownVersions.set(`${layerId}:${featureId}`, v);
      }
    }
    if (data.layerVersion) {
      knownLayerVersions.set(layerId, data.layerVersion);
    }
  } catch (e) { /* ignore */ }
};

// 检查图层是否有远端更新（stale）
// 页面加载时同步树版本（避免首次 checkTreeStale 误判）
export const syncTreeVersion = async () => {
  try {
    const res = await fetch('/api/tree-version');
    const data = await res.json();
    knownTreeVersion = data.version || 1;
  } catch (e) { /* ignore */ }
};

// 检查图层树是否有结构变更（新建/删除/重命名/排序图层）
export const checkTreeStale = async () => {
  try {
    const res = await fetch('/api/tree-version');
    const data = await res.json();
    const current = data.version || 1;
    if (current > knownTreeVersion) {
      knownTreeVersion = current;
      return true;
    }
    knownTreeVersion = current;
    return false;
  } catch (e) { return false; }
};

export const checkLayerStale = async (layerId) => {
  const prev = knownLayerVersions.get(layerId) || 1;
  const data = await fetchLayerLocks(layerId);
  const current = data.layerVersion || 1;
  knownLayerVersions.set(layerId, current);
  return current > prev;
};

// 检查图层 stale + 返回冲突详情（含修改人），供保存时使用
// 先比较要素版本（精确到单个要素），再比较图层版本（兜底：增删要素等结构变更）
export const checkLayerConflict = async (layerId, featureId) => {
  const prevLayer = knownLayerVersions.get(layerId) || 1;
  const prevFeature = featureId ? knownVersions.get(`${layerId}:${featureId}`) : undefined;
  const data = await fetchLayerLocks(layerId);
  const currentLayer = data.layerVersion || 1;
  knownLayerVersions.set(layerId, currentLayer);
  // 同步服务端要素版本（若存在）
  const fid = featureId ? String(featureId) : '';
  if (fid && data.versions && data.versions[fid] !== undefined) {
    knownVersions.set(`${layerId}:${fid}`, data.versions[fid]);
  }
  // 第一道防线：要素版本精确检测——仅当同一要素被他人修改才判 stale
  const currentFeature = fid ? (data.versions?.[fid]) : undefined;
  if (prevFeature !== undefined && currentFeature !== undefined && currentFeature > prevFeature) {
    const modifier = (data.modifiers && data.modifiers[fid]) ? `已被 ${data.modifiers[fid]} 修改` : '已被他人修改';
    return { stale: true, modifier, featureConflict: true };
  }
  // 要素版本一致时，即使图层版本因其他要素编辑而增加，也不判 stale
  if (prevFeature !== undefined && currentFeature !== undefined && currentFeature <= prevFeature) {
    return { stale: false, modifier: '' };
  }
  // 第二道防线：图层版本检测（兜底——要素版本未知或图层结构变更）
  if (currentLayer > prevLayer) {
    const modifier = (data.modifiers && data.modifiers[fid]) ? `已被 ${data.modifiers[fid]} 修改` : '已被他人修改';
    return { stale: true, modifier };
  }
  return { stale: false, modifier: '' };
};

// 页面关闭/刷新时释放所有持有的锁
export const releaseAllMyLocks = () => {
  const locks = [...myLocks];
  locks.forEach(key => {
    const parts = key.split(':');
    if (parts[0] === 'schema') {
      fetch('/api/locks/schema/release', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ layerId: parts[1] })
      }).catch(() => {});
    } else {
      const layerId = parts[0];
      const featureId = parts.slice(1).join(':');
      fetch('/api/locks/feature/release', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ layerId, featureId })
      }).catch(() => {});
    }
  });
};
window.addEventListener('beforeunload', releaseAllMyLocks);
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) releaseAllMyLocks();
});

// 保存后客户端同步更新本地版本记录 + 释放锁（不 bump 服务端版本）
export const markSaved = async (layerId, featureId) => {
  // 先同步 bump 本地版本（消除 release fetch 的 yield 窗口——避免 handlePropFocus
  // 在此期间切入并看到 server 已 bump 而 local 未 bump，误判 stale）
  myLocks.delete(`${layerId}:${featureId}`);
  const lockKey = `${layerId}:${featureId}`;
  knownVersions.set(lockKey, (knownVersions.get(lockKey) || 1) + 1);
  knownLayerVersions.set(layerId, (knownLayerVersions.get(layerId) || 1) + 1);
  // 锁释放放后面，fire-and-forget（PATCH handler 已 bump，release 只清理锁）
  fetch('/api/locks/feature/release', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ layerId, featureId, saved: false })
  }).catch(() => {});
};

export const getKnownVersion = (layerId, featureId) => {
  return knownVersions.get(`${layerId}:${featureId}`) || 0;
};

// keepLock 保存路径用：仅同步图层版本（不释放锁、不 bump 要素版本）
// 因为服务端 PATCH handler 已自动 bump layerVersion
export const syncLayerVersion = (layerId) => {
  knownLayerVersions.set(layerId, (knownLayerVersions.get(layerId) || 1) + 1);
};

// keepLock 保存路径用：同步要素版本（因服务端 PATCH 已自动 bump featureVersion）
export const syncFeatureVersion = (layerId, featureId) => {
  const lockKey = `${layerId}:${featureId}`;
  knownVersions.set(lockKey, (knownVersions.get(lockKey) || 1) + 1);
};

// 从服务端拉取单要素版本（首次编辑前同步，避免 _clientVersion=0 误判 409）
export const fetchFeatureVersion = async (layerId, featureId) => {
  try {
    const res = await fetch(`/api/locks/${layerId}/version/${featureId}`);
    const data = await res.json();
    if (data.version) knownVersions.set(`${layerId}:${featureId}`, data.version);
  } catch (e) { /* ignore */ }
};
