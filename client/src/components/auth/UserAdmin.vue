<template>
  <div class="admin-overlay" @click.self="$emit('close')">
    <div class="admin-panel">
      <div class="panel-header">
        <h2>👥 用户管理</h2>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>

      <div class="add-form">
        <input v-model="newUser.username" placeholder="用户名" class="field-input" />
        <input v-model="newUser.password" placeholder="密码" class="field-input" />
        <input v-model="newUser.displayName" placeholder="显示名（可选）" class="field-input" />
        <select v-model="newUser.role" class="field-input">
          <option value="editor">数据专员</option>
          <option value="admin">管理员</option>
        </select>
        <button class="btn-add" @click="handleAdd" :disabled="!newUser.username||!newUser.password">+ 添加</button>
      </div>

      <div class="user-list">
        <div v-for="user in users" :key="user.username" class="user-row" :class="{ online: isOnline(user.username), locked: isLocked(user.username) }">
          <span class="online-dot" :class="{ active: isOnline(user.username) }" :title="isOnline(user.username) ? '在线' : '离线'"></span>
          <span class="user-name">{{ user.displayName || user.username }}</span>
          <span class="user-role">{{ user.role === 'admin' ? '管理员' : '数据专员' }}</span>
          <span v-if="isOnline(user.username)" class="online-badge">在线</span>
          <span v-if="isLocked(user.username)" class="locked-badge" :title="lockRemainText(user.username)">已锁定</span>
          <button v-if="isLocked(user.username)" class="btn-unlock" @click="handleUnlock(user.username)">解锁</button>
          <button v-else class="btn-reset" @click="handleResetPwd(user.username)">重置密码</button>
          <button v-if="user.username !== 'admin'" class="btn-del" @click="handleDelete(user.username)">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { mapState } from '../../store/mapState';

const emit = defineEmits(['close']);

const users = ref([]);
const onlineUsers = ref([]);
const lockouts = ref([]);
const newUser = ref({ username: '', password: '', displayName: '', role: 'editor' });

const isOnline = (username) => onlineUsers.value.some(u => u.username === username);
const isLocked = (username) => lockouts.value.some(l => l.username === username);
const lockRemainText = (username) => {
  const l = lockouts.value.find(l => l.username === username);
  return l ? `剩余 ${l.remainMin} 分钟` : '';
};

const token = () => sessionStorage.getItem('cesium_mvp_token') || '';
const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` });

const loadUsers = async () => {
  const res = await fetch('/api/users', { headers: headers() });
  if (res.ok) users.value = await res.json();
};

const handleAdd = async () => {
  const res = await fetch('/api/users', {
    method: 'POST', headers: headers(),
    body: JSON.stringify(newUser.value)
  });
  if (res.ok) {
    newUser.value = { username: '', password: '', displayName: '', role: 'editor' };
    loadUsers();
  } else {
    const data = await res.json();
    alert(data.error);
  }
};

const handleDelete = async (username) => {
  if (!confirm(`确定删除用户 ${username}？`)) return;
  await fetch(`/api/users/${username}`, { method: 'DELETE', headers: headers() });
  loadUsers();
};

const handleResetPwd = async (username) => {
  const pw = prompt(`为用户 ${username} 输入新密码：`);
  if (!pw) return;
  await fetch(`/api/users/${username}`, {
    method: 'PUT', headers: headers(),
    body: JSON.stringify({ password: pw })
  });
  alert('密码已更新');
};

const handleUnlock = async (username) => {
  const res = await fetch(`/api/auth/unlock/${username}`, { method: 'POST', headers: headers() });
  const data = await res.json();
  if (data.success) loadLockouts();
};

const loadOnline = async () => {
  const res = await fetch('/api/sessions', { headers: headers() });
  if (res.ok) onlineUsers.value = await res.json();
};

const loadLockouts = async () => {
  const res = await fetch('/api/auth/lockouts', { headers: headers() });
  if (res.ok) lockouts.value = await res.json();
};

let _onlineTimer = null;
onMounted(() => { loadUsers(); loadOnline(); loadLockouts(); _onlineTimer = setInterval(() => { loadOnline(); loadLockouts(); }, 30000); });
onUnmounted(() => { clearInterval(_onlineTimer); });
</script>

<style scoped>
.admin-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 10000; }
.admin-panel { width: 480px; max-height: 80vh; background: #0f172a; border: 1px solid #38bdf8; border-radius: 8px; padding: 24px; overflow-y: auto; }
.panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.panel-header h2 { color: #fff; margin: 0; font-size: 18px; }
.close-btn { background: none; border: none; color: #64748b; font-size: 24px; cursor: pointer; }
.add-form { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
.field-input { padding: 6px 10px; background: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #e2e8f0; font-size: 13px; outline: none; }
.field-input:focus { border-color: #38bdf8; }
.btn-add { padding: 6px 14px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 4px; color: #fff; cursor: pointer; font-size: 13px; }
.btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.user-list { display: flex; flex-direction: column; gap: 6px; }
.user-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1e293b; border-radius: 4px; }
.user-name { flex: 1; color: #e2e8f0; font-size: 14px; }
.user-role { color: #38bdf8; font-size: 12px; width: 60px; }
.btn-reset { padding: 3px 10px; background: #334155; border: 1px solid #64748b; border-radius: 3px; color: #e2e8f0; cursor: pointer; font-size: 12px; }
.btn-del { padding: 3px 10px; background: #7f1d1d22; border: 1px solid #ef4444; border-radius: 3px; color: #ef4444; cursor: pointer; font-size: 12px; }
.online-dot { width: 8px; height: 8px; border-radius: 50%; background: #475569; flex-shrink: 0; }
.online-dot.active { background: #10b981; box-shadow: 0 0 6px #10b98188; }
.online-badge { color: #10b981; font-size: 11px; flex-shrink: 0; }
.locked-badge { color: #ef4444; font-size: 11px; flex-shrink: 0; }
.user-row.online { border-left: 3px solid #10b981; padding-left: 9px; }
.user-row.locked { border-left: 3px solid #ef4444; padding-left: 9px; background: #7f1d1d11; }
.btn-unlock { padding: 3px 10px; background: #7f1d1d33; border: 1px solid #ef4444; border-radius: 3px; color: #ef4444; cursor: pointer; font-size: 12px; }
.btn-unlock:hover { background: #7f1d1d55; }
</style>
