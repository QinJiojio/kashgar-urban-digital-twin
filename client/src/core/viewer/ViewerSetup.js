import * as Cesium from 'cesium';
import { mapState } from '../../store/mapState';
import { isDrawEngineActive } from './DrawEngine';

// 在模块顶层声明变量，绝对不进入 Vue 响应式
let viewer = null; 
let currentBaseMapLayer = null; 

// 🌟 状态追踪：用于高亮还原
let lastSelectedEntity = null;

const TIANDITU_TK = import.meta.env.VITE_TIANDITU_TK;

// 常用底图字典
const baseMapConfigs = {
  'google-satellite': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/google/s/{z}/{x}/{y}',
    maximumLevel: 20
  }),
  'google-hybrid': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/google/y/{z}/{x}/{y}',
    maximumLevel: 20
  }),
  'google-tianditu': () => [
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/google/s/{z}/{x}/{y}',
      maximumLevel: 20
    }),
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/tianditu/cia_w/{z}/{x}/{y}',
      maximumLevel: 18
    })
  ],
  'tianditu-satellite': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/tianditu/img_w/{z}/{x}/{y}',
    maximumLevel: 18
  }),
  'tianditu-hybrid': () => [
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/tianditu/img_w/{z}/{x}/{y}',
      maximumLevel: 18
    }),
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/tianditu/cia_w/{z}/{x}/{y}',
      maximumLevel: 18
    })
  ],
  'tianditu-vector': () => [
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/tianditu/vec_w/{z}/{x}/{y}',
      maximumLevel: 18
    }),
    new Cesium.UrlTemplateImageryProvider({
      url: '/tiles/tianditu/cva_w/{z}/{x}/{y}',
      maximumLevel: 17
    })
  ],
  'arcgis-satellite': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/arcgis/satellite/{z}/{x}/{y}',
    maximumLevel: 18
  }),
  'arcgis-street': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/arcgis/street/{z}/{x}/{y}',
    maximumLevel: 18
  }),
  'amap-satellite': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/amap/satellite/{z}/{x}/{y}',
    maximumLevel: 18
  }),
  'amap-vector': () => new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/amap/vector/{z}/{x}/{y}',
    maximumLevel: 18
  })
};

/**
 * 初始化 Cesium 地球引擎
 */
export const initViewer = (containerId) => {
  // 禁用 Cesium ion（本项目使用天地图底图，不需要 ion 服务）
  Cesium.Ion.defaultAccessToken = '';
  Cesium.RequestScheduler.maximumRequestsPerServer = 12;
  viewer = new Cesium.Viewer(containerId, {
    infoBox: false,
    selectionIndicator: false,
    navigationHelpButton: false,
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    // 不创建默认底图（避免 Cesium 自动请求 api.cesium.com 认证，浪费 2.5s）
    imageryProvider: false,
    // 性能优化：按需渲染，静止时降频到 0.5s/帧（保证加载期间流畅，又不浪费 GPU）
    requestRenderMode: true,
    maximumRenderTimeChange: 0.5
  });

  viewer.cesiumWidget.creditContainer.style.display = 'none';
  // 性能优化：限制内部分辨率上限，高端手机 DPR=3 降为 2，视觉无差别但 GPU 负载降 ~30%
  viewer.resolutionScale = Math.min(window.devicePixelRatio, 2); 

  viewer.scene.globe.depthTestAgainstTerrain = false; 
  viewer.scene.camera.frustum.near = 0.1; 
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 150; 
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

  viewer.imageryLayers.removeAll();
  switchBaseMap(mapState.system.baseMap || 'tianditu-hybrid');

  // C: 限制初始相机高度，避免首次加载时拉取全球范围瓦片
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(76.0, 39.5, 80000) });

  // ==========================================
  // 🌟 核心修改：鼠标左键拾取与高亮逻辑
  // ==========================================
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    // 绘制模式下不触发要素选中（放置顶点时下方可能有要素）
    if (mapState.editor.activeTool === 'draw') return;
    const allPicked = viewer.scene.drillPick(movement.position);
    const pickedObject = allPicked.find(p => p.id instanceof Cesium.Entity) || allPicked[0];

    // 1. 还原上一次选中的高亮（entity 可能已被删除，直接检查 _highlight 自身）
    if (lastSelectedEntity) {
      if (lastSelectedEntity._highlight) {
        if (!lastSelectedEntity._highlight.isDestroyed) {
          viewer.entities.remove(lastSelectedEntity._highlight);
        }
        lastSelectedEntity._highlight = null;
      }
      lastSelectedEntity = null;
    }

    if (Cesium.defined(pickedObject) && pickedObject.id instanceof Cesium.Entity) {
      const entity = pickedObject.id;
      
      // 2. 面要素高亮 (Polyline + disableDepthTest 避免遮挡)
      if (entity.polygon) {
        lastSelectedEntity = entity;
        // hierarchy 可能是 ConstantProperty 或原始 PolygonHierarchy（SpatialEditor 固化后）
        const hierarchy = entity.polygon.hierarchy?.getValue?.(Cesium.JulianDate.now()) ?? entity.polygon.hierarchy;
        if (hierarchy && hierarchy.positions && hierarchy.positions.length >= 3) {
          // 将高度烘焙到 Cartesian3 坐标中，避免 PolylineGraphics.height 对绝对坐标不生效
          // 注意：entity.polygon.height 是 Cesium Property 对象，需 getValue 取数字
          const h = entity.polygon.height?.getValue?.(Cesium.JulianDate.now()) ?? 0;
          const outlinePositions = hierarchy.positions.map(p => {
            const carto = Cesium.Cartographic.fromCartesian(p);
            carto.height = h;
            return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);
          });
          entity._highlight = viewer.entities.add({
            polyline: { positions: [...outlinePositions, outlinePositions[0]], width: 6, material: Cesium.Color.fromCssColorString('#38bdf8'), disableDepthTestDistance: Number.POSITIVE_INFINITY }
          });
        }
      }

      // 3. 提取属性并同步到状态树，同时确定所属图层
      // outline 实体（ThematicRenderer 创建的轮廓线）→ 重定向到父多边形
      const targetEntity = entity._outlineParent || entity;
      const props = {};
      if (targetEntity.properties) {
        targetEntity.properties.propertyNames.forEach(name => {
          const val = targetEntity.properties[name].getValue ? targetEntity.properties[name].getValue(Cesium.JulianDate.now()) : targetEntity.properties[name];
          props[name] = val;
        });

        // 解析所属图层：实体加载时已注入 _layerId，直接读取
        const layerId = targetEntity._layerId || null;

        // 新建要素：entity.id 可能是 temp_xxx（saveFeature 后仍不变），
        // 但 entity.properties.OBJECTID 已被服务端分配为正整数。以 OBJECTID 为准判断。
        const objIdVal = props.OBJECTID != null ? Number(props.OBJECTID) : 0;
        if (String(targetEntity.id).startsWith('temp_') && objIdVal <= 0) {
          // OBJECTID 仍未分配 → 保存未完成，禁止打开面板（防竞态数据丢失）
          mapState.interaction.selectedLayerId = layerId;
        } else {
          mapState.interaction.selectedLayerId = layerId;
          mapState.interaction.selectedFeatureId = targetEntity.id;
          mapState.interaction.selectedFeatureProps = props;
        }
      }
      // 确保焦点框 postRender + renderMode 下高亮立即显示
      viewer.scene.requestRender();
    } else {
      // 点击空白处，重置高亮与选中状态
      lastSelectedEntity = null;
      mapState.interaction.selectedFeatureProps = null;
      mapState.interaction.selectedFeatureId = null;
      mapState.interaction.selectedLayerId = null;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 普通模式双击空白缩放（绘制中同步跳过，函数引用规避循环依赖）
  handler.setInputAction((movement) => {
    if (isDrawEngineActive()) return;
    const picked = viewer.scene.pick(movement.position);
    // 3D Tiles 模型不响应交互——穿透到下层 GeoJSON entity 或直接缩放
    if (!Cesium.defined(picked) || !picked.id || !(picked.id instanceof Cesium.Entity)) zoomToPoint(viewer, movement.position);
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  mapState.system.isViewerReady = true;
};

/**
 * 切换全局底图
 */
export const switchBaseMap = (mapId) => {
  const v = getViewer();
  if (!v) return;

  v.imageryLayers.removeAll();
  const providerFactory = baseMapConfigs[mapId] || baseMapConfigs['google-satellite'];
  const providers = providerFactory();

  if (Array.isArray(providers)) {
    providers.forEach(p => v.imageryLayers.addImageryProvider(p));
  } else {
    v.imageryLayers.addImageryProvider(providers);
  }
};

export const getViewer = () => {
  if (!viewer) console.warn('Cesium Viewer 尚未初始化！');
  return viewer;
};

// 清除当前选中要素的高亮（外部调用——如删除要素时需主动清理）
export const clearSelectionHighlight = () => {
  if (!viewer || !lastSelectedEntity) return;
  if (lastSelectedEntity._highlight) {
    if (!lastSelectedEntity._highlight.isDestroyed) {
      viewer.entities.remove(lastSelectedEntity._highlight);
    }
    lastSelectedEntity._highlight = null;
  }
  lastSelectedEntity = null;
};

// 双击缩放：以屏幕坐标点为中心放大 2x，保持视角/方位
export const zoomToPoint = (viewer, screenPos) => {
  const ray = viewer.camera.getPickRay(screenPos);
  const center = viewer.scene.globe.pick(ray, viewer.scene);
  if (!Cesium.defined(center)) { viewer.camera.zoomIn(2.0); return; }
  const pt = Cesium.Cartographic.fromCartesian(center);
  const cam = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  // 平移到点击位置正上方 + 缩放到一半高度（2x），保持 heading/pitch/roll
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(pt.longitude, pt.latitude, pt.height + (cam.height - pt.height) * 0.5),
    orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
    duration: 0.5
  });
};

export const destroyViewer = () => {
  if (viewer) {
    viewer.destroy();
    viewer = null;
    currentBaseMapLayer = null;
    mapState.system.isViewerReady = false;
  }
};