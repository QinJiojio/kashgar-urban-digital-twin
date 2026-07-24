import * as Cesium from 'cesium';
import { getViewer } from '../viewer/ViewerSetup';
import { mapState, fieldSchema, getLayerState, saveLayerConfig, savePersonalVisibility, loadFieldFormat, loadFieldGroupsMeta, fieldGroupsMeta, showToast, hideToast, uk } from '../../store/mapState';
import { applySymbology } from '../symbology/ThematicRenderer';

// 🏦 图层金库
const layerVault = new Map();

// ==========================================
// 🎨 全局矢量图标注册中心 (Canvas 渲染——SVG data URI 在 Cesium billboard 上不可靠)
// ==========================================
const buildIcon = (pathData) => {
  const size = 64; // 高分辨率 canvas，缩放时清晰
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const path = new Path2D(pathData);
  // 将 SVG 24x24 viewBox 映射到 size x size
  ctx.save();
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = '#ffffff';
  ctx.fill(path);
  ctx.restore();
  return canvas;
};

export const IconRegistry = {
  'pin': buildIcon('M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z'),
  'flag': buildIcon('M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z'),
  'warning': buildIcon('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  'hospital': buildIcon('M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z'),
  'school': buildIcon('M12 3L1 9l11 6 9-4.91V17h2V9M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z'),
  'police': buildIcon('M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z'),
  'factory': buildIcon('M22 22H2V10l7-3v2l5-2v3h3l1-8h3v10zM12 6.73L6 9.3v8.7h12V10h-2.5l-3.5 1.5V6.73z'),
  'water': buildIcon('M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8zm0 18c-3.35 0-6-2.57-6-6.2 0-2.34 1.95-5.44 6-9.14 4.05 3.7 6 6.79 6 9.14 0 3.63-2.65 6.2-6 6.2z'),
  'power': buildIcon('M16.01 7L16 3h-2v4h-4V3H8v4h-.01C7 6.99 6 7.99 6 8.99v5.49L9.5 18v3h5v-3l3.5-3.51v-5.5c0-1-1-2-1.99-1.99z'),
  'park': buildIcon('M17 12h2L12 2 4.05 12h2l-3 5h5v5h4v-5h5l-3-5z'),
  'residential': buildIcon('M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z'),
  'shopping': buildIcon('M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z'),
  'airport': buildIcon('M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z'),
  'train': buildIcon('M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zm0 2c3.51 0 4.96.48 5.57 1H6.43c.61-.52 2.06-1 5.57-1zM6 15.5V12h12v3.5c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5zM12 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z')
};

// 仅加载 tree 中新增的图层，不重载已有图层。用于树结构变更（新建/删除/排序）。
export const syncTreeLayers = async () => {
  const viewer = getViewer();
  if (!viewer) return;
  const traverseNew = async (nodes, parentVisible = true) => {
    for (const cfg of nodes) {
      const ev = parentVisible && cfg.show;
      if (cfg.type === 'folder' && cfg.children) {
        await traverseNew(cfg.children, ev);
      } else if (cfg.type === 'geojson' && ev) {
        if (!layerVault.has(cfg.id)) await loadGeoJsonLayer(cfg, viewer);
      } else if (cfg.type === '3dtiles' && ev) {
        if (!layerVault.has(cfg.id)) {
          const feature = cfg.features?.[0] || { id: cfg.id + '_feature', name: cfg.name, url: cfg.url, show: true };
          await loadSingle3DTiles(cfg, feature, viewer);
        }
      }
    }
  };
  await traverseNew(mapState.layerTree);
  // 移除 viewer 中已不在 tree 里的 DataSource
  const treeIds = new Set();
  const collectIds = (nodes) => {
    for (const n of nodes) {
      if (n.type !== 'folder') treeIds.add(n.id);
      if (n.children) collectIds(n.children);
    }
  };
  collectIds(mapState.layerTree);
  for (const [id, ds] of layerVault) {
    if (!treeIds.has(id)) {
      viewer.dataSources.remove(ds, true);
      layerVault.delete(id);
    }
  }

  // 已加载图层的 features 可能因 loadLayerConfig 替换 tree 而丢失，从 DataSource 补回
  for (const [id, ds] of layerVault) {
    if (ds instanceof Cesium.GeoJsonDataSource) {
      const cfg = getLayerState(id);
      if (cfg && (!cfg.features || cfg.features.length === 0)) {
        const list = [];
        const time = Cesium.JulianDate.now();
        ds.entities.values.forEach(e => {
          const props = e.properties ? e.properties.getValue(time) : {};
          list.push({ id: e.id, name: e.name || '未命名', show: true, properties: props });
        });
        cfg.features = list;
      }
    }
  }
  applyLayerZOrder();
};

export const initAllLayers = async () => {
  const viewer = getViewer();
  if (!viewer) return;

  // 统计需要加载的图层数量
  let totalCount = 0;
  const countVisible = (nodes, parentVisible = true) => {
    for (const n of nodes) {
      if (n.type === 'folder' && n.children) {
        countVisible(n.children, parentVisible && n.show);
      } else if (n.show && parentVisible) {
        totalCount++;
      }
    }
  };
  countVisible(mapState.layerTree);

  if (totalCount === 0) {
    const isMobile = !!document.querySelector('.mobile-layout');
    showToast(isMobile ? '无显示图层，左上角选择工作图层面板可开启显示' : '无显示图层，请在图层管理器中至少开启一个图层', 'warning');
    return;
  }

  showToast(`正在加载图层 (0/${totalCount})，请稍等...`, 'info', 0);
  let loadedCount = 0;
  const updateProgress = () => {
    loadedCount++;
    showToast(`正在加载图层 (${loadedCount}/${totalCount})，请稍等...`, 'info', 0);
  };

  // A: 收集所有任务分组——GeoJSON 并行，3D Tiles 延迟
  const geojsonTasks = [];
  const tilesTasks = [];
  const collectTasks = (nodes, parentVisible = true) => {
    for (const layerConfig of nodes) {
      const effectiveVisible = parentVisible && layerConfig.show;
      if (layerConfig.type === 'folder' && layerConfig.children) {
        collectTasks(layerConfig.children, effectiveVisible);
      } else if (layerConfig.type === '3dtiles') {
        if (!layerConfig.features) {
          layerConfig.features = [{ id: layerConfig.id + '_feature', name: layerConfig.name, url: layerConfig.url, show: true, isLoaded: false, isLoading: false, pendingRequests: 0 }];
        }
        layerConfig.features.forEach(f => { if (!f.name && f.url) f.name = f.url.split('/').slice(-2)[0] || '未命名模型'; });
        if (effectiveVisible) {
          for (const feature of layerConfig.features) if (feature.show) {
            tilesTasks.push(loadSingle3DTiles(layerConfig, feature, viewer).then(updateProgress));
          }
        }
      } else if (layerConfig.type === 'geojson' && effectiveVisible) {
        geojsonTasks.push(loadGeoJsonLayer(layerConfig, viewer).then(updateProgress));
      }
    }
  };
  collectTasks(mapState.layerTree);

  // A: GeoJSON 全部并行加载
  if (geojsonTasks.length > 0) await Promise.all(geojsonTasks);
  // B: 3D Tiles 在 GeoJSON 之后异步加载，不阻塞页面交互
  if (tilesTasks.length > 0) Promise.all(tilesTasks).finally(hideToast);
  else hideToast();
  zoomToVisibleLayers();
  applyLayerZOrder();
  initAllLabels();
};

// Cesium 1.127+ tileset 缓存改为字节制（cacheBytes / maximumCacheOverflowBytes），
// 旧 maximumMemoryUsage 参数在 1.139 已被静默忽略（仅 TimeDynamicPointCloud 保留）。
// 3.1GB 倾斜摄影在默认 512MB 缓存下飞览会频繁换入换出，桌面端放宽到 1.5GB；
// 移动端/低内存设备保持保守，避免 GPU/JS 内存压力。
const _lowMemDevice = (typeof navigator !== 'undefined') && (
  /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '') ||
  (navigator.deviceMemory && navigator.deviceMemory <= 4)
);
const TILESET_CACHE_OPTS = _lowMemDevice
  ? { cacheBytes: 512 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024 }
  : { cacheBytes: 1536 * 1024 * 1024, maximumCacheOverflowBytes: 512 * 1024 * 1024 };

// tileset 加载状态监听：pendingRequests 计数 + 首次流式加载完成时 toast 通知（每个 tileset 只报一次）
const attachTilesetProgress = (tileset, layerConfig, featureConfig) => {
  let seenActivity = false, notifiedDone = false;
  tileset.loadProgress.addEventListener((pending, processing) => {
    featureConfig.pendingRequests = pending;
    featureConfig.isLoading = (pending !== 0 || processing !== 0);
    if (pending + processing > 0) seenActivity = true;
    else if (seenActivity && !notifiedDone) {
      notifiedDone = true;
      showToast(`模型「${layerConfig.name}」加载完成`, 'success', 2000);
    }
  });
};

const loadSingle3DTiles = async (layerConfig, featureConfig, viewer) => {
  if (!featureConfig.url) return;
  featureConfig.isLoading = true;
  try {
    const transform = (featureConfig.url?.includes('buildings/') || layerConfig.url?.includes('buildings/'))
      ? (featureConfig.transform || layerConfig.transform) : null;
    if (transform) {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(featureConfig.url, {
        maximumScreenSpaceError: mapState.system.currentQuality, ...TILESET_CACHE_OPTS
      });
      layerVault.set(featureConfig.id, tileset);
      tileset.show = featureConfig.show && layerConfig.show;
      viewer.scene.primitives.add(tileset);
      featureConfig.isLoaded = true;
      attachTilesetProgress(tileset, layerConfig, featureConfig);
      const t = transform;
      const center = Cesium.Cartesian3.fromDegrees(t.longitude, t.latitude, t.height || 0);
      const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(t.heading||0), Cesium.Math.toRadians(t.pitch||0), Cesium.Math.toRadians(t.roll||0));
      tileset.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(center, hpr);
      if (t.scale && t.scale !== 1.0) {
        tileset.modelMatrix = Cesium.Matrix4.multiply(tileset.modelMatrix, Cesium.Matrix4.fromUniformScale(t.scale), new Cesium.Matrix4());
      }
      tileset.style = new Cesium.Cesium3DTileStyle({ color: `color('white', ${layerConfig.opacity ?? 1.0})` });
      return;
    }

    const tileset = await Cesium.Cesium3DTileset.fromUrl(featureConfig.url, {
      maximumScreenSpaceError: mapState.system.currentQuality, ...TILESET_CACHE_OPTS,
      skipLevelOfDetail: true, baseScreenSpaceError: 1024, skipScreenSpaceErrorFactor: 16, skipLevels: 1, immediatelyLoadDesiredLevelOfDetail: false,
      loadSiblings: false, cullWithChildrenBounds: true,
      // 跳级加载时优先取最精细叶子 tile——主观变清晰更快
      preferLeaves: true,
      // 注视点渲染：视野中心全精度、边缘按锥角降精度，与 dynamicScreenSpaceError 正交叠加
      foveatedScreenSpaceError: true,
      dynamicScreenSpaceError: true, dynamicScreenSpaceErrorDensity: 0.00278, dynamicScreenSpaceErrorFactor: 4.0, dynamicScreenSpaceErrorHeightFalloff: 0.25
    });

    layerVault.set(featureConfig.id, tileset);
    tileset.show = featureConfig.show && layerConfig.show;
    viewer.scene.primitives.add(tileset);
    featureConfig.isLoaded = true;

    attachTilesetProgress(tileset, layerConfig, featureConfig);

    // 保存不受 modelMatrix 影响的原始中心点，供后续高度调整计算
    tileset._baseCenter = Cesium.Cartesian3.clone(tileset.boundingSphere.center);
    // 应用高度偏移到 modelMatrix——将包围球中心移至椭球面上方 offset 米处
    const hOffset = Number(layerConfig.heightOffset) || 0;
    const cartographic = Cesium.Cartographic.fromCartesian(tileset._baseCenter);
    const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, hOffset);
    const translation = Cesium.Cartesian3.subtract(surface, tileset._baseCenter, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);

    tileset.style = new Cesium.Cesium3DTileStyle({ color: `color('white', ${layerConfig.opacity ?? 1.0})` });
  } catch (error) {
    console.error(`模型加载失败:`, error);
    featureConfig.isLoading = false;
    showToast(`模型「${layerConfig.name}」加载失败，请检查数据文件或网络连接`, 'error', 4000);
  }
};

export const loadGeoJsonLayer = async (config, viewer) => {
  if (!config.url) return;
  if (!config.features) config.features = [];
  try {
    const url = config.url.includes('?') ? `${config.url}&_t=${Date.now()}` : `${config.url}?_t=${Date.now()}`;
    let dataSource;
    try {
      // 大数据图层分批加载，避免一次性创建数万 Entity 导致浏览器 OOM
      if (config.heightField) {
        const resp = await fetch(url);
        const geojson = await resp.json();
        const total = geojson.features?.length || 0;
        const BATCH = 5000;
        const batches = [];
        // 剥离空属性——null/undefined/''/'无' 不创建 ConstantProperty
        // 36% 的属性为空值，省 JS 对象 + 加载时间；0/false 保留（有意义数据）
        const isEmptyVal = (v) => v === null || v === undefined || v === '' || v === '无' || v === ' ';
        for (let i = 0; i < total; i += BATCH) {
          const chunk = geojson.features.slice(i, i + BATCH).map(f => {
            const clean = { type: 'Feature', geometry: f.geometry };
            const props = {};
            for (const [k, v] of Object.entries(f.properties || {})) {
              if (!isEmptyVal(v)) props[k] = v;
            }
            clean.properties = props;
            return clean;
          });
          batches.push({ type: 'FeatureCollection', features: chunk });
        }
        dataSource = new Cesium.GeoJsonDataSource(config.name || config.id);
        // 加载第一批 entity 并立即挤出——DataSource 尚未加入 viewer，
        // Cesium 创建几何体时 extrudedHeight 已就位，避免 flat→extruded 的二次重建
        await dataSource.load(batches[0], { strokeWidth: 2 });
        extrude(dataSource.entities.values, config.heightField);
        showToast(`加载 ${config.name} (1/${batches.length})...`, 'info', 0);
        for (let i = 1; i < batches.length; i++) {
          const prevCount = dataSource.entities.values.length;
          await new Promise(r => setTimeout(r, 100)); // GC 喘息
          await dataSource.process(batches[i], { strokeWidth: 2 });
          // 仅挤出本批新增的 entity
          const newEnts = Array.from(dataSource.entities.values).slice(prevCount);
          extrude(newEnts, config.heightField);
          showToast(`加载 ${config.name} (${i+1}/${batches.length})...`, 'info', 0);
        }
        hideToast();
      } else {
        dataSource = await Cesium.GeoJsonDataSource.load(url, { strokeWidth: 2 });
      }
    } catch (e) {
      // 文件不存在时创建空 DataSource，后续绘制会动态填充
      dataSource = new Cesium.GeoJsonDataSource(config.name || config.id);
      await dataSource.load({ type: 'FeatureCollection', features: [] }, { strokeWidth: 2 });
    }

    // 给每个 entity 标记所属图层 ID，点击时直接读取而无需搜索
    const entities = dataSource.entities.values;
    entities.forEach(e => { e._layerId = config.id; });

    // layerVault 先注册（applySymbology/getLayer 依赖它），但 DataSource 最后才加入 viewer——
    // 对齐架构文档§7 加载管线：所有 entity 属性（outline/材质/extrudedHeight）在入场景前定型，
    // Cesium 首次创建几何时即为最终状态，避免 24K entity flat/unstyled → styled 的二次几何重建
    layerVault.set(config.id, dataSource);
    dataSource.show = config.show;

    // 大图层相机距离裁剪：海拔 >5km 时隐藏整个挤出图层
    // 用 DataSource.show 而非 per-entity DistanceDisplayCondition——
    // GeoJsonDataSource 绝对坐标 entity 下 DistanceDisplayCondition 不可靠
    if (config.heightField) {
      const onCamChange = () => {
        if (viewer.isDestroyed()) return;
        const alt = viewer.camera.positionCartographic.height;
        const shouldShow = config.show && alt <= 5000;
        if (dataSource.show !== shouldShow) {
          dataSource.show = shouldShow;
          viewer.scene.requestRender();
        }
      };
      onCamChange(); // 初始检查
      viewer.camera.changed.addEventListener(onCamChange);
      config._camDistCull = onCamChange; // 存引用，供卸载时清理
    }

    const featureList = [];

    if (entities.length > 0) {
      const sampleProps = entities[0].properties;
      const propNames = sampleProps.propertyNames;
      const newSchema = {};
      propNames.forEach(name => {
        if (['OBJECTID', 'FID', 'Shape_Length', 'Shape_Area'].includes(name)) return;
        const sampleVal = sampleProps[name].getValue();
        if (typeof sampleVal === 'number') {
          newSchema[name] = { label: name, type: 'number' };
        } else {
          // 推断为 string 类型，不遍历全量 entity 收集 options（大图层性能灾难）
          // 字段选项由 loadFieldFormat 从持久化 schema 中读取
          newSchema[name] = { label: name, type: 'string' };
        }
      });
      fieldSchema[config.id] = newSchema;
    }

    // 始终加载服务端持久化的 schema（处理空图层——Excel 导入仅表头无数据行时 entities 为空但 schema 文件已写入）
    if (!fieldSchema[config.id]) fieldSchema[config.id] = {};
    try {
      const formats = await loadFieldFormat(config.id);
      for (const [key, fmt] of Object.entries(formats)) {
        if (fieldSchema[config.id][key]) {
          Object.assign(fieldSchema[config.id][key], fmt);
        } else {
          fieldSchema[config.id][key] = fmt;
        }
      }
      const gmeta = await loadFieldGroupsMeta(config.id);
      if (gmeta) fieldGroupsMeta[config.id] = gmeta; else delete fieldGroupsMeta[config.id];
    } catch (_) { /* ignore */ }

    entities.forEach(entity => {
      if (entity.polygon) {
        entity.polygon.outline = true;
        // 缓存 hierarchy positions——applySymbology 不再每次 getValue() 解析 Property
        const hier = entity.polygon.hierarchy?.getValue?.(Cesium.JulianDate.now())
          ?? entity.polygon.hierarchy;
        entity._hierarchyPositions = hier?.positions || [];
      }
      if (entity.polyline) {
        entity.basePositions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
      }
      if (entity.position) {
        entity.basePosition = entity.position.getValue(Cesium.JulianDate.now());
      }
      const rawProps = entity.properties ? entity.properties.getValue(Cesium.JulianDate.now()) : {};
      const entityName = rawProps['Name'] || rawProps['name'] || '未命名要素';
      entity.name = entityName;
      // 按需构建 InfoBox HTML——大图层(2.5万+)加载时一次性拼接 66字段×24K entity 的 table 字符串会消耗 ~50MB 内存
      // CallbackProperty 仅在用户点击要素弹出 InfoBox 时才执行，O(1) 而非 O(n)
      entity.description = new Cesium.CallbackProperty(() => {
        const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) ?? entity.properties ?? {};
        let html = '<table border="1" style="border-collapse:collapse; width:100%; color:white; font-size:12px;">';
        Object.keys(props).forEach(key => html += `<tr><td style="padding:4px; border:1px solid #475569;">${key}</td><td style="padding:4px; border:1px solid #475569;">${props[key]}</td></tr>`);
        html += '</table>';
        return html;
      }, false);
      featureList.push({ id: entity.id, name: entityName, show: true, properties: rawProps });
    });

    config.features = featureList;
    applySymbology(config.id);
    // 样式全部定型后 DataSource 才入场景——几何一次成型（H4 原理从挤出延伸到材质/outline）
    viewer.dataSources.add(dataSource);
    const { syncVersions } = await import('../locks.js');
    await syncVersions(config.id);
  } catch (error) { console.error(`GeoJSON 图层加载失败:`, error); }
};

export const refreshLayerVisibility = () => {
  const viewer = getViewer();
  if (!viewer) return;

  const syncRecursive = (nodes, parentEffectivelyVisible) => {
    nodes.forEach(node => {
      const effectivelyVisible = parentEffectivelyVisible && node.show;
      if (node.type === 'folder') {
        if (node.children) syncRecursive(node.children, effectivelyVisible);
      } else if (node.type === '3dtiles') {
        if (node.features) {
          node.features.forEach(feature => {
            const tileset = layerVault.get(feature.id);
            if (tileset) tileset.show = effectivelyVisible && feature.show;
          });
        }
      } else if (node.type === 'geojson') {
        const dataSource = layerVault.get(node.id);
        if (dataSource) dataSource.show = effectivelyVisible;
      }
    });
  };
  syncRecursive(mapState.layerTree, true);
  syncLabelVisibility();
  // requestRenderMode 开启后需手动触发渲染，否则 visibility 变更不刷新画面
  viewer.scene.requestRender();
};

export const syncLabelVisibility = () => {
  const viewer = getViewer();
  if (!viewer) return;
  const walk = (nodes, parentVisible) => {
    for (const node of nodes) {
      const effectivelyVisible = parentVisible && node.show;
      if (node.type === 'folder' && node.children) {
        walk(node.children, effectivelyVisible);
      } else if (node.type === 'geojson') {
        const collection = _labelCollections.get(node.id);
        if (collection) {
          // LabelCollection 自身无 show 属性，加入/移出 scene.primitives 控制可见性
          const prims = viewer.scene.primitives;
          const inScene = prims.contains(collection);
          if (effectivelyVisible && !inScene) prims.add(collection);
          else if (!effectivelyVisible && inScene) prims.remove(collection);
        }
      }
    }
  };
  walk(mapState.layerTree, true);
};

export const toggleLayerVisibility = async (layerId, isVisible) => {
  const layerConfig = getLayerState(layerId);
  if (!layerConfig) return;
  layerConfig.show = isVisible;
  const viewer = getViewer();

  // 按需加载：设为可见且尚未加载的图层
  if (isVisible && !getLayer(layerId)) {
    showToast(`正在加载 ${layerConfig.name}...`, 'info', 0);
    try {
      if (layerConfig.type === 'geojson' && layerConfig.url) {
        await loadGeoJsonLayer(layerConfig, viewer);
      } else if (layerConfig.type === '3dtiles') {
        if (!layerConfig.features) {
          layerConfig.features = [{ id: layerConfig.id + '_feature', name: layerConfig.name, url: layerConfig.url, show: true, isLoaded: false, isLoading: false }];
        }
        for (const f of layerConfig.features) {
          if (f.show) await loadSingle3DTiles(layerConfig, f, viewer);
        }
      }
    } finally {
      hideToast();
    }
  }

  // 文件夹：显示时递归加载子图层（之前隐藏文件夹导致子图层从未加载）
  if (isVisible && layerConfig.type === 'folder' && layerConfig.children) {
    showToast(`正在加载文件夹 ${layerConfig.name}...`, 'info', 0);
    try {
      const loadVisibleChildren = async (nodes) => {
      for (const child of nodes) {
        if (child.type === 'folder') {
          if (child.children) await loadVisibleChildren(child.children);
        } else if (child.show && !getLayer(child.id)) {
          if (child.type === 'geojson' && child.url) {
            await loadGeoJsonLayer(child, viewer);
          } else if (child.type === '3dtiles') {
            if (!child.features) child.features = [{ id: child.id + '_feature', name: child.name, url: child.url, show: true }];
            for (const f of child.features) {
              if (f.show) await loadSingle3DTiles(child, f, viewer);
            }
          }
        }
      }
    };
    await loadVisibleChildren(layerConfig.children);
    } finally {
      hideToast();
    }
  }

  refreshLayerVisibility();
  // 第二次 requestRender：隐藏再显示的图层需要额外刷新才能真正渲染
  if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  savePersonalVisibility(layerId, isVisible);
};

export const toggleFeatureVisibility = (layerId, entityId, isVisible) => {
  const layerConfig = getLayerState(layerId);
  if (!layerConfig) return;
  const feature = layerConfig.features.find(f => f.id === entityId || String(f.properties?.OBJECTID) === String(entityId));
  if (feature) { feature.show = isVisible; refreshLayerVisibility(); }
};

// 同步设置 entities 的 extrudedHeight——在 DataSource 加入 viewer 之前调用
// 确保 Cesium 首次创建几何时 extrudeHeight 已就位，避免 flat→extruded 的二次重建
const extrude = (entities, hField) => {
  entities.forEach(e => {
    if (!e.polygon) return;
    e._heightField = hField;
    const props = e.properties?.getValue?.(Cesium.JulianDate.now()) ?? e.properties;
    const h = props ? Number(props[hField]) : 0;
    if (h > 0) e.polygon.extrudedHeight = h;
  });
};

// 属性表修改 Height_m 后同步更新 extrudedHeight
export const refreshExtrudedHeight = (entity) => {
  if (!entity?.polygon || !entity._heightField) return;
  const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) ?? entity.properties;
  const h = props ? Number(props[entity._heightField]) : 0;
  entity.polygon.extrudedHeight = h > 0 ? h : 0;
  const viewer = getViewer();
  if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
};

export const getLayer = (layerId) => layerVault.get(layerId);

export const update3DTilesQuality = (quality) => {
  mapState.system.currentQuality = quality;
  layerVault.forEach((layer) => { if (layer.maximumScreenSpaceError !== undefined) layer.maximumScreenSpaceError = quality; });
  // requestRenderMode 下 maximumScreenSpaceError 赋值不触发渲染（setter 仅写内部字段），必须手动请求
  const v = getViewer();
  if (v && !v.isDestroyed()) v.scene.requestRender();
};

export const updateBaseMapOpacity = (alpha) => {
  const viewer = getViewer();
  if (viewer && viewer.imageryLayers.length > 0) viewer.imageryLayers.get(0).alpha = alpha;
  if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
};

export const updateLayerOpacity = (layerId, alpha) => {
  const layerConfig = getLayerState(layerId); 
  if (!layerConfig) return;
  if (layerConfig.type === '3dtiles') {
    layerConfig.features.forEach(f => {
      const tileset = layerVault.get(f.id);
      if (tileset) tileset.style = new Cesium.Cesium3DTileStyle({ color: `color('white', ${alpha})` });
    });
  } else if (layerConfig.type === 'geojson') {
    applySymbology(layerId);
  }
  const v = getViewer();
  if (v && !v.isDestroyed()) v.scene.requestRender();
};

// ==========================================
// 🌟 核心修复：基于笛卡尔基准坐标系的全要素高度重算
// ==========================================
// 🎯 实时调整模型位置/缩放（Model entity）
let _transformSaveTimer = null;
export const updateTilesetTransform = (layerId, featureId, transform) => {
  const obj = layerVault.get(featureId);
  const layerConfig = getLayerState(layerId);
  const t = transform;

  if (obj) {
    const center = Cesium.Cartesian3.fromDegrees(t.longitude, t.latitude, t.height || 0);
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(t.heading||0), Cesium.Math.toRadians(t.pitch||0), Cesium.Math.toRadians(t.roll||0));
    if (obj._isBuildingModel) {
      obj.position = center;
      obj.orientation = Cesium.Transforms.headingPitchRollQuaternion(center, hpr);
      if (obj.model) obj.model.scale = t.scale || 1.0;
    } else if (obj._baseCenter) {
      const trans = Cesium.Cartesian3.subtract(center, obj._baseCenter, new Cesium.Cartesian3());
      obj.modelMatrix = Cesium.Matrix4.fromTranslation(trans);
      if (t.scale && t.scale !== 1.0) {
        obj.modelMatrix = Cesium.Matrix4.multiply(obj.modelMatrix, Cesium.Matrix4.fromUniformScale(t.scale), new Cesium.Matrix4());
      }
    }
  }

  if (layerConfig) {
    layerConfig.transform = { ...transform };
    const feat = layerConfig.features?.find(f => f.id === featureId);
    if (feat) feat.transform = { ...transform };
    clearTimeout(_transformSaveTimer);
    _transformSaveTimer = setTimeout(() => saveLayerConfig().catch(() => {}), 800);
  }
  const viewer = getViewer();
  if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
};

export const updateLayerHeight = (layerId, heightOffset) => {
  const offset = Number(heightOffset);
  const layerInfo = getLayerState(layerId);
  if (layerInfo) layerInfo.heightOffset = offset;

  // 3D Tiles 倾斜摄影：modelMatrix + makeStyleDirty 强制 tile 重评估
  if (layerInfo?.type === '3dtiles') {
    const tileset = layerVault.get(layerId + '_feature') || layerVault.get(layerId);
    if (!tileset) return;
    const base = tileset._baseCenter || tileset.boundingSphere.center;
    const carto = Cesium.Cartographic.fromCartesian(base);
    const srf = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, offset);
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.subtract(srf, base, new Cesium.Cartesian3()));
    tileset.makeStyleDirty();
    const v = getViewer();
    if (v && !v.isDestroyed()) v.scene.requestRender();
    return;
  }

  const layer = layerVault.get(layerId);
  if (!layer) return;

  if (layer instanceof Cesium.GeoJsonDataSource) {
    layer.entities.values.forEach(ent => {
      // 1. 面要素：原生支持拉伸
      // 有 heightField 的挤出建筑不参与统一高度调整（高度由字段控制）
      if (ent.polygon && !ent._heightField) ent.polygon.height = offset;
      
      // 2. 线要素：根据 basePositions 重算 Z 轴
      if (ent.polyline && ent.basePositions) {
        ent.polyline.clampToGround = (offset === 0); // 只有高度为0才贴地
        const newPositions = ent.basePositions.map(p => {
          const carto = Cesium.Cartographic.fromCartesian(p);
          carto.height = offset;
          return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);
        });
        ent.polyline.positions = newPositions;
      } else if (ent.polyline) {
        // _outline Polyline（ThematicRenderer 创建的轮廓线，无 basePositions）
        ent.polyline.height = offset;
      }

      // 3. 点/图标要素：根据 basePosition 重算 Z 轴
      if (ent.position && ent.basePosition) {
        const carto = Cesium.Cartographic.fromCartesian(ent.basePosition);
        carto.height = offset;
        ent.position = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);
      }
    });
  }
  const v3 = getViewer();
  if (v3 && !v3.isDestroyed()) v3.scene.requestRender();
};

export const zoomToVisibleLayers = (opts = {}) => {
  const viewer = getViewer();
  if (!viewer) return;

  const spheres = [];
  for (let [id, object] of layerVault.entries()) {
    if (object instanceof Cesium.Cesium3DTileset && object.show && object.boundingSphere) {
      spheres.push(object.boundingSphere);
    } else if (object instanceof Cesium.GeoJsonDataSource && object.show) {
      let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
      let hasGeometry = false;
      const time = Cesium.JulianDate.now();
      const expandBounds = (cartesian) => {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        hasGeometry = true;
      };
      object.entities.values.forEach(entity => {
        // Polygon——优先用加载时缓存的 _hierarchyPositions，避免大图层 25K 次 getValue 解析
        if (entity.polygon && entity.polygon.hierarchy) {
          const pos = entity._hierarchyPositions
            || entity.polygon.hierarchy.getValue(time)?.positions;
          if (pos) pos.forEach(expandBounds);
        }
        // Polyline
        if (entity.polyline && entity.polyline.positions) {
          entity.polyline.positions.getValue(time).forEach(expandBounds);
        }
        // Point / Billboard
        if (entity.position) {
          expandBounds(entity.position.getValue(time));
        }
      });
      if (hasGeometry) {
        const rect = Cesium.Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);
        spheres.push(Cesium.BoundingSphere.fromRectangle3D(rect));
      }
    }
  }

  if (spheres.length === 0) {
    showToast('当前无可见图层数据，请开启至少一个图层', 'warning', 3000);
    return;
  }
  let finalSphere = spheres[0];
  for (let i = 1; i < spheres.length; i++) finalSphere = Cesium.BoundingSphere.union(finalSphere, spheres[i], new Cesium.BoundingSphere());
  const pitch = opts.to2D ? Cesium.Math.toRadians(-90) : Cesium.Math.toRadians(-60);
  viewer.camera.flyToBoundingSphere(finalSphere, { duration: 1.5, offset: new Cesium.HeadingPitchRange(0, pitch, finalSphere.radius * 2.5) });
};


// Z 顺序：按图层树遍历顺序自动分配微小高度偏移，列表上方 = 渲染在上层

// 页面加载后恢复所有已开启的标签显示
export const initAllLabels = () => {
  const viewer = getViewer();
  if (!viewer) return;
  let savedSettings = {};
  try {
    const raw = localStorage.getItem(uk('cesium_mvp_label_settings'));
    if (raw) savedSettings = JSON.parse(raw);
  } catch (e) { /* ignore */ }
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'folder' && node.children) {
        walk(node.children);
      } else if (node.type === 'geojson') {
        const saved = savedSettings[node.id];
        if (saved && saved.showLabel && saved.labelField) {
          applyLayerLabels(node.id, saved.labelField,
            saved.labelFontSize || 14,
            saved.labelFontFamily || 'sans-serif',
            saved.labelBold || false,
            saved.labelColor || '#ffffff'
          );
        }
      }
    }
  };
  walk(mapState.layerTree);
};

// 给图层所有要素添加标签（独立 entity）
const _labelCollections = new Map(); // layerId -> LabelCollection
const _labelItems = new Map(); // layerId -> Label[]
export const applyLayerLabels = (layerId, fieldKey, fontSize, fontFamily, bold, color) => {
  const viewer = getViewer();
  if (!viewer) return;
  const ds = getLayer(layerId);
  if (!ds || !ds.entities) return;
  const weight = bold ? 'bold ' : '';
  const font = weight + fontSize + 'px ' + fontFamily;
  const newColor = Cesium.Color.fromCssColorString(color || '#ffffff');
  // 已有标签且仅样式变化：原地修改 Label 属性，对标 updateLayerHeight 的原地修改模式
  const items = _labelItems.get(layerId);
  if (items && items.length > 0) {
    items.forEach(l => { l.font = font; l.fillColor = newColor; });
    const vl = getViewer();
    if (vl && !vl.isDestroyed()) vl.scene.requestRender();
    return;
  }
  // 首次创建或标签字段变更：全量重建
  let collection = _labelCollections.get(layerId);
  if (collection) { collection.removeAll(); _labelItems.set(layerId, []); }
  else {
    collection = new Cesium.LabelCollection();
    _labelCollections.set(layerId, collection);
    _labelItems.set(layerId, []);
    viewer.scene.primitives.add(collection);
  }
  const newItems = [];
  const time = Cesium.JulianDate.now();
  ds.entities.values.forEach(e => {
    const props = e.properties ? e.properties.getValue(time) : {};
    const val = props[fieldKey];
    if (val === undefined || val === null || String(val).trim() === '') return;
    let center = null;
    if (e.polygon && e.polygon.hierarchy) {
      const positions = e.polygon.hierarchy.getValue(time).positions;
      const plane = Cesium.EllipsoidTangentPlane.fromPoints(positions, Cesium.Ellipsoid.WGS84);
      const p2d = positions.map(p => plane.projectPointOntoPlane(p, new Cesium.Cartesian2()));
      let cx = 0, cy = 0, area2 = 0;
      const n = p2d.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cross = p2d[i].x * p2d[j].y - p2d[j].x * p2d[i].y;
        area2 += cross;
        cx += (p2d[i].x + p2d[j].x) * cross;
        cy += (p2d[i].y + p2d[j].y) * cross;
      }
      if (Math.abs(area2) > 1e-10) {
        cx /= (3 * area2);
        cy /= (3 * area2);
        center = plane.projectPointsOntoEllipsoid([new Cesium.Cartesian2(cx, cy)])[0];
      } else {
        center = new Cesium.Cartesian3();
        for (let i = 0; i < n; i++) center = Cesium.Cartesian3.add(center, positions[i], center);
        center = Cesium.Cartesian3.divideByScalar(center, n, new Cesium.Cartesian3());
      }
    } else if (e.polyline && e.polyline.positions) {
      const positions = e.polyline.positions.getValue(time);
      center = positions[Math.floor(positions.length / 2)];
    } else if (e.position) {
      center = e.position.getValue(time);
    }
    if (!center) return;
    const lbl = collection.add({
      position: center,
      text: String(val),
      font: font,
      fillColor: newColor,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    });
    newItems.push(lbl);
  });
  _labelItems.set(layerId, newItems);
  const vl = getViewer();
  if (vl && !vl.isDestroyed()) vl.scene.requestRender();
};

// 移除图层的所有标签 entity
export const removeLayerLabels = (layerId) => {
  const viewer = getViewer();
  if (!viewer) return;
  const collection = _labelCollections.get(layerId);
  if (collection) {
    if (!viewer.isDestroyed()) viewer.scene.primitives.remove(collection);
    _labelCollections.delete(layerId);
    _labelItems.delete(layerId);
  }
  if (!viewer.isDestroyed()) viewer.scene.requestRender();
  if (!viewer.isDestroyed()) viewer.scene.requestRender();
};

export const applyLayerZOrder = () => {
  const step = 1.0; // 每层间隔 1m
  let index = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'folder' && node.children) {
        walk(node.children);
      } else if (node.type === 'geojson') {
        const manualH = Number(node.heightOffset) || 0;
        const totalH = manualH + index * step;
        const layer = getLayer(node.id);
        if (!layer) { index++; continue; }
        // 有 heightField 的挤出图层跳过 Z 排序
        if (node.heightField) continue;
        layer.entities.values.forEach(ent => {
          if (ent.polygon) ent.polygon.height = totalH;
          if (ent.polyline && ent.basePositions) {
            ent.polyline.clampToGround = (totalH === 0);
            const newP = ent.basePositions.map(p => {
              const c = Cesium.Cartographic.fromCartesian(p);
              c.height = totalH;
              return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
            });
            ent.polyline.positions = newP;
          } else if (ent.polyline) {
            ent.polyline.height = totalH;
          }
          if (ent.position && ent.basePosition) {
            const c = Cesium.Cartographic.fromCartesian(ent.basePosition);
            c.height = totalH;
            ent.position = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
          }
        });
        index++;
      }
    }
  };
  walk(mapState.layerTree);
  const v4 = getViewer();
  if (v4 && !v4.isDestroyed()) v4.scene.requestRender();
};


export const reloadLayer = async (layerId) => {
  const viewer = getViewer();
  if (!viewer) return;
  const layerConfig = getLayerState(layerId);
  if (!layerConfig) return;

  const oldDataSource = layerVault.get(layerId);
  if (oldDataSource) {
    viewer.dataSources.remove(oldDataSource, true); 
    layerVault.delete(layerId);
  }

  if (layerConfig.type === 'geojson') {
    await loadGeoJsonLayer(layerConfig, viewer);
    refreshLayerVisibility();
  }
};

// ==========================================
// 🌟 新增：空间背景色控制引擎
// ==========================================
export const updateBackgroundColor = (colorHex) => {
  const viewer = getViewer();
  if (!viewer) return;
  
  // 1. 核心陷阱：必须关闭宇宙星空盒子和地球大气层光晕
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;
  
  // 2. 设置真正的背景纯色
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(colorHex);
  
  // 3. 顺便把地球的素颜底色也改了（当底图透明度为 0 时能看到）
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(colorHex);
  viewer.scene.requestRender();
};
