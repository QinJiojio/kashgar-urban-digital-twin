import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const usersPath = path.resolve(__dirname, '..', 'users.json');

const router = Router();

// 所有 /users 路由需要 admin 权限（加路径前缀防止误拦截其他路由，教训 #37）
router.use('/users', requireAdmin);

// 读取用户列表
const readUsers = async () => {
  try {
    const raw = await fs.readFile(usersPath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

// GET /api/users — 列出所有用户（不含密码哈希）
router.get('/users', async (req, res) => {
  try {
    const users = await readUsers();
    res.json(users.map(u => ({ username: u.username, role: u.role, displayName: u.displayName })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users — 添加用户
router.post('/users', async (req, res) => {
  try {
    const { username, password, role, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

    const users = await readUsers();
    if (users.find(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });

    users.push({
      username,
      password: await bcrypt.hash(password, 10),
      role: role || 'editor',
      displayName: displayName || username
    });
    await fs.writeFile(usersPath, JSON.stringify(users, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:username — 更新用户（角色/密码）
router.put('/users/:username', async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (req.body.role) user.role = req.body.role;
    if (req.body.displayName) user.displayName = req.body.displayName;
    if (req.body.password) user.password = await bcrypt.hash(req.body.password, 10);

    await fs.writeFile(usersPath, JSON.stringify(users, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:username — 删除用户
router.delete('/users/:username', async (req, res) => {
  try {
    const users = await readUsers();
    if (req.params.username === 'admin') return res.status(400).json({ error: '不能删除管理员账号' });
    const newUsers = users.filter(u => u.username !== req.params.username);
    if (newUsers.length === users.length) return res.status(404).json({ error: '用户不存在' });
    await fs.writeFile(usersPath, JSON.stringify(newUsers, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
