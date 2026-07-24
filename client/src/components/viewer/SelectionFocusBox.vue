<template>
  <div 
    class="selection-focus-wrapper" 
    v-show="isVisible && mapState.ui.currentView === 'map'"
    :style="boxStyle"
  >
    <div class="corner top-left"></div>
    <div class="corner top-right"></div>
    <div class="corner bottom-left"></div>
    <div class="corner bottom-right"></div>
    
    <div class="target-dot"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { 
  BoundingSphere, 
  BoundingSphereState, 
  Cartesian3, 
  Cartesian2 
} from 'cesium';
import { mapState, getLayerState } from '../../store/mapState';
import { getViewer } from '../../core/viewer/ViewerSetup';
import { getLayer } from '../../core/layers/LayerManager';

const screenPos = ref({ x: 0, y: 0, size: 0 });
const isVisible = ref(false);

const boxStyle = computed(() => ({
  left: `${screenPos.value.x}px`,
  top: `${screenPos.value.y}px`,
  width: `${screenPos.value.size}px`,
  height: `${screenPos.value.size}px`,
}));

let removeListener = null;

const updateFocusBox = () => {
  const viewer = getViewer();
  const id = mapState.interaction.selectedFeatureId;
  
  // 基础状态检查
  if (!viewer || !id || mapState.ui.currentView !== 'map') {
    if (isVisible.value) isVisible.value = false;
    return;
  }

  // 获取实体：先限定到选中要素所属图层，避免跨图层 OBJECTID 碰撞（教训 #13）
  const layerId = mapState.interaction.selectedLayerId;
  let entity = null;
  if (layerId) {
    const ds = getLayer(layerId);
    if (ds?.entities) entity = ds.entities.getById(id);
  }
  if (!entity) { // fallback：根容器或跨图层兜底
    entity = viewer.entities.getById(id);
    if (!entity) {
      for (let i = 0; i < viewer.dataSources.length; i++) {
        entity = viewer.dataSources.get(i).entities.getById(id);
        if (entity) break;
      }
    }
  }

  if (!entity) return;

  // 🌟 核心护甲：加入 try...catch 拦截底层未就绪异常
  try {
    const boundingSphere = new BoundingSphere();
    const state = viewer.dataSourceDisplay.getBoundingSphere(entity, true, boundingSphere);
    
    // 🛡️ 防御 1：如果是 PENDING (正在异步计算中)，直接 return 等待下一帧，绝不强求！
    if (state === BoundingSphereState.PENDING) {
      return; 
    }
    
    // 🛡️ 防御 2：只有在计算完毕 (DONE) 的情况下，才去更新外框
    if (state === BoundingSphereState.DONE) {
      const scene = viewer.scene;
      const center = boundingSphere.center;
      
      const canvasPos = scene.cartesianToCanvasCoordinates(center);
      
      if (canvasPos) {
        const radius = boundingSphere.radius > 0 ? boundingSphere.radius : 100;
        const offsetPoint = Cartesian3.add(
          center, 
          new Cartesian3(radius, 0, 0), 
          new Cartesian3()
        );
        
        const offsetCanvasPos = scene.cartesianToCanvasCoordinates(offsetPoint);
        
        let pixelRadius = 50;
        if (offsetCanvasPos) {
          pixelRadius = Cartesian2.distance(canvasPos, offsetCanvasPos);
        }

        const finalSize = Math.max(80, Math.min(pixelRadius * 2.5, 400));

        screenPos.value = {
          x: canvasPos.x - finalSize / 2,
          y: canvasPos.y - finalSize / 2,
          size: finalSize
        };
        
        if (!isVisible.value) isVisible.value = true;
      } else {
        isVisible.value = false;
      }
    } else {
      // 状态为 FAILED 或其他异常时，隐藏聚焦框
      isVisible.value = false;
    }
  } catch (error) {
    // 🛡️ 防御 3：拦截 updaters undefined 等底层报错
    // 默默吞掉报错，等待下一帧几何体建好后再画框，绝不让地球渲染循环崩溃！
    isVisible.value = false;
    return;
  }
};

onMounted(() => {
  // 轮询检查 Viewer 是否就绪
  const checkTimer = setInterval(() => {
    const viewer = getViewer();
    if (viewer && viewer.scene) {
      clearInterval(checkTimer);
      // 监听渲染帧，实现平滑同步
      removeListener = viewer.scene.postRender.addEventListener(updateFocusBox);
    }
  }, 500);
});

onUnmounted(() => {
  if (removeListener) removeListener();
});
</script>

<style scoped>
.selection-focus-wrapper {
  position: fixed; /* 使用 fixed 定位，防止被复杂的父容器 relative 干扰 */
  pointer-events: none; /* 必须穿透，否则会挡住地图点击 */
  z-index: 9999;
  animation: box-breathe 2s infinite ease-in-out;
  transition: opacity 0.3s;
}

.corner {
  position: absolute;
  width: 30px;
  height: 30px;
  border: 3px solid #db0180; /* 科技蓝 */
  filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.8));
}

/* L 形四角定位 */
.top-left { top: 0; left: 0; border-right: none; border-bottom: none; }
.top-right { top: 0; right: 0; border-left: none; border-bottom: none; }
.bottom-left { bottom: 0; left: 0; border-right: none; border-top: none; }
.bottom-right { bottom: 0; right: 0; border-left: none; border-top: none; }

.target-dot {
  position: absolute;
  top: 50%; left: 50%;
  width: 4px; height: 4px;
  background: #38bdf8;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 10px #38bdf8;
}

@keyframes box-breathe {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.1); opacity: 1; }
}
</style>