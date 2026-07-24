<template>
  <div class="hud-wrapper" :class="{ 'is-folded': !isExpanded }">
    
    <div class="hud-handler" @click="isExpanded = !isExpanded" :title="isExpanded ? 'SYSTEM OFFLINE' : 'SYSTEM ONLINE'">
      <div class="handler-decor left"></div>
      <div class="handler-core">
        <span class="handler-text">{{ isExpanded ? '▼ 收起遥测中控' : '▲ 展开遥测中控' }}</span>
      </div>
      <div class="handler-decor right"></div>
    </div>

    <div class="hud-body">
      <div class="hud-glow-bg"></div> <div class="hud-content">
        <div class="hud-section telemetry-screen">
          <div class="data-block">
            <span class="label">经度</span>
            <span class="value">{{ telemetry.lon.toFixed(5) }}°</span>
          </div>
          <div class="data-block">
            <span class="label">纬度</span>
            <span class="value">{{ telemetry.lat.toFixed(5) }}°</span>
          </div>
          <div class="data-block alt-block">
            <span class="label">海拔</span>
            <span class="value highlight">{{ telemetry.alt.toFixed(0) }} <span class="unit">m</span></span>
          </div>
        </div>

        <div class="hud-section center-console">
          <button class="hud-btn" @click="toggle2D3D">
            <div class="btn-hex">
              <span class="icon">{{ is2D ? '3D' : '2D' }}</span>
            </div>
            <span class="text">视角</span>
          </button>
          
          <div class="scale-module">
            <div class="scale-text">{{ telemetry.scaleDistance }}</div>
            <div class="scale-ruler">
              <div class="tick left"></div>
              <div class="tick center"></div>
              <div class="tick right"></div>
            </div>
          </div>

          <button class="hud-btn" @click="zoomToHome">
            <div class="btn-hex">
              <span class="icon">⌖</span>
            </div>
            <span class="text">归位</span>
          </button>

          <button class="hud-btn gps-toggle" :class="{ active: gpsActive }" @click="handleGPSClick" @dblclick="handleGPSDblClick">
            <div class="btn-hex">
              <span class="icon">📍</span>
            </div>
            <span class="text">{{ gpsActive ? '定位中' : '定位' }}</span>
          </button>
        </div>

        <div class="hud-section compass-module" @click="resetHeading">
          <div class="compass-3d-scene">
            <div 
              class="compass-disc" 
              :style="{ transform: `rotateX(${telemetry.pitch}deg) rotateZ(${telemetry.heading}deg)` }"
            >
              <div class="mark north">N</div>
              <div class="mark south">S</div>
              <div class="mark east">E</div>
              <div class="mark west">W</div>
              <div class="crosshair-x"></div>
              <div class="crosshair-y"></div>
            </div>
          </div>
          <div class="compass-label">方位</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import * as Cesium from 'cesium';
import { getViewer } from '../../core/viewer/ViewerSetup';
import { mapState } from '../../store/mapState';
import { zoomToVisibleLayers } from '../../core/layers/LayerManager';
import { startTracking, stopTracking, isTracking, flyToUser } from '../../core/GeolocationTracker';

const isExpanded = ref(true);

const telemetry = reactive({
  lon: 0,
  lat: 0,
  alt: 0,
  heading: 0,
  pitch: 0,
  scaleDistance: '---'
});

const is2D = ref(false);
const gpsActive = ref(false);
let renderListener = null;

// 切换 2D 顶视图与 3D 倾斜视图 (以屏幕中心为锚点)
const toggle2D3D = () => {
  const viewer = getViewer();
  if (!viewer) return;

  // 1. 获取屏幕正中心的像素坐标
  const canvas = viewer.canvas;
  const centerPixel = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);

  // 2. 射线拾取：尝试获取屏幕中心对应的 3D 模型坐标或地球表面坐标
  let centerPosition = viewer.scene.pickPosition(centerPixel);
  if (!centerPosition) {
    centerPosition = viewer.camera.pickEllipsoid(centerPixel, viewer.scene.globe.ellipsoid);
  }

  // 如果实在没点到东西（比如看着外太空），就降级为原地低头
  if (!centerPosition) {
    viewer.camera.flyTo({
      destination: viewer.camera.position,
      orientation: {
        heading: viewer.camera.heading,
        pitch: Cesium.Math.toRadians(is2D.value ? -60 : -90),
        roll: 0
      },
      duration: 0.8
    });
    is2D.value = !is2D.value;
    return;
  }

  // 计算相机当前距离目标点的真实距离
  const distance = Cesium.Cartesian3.distance(viewer.camera.position, centerPosition);

  if (is2D.value) {
    // 【切回 3D】：以屏幕中心点为圆心，保持距离，将俯仰角拉回 60°
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(centerPosition, 0),
      {
        offset: new Cesium.HeadingPitchRange(viewer.camera.heading, Cesium.Math.toRadians(-60), distance),
        duration: 0.8
      }
    );
  } else {
    // 【切换 2D】：将相机移动到目标点正上方，保持原有距离和朝向，严格垂直俯视
    const cartographic = Cesium.Cartographic.fromCartesian(centerPosition);
    cartographic.height += distance; // 抬高相机
    const topDownPosition = Cesium.Cartographic.toCartesian(cartographic);

    viewer.camera.flyTo({
      destination: topDownPosition,
      orientation: {
        heading: viewer.camera.heading, 
        pitch: Cesium.Math.toRadians(-90), // -90度就是完美顶视图
        roll: 0
      },
      duration: 0.8
    });
  }

  is2D.value = !is2D.value;
};

// 飞回 归位 
const zoomToHome = () => {
  // 必须确保先从 LayerManager 引入了 zoomToVisibleLayers
  zoomToVisibleLayers(); 
  is2D.value = false; // 回家后默认恢复 3D 状态
};

let _clickTimer = null;
const handleGPSClick = () => {
  if (_clickTimer) {
    // Double click = stop
    clearTimeout(_clickTimer);
    _clickTimer = null;
    stopTracking();
    gpsActive.value = false;
  } else {
    _clickTimer = setTimeout(() => {
      _clickTimer = null;
      if (!isTracking()) {
        startTracking(() => { setTimeout(() => flyToUser(), 200); });
        gpsActive.value = true;
      } else {
        flyToUser();
      }
    }, 250);
  }
};
const handleGPSDblClick = () => {}; // handled by click timer

const resetHeading = () => {
  const viewer = getViewer();
  if (!viewer) return;
  viewer.camera.flyTo({
    destination: viewer.camera.position,
    orientation: { heading: 0, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
    duration: 0.5
  });
};

onMounted(() => {
  const viewer = getViewer();
  if (!viewer) return;

  renderListener = viewer.scene.preRender.addEventListener(() => {
    const camera = viewer.camera;
    const position = camera.positionCartographic;
    
    if (position && position.longitude !== undefined) {
      telemetry.lon = Cesium.Math.toDegrees(position.longitude);
      telemetry.lat = Cesium.Math.toDegrees(position.latitude);
      telemetry.alt = position.height || 0;
    }

    if (camera.heading !== undefined && camera.pitch !== undefined) {
      telemetry.heading = -Cesium.Math.toDegrees(camera.heading);
      telemetry.pitch = Cesium.Math.toDegrees(camera.pitch) + 90; 
    }

    const canvas = viewer.scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    const leftPx = new Cesium.Cartesian2((width / 2) - 50, height - 20);
    const rightPx = new Cesium.Cartesian2((width / 2) + 50, height - 20);
    
    const leftPos = camera.pickEllipsoid(leftPx, viewer.scene.globe.ellipsoid);
    const rightPos = camera.pickEllipsoid(rightPx, viewer.scene.globe.ellipsoid);

    if (leftPos && rightPos) {
      const dist = Cesium.Cartesian3.distance(leftPos, rightPos);
      if (dist > 1000) {
        telemetry.scaleDistance = (dist / 1000).toFixed(1) + ' km';
      } else {
        telemetry.scaleDistance = Math.round(dist) + ' m';
      }
    } else {
      const estDist = (position.height || 1000) * 0.2;
      telemetry.scaleDistance = estDist > 1000 ? (estDist / 1000).toFixed(1) + ' km' : Math.round(estDist) + ' m';
    }
  });
});

onUnmounted(() => {
  const viewer = getViewer();
  if (viewer && renderListener) viewer.scene.preRender.removeEventListener(renderListener);
});
</script>


<style scoped>
/* 包装器：精准控制隐藏 */
.hud-wrapper {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.hud-wrapper.is-folded {
  transform: translate(-50%, calc(100% - 24px));
}

/* 顶部机械拉手 */
.hud-handler {
  pointer-events: auto;
  height: 24px;
  display: flex;
  align-items: flex-end;
  cursor: pointer;
  filter: drop-shadow(0 -2px 5px rgba(56, 189, 248, 0.3));
}
.hud-handler:hover .handler-core { background: rgba(56, 189, 248, 0.4); }
.handler-decor { width: 30px; height: 100%; background: rgba(10, 15, 25, 0.85); backdrop-filter: blur(10px); border-top: 1px solid var(--color-accent);}
.handler-decor.left { clip-path: polygon(0 100%, 100% 100%, 100% 0, 40% 0); margin-right: -1px; }
.handler-decor.right { clip-path: polygon(0 100%, 100% 100%, 60% 0, 0 0); margin-left: -1px; }
.handler-core {
  width: 120px; height: 100%;
  background: rgba(10, 15, 25, 0.85); backdrop-filter: blur(10px);
  border-top: 2px solid var(--color-accent);
  display: flex; justify-content: center; align-items: center;
  transition: background 0.2s;
}
/* 👇 1. 顶部拉手文字：字号从 10px 放大到 13px，加发光 */
.handler-text { color: var(--color-accent); font-size: 13px; font-weight: 700; font-family: var(--font-body); text-shadow: 0 1px 2px rgba(0,0,0,0.8); }

/* 跑车主体：梯形切割与发光底座 */
.hud-body {
  position: relative;
  pointer-events: auto;
  width: 900px; max-width: 95vw;
  padding-top: 2px;
}
.hud-glow-bg {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.1) 0%, rgba(0, 0, 0, 0.6) 100%);
  clip-path: polygon(5% 0, 95% 0, 100% 100%, 0 100%);
  backdrop-filter: blur(20px);
  border-top: 1px solid rgba(56, 189, 248, 0.5);
  box-shadow: inset 0 5px 20px rgba(56, 189, 248, 0.2);
}

.hud-content {
  position: relative;
  display: flex; justify-content: space-between; align-items: stretch;
  padding: 15px 50px 20px 50px;
  color: var(--color-accent);
  font-family: var(--font-body);
}

.hud-section { flex: 1; display: flex; align-items: center; }

/* 左侧：遥测终端 */
.telemetry-screen { flex-direction: column; align-items: flex-start; gap: 8px; }
.data-block { 
  display: flex; 
  justify-content: space-between; 
  align-items: baseline; /* 让标签和数值的底部对齐，更美观 */
  width: 190px; /* 👈 从原本的 160px 放大到 240px，给大字体留足空间 */
  background: rgba(0,0,0,0.3); 
  padding: 6px 16px; /* 👈 增加左右的内边距，让文字不要紧贴边缘 */
  border-left: 3px solid var(--color-accent); 
  transform: skewX(-10deg); 
}
.data-block > * { transform: skewX(10deg); }
.label { color: var(--text-secondary); font-size: 13px; font-weight: 700; font-family: var(--font-body); text-shadow: 0 1px 4px rgba(0,0,0,0.9); }
.value { color: var(--text-primary); font-size: 18px; font-weight: 900; font-family: var(--font-data); text-shadow: 0 2px 4px rgba(0,0,0,1); }
.alt-block { border-left-color: #f59e0b; }
.alt-block .value.highlight { color: #fbbf24; font-size: 20px; font-weight: 900; text-shadow: 0 0 10px rgba(245, 158, 11, 0.9), 0 2px 4px rgba(0,0,0,1); }

/* 中间：控制与动态比例尺 */
.center-console { justify-content: center; gap: 40px; }
.hud-btn {
  background: transparent; border: none; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  transition: all 0.2s; outline: none;
}
.hud-btn:hover { transform: translateY(-3px); }
.btn-hex {
  width: 44px; height: 44px;
  background: rgba(56, 189, 248, 0.1);
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  border: 1px solid var(--color-accent);
  display: flex; justify-content: center; align-items: center;
  box-shadow: inset 0 0 10px rgba(56, 189, 248, 0.3);
  transition: all 0.2s;
}
.hud-btn:hover .btn-hex { background: rgba(56, 189, 248, 0.3); box-shadow: inset 0 0 20px var(--color-accent), 0 0 15px var(--color-accent); }
.btn-hex .icon { font-size: 14px; font-weight: 900; color: var(--text-primary); }
.hud-btn .text { font-size: 13px; color: var(--text-secondary); font-weight: 700; font-family: var(--font-body); margin-top: 4px; }

/* 动态比例尺 */
.scale-module { display: flex; flex-direction: column; align-items: center; width: 100px; }
.scale-text { font-size: 14px; color: var(--text-primary); font-weight: bold; letter-spacing: 1px; margin-bottom: 2px;}
.scale-ruler { width: 100%; height: 8px; border-bottom: 2px solid rgba(56, 189, 248, 0.8); display: flex; justify-content: space-between; align-items: flex-end;}
.tick { width: 2px; background: rgba(56, 189, 248, 0.8); }
.tick.left, .tick.right { height: 8px; }
.tick.center { height: 4px; }

/* 右侧：3D 方位罗盘 */
.compass-module { flex-direction: column; justify-content: center; align-items: center; cursor: pointer; }
.compass-3d-scene {
  width: 70px; height: 70px;
  perspective: 300px;
  display: flex; justify-content: center; align-items: center;
  background: radial-gradient(circle, rgba(0,240,255,0.1) 0%, transparent 70%);
}
.compass-disc {
  width: 50px; height: 50px;
  border-radius: 50%;
  border: 2px solid rgba(56, 189, 248, 0.5);
  position: relative;
  transform-style: preserve-3d;
  box-shadow: inset 0 0 15px rgba(56, 189, 248, 0.3);
}
.compass-disc::before { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 1px dashed rgba(56, 189, 248, 0.3); }
.mark { position: absolute; font-size: 14px; font-weight: 900; color: var(--text-primary); transform: translate(-50%, -50%); }
.mark.north { top: 2px; left: 50%; color: #ef4444; text-shadow: 0 0 10px #ef4444; font-size: 16px;}
.mark.south { top: 46px; left: 50%; }
.mark.east { top: 50%; right: -6px; }
.mark.west { top: 50%; left: 4px; }
.crosshair-x { position: absolute; top: 50%; left: 10%; right: 10%; height: 1px; background: rgba(56, 189, 248, 0.3); transform: translateY(-50%); }
.crosshair-y { position: absolute; left: 50%; top: 10%; bottom: 10%; width: 1px; background: rgba(56, 189, 248, 0.3); transform: translateX(-50%); }

.compass-label { font-size: 12px; color: var(--text-secondary); font-weight: 700; font-family: var(--font-body); margin-top: 8px; }
.gps-toggle .btn-hex { border-color: var(--text-secondary); }
.gps-toggle .icon { color: var(--text-secondary); }
.gps-toggle .text { color: var(--text-secondary); }
.gps-toggle.active .btn-hex { border-color: #38bdf8; box-shadow: 0 0 12px rgba(56,189,248,0.6); }
.gps-toggle.active .icon { color: #38bdf8; }
.gps-toggle.active .text { color: #38bdf8; }
</style>