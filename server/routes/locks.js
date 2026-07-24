import { Router } from 'express';
import { requireEditor, requireAdmin, optionalAuth } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_FILE = path.resolve(__dirname, '..', 'feature_versions.json');

const router = Router();

// 内存锁存储
const featureLocks = new Map();
const schemaLocks = new Map();
// 版本号持久化到文件，避免服务器重启丢失
let featureVersions = new Map();
try {
  if (fs.existsSync(VERSIONS_FILE)) {
    featureVersions = new Map(JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8')));
  }
} catch (e) { /* ignore */ }
const saveVersions = () => {
  try { fs.writeFileSync(VERSIONS_FILE, JSON.stringify([...featureVersions]), 'utf-8'); } catch (e) { /* ignore */ }
};

// 供外部（features.js）调用的版本递增
export const bumpFeatureVersion = (layerId, featureId) => {
  const lockKey = `${layerId}:${featureId}`;
  const v = featureVersions.get(lockKey) || 1;
  featureVersions.set(lockKey, v + 1);
  saveVersions();
};

export const bumpLayerVersion = (layerId) => {
  const key = `layer:${layerId}`;
  const v = featureVersions.get(key) || 1;
  featureVersions.set(key, v + 1);
  saveVersions();
};

export const getFeatureVersion = (layerId, featureId) => {
  return featureVersions.get(`${layerId}:${featureId}`) || 1;
};

// 要素最后修改者（内存，供 409 冲突提示用）
const featureModifiers = new Map();
export const setFeatureModifier = (layerId, featureId, username) => {
  featureModifiers.set(`${layerId}:${featureId}`, username);
};
export const getFeatureModifier = (layerId, featureId) => {
  return featureModifiers.get(`${layerId}:${featureId}`) || '';
};

const TREE_VERSION_KEY = '_tree';
export const getTreeVersion = () => featureVersions.get(TREE_VERSION_KEY) || 1;
export const bumpTreeVersion = () => {
  const v = getTreeVersion();
  featureVersions.set(TREE_VERSION_KEY, v + 1);
  saveVersions();
};
// per-file mutex for layer-config.json（共享锁，同时被 layers.js 和 features.js 使用）
let configLock = null;
export const withConfigLock = async (fn) => {
  while (configLock) await configLock;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  configLock = promise;
  try { return await fn(); }
  finally { configLock = null; resolve(); }
};

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

// 清理过期锁
const cleanExpired = () => {
  const now = Date.now();
  for (const [key, lock] of featureLocks) {
    if (now > lock.expiresAt) featureLocks.delete(key);
  }
  for (const [key, lock] of schemaLocks) {
    if (now > lock.expiresAt) schemaLocks.delete(key);
  }
};

// 要素锁：获取
router.post('/locks/feature/acquire', requireEditor, (req, res) => {
  cleanExpired();
  const { layerId, featureId } = req.body;
  if (!layerId || !featureId) return res.status(400).json({ error: '缺少 layerId 或 featureId' });

  const lockKey = `${layerId}:${featureId}`;
  const existing = featureLocks.get(lockKey);
  if (existing && Date.now() < existing.expiresAt) {
    if (existing.userId === req.user.username) {
      // 同一用户，续期
      existing.expiresAt = Date.now() + LOCK_TIMEOUT_MS;
      return res.json({ success: true, owned: true });
    }
    return res.status(423).json({ error: `该要素正在被 ${existing.username} 编辑` });
  }

  // 检查 schema 锁冲突
  const schemaLock = schemaLocks.get(layerId);
  if (schemaLock && Date.now() < schemaLock.expiresAt && schemaLock.userId !== req.user.username) {
    return res.status(423).json({ error: `图层表结构正在被 ${schemaLock.username} 修改，暂时无法编辑要素` });
  }

  const version = featureVersions.get(lockKey) || 1;
  const layerVersion = featureVersions.get(`layer:${layerId}`) || 1;
  featureLocks.set(lockKey, {
    userId: req.user.username,
    username: req.user.displayName || req.user.username,
    lockedAt: Date.now(),
    expiresAt: Date.now() + LOCK_TIMEOUT_MS
  });
  res.json({ success: true, version, layerVersion });
});

// 要素锁：释放
router.post('/locks/feature/release', requireEditor, (req, res) => {
  const { layerId, featureId, saved } = req.body;
  if (!layerId || !featureId) return res.status(400).json({ error: '缺少 layerId 或 featureId' });

  const lockKey = `${layerId}:${featureId}`;
  const existing = featureLocks.get(lockKey);
  if (existing && existing.userId !== req.user.username) {
    return res.status(403).json({ error: '无权释放他人的锁' });
  }
  featureLocks.delete(lockKey);
  // 保存后递增版本号
  if (saved) {
    const v = featureVersions.get(lockKey) || 1;
    featureVersions.set(lockKey, v + 1);
    saveVersions();
  }
  res.json({ success: true });
});

// Schema 锁：获取
router.post('/locks/schema/acquire', requireEditor, (req, res) => {
  cleanExpired();
  const { layerId } = req.body;
  if (!layerId) return res.status(400).json({ error: '缺少 layerId' });

  const existing = schemaLocks.get(layerId);
  if (existing && Date.now() < existing.expiresAt) {
    if (existing.userId === req.user.username) {
      existing.expiresAt = Date.now() + LOCK_TIMEOUT_MS;
      return res.json({ success: true, owned: true });
    }
    return res.status(423).json({ error: `表结构正在被 ${existing.username} 修改` });
  }

  // 检查是否有活跃的要素锁（其他人持有的）
  for (const [key, lock] of featureLocks) {
    if (key.startsWith(`${layerId}:`) && Date.now() < lock.expiresAt && lock.userId !== req.user.username) {
      return res.status(423).json({ error: `图层中有要素正在被 ${lock.username} 编辑，无法修改表结构` });
    }
  }

  schemaLocks.set(layerId, {
    userId: req.user.username,
    username: req.user.displayName || req.user.username,
    lockedAt: Date.now(),
    expiresAt: Date.now() + LOCK_TIMEOUT_MS
  });
  res.json({ success: true });
});

// Schema 锁：释放
router.post('/locks/schema/release', requireEditor, (req, res) => {
  const { layerId } = req.body;
  if (!layerId) return res.status(400).json({ error: '缺少 layerId' });
  const existing = schemaLocks.get(layerId);
  if (existing && existing.userId !== req.user.username) {
    return res.status(403).json({ error: '无权释放他人的锁' });
  }
  schemaLocks.delete(layerId);
  res.json({ success: true });
});

// 查询图层树版本（轻量，公开）
router.get('/tree-version', (req, res) => {
  res.json({ version: getTreeVersion() });
});

// 查询图层所有锁状态
router.get('/locks/:layerId', optionalAuth, (req, res) => {
  cleanExpired();
  const { layerId } = req.params;
  const features = [];
  for (const [key, lock] of featureLocks) {
    if (key.startsWith(`${layerId}:`)) {
      features.push({ featureId: key.split(':')[1], username: lock.username, lockedAt: lock.lockedAt });
    }
  }
  const schema = schemaLocks.get(layerId);
  const versions = {};
  for (const [key, v] of featureVersions) {
    if (key.startsWith(`${layerId}:`)) versions[key.split(':')[1]] = v;
  }
  const layerVersion = featureVersions.get(`layer:${layerId}`) || 1;
  const modifiers = {};
  for (const [key, username] of featureModifiers) {
    if (key.startsWith(`${layerId}:`)) modifiers[key.split(':')[1]] = username;
  }
  res.json({
    features,
    schema: schema && Date.now() < schema.expiresAt ? { username: schema.username, lockedAt: schema.lockedAt } : null,
    versions,
    layerVersion,
    modifiers
  });
});

// 查询单个要素版本（用于首次编辑前同步，避免 _clientVersion=0 误判 409）
router.get('/locks/:layerId/version/:featureId', (req, res) => {
  const { layerId, featureId } = req.params;
  const v = getFeatureVersion(layerId, featureId);
  res.json({ version: v });
});

// 管理员强制解锁（清除残留锁）
router.post('/locks/force-release', requireAdmin, (req, res) => {
  const { layerId, featureId } = req.body;
  if (!layerId || !featureId) return res.status(400).json({ error: '缺少 layerId 或 featureId' });
  const lockKey = `${layerId}:${featureId}`;
  featureLocks.delete(lockKey);
  res.json({ success: true });
});

export default router;
