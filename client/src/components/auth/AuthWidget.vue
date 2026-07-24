<template>
  <div class="auth-container" v-if="mapState.ui.currentView !== 'table'">
    <div class="auth-badge" :class="mapState.auth.role" @click="toggleModal">
      <span class="icon">{{ mapState.auth.role === 'admin' ? '🛡️' : '👁️' }}</span>
      <span class="username">{{ mapState.auth.username }}</span>
      <span class="status-dot"></span>
    </div>

    <div class="login-modal-overlay" v-if="showModal">
      <div class="login-modal">
        <button class="close-btn" @click="showModal = false">×</button>

        <div class="modal-header">
          <h2>已授权接入</h2>
          <p>{{ mapState.auth.username }}</p>
        </div>
        <div class="modal-body">
          <p class="success-text">🟢 数据编辑功能已解锁。</p>
          <button v-if="mapState.auth.role === 'admin'" class="cyber-btn admin-btn" @click="showAdmin = true; showModal = false">👥 用户管理</button>
          <button v-if="mapState.auth.role === 'admin'" class="cyber-btn admin-btn" @click="showBackups = true; showModal = false" style="background:#7c3aed22;border-color:#a78bfa;color:#a78bfa;">📂 备份管理</button>
          <div v-if="mapState.auth.role === 'admin'" class="online-section">
            <p class="online-title">🟢 在线 ({{ onlineUsers.length }}) <button class="stats-btn" @click="openStatsPanel">📊 详情</button></p>
            <div v-if="onlineUsers.length" class="online-list">
              <div v-for="u in onlineUsers" :key="u.username" class="online-item">
                <span>{{ u.role === 'admin' ? '🛡️' : '✏️' }} {{ u.displayName }}</span>
                <span class="online-device">{{ u.device }}</span>
              </div>
            </div>
            <p v-else class="online-empty">暂无其他在线用户</p>
          </div>
          <button class="cyber-btn logout-btn" @click="handleLogout">断开连接 (LOGOUT)</button>
        </div>
      </div>
    </div>
    <UserAdmin v-if="showAdmin" @close="showAdmin = false" />
    <BackupManager v-if="showBackups" @close="showBackups = false" />

    <!-- 使用统计大面板 -->
    <div v-if="showStatsModal" class="stats-overlay" @click.self="showStatsModal = false">
      <div class="stats-dash">
        <div class="stats-topbar">
          <h2>📊 平台使用统计</h2>
          <button class="close-btn" @click="showStatsModal = false">×</button>
        </div>
        <div v-if="statsLoading" class="stats-loading">加载中...</div>
        <template v-else>
          <div class="stats-body">
            <div class="stats-left">
              <h3>👥 用户使用情况</h3>
              <div v-if="usageStats.length" class="user-cards">
                <div v-for="u in usageStats" :key="u.username" class="user-card">
                  <div class="uc-avatar">{{ u.role === 'admin' ? '🛡️' : '✏️' }}</div>
                  <div class="uc-info">
                    <div class="uc-name">{{ u.displayName || u.username }}</div>
                    <div class="uc-role">{{ u.role === 'admin' ? '管理员' : '数据专员' }}</div>
                    <div class="uc-stats">
                      <span class="uc-stat">{{ u.totalMinutes >= 60 ? Math.floor(u.totalMinutes / 60) + 'h' + (u.totalMinutes % 60) + 'm' : u.totalMinutes + 'm' }}</span>
                      <span class="uc-stat">{{ u.loginCount }} 次登录</span>
                    </div>
                    <div v-if="u.lastLogin" class="uc-last">最近: {{ formatTime(u.lastLogin) }}</div>
                    <div v-if="u.sessions && u.sessions.length" class="uc-sessions">
                      <div v-for="(s, i) in u.sessions.slice(-5)" :key="i" class="uc-sess-line">
                        <span class="sess-dot" :class="{ ongoing: s.ongoing }"></span>
                        {{ formatTime(s.login) }} → {{ s.ongoing ? '进行中' : formatTime(s.logout) }}
                        <span class="sess-dur">({{ s.minutes >= 60 ? Math.floor(s.minutes/60)+'h'+(s.minutes%60)+'m' : s.minutes+'m' }})</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p v-else class="stats-empty">暂无使用记录</p>
            </div>
            <div class="stats-right">
              <h3>📋 最近活动</h3>
              <div v-if="recentLogs.length" class="activity-list">
                <div v-for="(l, i) in recentLogs.slice(0, 30)" :key="i" class="activity-item">
                  <span class="act-dot" :class="l.action"></span>
                  <span class="act-time">{{ formatTime(l.time) }}</span>
                  <span class="act-action" :class="l.action">{{ { login: '登录', kicked: '被踢', logout: '退出' }[l.action] || l.action }}</span>
                  <span class="act-user">{{ l.displayName || l.username }}</span>
                  <span class="act-device">{{ l.device }}</span>
                </div>
              </div>
              <p v-else class="stats-empty">暂无活动记录</p>
            </div>
          </div>
          <div class="stats-footer">
            <span>数据更新于 {{ lastRefreshTime }}</span>
            <button class="refresh-btn" @click="fetchStats">🔄 刷新</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { mapState } from '../../store/mapState';
import UserAdmin from './UserAdmin.vue';
import BackupManager from './BackupManager.vue';

const showModal = ref(false);
const showAdmin = ref(false);
const showBackups = ref(false);
const onlineUsers = ref([]);
const onlineCount = ref(0);
const showStats = ref(false);
const showStatsModal = ref(false);
const usageStats = ref([]);
const recentLogs = ref([]);
const statsLoading = ref(false);
const lastRefreshTime = ref('');
let _onlineTimer = null;

const fetchOnlineUsers = async () => {
  if (mapState.auth.role !== 'admin') return;
  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const res = await fetch('/api/sessions', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      onlineUsers.value = await res.json();
      onlineCount.value = onlineUsers.value.length;
    }
  } catch (e) { /* ignore */ }
};

const fetchStats = async () => {
  if (mapState.auth.role !== 'admin') return;
  statsLoading.value = true;
  try {
    const token = sessionStorage.getItem('cesium_mvp_token') || '';
    const res = await fetch('/api/sessions/stats', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      usageStats.value = data.stats || [];
      recentLogs.value = data.recentLogs || [];
      onlineUsers.value = data.online || [];
      onlineCount.value = onlineUsers.value.length;
    }
  } catch (e) { /* ignore */ }
  finally { statsLoading.value = false; lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
};

const openStatsPanel = () => {
  showStatsModal.value = true;
  fetchStats();
};

const formatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

onMounted(() => {
  fetchOnlineUsers();
  _onlineTimer = setInterval(fetchOnlineUsers, 30000);
});
onUnmounted(() => { if (_onlineTimer) clearInterval(_onlineTimer); });

watch(showStatsModal, (v) => { if (v) fetchStats(); });

const toggleModal = () => {
  showModal.value = !showModal.value;
};

const handleLogout = () => {
  sessionStorage.removeItem('cesium_mvp_token');
  sessionStorage.removeItem('cesium_mvp_user');
  location.reload();
};
</script>

<style scoped>
/* 右上角身份徽章 */
.auth-container { position: absolute; top: 20px; right: 20px; z-index: 999; }
.auth-badge {
  display: flex; align-items: center; gap: 8px; padding: 6px 16px;
  background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(8px);
  border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 20px;
  color: #e2e8f0; font-family: monospace; font-size: 13px;
  cursor: pointer; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.auth-badge:hover { background: rgba(30, 41, 59, 0.9); border-color: #38bdf8; }
.auth-badge.admin { border-color: #10b981; box-shadow: 0 0 15px rgba(16, 185, 129, 0.2); }
.auth-badge.admin .username { color: #10b981; font-weight: bold; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8; }
.auth-badge.admin .status-dot { background: #10b981; box-shadow: 0 0 8px #10b981; }

/* 全屏遮罩与弹窗 */
.login-modal-overlay {
  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
  background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(5px);
  display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.login-modal {
  width: 380px; background: rgba(15, 23, 42, 0.95);
  border: 1px solid #38bdf8; border-top: 4px solid #38bdf8;
  padding: 30px; position: relative; box-shadow: 0 0 30px rgba(56, 189, 248, 0.2);
}
.close-btn {
  position: absolute; top: 10px; right: 15px; background: transparent; border: none;
  color: #64748b; font-size: 24px; cursor: pointer; transition: color 0.2s;
}
.close-btn:hover { color: #ef4444; }
.modal-header h2 { margin: 0; color: #fff; font-size: 20px; letter-spacing: 2px; }
.modal-header p { margin: 4px 0 20px; color: #38bdf8; font-family: monospace; font-size: 12px; opacity: 0.8; }
.warning-text { color: #fbbf24; font-size: 13px; line-height: 1.5; margin-bottom: 20px; }
.success-text { color: #10b981; font-size: 14px; margin-bottom: 20px; font-weight: bold; }

.tech-input {
  width: 100%; box-sizing: border-box; background: rgba(0, 0, 0, 0.5); border: 1px solid #475569;
  color: #38bdf8; padding: 12px; font-family: monospace; font-size: 16px; margin-bottom: 10px; outline: none; transition: border 0.3s;
}
.tech-input:focus { border-color: #38bdf8; box-shadow: inset 0 0 10px rgba(56, 189, 248, 0.2); }
.error-msg { color: #ef4444; font-size: 12px; font-family: monospace; margin: 0 0 15px 0; height: 14px; }

.cyber-btn {
  width: 100%; padding: 12px; background: #0369a1; border: 1px solid #38bdf8;
  color: white; font-weight: bold; cursor: pointer; transition: all 0.2s; letter-spacing: 1px;
}
.cyber-btn:hover { background: #0284c7; box-shadow: 0 0 15px rgba(56, 189, 248, 0.5); }
.logout-btn { background: transparent; border-color: #ef4444; color: #ef4444; }
.logout-btn:hover { background: rgba(239, 68, 68, 0.1); box-shadow: 0 0 15px rgba(239, 68, 68, 0.3); }
.online-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #334155; }
.online-title { font-size: 12px; color: #10b981; margin: 0 0 8px; }
.online-list { display: flex; flex-direction: column; gap: 4px; }
.online-item { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; }
.online-device { color: #64748b; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.online-empty { font-size: 12px; color: #64748b; }
.stats-btn { font-size: 11px; background: none; border: 1px solid #475569; color: #38bdf8; border-radius: 4px; cursor: pointer; padding: 1px 6px; margin-left: 4px; }

/* --- 统计大面板 --- */
.stats-overlay { position: fixed; inset: 0; z-index: 10001; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; }
.stats-dash { width: 900px; max-width: 95vw; max-height: 85vh; background: #0f172a; border: 1px solid #334155; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.stats-topbar { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid #1e293b; flex-shrink: 0; }
.stats-topbar h2 { margin: 0; font-size: 16px; color: #38bdf8; }
.stats-loading { padding: 40px; text-align: center; color: #64748b; }
.stats-body { flex: 1; overflow-y: auto; display: flex; gap: 0; min-height: 0; }
.stats-left { flex: 1; padding: 16px; border-right: 1px solid #1e293b; min-width: 0; }
.stats-right { flex: 1; padding: 16px; min-width: 0; }
.stats-body h3 { margin: 0 0 12px; font-size: 13px; color: #94a3b8; }
.user-cards { display: flex; flex-direction: column; gap: 10px; }
.user-card { display: flex; gap: 12px; background: rgba(30,41,59,0.5); padding: 12px; border-radius: 8px; border: 1px solid #1e293b; }
.uc-avatar { font-size: 24px; flex-shrink: 0; }
.uc-info { flex: 1; min-width: 0; }
.uc-name { font-size: 14px; font-weight: bold; color: #e2e8f0; }
.uc-role { font-size: 11px; color: #64748b; }
.uc-stats { display: flex; gap: 12px; margin-top: 4px; }
.uc-stat { font-size: 12px; color: #38bdf8; font-weight: bold; }
.uc-last { font-size: 11px; color: #64748b; margin-top: 2px; }
.uc-sessions { margin-top: 8px; padding-top: 6px; border-top: 1px solid #1e293b; }
.uc-sess-line { font-size: 11px; color: #64748b; display: flex; align-items: center; gap: 4px; }
.sess-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
.sess-dot.ongoing { background: #38bdf8; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.sess-dur { color: #475569; margin-left: auto; }
.activity-list { display: flex; flex-direction: column; }
.activity-item { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px solid rgba(30,41,59,0.5); font-size: 12px; color: #94a3b8; }
.act-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.act-dot.login { background: #10b981; }
.act-dot.kicked { background: #ef4444; }
.act-dot.logout { background: #f59e0b; }
.act-time { color: #64748b; flex-shrink: 0; min-width: 110px; }
.act-action { flex-shrink: 0; min-width: 32px; }
.act-action.login { color: #10b981; }
.act-action.kicked { color: #ef4444; }
.act-action.logout { color: #f59e0b; }
.act-user { color: #e2e8f0; }
.act-device { color: #475569; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }
.stats-footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b; flex-shrink: 0; }
.refresh-btn { background: #1e293b; border: 1px solid #475569; color: #94a3b8; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.refresh-btn:active { border-color: #38bdf8; color: #38bdf8; }
.stats-empty { text-align: center; color: #64748b; padding: 20px 0; font-size: 13px; }
.admin-btn { background: #7c3aed22; border-color: #7c3aed; color: #a78bfa; margin-bottom: 8px; }
.admin-btn:hover { background: #7c3aed44; }
</style>
