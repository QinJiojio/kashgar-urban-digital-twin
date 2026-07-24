// GPS 定位引擎：watchPosition → Cesium 蓝色脉冲点 + 精度圈
import * as Cesium from 'cesium';
import { getViewer } from './viewer/ViewerSetup';
import { mapState } from '../store/mapState';

const entityId = '__gps_user_dot__';
const accCircleId = '__gps_accuracy_circle__';
let watchId = null;
let userEntity = null;
let accEntity = null;
let _onFirstFix = null;
let _onError = null;
let _lastGpsPos = null; // 用于检测是否真正移动了（GPS航向阈值）
let _lastGpsHeadingTime = 0;
let _lastDisplayedAccuracy = -1; // 精度圈平滑：变化<30%不更新半径
let _orientationHandler = null;
let _compassDiag = '';

// 生成定位图标 Canvas：蓝色圆点 + 白色方向箭头
const generateHeadingArrow = () => {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  // 蓝色圆点
  ctx.fillStyle = '#1E90FF';
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 方向箭头（朝上 = 默认北向）
  ctx.fillStyle = '#1E90FF';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx + 5, cy - 4);
  ctx.lineTo(cx - 5, cy - 4);
  ctx.closePath();
  ctx.fill();
  return canvas;
};

export const isTracking = () => watchId !== null;

const getCurrentPos = () => {
  if (!mapState.geolocation.lat || !mapState.geolocation.lon) return null;
  return Cesium.Cartesian3.fromDegrees(mapState.geolocation.lon, mapState.geolocation.lat, 0);
};

const updateMapState = (pos) => {
  mapState.geolocation.lat = pos.coords.latitude;
  mapState.geolocation.lon = pos.coords.longitude;
  mapState.geolocation.accuracy = pos.coords.accuracy || 0;
  mapState.geolocation.heading = pos.coords.heading || null;
  mapState.geolocation.timestamp = pos.timestamp;
};

const upsertEntities = (viewer) => {
  const cartesian = getCurrentPos();
  if (!cartesian) return;

  if (!userEntity) {
    userEntity = viewer.entities.getById(entityId);
  }
  if (!userEntity) {
    userEntity = viewer.entities.add({
      id: entityId,
      position: cartesian,
      billboard: {
        image: generateHeadingArrow(),
        scale: 0.9,
        rotation: 0,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  } else {
    userEntity.position = cartesian;
  }

  const acc = mapState.geolocation.accuracy;
  if (acc > 0) {
    if (!accEntity) {
      accEntity = viewer.entities.getById(accCircleId);
    }
    if (!accEntity) {
      accEntity = viewer.entities.add({
        id: accCircleId,
        position: cartesian,
        ellipse: {
          semiMajorAxis: acc,
          semiMinorAxis: acc,
          height: 0,
          material: Cesium.Color.DODGERBLUE.withAlpha(0.15),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    } else {
      accEntity.position = cartesian;
      const ratio = _lastDisplayedAccuracy > 0 ? Math.abs(acc - _lastDisplayedAccuracy) / _lastDisplayedAccuracy : 1;
      if (ratio > 0.3) {
        accEntity.ellipse.semiMajorAxis = acc;
        accEntity.ellipse.semiMinorAxis = acc;
        _lastDisplayedAccuracy = acc;
      }
    }
  } else if (accEntity) {
    viewer.entities.remove(accEntity);
    accEntity = null;
  }
};

const onPosition = (pos) => {
  updateMapState(pos);
  if (_onFirstFix) { _onFirstFix(); _onFirstFix = null; import('../store/mapState.js').then(m => m.hideToast()); }
  const viewer = getViewer();
  if (viewer && userEntity && userEntity.billboard) {
    // GPS heading: 仅在移动超过 5 米 + 速度 > 1 m/s 时使用
    const h = pos.coords.heading;
    const speed = pos.coords.speed || 0;
    const curPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    let moved = false;
    if (_lastGpsPos) {
      const dlat = curPos.lat - _lastGpsPos.lat;
      const dlon = curPos.lon - _lastGpsPos.lon;
      const dist = Math.sqrt(dlat * dlat + dlon * dlon) * 111000; // 近似米
      moved = dist > 5;
    }
    _lastGpsPos = curPos;
    if (h != null && moved && speed > 1) {
      userEntity.billboard.rotation = Cesium.Math.toRadians(360 - h);
      _lastGpsHeadingTime = Date.now();
      viewer.scene.requestRender();
    }
  }
  if (viewer && !viewer.isDestroyed()) {
    upsertEntities(viewer);
    viewer.scene.requestRender();
  } else {
    // viewer 尚未就绪，轮询等待
    let retries = 0;
    const retry = setInterval(() => {
      const v = getViewer();
      if (v && !v.isDestroyed() && mapState.system.isViewerReady) {
        upsertEntities(v);
        v.scene.requestRender();
        clearInterval(retry);
      } else if (++retries > 60) {
        clearInterval(retry);
      }
    }, 500);
  }
};

const onError = (err) => {
  console.warn('[GPS] 定位失败:', err.message);
  mapState.geolocation.error = err.message;
  if (_onError) { _onError(err); _onError = null; }
  import('../store/mapState.js').then(m => {
    m.showToast('定位失败: ' + (err.message || '请检查定位权限和HTTPS'), 'error', 4000);
  });
};

// 手机罗盘朝向（静止时也能获取）
let _compassHeading = null;

const startCompassListener = () => {
  _compassDiag = 'API:' + (typeof DeviceOrientationEvent) + ' abs:' + ('ondeviceorientationabsolute' in window) + ' req:' + (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') + ' https:' + (location.protocol === 'https:');
  // 尝试主动请求权限 (新版 Chromium Edge 需要)
  if (typeof DeviceOrientationEvent !== 'undefined') {
    DeviceOrientationEvent.requestPermission?.().then(r => { _compassDiag += ' perm:' + r; }).catch(e => { _compassDiag += ' err:' + e.message; });
  }
  let _lastCompassUpdate = 0;
  const hasAbsoluteCompass = 'ondeviceorientationabsolute' in window;
  const handler = (event) => {
    const now = Date.now();
    if (now - _lastCompassUpdate < 500) return;
    _lastCompassUpdate = now;
    // GPS 航向在移动中更准确，2 秒内刚更新过则跳过罗盘
    if (_lastGpsHeadingTime && now - _lastGpsHeadingTime < 2000) return;
    let h = event.webkitCompassHeading || event.compassHeading;
    if (h != null) {
      _compassHeading = h;
      if (userEntity && userEntity.billboard) {
        userEntity.billboard.rotation = Cesium.Math.toRadians(h);
        getViewer()?.scene?.requestRender();
      }
    } else if (event.alpha != null) {
      // Android: alpha is heading relative to the device's initial orientation
      // Convert: 0=North, clockwise
      const alpha = event.alpha;
      if (alpha != null && !isNaN(alpha)) {
        _compassHeading = alpha;
        if (userEntity && userEntity.billboard) {
          userEntity.billboard.rotation = Cesium.Math.toRadians(alpha);
          getViewer()?.scene?.requestRender();
        }
      }
    }
  };
  if (hasAbsoluteCompass) {
    window.addEventListener('deviceorientationabsolute', handler);
  }
  window.addEventListener('deviceorientation', handler);
  _orientationHandler = handler;
};

export const startTracking = (onFirstFix, onErrorCb) => {
  if (watchId) return;
  if (!navigator.geolocation) {
    mapState.geolocation.error = "浏览器不支持地理定位";
    return;
  }
  _onFirstFix = onFirstFix || null;
  _onError = onErrorCb || null;
  mapState.geolocation.enabled = true;
  mapState.geolocation.error = null;

  const opts = { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 };

  startCompassListener();

  watchId = navigator.geolocation.watchPosition(onPosition, onError, opts);
};

export const stopTracking = () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  mapState.geolocation.enabled = false;
  mapState.geolocation.followMode = false;
  mapState.geolocation.lat = null;
  mapState.geolocation.lon = null;
  _onFirstFix = null;
  _lastGpsPos = null;
  _lastGpsHeadingTime = 0;
  _lastDisplayedAccuracy = -1;
  if (_orientationHandler) {
    window.removeEventListener('deviceorientationabsolute', _orientationHandler);
    window.removeEventListener('deviceorientation', _orientationHandler);
    _orientationHandler = null;
  }
  const viewer = getViewer();
  if (viewer && !viewer.isDestroyed()) {
    if (userEntity) { viewer.entities.remove(userEntity); userEntity = null; }
    if (accEntity) { viewer.entities.remove(accEntity); accEntity = null; }
    viewer.scene.requestRender();
  }
};

export const flyToUser = () => {
  const cartesian = getCurrentPos();
  if (!cartesian) {
    if (mapState.geolocation.enabled) {
      import('../store/mapState.js').then(m => m.showToast(mapState.geolocation.error || 'GPS 定位中，请稍候...', 'info', 2500));
    }
    return;
  }
  const viewer = getViewer();
  if (!viewer || viewer.isDestroyed()) return;
  // 保持当前距离和视角，仅平移画面使 GPS 位置居中
  const dist = Cesium.Cartesian3.distance(viewer.camera.position, cartesian);
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(cartesian, 0),
    {
      offset: new Cesium.HeadingPitchRange(viewer.camera.heading, viewer.camera.pitch, Math.max(dist, 100)),
      duration: 0.8
    }
  );
};

