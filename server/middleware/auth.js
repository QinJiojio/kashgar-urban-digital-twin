import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET 未设置！请在 .env 中配置 JWT_SECRET');
  process.exit(1);
}

const USERS_PATH = path.resolve(__dirname, '..', 'users.json');

// --- Token 版本号（防同账号并发登录）---
const userTokenVersions = new Map();

// 启动时从 users.json 加载各用户的 tokenVersion
const _loadTokenVersions = () => {
  try {
    if (fs.existsSync(USERS_PATH)) {
      const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
      users.forEach(u => {
        if (u.username) userTokenVersions.set(u.username, u.tokenVersion || 1);
      });
    }
  } catch (e) { /* ignore */ }
};
_loadTokenVersions();

// 写 users.json 的互斥锁（防并发覆盖）
let _usersWriteLock = null;
const _withUsersLock = async (fn) => {
  while (_usersWriteLock) await _usersWriteLock;
  let resolve;
  _usersWriteLock = new Promise(r => { resolve = r; });
  try { return await fn(); }
  finally { _usersWriteLock = null; resolve(); }
};

const _writeUsers = async (users) => {
  await fs.promises.writeFile(USERS_PATH, JSON.stringify(users, null, 2), 'utf-8');
};

// 登录成功后调用：递增 tokenVersion，写回文件，返回新版本号
export const bumpTokenVersion = async (username) => {
  return _withUsersLock(async () => {
    const current = userTokenVersions.get(username) || 1;
    const next = current + 1;
    userTokenVersions.set(username, next);
    // 同步写回 users.json
    try {
      if (fs.existsSync(USERS_PATH)) {
        const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
        const user = users.find(u => u.username === username);
        if (user) user.tokenVersion = next;
        await _writeUsers(users);
      }
    } catch (e) { /* 写文件失败不影响 tokenVersion 在内存中的更新 */ }
    return next;
  });
};

export const getTokenVersion = (username) => {
  return userTokenVersions.get(username) || 1;
};

// 必须登录 — 拒绝未认证请求
export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    // Token 版本号校验：防同账号并发登录（旧 token 无 tv 字段视为 tv=0）
    const currentTv = getTokenVersion(req.user.username);
    const tokenTv = req.user.tv || 0;
    if (tokenTv < currentTv) {
      // 记录被踢日志
      try {
        const logsDir = path.resolve(process.env.DATA_DIR || 'D:/cesium-mvp-data', 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFileSync(path.resolve(logsDir, 'login_logs.jsonl'),
          JSON.stringify({ time: new Date().toISOString(), username: req.user.username, displayName: req.user.displayName, action: 'kicked', ip: req.ip, device: (req.headers['user-agent'] || '').slice(0, 80) }) + '\n', 'utf-8');
      } catch (_) {}
      return res.status(401).json({ error: '账号已在其他设备登录，请重新登录' });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
};

// 必须为 editor 或 admin
export const requireEditor = (req, res, next) => {
  requireAuth(req, res, () => {
    next();
  });
};

// 必须为 admin
export const requireAdmin = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可执行此操作' });
    }
    next();
  });
};

// 可选登录 — 不拒绝未认证请求，但若携带有效 token 则解析
export const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) { /* token invalid */ }
  }
  next();
};
