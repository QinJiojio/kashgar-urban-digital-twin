// 用户会话管理：心跳 + 在线状态 + 登录确认
const sessions = new Map(); // username → { tokenVersion, lastHeartbeat, device, displayName, role, loginTime }

const SESSION_TIMEOUT_MS = 2 * 60 * 1000; // 2 分钟无心跳视为离线

// 定时清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [username, s] of sessions) {
    if (now - s.lastHeartbeat > SESSION_TIMEOUT_MS) {
      sessions.delete(username);
    }
  }
}, 60_000);

export const addSession = (username, info) => {
  sessions.set(username, {
    ...info,
    lastHeartbeat: Date.now(),
    loginTime: info.loginTime || Date.now()
  });
};

export const removeSession = (username) => {
  sessions.delete(username);
};

export const heartbeat = (username) => {
  const s = sessions.get(username);
  if (s) {
    s.lastHeartbeat = Date.now();
    return true;
  }
  return false;
};

export const getSession = (username) => sessions.get(username);

export const isActive = (username) => {
  const s = sessions.get(username);
  if (!s) return false;
  return (Date.now() - s.lastHeartbeat) < SESSION_TIMEOUT_MS;
};

export const getActiveSessions = () => {
  const now = Date.now();
  const active = [];
  for (const [username, s] of sessions) {
    if (now - s.lastHeartbeat < SESSION_TIMEOUT_MS) {
      active.push({ username, displayName: s.displayName, role: s.role, device: s.device, loginTime: new Date(s.loginTime).toISOString(), lastHeartbeat: new Date(s.lastHeartbeat).toISOString() });
    }
  }
  return active;
};
