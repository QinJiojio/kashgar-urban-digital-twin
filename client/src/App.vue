<template>
  <div id="app">
    <!-- 桌面端：地图容器始终存在，LoginGate 的 z-index:10000 作为遮罩覆盖 -->
    <div v-if="!isMobile" id="cesiumContainer"></div>
    <LoginGate v-if="!authenticated" @authenticated="onAuthenticated" />
    <template v-if="authenticated">
      <template v-if="isMobile">
        <MobileLayout />
      </template>
      <template v-else>
        <AuthWidget />
        <div v-if="mapState.system.isViewerReady" class="ui-layer">
          <MainLayout />
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import MainLayout from './components/layout/MainLayout.vue';
import MobileLayout from './components/layout/MobileLayout.vue';
import AuthWidget from './components/auth/AuthWidget.vue';
import LoginGate from './components/auth/LoginGate.vue';
import { initViewer, destroyViewer, getViewer } from './core/viewer/ViewerSetup';
import { initAllLayers, zoomToVisibleLayers } from './core/layers/LayerManager';
import { mapState, loadLayerConfig, verifyAuth } from './store/mapState';

const savedToken = sessionStorage.getItem('cesium_mvp_token');
const authenticated = ref(!!savedToken);
const isMobile = ref(window.innerWidth < 768);
let heartBeatTimer = null;

const startHeartbeat = () => {
  if (heartBeatTimer) clearInterval(heartBeatTimer);
  heartBeatTimer = setInterval(async () => {
    const token = sessionStorage.getItem('cesium_mvp_token');
    if (!token) { clearInterval(heartBeatTimer); return; }
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }).catch(() => {});
  }, 60_000);
};

const stopHeartbeat = () => {
  if (heartBeatTimer) { clearInterval(heartBeatTimer); heartBeatTimer = null; }
};

onMounted(async () => {
  // 桌面端：提前初始化 Viewer，让瓦片在登录界面背后预加载
  if (!isMobile.value) {
    await nextTick();
    initViewer('cesiumContainer');
  }

  if (savedToken) {
    await verifyAuth();
    if (!mapState.auth.isLoggedIn) {
      // 验证失败（被踢下线或过期），回退到登录界面（Viewer 已在后台运行）
      authenticated.value = false;
      return;
    }
    await onAuthenticated();
  }
});

const onAuthenticated = async () => {
  authenticated.value = true;
  startHeartbeat();
  await nextTick();
  // 桌面端 Viewer 已在 onMounted 中创建，移动端在此创建
  if (isMobile.value) {
    initViewer('cesiumContainer');
  }
  if (isMobile.value) {
    const viewer = getViewer();
    if (viewer) {
      viewer.scene.screenSpaceCameraController.enableRotate = false;
      viewer.scene.screenSpaceCameraController.enableTilt = false;
      viewer.scene.screenSpaceCameraController.enableTranslate = true;
      viewer.scene.screenSpaceCameraController.enableZoom = true;
      viewer.scene.screenSpaceCameraController.zoomFactor = 12.0; // 双指缩放更跟手（默认5.0）
    }
  }
  mapState.system.isViewerReady = true;
  await loadLayerConfig();
  await initAllLayers();
  // 移动端：直接缩放到所有可见图层，一步到位切 2D 顶视图
  if (isMobile.value) {
    zoomToVisibleLayers({ to2D: true });
  }
};

onUnmounted(() => {
  stopHeartbeat();
  destroyViewer();
});
</script>

<style scoped>
html, body, #app { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
#cesiumContainer { position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; margin: 0; z-index: 0; }
.ui-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
:deep(.cesium-infoBox) { background: rgba(15, 23, 42, 0.95); border: 1px solid #38bdf8; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
:deep(.cesium-infoBox-title) { background: #0f172a; }
</style>
