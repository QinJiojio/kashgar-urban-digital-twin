// 登录日志：记录每次登录/退出/被踢事件
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const LOGS_DIR = path.resolve(DATA_DIR, 'logs');
const LOG_PATH = path.resolve(LOGS_DIR, 'login_logs.jsonl');

const MAX_DAYS = 30;
const MAX_ENTRIES = 10000;

// 确保目录存在
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// 追加一条日志（JSONL 格式，每行一条，高效追加）
export const logEvent = (entry) => {
  const record = {
    time: new Date().toISOString(),
    ...entry
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) { /* ignore */ }
};

// 轮转：启动时清理过期日志 + 超量日志
export const rotateLogs = () => {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    let lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
    const cutoff = Date.now() - MAX_DAYS * 86400000;
    // 按时间过滤
    lines = lines.filter(line => {
      try {
        const r = JSON.parse(line);
        return new Date(r.time).getTime() >= cutoff;
      } catch { return false; }
    });
    // 按数量截断
    if (lines.length > MAX_ENTRIES) {
      lines = lines.slice(-MAX_ENTRIES);
    }
    fs.writeFileSync(LOG_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
  } catch (e) { /* ignore */ }
};

// 读取全部日志（倒序，最新在前）
export const getLogs = (username, limit = 200) => {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
    const records = [];
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (!username || r.username === username) records.push(r);
      } catch { /* skip corrupt lines */ }
    }
    return records;
  } catch (e) { return []; }
};

// 汇总统计：各用户的使用情况
export const getUsageStats = () => {
  const logs = getLogs(null, 5000);
  const users = new Map();
  // 第一遍：统计基本信息
  for (const entry of logs) {
    if (!users.has(entry.username)) {
      users.set(entry.username, { username: entry.username, displayName: entry.displayName, sessions: [], totalMinutes: 0, lastLogin: null, loginCount: 0 });
    }
    const u = users.get(entry.username);
    if (entry.action === 'login') {
      u.loginCount++;
      if (!u.lastLogin || entry.time > u.lastLogin) u.lastLogin = entry.time;
    }
  }
  // 第二遍：按时间顺序处理每个用户的事件，配对会话
  for (const [username, u] of users) {
    const userEvents = logs.filter(e => e.username === username).reverse(); // 正序
    let sessionStart = null;
    for (const e of userEvents) {
      if (e.action === 'login' && !sessionStart) {
        sessionStart = new Date(e.time).getTime();
      } else if ((e.action === 'kicked' || e.action === 'logout') && sessionStart) {
        const duration = (new Date(e.time).getTime() - sessionStart) / 60000;
        if (duration > 0 && duration < 1440) {
          u.sessions.push({ login: new Date(sessionStart).toISOString(), logout: e.time, minutes: Math.round(duration) });
          u.totalMinutes += Math.round(duration);
        }
        sessionStart = null;
      } else if (e.action === 'login' && sessionStart) {
        // 新 login 出现：上一个会话隐式结束（无 kicked/logout，fallback 配对）
        const duration = (new Date(e.time).getTime() - sessionStart) / 60000;
        if (duration > 0 && duration < 1440) {
          u.sessions.push({ login: new Date(sessionStart).toISOString(), logout: e.time, minutes: Math.round(duration) });
          u.totalMinutes += Math.round(duration);
        }
        sessionStart = new Date(e.time).getTime();
      }
    }
    // 最后一个未结束的会话
    if (sessionStart) {
      const ongoing = (Date.now() - sessionStart) / 60000;
      if (ongoing > 0 && ongoing < 1440) {
        u.sessions.push({ login: new Date(sessionStart).toISOString(), logout: null, minutes: Math.round(ongoing), ongoing: true });
        u.totalMinutes += Math.round(ongoing);
      }
    }
  }
  return [...users.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
};

// 启动时执行一次轮转
rotateLogs();
