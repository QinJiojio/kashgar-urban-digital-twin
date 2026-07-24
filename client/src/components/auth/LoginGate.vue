<template>
  <div class="login-gate">
    <div class="gate-card">
      <h1>城市更新 3D 可视化平台</h1>
      <p class="subtitle">URBAN RENEWAL 3D VISUALIZATION</p>

      <div class="login-form" v-if="!confirmMsg">
        <input type="text" id="username" name="username" v-model="username" placeholder="用户名" @keyup.enter="handleLogin" />
        <input type="password" id="password" name="password" v-model="password" placeholder="密码" @keyup.enter="handleLogin" />
        <p class="error" v-if="error">{{ error }}</p>
        <button class="btn-primary" @click="handleLogin" :disabled="loading">
          {{ loading ? '验证中...' : '登录' }}
        </button>
      </div>
      <div class="login-form" v-else>
        <p class="confirm-msg">{{ confirmMsg }}</p>
        <div class="confirm-btns">
          <button class="btn-primary" @click="confirmLogin" :disabled="loading">确认继续</button>
          <button class="btn-ghost" @click="confirmMsg = ''">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { mapState } from '../../store/mapState';

const emit = defineEmits(['authenticated']);

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const confirmMsg = ref('');

const TOKEN_KEY = 'cesium_mvp_token';
const USER_KEY = 'cesium_mvp_user';

const doLogin = async (force = false) => {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value, force })
    });
    const data = await res.json();
    if (data.requireConfirm) {
      confirmMsg.value = data.message;
    } else if (res.ok) {
      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(data.user));
      mapState.auth.isLoggedIn = true;
      mapState.auth.role = data.user.role;
      mapState.auth.username = data.user.displayName;
      emit('authenticated');
    } else {
      error.value = data.error || '登录失败';
    }
  } catch (e) {
    error.value = '无法连接到服务器';
  } finally {
    loading.value = false;
  }
};

const handleLogin = () => {
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }
  doLogin(false);
};

const confirmLogin = () => {
  doLogin(true);
};
</script>

<style scoped>
.login-gate {
  position: fixed; inset: 0; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, #0f172a 0%, #020617 100%);
}
.gate-card {
  width: 380px; max-width: 90vw; padding: 40px 36px;
  background: rgba(15, 23, 42, 0.9); border: 1px solid #334155;
  border-radius: 12px; text-align: center;
}
@media (max-width: 480px) {
  .gate-card { padding: 24px 16px; }
  h1 { font-size: 17px; }
}
h1 { color: #fff; font-size: 20px; margin: 0 0 4px; letter-spacing: 1px; }
.subtitle { color: #38bdf8; font-size: 11px; letter-spacing: 3px; margin: 0 0 28px; }
.login-form { display: flex; flex-direction: column; gap: 10px; }
input {
  padding: 10px 14px; background: rgba(0,0,0,0.4); border: 1px solid #475569;
  border-radius: 6px; color: #e2e8f0; font-size: 14px; outline: none;
}
input:focus { border-color: #38bdf8; }
.error { color: #ef4444; font-size: 12px; margin: 0; min-height: 16px; }
.btn-primary {
  padding: 10px; background: #0369a1; border: 1px solid #38bdf8; border-radius: 6px;
  color: #fff; font-size: 14px; font-weight: bold; cursor: pointer;
}
.btn-primary:hover { background: #0284c7; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.confirm-msg { color: #f59e0b; font-size: 14px; margin: 0 0 16px; line-height: 1.6; }
.confirm-btns { display: flex; gap: 10px; }
.confirm-btns .btn-primary { flex: 1; }
.confirm-btns .btn-ghost { flex: 0 0 auto; padding: 10px 16px; background: transparent; border: 1px solid #475569; border-radius: 6px; color: #94a3b8; cursor: pointer; }
</style>
