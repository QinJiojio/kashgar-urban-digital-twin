import * as Cesium from 'cesium';
import { getViewer, zoomToPoint } from './ViewerSetup';
import { mapState, getLayerState, showToast } from '../../store/mapState';
import { getLayer } from '../layers/LayerManager';
import { applySymbology } from '../symbology/ThematicRenderer';
import { acquireFeatureLock, releaseFeatureLock } from '../locks';

const IS_MOBILE = window.innerWidth < 768;
const PT = { control: IS_MOBILE ? 24 : 12, mid: IS_MOBILE ? 18 : 8, active: IS_MOBILE ? 28 : 16 };
import { saveFeature } from '../saveFeature';
import { watch } from 'vue';

class SpatialEditor {
  constructor() {
    this.viewer = null;
    this.handler = null;
    this.activeEntity = null;
    this.activeLayerId = null;
    this._lockedFeatureId = null;
    this._wasEdited = false;
    this.controlPoints = [];
    this.midPoints = [];
    this.draggedPoint = null;
    this._justDeleted = false;

    this.isActive = false;
    this.dynamicHierarchyProperty = null;
    this.watchStopHandle = null;

    this.lastInteractionTime = 0;
    this._longPressTimer = null;

    this.currentLayerOffset = 0.0;
    this.currentClampMode = 'absolute-plane';
    this.activeGeomType = 'polygon'; // 🌟 新增当前编辑类型
  }

  init() {
    this.viewer = getViewer();
    if (!this.viewer) return;
    
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
    
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this._bindEvents();

    if (!this.watchStopHandle) {
      this.watchStopHandle = watch(() => mapState.editor.isEditing, (isGlobalEditing) => {
        if (!isGlobalEditing) {
          if (this.isActive) this.deactivate();
          this._scrubMap(); 
        }
      });
    }
  }

  _scrubMap() {
    if (!this.viewer) return;
    const entities = this.viewer.entities.values.slice();
    entities.forEach(ent => {
      if (ent._isSpatialNode) {
        this.viewer.entities.remove(ent);
      }
    });
    this.controlPoints = [];
    this.midPoints = [];
  }

  async activate(entityId, layerId) {
    if (!this.viewer) this.init();

    this.deactivate();
    this._scrubMap();

    // 🌟 优先从该图层专属的 DataSource 查找，避免跨图层 ID 碰撞
    let entity = null;
    const layerDataSource = getLayer(layerId);
    if (layerDataSource instanceof Cesium.GeoJsonDataSource) {
      entity = layerDataSource.entities.getById(entityId);
    }
    if (!entity) entity = this.viewer.entities.getById(entityId);
    if (!entity) {
      for (let i = 0; i < this.viewer.dataSources.length; i++) {
        entity = this.viewer.dataSources.get(i).entities.getById(entityId);
        if (entity) break;
      }
    }

    if (!entity) {
      console.warn('[SpatialEditor] 未找到实体, entityId:', entityId);
      return;
    }

    const layerInfo = getLayerState(layerId);
    this.activeGeomType = layerInfo?.geometryType || 'polygon';

    // 🌟 核心解封：按类型校验实体是否存在
    if (this.activeGeomType === 'polygon' && !entity.polygon) {
      console.warn('[SpatialEditor] 实体无 polygon 属性, entity:', entity.id, 'hasPolygon:', !!entity.polygon);
      return;
    }
    if (this.activeGeomType === 'polyline' && !entity.polyline) return;
    if (this.activeGeomType === 'point' && !entity.position && !entity.billboard && !entity.point) return;

    // 获取要素锁（使用 OBJECTID 而非 Cesium entity UUID，确保跨会话一致）
    const props = entity.properties ? entity.properties.getValue(Cesium.JulianDate.now()) : {};
    const stableId = props.OBJECTID || entityId;
    const lockResult = await acquireFeatureLock(layerId, String(stableId));
    if (lockResult.error) { alert(lockResult.error); return; }
    if (lockResult.stale) {
      releaseFeatureLock(layerId, String(stableId));
      showToast('数据已被他人修改，正在刷新...', 'info', 0);
      const { reloadLayer } = await import('../layers/LayerManager.js');
      await reloadLayer(layerId);
      showToast('图层已刷新，请重新选中要素编辑', 'info', 2000);
      return;
    }
    this._lockedFeatureId = String(stableId);

    this.currentLayerOffset = layerInfo && layerInfo.heightOffset !== undefined ? Number(layerInfo.heightOffset) : 0.0;
    if (isNaN(this.currentLayerOffset)) this.currentLayerOffset = 0.0;
    this.currentClampMode = layerInfo && layerInfo.clampMode ? layerInfo.clampMode : 'absolute-plane';

    this.activeEntity = entity;
    this.activeLayerId = layerId;
    this.isActive = true;
    mapState.editor.activeTool = 'vertex';

    try {
      this._createControlPoints();
    } catch (e) {
      console.warn('[SpatialEditor] 控制点创建失败:', e);
      this.deactivate();
    }
  }

  async deactivate() {
    if (!this.isActive || !this.viewer) return;

    // 防 reloadLayer 后 entity 已销毁：按 OBJECTID 重新查找
    if (this.activeEntity?.isDestroyed?.() && this.activeLayerId && this._lockedFeatureId) {
      const ds = getLayer(this.activeLayerId);
      if (ds?.entities) {
        for (const e of ds.entities.values) {
          const p = e.properties?.getValue?.(Cesium.JulianDate.now()) ?? e.properties;
          if (p && String(p.OBJECTID) === this._lockedFeatureId) {
            this.activeEntity = e; break;
          }
        }
      }
    }

    this.viewer.scene.screenSpaceCameraController.enableInputs = true;

    // 先保存（entity 仍持有 CallbackProperty，几何未固化，保存失败可重试）
    if (this.activeLayerId && this._lockedFeatureId && this._wasEdited) {
      try {
        const saveResult = await saveFeature(this.activeLayerId, this._lockedFeatureId);
        if (!saveResult?.success) {
          showToast('保存几何失败，请重试', 'error', 3000);
          return false; // 保留控制点 + 编辑状态，用户可重试
        }
      } catch (e) {
        showToast('保存失败: ' + (e.message || '网络错误'), 'error', 3000);
        return false;
      }
    }

    const savedLayerId = this.activeLayerId;
    try {
      if (this.activeEntity && this.controlPoints.length > 0) {
        const validPoints = this.controlPoints.filter(p => p && p.position);
        const finalPositions = validPoints.map(p => p.position.getValue(Cesium.JulianDate.now()));

        // 保存成功后才固化坐标（CallbackProperty → 静态坐标）
        if (this.activeGeomType === 'polygon' && this.activeEntity.polygon) {
          if (this.activeEntity.polygon.hierarchy && this.activeEntity.polygon.hierarchy._isSpatialEditor) {
            this.activeEntity.polygon.hierarchy = new Cesium.PolygonHierarchy(finalPositions);
            if (this.activeEntity._outline) {
              this.activeEntity._outline.polyline.positions = [...finalPositions, finalPositions[0]];
            }
          }
        } else if (this.activeGeomType === 'polyline' && this.activeEntity.polyline) {
          this.activeEntity.polyline.positions = finalPositions;
        } else if (this.activeGeomType === 'point' && this.activeEntity.position) {
          this.activeEntity.position = finalPositions[0];
        }
      }
    } catch (error) {
      console.warn("[SpatialEditor] 固化坐标时出错:", error);
    } finally {
      this._scrubMap();
      this.dynamicHierarchyProperty = null;
      if (this.activeLayerId && this._lockedFeatureId) {
        releaseFeatureLock(this.activeLayerId, this._lockedFeatureId, false);
      }
      this._wasEdited = false;
      this.activeEntity = null;
      this.activeLayerId = null;
      this.draggedPoint = null;
      this.isActive = false;
      if (mapState.editor.activeTool === 'vertex') {
        mapState.editor.activeTool = null;
      }
    }
    // 恢复专题渲染样式（reloadLayer 后 entity 可能丢失了 ThematicRenderer 配色）
    if (savedLayerId) applySymbology(savedLayerId);
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    return true;
  }

  _createControlPoints() {
    const time = Cesium.JulianDate.now();
    let positions = [];

    // 1. 按几何类型提取初始坐标
    if (this.activeGeomType === 'polygon') {
      let hierarchy = this.activeEntity.polygon.hierarchy;
      positions = typeof hierarchy.getValue === 'function' ? hierarchy.getValue(time).positions : hierarchy.positions;
    } else if (this.activeGeomType === 'polyline') {
      let posProp = this.activeEntity.polyline.positions;
      positions = typeof posProp.getValue === 'function' ? posProp.getValue(time) : posProp;
    } else if (this.activeGeomType === 'point') {
      let p = this.activeEntity.position;
      positions = [typeof p.getValue === 'function' ? p.getValue(time) : p];
    }

    // 🌟 确定控制点的有效高度：优先使用 polygon 实体的 height 属性（由 updateLayerHeight 设定），
    // 否则取顶点自身的实际高度。避免控制点与 polygon 处于不同高度平面。
    if (this.activeGeomType === 'polygon' && this.activeEntity.polygon) {
      if (this.activeEntity.polygon.height !== undefined && this.activeEntity.polygon.height !== null) {
        this.currentLayerOffset = Number(this.activeEntity.polygon.height);
      } else if (positions.length > 0) {
        this.currentLayerOffset = Cesium.Cartographic.fromCartesian(positions[0]).height;
      }
    }

    // 生成绿色控制点
    positions.forEach((pos, index) => {
      let cartographic = Cesium.Cartographic.fromCartesian(pos);
      if (this.currentClampMode === 'absolute-plane') {
        cartographic.height = this.currentLayerOffset;
      }
      let adjustedPos = Cesium.Cartographic.toCartesian(cartographic);

      let point = this.viewer.entities.add({
        position: adjustedPos, 
        point: {
          pixelSize: PT.control,
          color: Cesium.Color.fromCssColorString('#10b981'), 
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY 
        }
      });
      point._isSpatialNode = true;
      point._nodeType = 'control';
      
      this.controlPoints.push(point);
    });

    // 2. 跨次元绑定：让实体坐标实时跟随控制点
    if (this.activeGeomType === 'polygon') {
      this.dynamicHierarchyProperty = new Cesium.CallbackProperty(() => {
        const validPoints = this.controlPoints.filter(p => p && p.position);
        const updatedPositions = validPoints.map(p => p.position.getValue(Cesium.JulianDate.now()));
        return new Cesium.PolygonHierarchy(updatedPositions);
      }, false);
      this.activeEntity.polygon.hierarchy = this.dynamicHierarchyProperty;
    } else if (this.activeGeomType === 'polyline') {
      this.dynamicHierarchyProperty = new Cesium.CallbackProperty(() => {
        const validPoints = this.controlPoints.filter(p => p && p.position);
        return validPoints.map(p => p.position.getValue(Cesium.JulianDate.now()));
      }, false);
      this.activeEntity.polyline.positions = this.dynamicHierarchyProperty;
    } else if (this.activeGeomType === 'point') {
      this.dynamicHierarchyProperty = new Cesium.CallbackProperty(() => {
        if(this.controlPoints[0] && this.controlPoints[0].position) {
           return this.controlPoints[0].position.getValue(Cesium.JulianDate.now());
        }
        return positions[0];
      }, false);
      this.activeEntity.position = this.dynamicHierarchyProperty;
    }
    
    this.dynamicHierarchyProperty._isSpatialEditor = true;
    this._updateMidPoints();
  }

  _updateMidPoints() {
    this.midPoints.forEach(p => this.viewer.entities.remove(p));
    this.midPoints = [];
    
    // 🌟 点要素没有中点，直接 return
    if (!this.isActive || this.controlPoints.length < 2 || this.activeGeomType === 'point') return;

    const len = this.controlPoints.length;
    const loopEnd = this.activeGeomType === 'polygon' ? len : len - 1; // 线不闭合

    for (let i = 0; i < loopEnd; i++) {
      const p1 = this.controlPoints[i];
      const p2 = this.controlPoints[(i + 1) % len]; 
      
      if (!p1 || !p2 || !p1.position || !p2.position) continue;

      const pos1 = p1.position.getValue(Cesium.JulianDate.now());
      const pos2 = p2.position.getValue(Cesium.JulianDate.now());

      if (Cesium.Cartesian3.distance(pos1, pos2) > 0.1) {
        const midPos = Cesium.Cartesian3.midpoint(pos1, pos2, new Cesium.Cartesian3());
        let midPoint = this.viewer.entities.add({
          position: midPos,
          point: {
            pixelSize: PT.mid,
            color: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.8),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
        
        midPoint._isSpatialNode = true;
        midPoint._nodeType = 'mid';
        midPoint._insertIndex = i + 1;
        
        this.midPoints.push(midPoint);
      }
    }
  }

  _deleteControlPoint(entity) {
    if (this.activeGeomType === 'polygon' && this.controlPoints.length <= 3) {
      alert("⚠️ 无法删除！多边形至少需要 3 个顶点。"); return;
    }
    if (this.activeGeomType === 'polyline' && this.controlPoints.length <= 2) {
      alert("⚠️ 无法删除！线段至少需要 2 个顶点。"); return;
    }
    if (this.activeGeomType === 'point') {
      alert("⚠️ 点要素不可删除顶点，仅支持拖拽移动！"); return;
    }
    const idx = this.controlPoints.indexOf(entity);
    if (idx > -1) {
      this.controlPoints.splice(idx, 1);
      this.viewer.entities.remove(entity);
      this._updateMidPoints();
      mapState.editor.isDirty = true;
      this._wasEdited = true;
    }
  }

  _bindEvents() {
    this.handler.setInputAction((event) => {
      if (!this.isActive) return;

      const pickedObject = this.viewer.scene.pick(event.position);
      if (Cesium.defined(pickedObject) && pickedObject.id) {
        const entity = pickedObject.id;
        
        if (entity._isSpatialNode) {
          this.lastInteractionTime = Date.now(); 
          
          if (entity._nodeType === 'mid') {
            const insertIdx = entity._insertIndex;
            let newPoint = this.viewer.entities.add({
              position: entity.position.getValue(Cesium.JulianDate.now()),
              point: {
                pixelSize: PT.active,
                color: Cesium.Color.RED,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
              }
            });
            newPoint._isSpatialNode = true;
            newPoint._nodeType = 'control';

            this.controlPoints.splice(insertIdx, 0, newPoint);
            this.draggedPoint = newPoint;
            this._wasEdited = true;
          } else if (entity._nodeType === 'control') {
            this.draggedPoint = entity;
            this.draggedPoint.point.color = Cesium.Color.RED;
            this.draggedPoint.point.pixelSize = PT.active;
            // 长按 600ms 删除控制点（移动端替代右键）
            this._longPressTimer = setTimeout(() => {
              if (this.draggedPoint === entity) {
                this._deleteControlPoint(entity);
                this.draggedPoint = null;
                this._longPressTimer = null;
                this._justDeleted = true;
                this.viewer.scene.screenSpaceCameraController.enableInputs = true;
              }
            }, 600);
          }
          
          this.viewer.scene.screenSpaceCameraController.enableInputs = false;
          mapState.editor.isDirty = true;
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    this.handler.setInputAction((event) => {
      if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
      if (!this.isActive || !this.draggedPoint) return;

      this.lastInteractionTime = Date.now();

      let cartesian = null;
      if (this.currentClampMode === 'absolute-plane') {
        const ray = this.viewer.camera.getPickRay(event.endPosition);
        cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene); 
      } else if (this.currentClampMode === 'clamp-to-model') {
        cartesian = this.viewer.scene.pickPosition(event.endPosition); 
        if (!Cesium.defined(cartesian)) {
          const ray = this.viewer.camera.getPickRay(event.endPosition);
          cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene);
        }
      }
      
      if (cartesian) {
        const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
        if (this.currentClampMode === 'absolute-plane') {
          cartographic.height = this.currentLayerOffset; 
        } else {
          cartographic.height += this.currentLayerOffset; 
        }
        this.draggedPoint.position = Cesium.Cartographic.toCartesian(cartographic);
        this._wasEdited = true;

        if (!mapState.editor.isDirty) {
          mapState.editor.isDirty = true;
        }
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
      if (this.draggedPoint) {
        this.lastInteractionTime = Date.now();
        this.draggedPoint.point.color = Cesium.Color.fromCssColorString('#10b981');
        this.draggedPoint.point.pixelSize = PT.control;
        this.draggedPoint = null;
        this._updateMidPoints();
      }
      this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    this.handler.setInputAction((event) => {
      if (!this.isActive) return;
      this.lastInteractionTime = Date.now();
      const pickedObjects = this.viewer.scene.drillPick(event.position);
      for (let i = 0; i < pickedObjects.length; i++) {
        const picked = pickedObjects[i];
        if (Cesium.defined(picked) && picked.id && picked.id._isSpatialNode && picked.id._nodeType === 'control') {
          this._deleteControlPoint(picked.id);
          break;
        }
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    
    this.handler.setInputAction((event) => {
      if (!this.isActive) return;
      if (Date.now() - this.lastInteractionTime < 250) return;

      const pickedObjects = this.viewer.scene.drillPick(event.position);
      let entity = null;
      let entityId = null;
      for (const picked of pickedObjects) {
        if (!Cesium.defined(picked) || !picked.id) continue;
        const e = picked.id;
        if (e._isSpatialNode) continue;
        // 实体加载时已注入 _layerId，直接判断是否属于 GeoJSON 图层
        if (e._layerId) {
          entity = e;
          entityId = e.id;
          break;
        }
      }
      if (!entity || !entityId) {
        if (this._justDeleted) { this._justDeleted = false; return; }
        this.deactivate();
        return;
      }
      if (this.activeEntity && entity.id === this.activeEntity.id) return;

      // 直接使用 entity._layerId（加载/创建时已注入），无需遍历搜索，也避免 OBJECTID 跨图层重复误匹配
      const targetLayerId = entity._layerId || null;
      if (targetLayerId) {
        mapState.interaction.selectedFeatureId = entityId;
        mapState.interaction.selectedLayerId = targetLayerId;
        this.activate(entityId, targetLayerId);
      } else {
        this.deactivate();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction((event) => {
      if (!mapState.editor.isEditing || this.isActive) return;

      const pickedObject = this.viewer.scene.pick(event.position);
      if (Cesium.defined(pickedObject) && pickedObject.id) {
        const entity = pickedObject.id;
        if (!entity.id || entity._isSpatialNode) return;

        const targetLayerId = entity._layerId || null;
        if (targetLayerId) {
          mapState.interaction.selectedFeatureId = entity.id;
          mapState.interaction.selectedLayerId = targetLayerId;
          this.activate(entity.id, targetLayerId);
        }
      } else {
        // 双击空白处：以点击点为中心放大 2x，保持当前视角/方位角
        zoomToPoint(this.viewer, event.position);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }
}

export const spatialEditor = new SpatialEditor();