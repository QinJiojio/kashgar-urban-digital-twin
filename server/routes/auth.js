import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { bumpTokenVersion, getTokenVersion } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { addSession, isActive, getActiveSessions, heartbeat } from '../sessions.js';
import { logEvent } from '../login_logger.js';
import { getUsageStats, getLogs } from '../login_logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET 未设置！请在 .env 中配置 JWT_SECRET');
  process.exit(1);
}

const router = Router();

// 账号锁定追踪（global 单例，服务重启自动清零）
// Map<username, { failCount: number, lockedUntil: number (epoch ms) }>
// 使用 global 而非模块级 const：ESM 动态 import 可能创建多个模块实例
global.__lockouts = global.__lockouts || new Map();
const lockouts = global.__lockouts;
const MAX_FAILS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 分钟

// 登录速率限制：每 IP 每分钟最多 10 次尝试
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' }
});

// POST /api/auth/login — 用户名密码登录，返回 JWT
router.post('/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
    // 账号锁定检查（在 bcrypt 之前，锁定请求不应浪费 CPU 算哈希）
    const lock = lockouts.get(username);
    if (lock && lock.lockedUntil > Date.now()) {
      const remainMin = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({ error: `账号已锁定，请 ${remainMin} 分钟后重试` });
    }
    // 锁定已过期则清除（lockedUntil > 0 限定仅清除真正锁定过的记录）
    if (lock && lock.lockedUntil > 0 && lock.lockedUntil <= Date.now()) {
      lockouts.delete(username);
    }

    const usersPath = path.resolve(__dirname, '..', 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      // 记录失败，达到阈值则锁定
      const current = lockouts.get(username) || { failCount: 0, lockedUntil: 0 };
      current.failCount++;
      if (current.failCount >= MAX_FAILS) {
        current.lockedUntil = Date.now() + LOCK_DURATION;
        lockouts.set(username, current);
        logEvent({ username, displayName: user.displayName, action: 'locked', ip: req.ip, failCount: current.failCount });
        return res.status(423).json({ error: `密码错误次数过多，账号已锁定 ${LOCK_DURATION / 60000} 分钟` });
      }
      lockouts.set(username, current);
      logEvent({ username, displayName: user.displayName, action: 'login_failed', ip: req.ip, failCount: current.failCount });
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 登录成功：清除失败记录
    lockouts.delete(username);

    // 检测是否有活跃会话（心跳而非永久的 tokenVersion 判断）
    if (isActive(user.username) && !req.body.force) {
      return res.json({ requireConfirm: true, message: '该账号可能已在其他设备登录，继续将已登录设备下线？' });
    }

    const tokenVersion = await bumpTokenVersion(user.username);

    // 记录登录会话
    const device = (req.headers['user-agent'] || '').slice(0, 80);
    addSession(user.username, { tokenVersion, device, displayName: user.displayName, role: user.role });
    logEvent({ username: user.username, displayName: user.displayName, action: 'login', ip: req.ip, device });

    const token = jwt.sign(
      { username: user.username, role: user.role, displayName: user.displayName, tv: tokenVersion },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { username: user.username, role: user.role, displayName: user.displayName, tokenVersion }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/heartbeat — 客户端保活
router.post('/heartbeat', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // tv 校验（与 requireAuth 一致，踢掉被挤下线的旧设备）
    const currentTv = getTokenVersion(decoded.username);
    if ((decoded.tv || 0) < currentTv) {
      return res.status(401).json({ error: '账号已在其他设备登录' });
    }
    // 更新或重建会话（服务端重启后内存会话丢失，心跳重建）
    if (!heartbeat(decoded.username)) {
      addSession(decoded.username, {
        tokenVersion: decoded.tv || 0,
        device: (req.headers['user-agent'] || '').slice(0, 80),
        displayName: decoded.displayName,
        role: decoded.role
      });
    }
    res.json({ ok: true, online: getActiveSessions().length });
  } catch (e) {
    res.status(401).json({ error: '登录已过期' });
  }
});

// GET /api/sessions/stats — 使用统计（Admin）
router.get('/sessions/stats', requireAdmin, (req, res) => {
  try {
    const stats = getUsageStats();
    const recent = getLogs(null, 50);
    res.json({ stats, recentLogs: recent, online: getActiveSessions() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions — 在线用户列表（Admin）
router.get('/sessions', requireAdmin, (req, res) => {
  res.json(getActiveSessions());
});

// GET /api/auth/lockouts — 查看所有锁定状态（Admin）
router.get('/auth/lockouts', requireAdmin, (req, res) => {
  const now = Date.now();
  const result = [];
  for (const [username, lock] of lockouts) {
    if (lock.lockedUntil > now) {
      result.push({ username, failCount: lock.failCount, lockedUntil: lock.lockedUntil, remainMin: Math.ceil((lock.lockedUntil - now) / 60000) });
    }
  }
  res.json(result);
});

// POST /api/auth/unlock/:username — 手动解除锁定（Admin）
router.post('/auth/unlock/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  if (lockouts.has(username)) {
    lockouts.delete(username);
    logEvent({ username, action: 'unlocked', ip: req.ip, unlockedBy: req.user?.username });
    res.json({ success: true, message: `已解除 ${username} 的登录锁定` });
  } else {
    res.json({ success: true, message: `${username} 当前未被锁定` });
  }
});

// POST /api/auth/verify — 验证 token 是否仍然有效（页面刷新时调用）
router.post('/auth/verify', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.json({ valid: false, reason: 'no_token' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    const currentTv = getTokenVersion(decoded.username);
    const tokenTv = decoded.tv || 0;
    if (tokenTv < currentTv) {
      return res.json({ valid: false, reason: 'kicked' });
    }
    // 刷新心跳（页面刷新 = 用户仍在活跃使用）
    heartbeat(decoded.username);
    res.json({ valid: true, user: { username: decoded.username, role: decoded.role, displayName: decoded.displayName } });
  } catch (e) {
    res.json({ valid: false, reason: 'expired' });
  }
});

export default router;
