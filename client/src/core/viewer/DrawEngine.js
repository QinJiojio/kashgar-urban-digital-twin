import * as Cesium from 'cesium';
import { getViewer } from './ViewerSetup';
import { mapState, fieldSchema, getLayerState, showToast, hideToast } from '../../store/mapState';
import { getLayer } from '../layers/LayerManager';
import { saveFeature, saveGeometryForFeature } from '../saveFeature';
import { applySymbology } from '../symbology/ThematicRenderer';

// 同步导出给 ViewerSetup 双击守卫用（函数引用，规避 circular import）
export const isDrawEngineActive = () => drawEngine?.isDrawing ?? false;
import { checkLayerStale } from '../locks';

class DrawEngine {
  constructor() {
    this.viewer = null;
    this.handler = null;
    this.activeLayerId = null;
    this.activeGeometryType = 'polygon';
    this.activeLayerOffset = 0.0;
    this.tempPoints = [];
    this.floatingPoint = null;
    this.drawEntity = null;
    this.isDrawing = false;
    this._stateListeners = [];
    this._completeListeners = [];
    // 屏幕锁定预览模式（移动端线/面绘制）
    this._screenLockedMode = false;
    this._savingDrawing = false;
    this._tempIdCounter = 0;
    this._lockedVertices = [];
    this._previewScreenX = 0;
    this._previewScreenY = 0;
    this._previewCartesian = null;
    this._hasPreview = false;
    this._preRenderUnsub = null;
  }

  onDrawStateChange(fn) {
    this._stateListeners.push(fn);
    return () => { this._stateListeners = this._stateListeners.filter(f => f !== fn); };
  }

  // 绘制完成回调（移动端自动弹出属性面板用）
  onDrawComplete(fn) {
    this._completeListeners.push(fn);
    return () => { this._completeListeners = this._completeListeners.filter(f => f !== fn); };
  }

  _notifyStateChange(isDrawing) {
    this._stateListeners.forEach(fn => { try { fn(isDrawing); } catch {} });
  }

  init() {
    this.viewer = getViewer();
    if (!this.viewer) return;
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
  }

  // 🌟 抛弃 CallbackProperty，初始化一个纯静态的预览壳子
  _initDrawEntity() {
    if (this.drawEntity) return;

    this.drawEntity = this.viewer.entities.add({
      show: false,
      polyline: {
        show: false,
        positions: [],
        width: 4,
        material: Cesium.Color.CYAN.withAlpha(0.9),
        clampToGround: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      polygon: {
        show: false,
        hierarchy: new Cesium.PolygonHierarchy([]),
        outline: false,
        height: 0,
        material: Cesium.Color.CYAN.withAlpha(0.2)
      }
    });
  }

  _screenPoints() {
    const pts = [...this._lockedVertices];
    if (this._hasPreview && this._previewCartesian) pts.push(this._previewCartesian);
    return pts;
  }

  _screenPointCount() {
    return this._lockedVertices.length + (this._hasPreview && this._previewCartesian ? 1 : 0);
  }

  _buildScreenLine() {
    const pts = this._screenPoints();
    if (pts.length === 0) return [Cesium.Cartesian3.fromDegrees(0, 0, 0), Cesium.Cartesian3.fromDegrees(0, 0, 0)];
    if (pts.length === 1) {
      const c = Cesium.Cartographic.fromCartesian(pts[0]);
      const d = 0.000005;
      return [
        Cesium.Cartesian3.fromRadians(c.longitude - d, c.latitude, c.height),
        Cesium.Cartesian3.fromRadians(c.longitude + d, c.latitude, c.height)
      ];
    }
    let linePts = pts;
    if (this.activeGeometryType === 'polygon' && linePts.length > 2) linePts = [...linePts, linePts[0]];
    return linePts;
  }

  // 🌟 核心引擎升级：只有鼠标动了，才去手动刷新几何体，彻底杜绝 60FPS 疯狂重建引发的 WebWorker 崩溃
  _updateDrawEntityGeometry() {
    if (!this.drawEntity || !this.isDrawing) return;

    // 屏幕锁定模式：位置由 CallbackProperty 自动计算，这里只处理顶点标记
    if (this._screenLockedMode) {
      this._updateVertexMarkers();
      // requestRenderMode 下 vertex marker 的 entity 增删不自动触发渲染（教训 #64）
      if (this.viewer && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
      return;
    }

    let pts = this.floatingPoint ? [...this.tempPoints, this.floatingPoint] : [...this.tempPoints];
    const DUMMY_POS = Cesium.Cartesian3.fromDegrees(0, 0, 0);

    // 1. 更新线
    let linePts = pts;
    if (linePts.length < 2) {
      const p = linePts.length === 1 ? linePts[0] : DUMMY_POS;
      linePts = [p, p];
    } else if (this.activeGeometryType === 'polygon' && linePts.length > 2) {
      linePts = [...linePts, linePts[0]];
    }
    this.drawEntity.polyline.positions = linePts;
    this.drawEntity.polyline.show = pts.length > 0;

    // 2. 更新面
    if (this.activeGeometryType === 'polygon') {
      let polyPts = pts;
      if (polyPts.length < 3) {
        const p = polyPts.length > 0 ? polyPts[0] : DUMMY_POS;
        polyPts = [p, p, p];
      }
      this.drawEntity.polygon.hierarchy = new Cesium.PolygonHierarchy(polyPts);
      this.drawEntity.polygon.height = Number(this.activeLayerOffset || 0);
      this.drawEntity.polygon.show = pts.length > 1;
    } else {
      this.drawEntity.polygon.show = false;
    }

    // requestRenderMode 下 entity positions/hierarchy/show 赋值不触发渲染（教训 #64）
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  // 屏幕锁定模式：更新锁定顶点（绿点）和预放点（金色点）的 Cesium 标记
  _updateVertexMarkers() {
    const v = this.viewer;
    if (!this._lockedMarkers) this._lockedMarkers = [];

    for (let i = 0; i < this._lockedVertices.length; i++) {
      if (i < this._lockedMarkers.length) {
        this._lockedMarkers[i].position = this._lockedVertices[i];
      } else {
        this._lockedMarkers.push(v.entities.add({
          position: this._lockedVertices[i],
          point: { pixelSize: 7, color: Cesium.Color.LIME, outlineColor: Cesium.Color.WHITE, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY }
        }));
      }
    }
    while (this._lockedMarkers.length > this._lockedVertices.length) {
      v.entities.remove(this._lockedMarkers.pop());
    }

    if (this._hasPreview && this._previewCartesian) {
      if (this._previewMarker) {
        this._previewMarker.position = this._previewCartesian;
      } else {
        this._previewMarker = v.entities.add({
          position: this._previewCartesian,
          point: { pixelSize: 10, color: Cesium.Color.GOLD, outlineColor: Cesium.Color.RED, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }
        });
      }
    } else if (this._previewMarker) {
      v.entities.remove(this._previewMarker);
      this._previewMarker = null;
    }
  }

  _onKeyDown = (event) => {
    if (!this.isDrawing) return;
    
    if (event.key === 'Escape') {
      this.stop();
    } else if (event.key === 'Enter') {
      if (this.activeGeometryType === 'point') return;
      const vertCount = this._screenLockedMode
        ? (this._lockedVertices.length + (this._hasPreview ? 1 : 0))
        : this.tempPoints.length;
      if (vertCount < (this.activeGeometryType === 'polygon' ? 3 : 2)) {
        alert("⚠️ 顶点不足！多边形至少需要 3 个点，线段至少需要 2 个点。");
        return;
      }
      this._finishDrawing();
    }
  };

  async start(layerId, options = {}) {
    if (!this.viewer) this.init();
    if (this.isDrawing) this.stop();

    const layer = getLayerState(layerId);
    if (!layer) return;
    if (!layer.show) {
      showToast('该图层未显示，请先在图层列表中开启可见性（👁）', 'error');
      return;
    }

    this.activeLayerId = layerId;
    this.activeGeometryType = layer.geometryType || 'polygon';
    this.activeLayerOffset = layer.heightOffset || 0.0;
    // 绑定已有要素模式：不为已有行创建新 entity，直接 PATCH 其几何
    this._bindToObjectId = options.bindToObjectId || null;

    const stale = await checkLayerStale(layerId);
    if (stale) {
      showToast('检测到数据有更新，正在刷新...', 'info', 0);
      const { reloadLayer } = await import('../layers/LayerManager');
      await reloadLayer(layerId);
      hideToast();
    }

    this._initDrawEntity();
    this.tempPoints = [];
    this.floatingPoint = null;
    this.isDrawing = true;

    // 屏幕锁定预览模式（移动端线/面）
    this._screenLockedMode = options.screenPreview || false;
    if (this._screenLockedMode) {
      this._lockedVertices = [];
      this._hasPreview = false;
      this._previewCartesian = null;
      this._preRenderUnsub = this.viewer.scene.preRender.addEventListener(
        this._onPreRender.bind(this)
      );
      // 禁用旋转/倾斜，让单指拖动用于平移（由 MobileLayout 自定义手势处理）
      this._savedEnableRotate = this.viewer.scene.screenSpaceCameraController.enableRotate;
      this._savedEnableTilt = this.viewer.scene.screenSpaceCameraController.enableTilt;
      this.viewer.scene.screenSpaceCameraController.enableRotate = false;
      this.viewer.scene.screenSpaceCameraController.enableTilt = false;
    }

    this.drawEntity.show = true;
    this._updateDrawEntityGeometry();

    // 屏幕锁定模式：用 CallbackProperty 让 Cesium 每帧自动求值（消除手动 assign 的时序问题）
    if (this._screenLockedMode) {
      this.drawEntity.polyline.positions = new Cesium.CallbackProperty(
        () => this._buildScreenLine(), false
      );
      this.drawEntity.polyline.show = new Cesium.CallbackProperty(
        () => this.isDrawing && this._screenPointCount() > 0, false
      );
      if (this.activeGeometryType === 'polygon') {
        this.drawEntity.polygon.hierarchy = new Cesium.CallbackProperty(
          () => new Cesium.PolygonHierarchy(this._screenPoints()), false
        );
        this.drawEntity.polygon.show = new Cesium.CallbackProperty(
          () => this.isDrawing && this._screenPointCount() > 1, false
        );
      }
    }

    mapState.editor.activeTool = 'draw';
    this.viewer._container.style.cursor = options.passivePoint ? 'default' : 'crosshair';
    this.viewer.scene.screenSpaceCameraController.enableTranslate = options.passivePoint;

    this._bindEvents();
    if (options.passivePoint || options.screenPreview) {
      this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }
    document.addEventListener('keydown', this._onKeyDown);
    this._notifyStateChange(true);
  }

  stop() {
    this.isDrawing = false;
    this._bindToObjectId = null;

    // 🌟 直接让外壳和组件全部隐身，停止一切几何计算
    if (this.drawEntity) {
      this.drawEntity.show = false; 
      this.drawEntity.polyline.show = false;
      if (this.drawEntity.polygon) this.drawEntity.polygon.show = false;
    }

    if (this.handler) {
      this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
      this.handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      if (!this._screenLockedMode) {
        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.RIGHT_CLICK);
        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      }
    }
    document.removeEventListener('keydown', this._onKeyDown);

    this.tempPoints = [];
    this.floatingPoint = null;
    this._lockedVertices = [];
    this._previewCartesian = null;
    this._hasPreview = false;
    this._screenLockedMode = false;
    if (this._preRenderUnsub) {
      this._preRenderUnsub();
      this._preRenderUnsub = null;
    }
    if (this._lockedMarkers) {
      this._lockedMarkers.forEach(m => this.viewer.entities.remove(m));
      this._lockedMarkers = [];
    }
    if (this._previewMarker) {
      this.viewer.entities.remove(this._previewMarker);
      this._previewMarker = null;
    }
    if (this._savedEnableRotate !== undefined) {
      this.viewer.scene.screenSpaceCameraController.enableRotate = this._savedEnableRotate;
      this.viewer.scene.screenSpaceCameraController.enableTilt = this._savedEnableTilt;
    }
    mapState.editor.activeTool = null;
    
    if (this.viewer) {
      this.viewer._container.style.cursor = 'default';
      this.viewer.scene.screenSpaceCameraController.enableTranslate = true;
    }
    this._notifyStateChange(false);
  }

  _bindEvents() {
    // 屏幕锁定模式：点击→预览/锁定，非屏幕锁定模式：点击→直接放置顶点
    this.handler.setInputAction(async (event) => {
      if (this.activeGeometryType === 'point') {
        const cartesian = this._getCorrectHeightPosition(event.position);
        if (!cartesian) return;
        this.tempPoints.push(cartesian);
        const savedBindId = this._bindToObjectId;
        this.stop();
        this._bindToObjectId = savedBindId; // stop 已清除，恢复以便 _addPointEntity 使用
        await this._addPointEntity(cartesian);
        if (!savedBindId) this.start(this.activeLayerId);
        return;
      }

      if (this._screenLockedMode) {
        // 屏幕锁定模式：预放点逻辑
        const layer = getLayerState(this.activeLayerId);
        this.activeLayerOffset = layer?.heightOffset || 0.0;

        if (!this._hasPreview) {
          this._previewScreenX = event.position.x;
          this._previewScreenY = event.position.y;
          this._updatePreviewCartesian();
          this._hasPreview = true;
        } else {
          if (this._previewCartesian) {
            this._lockedVertices.push(this._previewCartesian.clone());
          }
          this._previewScreenX = event.position.x;
          this._previewScreenY = event.position.y;
          this._updatePreviewCartesian();
        }
        this._updateDrawEntityGeometry();
        return;
      }

      // 标准模式：点击放置顶点（桌面端）
      const layer = getLayerState(this.activeLayerId);
      this.activeLayerOffset = layer?.heightOffset || 0.0;
      const cartesian = this._getCorrectHeightPosition(event.position);
      if (!cartesian) return;
      this.tempPoints.push(cartesian);
      this._updateDrawEntityGeometry();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction(async (event) => {
      if (!this.isDrawing || this._screenLockedMode || this.tempPoints.length === 0) return;

      const layer = getLayerState(this.activeLayerId);
      this.activeLayerOffset = layer?.heightOffset || 0.0;

      const cartesian = this._getCorrectHeightPosition(event.endPosition);
      if (!cartesian) return;

      this.floatingPoint = cartesian;
      this._updateDrawEntityGeometry();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 右键/双击完成：仅桌面端标准模式
    if (!this._screenLockedMode) {
      this.handler.setInputAction(() => {
        if (this.activeGeometryType === 'point') return;
        if (this.tempPoints.length < (this.activeGeometryType === 'polygon' ? 3 : 2)) return alert("⚠️ 顶点不足！");
        this._finishDrawing();
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

      this.handler.setInputAction(() => {
        if (this.activeGeometryType === 'point') return;
        if (this.tempPoints.length < (this.activeGeometryType === 'polygon' ? 3 : 2)) return alert("⚠️ 顶点不足！");
        this._finishDrawing();
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
  }

  _getCorrectHeightPosition(screenPos) {
    const ray = this.viewer.camera.getPickRay(screenPos);
    const cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!cartesian) return null;

    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    cartographic.height = Number(this.activeLayerOffset || 0); 
    return Cesium.Cartographic.toCartesian(cartographic);
  }

  // 屏幕锁定模式：从 canvas 内坐标计算当前地理坐标
  _updatePreviewCartesian() {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const x = this._previewScreenX;
    const y = this._previewScreenY;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const cartesian = this._getCorrectHeightPosition(new Cesium.Cartesian2(x, y));
    if (cartesian) this._previewCartesian = cartesian;
  }

  // 屏幕锁定模式：每帧跟随相机更新预放点地理坐标
  _onPreRender() {
    if (!this._hasPreview || !this.isDrawing) return;
    this._updatePreviewCartesian();
    this._updateVertexMarkers();
  }

  // 屏幕锁定模式：由 MobileLayout touchend 直接调用，绕过 Cesium LEFT_CLICK
  handleScreenTap(screenX, screenY) {
    if (!this._screenLockedMode || !this.isDrawing) return;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const cx = screenX - rect.left;
    const cy = screenY - rect.top;
    // 先保存旧预放点，再更新坐标和反算
    const oldPreview = (this._hasPreview && this._previewCartesian) ? this._previewCartesian.clone() : null;
    this._previewScreenX = cx;
    this._previewScreenY = cy;
    this._updatePreviewCartesian();
    if (!oldPreview && !this._previewCartesian) return; // 首次点击且 globe pick 失败
    if (oldPreview) {
      this._lockedVertices.push(oldPreview);
    }
    this._hasPreview = true;
    this._updateVertexMarkers();
  }

  async _finishDrawing() {
    // 防重入：async 函数可能在 stop() 前被多次触发，导致重复 entity
    if (this._savingDrawing) return;
    this._savingDrawing = true;
    try {
    // 屏幕锁定模式：先锁定当前预放点
    if (this._screenLockedMode && this._hasPreview && this._previewCartesian) {
      this._lockedVertices.push(this._previewCartesian.clone());
      this._hasPreview = false;
    }

    const layer = getLayerState(this.activeLayerId);
    if (!layer) return;

    // 检查顶点数量
    const verts = this._screenLockedMode ? this._lockedVertices : this.tempPoints;
    const minPts = this.activeGeometryType === 'polygon' ? 3 : 2;
    if (verts.length < minPts) {
      const label = this.activeGeometryType === 'polygon' ? '多边形' : '线段';
      alert(`⚠️ 顶点不足！${label}至少需要 ${minPts} 个点。`);
      return;
    }

    // 绑定已有要素模式：跳过 entity 创建，直接 PATCH 几何到已有行
    if (this._bindToObjectId) {
      const coords = this._convertToGeoJsonCoords();
      const geomType = this.activeGeometryType === 'polygon' ? 'Polygon'
        : (this.activeGeometryType === 'polyline' ? 'LineString' : 'Point');
      const result = await saveGeometryForFeature(
        this.activeLayerId, this._bindToObjectId, { type: geomType, coordinates: coords }
      );
      if (result && result.success) {
        mapState.interaction.selectedFeatureId = this._bindToObjectId;
        mapState.interaction.selectedLayerId = this.activeLayerId;
        const r = { layerId: this.activeLayerId, featureId: this._bindToObjectId, entityId: null };
        this._completeListeners.forEach(fn => { try { fn(r); } catch {} });
      }
      this.stop();
      return;
    }

    this._tempIdCounter++;
    const tempId = `temp_${Date.now()}_${this._tempIdCounter}`;

    const newFeature = {
      id: tempId,
      type: "Feature",
      geometry: {
        type: this.activeGeometryType === 'polygon' ? "Polygon" : (this.activeGeometryType === 'polyline' ? "LineString" : "Point"),
        coordinates: this._convertToGeoJsonCoords()
      },
      properties: { OBJECTID: 0 }
    };

    const schema = fieldSchema[this.activeLayerId] || {};
    Object.keys(schema).forEach(key => {
      if (key.toUpperCase() !== 'OBJECTID') newFeature.properties[key] = "";
    });

    const layerDataSource = getLayer(this.activeLayerId);
    const targetEntityCollection = (layerDataSource instanceof Cesium.GeoJsonDataSource)
      ? layerDataSource.entities
      : this.viewer.entities;

    const layerStyle = layer.style || {};
    const entityConfig = {
      id: tempId,
      properties: newFeature.properties,
    };

    if (this.activeGeometryType === 'polygon') {
      entityConfig.polygon = {
        hierarchy: new Cesium.PolygonHierarchy([...verts]),
        height: Number(this.activeLayerOffset || 0),
        material: Cesium.Color.fromCssColorString(layerStyle.fillColor || '#10b981').withAlpha(layerStyle.fillOpacity ?? 0.4),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(layerStyle.outlineColor || '#10b981'),
        outlineWidth: layerStyle.outlineWidth || 2
      };
    } else if (this.activeGeometryType === 'polyline') {
      entityConfig.polyline = {
        positions: [...verts],
        width: layerStyle.lineWidth || 3,
        material: Cesium.Color.fromCssColorString(layerStyle.color || '#38bdf8')
      };
    }

    targetEntityCollection.add(entityConfig);
    // 标记所属图层 + 缓存 hierarchy 顶点供 applySymbology 创建 outline polyline
    const addedEntity = targetEntityCollection.getById(tempId);
    if (addedEntity) {
      addedEntity._layerId = this.activeLayerId;
      if (this.activeGeometryType === 'polygon') {
        addedEntity._hierarchyPositions = [...verts];
      }
    }
    if (!layer.features) layer.features = [];
    layer.features.push(newFeature);

    // 填充 fieldSchema
    if (!fieldSchema[this.activeLayerId]) {
      const s = {};
      Object.keys(newFeature.properties).forEach(k => {
        if (['OBJECTID', 'FID'].includes(k)) return;
        s[k] = { label: k, type: typeof newFeature.properties[k] === 'number' ? 'number' : 'string' };
      });
      if (Object.keys(s).length > 0) fieldSchema[this.activeLayerId] = s;
    }

    // 自动保存（服务端分配真正 OBJECTID，saveFeature 内更新 entity 和 layer.features）
    const saveResult = await saveFeature(this.activeLayerId, tempId);
    if (!saveResult || !saveResult.success) {
      targetEntityCollection.removeById(tempId);
      if (layer.features) layer.features = layer.features.filter(f => f.id !== tempId);
      showToast('保存失败，请检查网络后重试', 'error', 3000);
      this.stop();
      return;
    }
    // 应用专题渲染配色，确保新要素与图层其他要素样式统一
    applySymbology(this.activeLayerId);
    const finalId = (saveResult && saveResult.assignedId) || tempId;
    // 从 entity 读取真实属性（saveFeature 已更新了 OBJECTID）
    const realProps2 = {};
    const savedEntity2 = targetEntityCollection.getById(tempId);
    if (savedEntity2?.properties) {
      savedEntity2.properties.propertyNames.forEach(n => {
        realProps2[n] = savedEntity2.properties[n]?.getValue?.(Cesium.JulianDate.now()) ?? savedEntity2.properties[n];
      });
    }
    // selectedFeatureId 保持 tempId（Cesium entity 真实 id）
    // handleDataChange 按此查找 entity 写属性，handlePropBlur 从 OBJECTID 取稳定 ID
    mapState.interaction.selectedFeatureId = tempId;
    mapState.interaction.selectedLayerId = this.activeLayerId;
    mapState.interaction.selectedFeatureProps = realProps2;

    // 通知移动端：绘制完成，可以弹出属性面板
    const result = { layerId: this.activeLayerId, featureId: finalId, entityId: tempId };
    this._completeListeners.forEach(fn => { try { fn(result); } catch {} });

    this.stop();
    } finally {
      this._savingDrawing = false;
    }
  }


  // 点要素专用：添加 entity + 保存
  async _addPointEntity(cartesian) {
    const layer = getLayerState(this.activeLayerId);
    if (!layer) return;

    // 绑定已有要素模式：不为已有行创建 entity，直接保存坐标
    if (this._bindToObjectId) {
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      const coords = [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
      const result = await saveGeometryForFeature(
        this.activeLayerId, this._bindToObjectId, { type: 'Point', coordinates: coords }
      );
      if (result && result.success) {
        mapState.interaction.selectedFeatureId = this._bindToObjectId;
        mapState.interaction.selectedLayerId = this.activeLayerId;
        const r = { layerId: this.activeLayerId, featureId: this._bindToObjectId, entityId: null };
        this._completeListeners.forEach(fn => { try { fn(r); } catch {} });
      }
      this.stop();
      return;
    }

    if (!layer.features) layer.features = [];
    this._tempIdCounter++;
    const tempId = 'temp_' + Date.now() + '_' + this._tempIdCounter;
    this._lastPointTempId = tempId;
    const props = { OBJECTID: 0 };
    const schema = fieldSchema[this.activeLayerId] || {};
    Object.keys(schema).forEach(k => {
      if (k.toUpperCase() !== 'OBJECTID') props[k] = '';
    });
    const layerStyle = layer.style || {};
    const ds = getLayer(this.activeLayerId);
    const collection = (ds instanceof Cesium.GeoJsonDataSource) ? ds.entities : this.viewer.entities;
    collection.add({
      id: tempId,
      position: cartesian,
      properties: props,
      point: {
        pixelSize: Math.max(layerStyle.radius || 14, 14),
        color: Cesium.Color.fromCssColorString(layerStyle.fillColor || '#ef4444'),
        outlineColor: Cesium.Color.fromCssColorString(layerStyle.outlineColor || '#ffffff'),
        outlineWidth: layerStyle.outlineWidth || 2
      }
    });
    if (collection.getById) {
      const addedPt = collection.getById(tempId);
      if (addedPt) addedPt._layerId = this.activeLayerId;
    }
    layer.features.push({ id: tempId, name: '未命名要素', show: true, properties: props });
    const result = await saveFeature(this.activeLayerId, tempId);
    if (!result || !result.success) {
      if (collection.getById) collection.removeById(tempId);
      if (layer.features) layer.features = layer.features.filter(f => f.id !== tempId);
      showToast('保存失败，请检查网络后重试', 'error', 3000);
      return;
    }
    applySymbology(this.activeLayerId);
    // 从 entity 读取真实属性（saveFeature 已更新了 OBJECTID 等字段）
    const realProps = {};
    if (collection.getById) {
      const savedEntity = collection.getById(tempId);
      if (savedEntity?.properties) {
        savedEntity.properties.propertyNames.forEach(n => {
          realProps[n] = savedEntity.properties[n]?.getValue?.(Cesium.JulianDate.now()) ?? savedEntity.properties[n];
        });
      }
    }
    // selectedFeatureId 保持 tempId（Cesium entity 真实 id）
    // handleDataChange 按此查找 entity 写属性，handlePropBlur 从 OBJECTID 取稳定 ID
    mapState.interaction.selectedFeatureId = tempId;
    mapState.interaction.selectedLayerId = this.activeLayerId;
    mapState.interaction.selectedFeatureProps = realProps;
  }

  undoLastPoint() {
    if (!this.isDrawing || this.activeGeometryType === 'point') return;
    if (this._screenLockedMode) {
      if (this._hasPreview) {
        this._hasPreview = false;
        this._previewCartesian = null;
      } else if (this._lockedVertices.length > 0) {
        this._lockedVertices.pop();
      }
    } else {
      if (this.tempPoints.length === 0) return;
      this.tempPoints.pop();
      this.floatingPoint = null;
    }
    this._updateDrawEntityGeometry();
  }

  finishDrawing() {
    if (this.activeGeometryType === 'point') return false;
    const verts = this._screenLockedMode ? this._lockedVertices : this.tempPoints;
    const hasPreview = this._screenLockedMode && this._hasPreview;
    const count = verts.length + (hasPreview ? 1 : 0);
    const minPts = this.activeGeometryType === 'polygon' ? 3 : 2;
    if (count < minPts) {
      showToast('顶点不足！', 'warning');
      return false;
    }
    this._finishDrawing();
    return true;
  }

  async placePointAt(cartesian) {
    this.stop();
    await this._addPointEntity(cartesian);
  }

  // 批量增点模式：不 stop，保持引擎运行
  async addPassivePoint(cartesian) {
    await this._addPointEntity(cartesian);
  }

  _convertToGeoJsonCoords() {
    const verts = this._screenLockedMode ? this._lockedVertices : this.tempPoints;
    const toLngLat = (p) => {
      const carto = Cesium.Cartographic.fromCartesian(p);
      return [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)];
    };

    if (this.activeGeometryType === 'point') return toLngLat(verts[0]);

    const coords = verts.map(toLngLat);
    if (this.activeGeometryType === 'polygon') {
      coords.push(coords[0]);
      return [coords];
    }
    return coords;
  }

  // 完全销毁引擎：清理所有事件/订阅/标记（用于组件卸载等异常退出场景）
  destroy() {
    this.stop();
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
    this._stateListeners = [];
    this._completeListeners = [];
  }
}

export const drawEngine = new DrawEngine();