import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

// 全局 fetch 拦截：401 统一处理，覆盖所有 API 调用
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
  if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/login')) {
    if (!window.__kickHandled) {
      window.__kickHandled = true;
      const body = await res.clone().json().catch(() => ({}));
      const msg = body.error || '登录已失效，请重新登录';
      alert(msg + '，即将刷新页面');
      location.reload();
    }
  }
  return res;
};

createApp(App).mount('#app')
