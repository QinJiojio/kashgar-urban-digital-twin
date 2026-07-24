# 平台架构知识库

> **文档用途**：记录 cesium-mvp 项目中的架构决策、技术权衡、设计模式和深层认知。CLAUDE.md 是"怎么做"的操作手册，本文档是"为什么这么做"的知识沉淀。
>
> **读者**：AI（下次会话）+ 项目开发者
>
> **维护规则**：每次做出影响架构的决策后，在对应主题章节追加条目，标注日期。

---

## 1. 渲染与交互分离

> 核心矛盾：无人机倾斜摄影模型（3D Tiles/B3DM）精度高，但以片区为单位（单个 tileset），不能识别单体楼栋。平台需要逐栋交互（点击弹属性、编辑、搜索），但 b3dm 的 batch table 只有 fragmentId，不含楼栋标识。

### 决策：无人机模型纯渲染 + GeoJSON 挤出层纯交互

- **日期**：2026-07-23
- **方案**：
  - 3D Tiles 图层负责视觉呈现（不响应点击）
  - GeoJSON 挤出图层（透明度 1%）作为交互代理层——复用全部 entity 基础设施
  - 点击穿透：`drillPick` 替代 `pick`，过滤掉 `Cesium3DTileFeature`，取第一个 `Cesium.Entity`
- **为什么不用方案 B（重建 b3dm 嵌入 batch table）**：
  - 需要回建模软件重新跑 3.1GB×4 个片区的倾斜摄影流程
  - 做完后仍需要 GeoJSON 管理属性和编辑——只是推迟了做这个
  - Cesium 的 batch table 交互远不如 entity 体系（无属性编辑、无协同锁、无过滤、无专题渲染）
- **优缺点**：详见 2026-07-23 会话讨论
- **后续演进**：可从无人机正射影像半自动提取更精确的楼栋轮廓，逐步替换当前 GeoJSON

---

## 2. Cesium Entity vs Primitive 性能边界

> 核心矛盾：Entity 系统每个 entity = 独立 JS 对象 + Visualizer + GPU draw call。25K entity 样式变更 ~3s。3D Tiles 百万级特征因为走 Primitive 管道（共享 Material、批量 draw call）。

### 现状认知

| 维度 | Entity（当前挤出图层） | 3D Tiles（倾斜摄影） | Primitive（未来方向） |
|------|----------------------|---------------------|---------------------|
| 单次 draw call 要素数 | 1 | N（批量） | N（批量） |
| 样式变更耗时 | ~3s（25K entity） | <1ms（改 uniform） | <1ms |
| 交互能力 | 完整（pick/属性/编辑/协同） | 无（仅 Cesium3DTileFeature） | 需手动实现（scene.pick + 查 OBJECTID） |
| 数据来源 | GeoJSON | b3dm | 任意 |

### 决策：大图层不做 style 实时变更优化

- **日期**：2026-07-22
- **为什么**：Entity 系统的 ~3s 是架构硬上限，JS 层优化（颜色预计算、outline 跳过、material change detection）已经到顶。进一步优化需要换 Primitive 管道——留作未来方向。
- **相关尝试**：渐进式分帧渲染（suspendEvents/resumeEvents 分批）——放弃，首次加载会变慢。最终保留一次性同步渲染。
- **后续方向**：`GeometryInstance + PerInstanceColorAppearance` 方案（1 次 draw call），需自定义 picking 层

---

## 3. requestRenderMode 的深度影响

> 核心认知：`requestRenderMode: true` 省电 97%，但改变了 Cesium 的渲染触发模型。任何"非标准变更"都需要手动干预。

### 已知影响面（截至 2026-07-23）

| 操作 | 自动触发？ | 修复方式 |
|------|----------|---------|
| `viewer.entities.add/remove` | ✅ 自动 | — |
| 相机移动 | ✅ 自动（0.5s 窗口） | — |
| `entity.show` 切换 | ❌ | `requestRender()` |
| `DataSource.entities.removeById()` | ❌ | `requestRender()` |
| Label entity show 切换 | ❌ | `requestRender()` |
| 专题渲染 applySymbology | ❌ | `requestRender()` |
| 顶点编辑退出 | ❌ | `requestRender()` |
| 点要素放置 | ❌ | `requestRender()` |
| GPS 位置/方向更新 | ❌ | `requestRender()` |
| 图层可见性切换 | ❌ | `requestRender()` ×2 |
| `tileset.modelMatrix` 变更 | ❌ | `requestRender()` + `makeStyleDirty()` |
| `tileset.maximumScreenSpaceError` 变更 | ❌ | `requestRender()`（setter 仅写内部字段，2026-07-24 补） |

### 关键教训

- **仅设 `tileset.modelMatrix` 不会触发 GPU 更新**（2026-07-23）：`modelMatrix` setter 只调 `_updateTransforms()`（root 级），子 tile 的 GPU 变换需要 `makeStyleDirty()` 强制完整遍历。尝试过的失败方案：splice/_primitives（destroy 对象）、remove/add（remove 必 destroy）、show 翻转（无渲染周期）、trimLoadedTiles + 心跳（requestRenderMode 只给 1 帧）
- **`tileset.boundingSphere.center` 在 modelMatrix 变更后会被 Cesium 更新**（2026-07-23）：导致 2n 次交替偏移。解决：加载时保存 `_baseCenter`
- **严禁操作 `_primitives` 内部数组**：绕过 Cesium bookkeeping 会产生重复引用
- **严禁使用 `primitives.remove()`**：总是销毁对象，Cesium 1.139 无 `false` 参数

---

## 4. 大图层性能优化模式

### 加载时优化（城镇住宅 24,903 栋）

- **H1: Schema 推断去嵌套**：从 `fields × entities` 双重循环改为只读首 entity 的 propertyNames。消除 160 万次 `getValue()` 调用。
- **H2: Description 按需构建**：`CallbackProperty` 替代预建 HTML table。省 ~50MB 常驻内存。
- **H4: 挤出在 DataSource 加入 viewer 前完成**：避免 Cesium 先建 flat 再重建 extruded（7.2s → 3.0s）
- **D1: 相机距离裁剪**：海拔 >5km 设 `DataSource.show = false`。DataSource 级操作，避免 per-entity 迭代。
- **D2: Strip 空属性**：加载时过滤 null/''/无，省 36% `ConstantProperty` 对象。
- **Hierarchy 缓存**：`_hierarchyPositions` 避免 applySymbology 中重复 `getValue()`
- **挤出与 entity 创建交叉进行**：DataSource 不在 viewer 中时设置 `extrudedHeight`——Cesium 一次建 extruded 几何，不重建

### 样式渲染优化

- 非专题模式预计算 uniform 颜色到循环外
- heightField 图层跳过 outline polyline entity（省 24K entity）
- 颜色/宽度仅在值变化时赋值（跳过 dirty 标记）
- 已知限制：~3s actual-render 是 Entity 系统硬上限

---

## 5. 3D Tiles 树结构认知

### 倾斜摄影 tileset 结构（山水文园为例）

- **不是扁平 2 层树**：外部 tileset.json 引用 + 嵌套子节点形成完整 9 层 LOD 金字塔
- 根 tileset.json → `Block/tileset.json`（外部引用）→ 第 1 层 b3dm → 嵌套 children → 逐级展开
- 1,668 个 b3dm，L1:1 → L9:850
- `skipLevelOfDetail: true` 正常工作——用户看到的 4-5 次清晰度变化即 Cesium 跳过中间级的效果
- **Batch table 只有 fragmentId**：建模软件内部碎片编号，不是楼栋 ID。这就是为什么不能靠 batch table 做单体交互
- box bounding volume 的 half-extents 是 **模型局部空间**的尺寸，不是 ECEF

### 单体建筑模型 vs 倾斜摄影

- URL 含 `"buildings/"` → Model Entity 路径（`transform` 存在时）
- 否则 → 标准 Cesium3DTileset 路径
- `v-if="activeNode.transform"` 防止给倾斜摄影注入假 transform

### tileset 缓存与遍历参数（2026-07-24 确认）

- **Cesium 1.127+ 缓存为字节制**：`cacheBytes`（默认 512MB）+ `maximumCacheOverflowBytes`（默认 512MB）。旧 `maximumMemoryUsage` 在 1.139 **静默失效**（无警告）——代码原设 4096 从未生效，所有 tileset 一直跑在 512MB 默认缓存
- 决策：桌面端 1536MB/512MB，移动端 512MB/256MB（UA + deviceMemory 探测），按设备自适应
- `preferLeaves: true`：跳级加载时优先叶子 tile——配合 skipLevelOfDetail，主观变清晰更快
- `foveatedScreenSpaceError: true`：注视点渲染，与 dynamicScreenSpaceError 正交叠加。若实测出现边缘模糊不回填可关闭
- SSE 滑块 UI 层对数映射（桌面 8↔0.01，默认 2.0 约在 21% 处；移动端三档 8/2/0.5），`currentQuality` 保持 SSE 原始语义

---

## 6. 协同编辑版本体系

> 详见 CLAUDE.md "协同编辑架构"章节。此处仅记录架构层面的设计理念。

### 为什么是两层版本

- 要素版本（`layerId:featureId`）：精确检测单个要素冲突，避免其他要素修改误判
- 图层版本（`layer:layerId`）：兜底检测结构变更（schema 改、新增/删除）
- 聚焦时检测 stale（图层级，轻量），保存前走 conflict（要素级，精确）

### 关键设计决策

- 属性编辑去要素锁：不长期持有锁，只查版本。聚焦时记录 `focusedField`，保存前检测冲突 → 自动合并非冲突字段
- `markSaved` 本地版本先 bump：在 await fetch 之前同步更新，消除 yield 窗口
- `reloadLayer` 后必须用 OBJECTID 遍历查找 entity（旧 Cesium ID 已随 DataSource 销毁）

---

## 7. 图层加载管线

### 加载顺序为什么重要

1. GeoJSON 加载 → DataSource 创建
2. Entity 属性设置（`_layerId`, `_hierarchyPositions`, extrudedHeight）
3. Schema 推断 + 格式加载
4. Entity 元数据循环（outline, description, featureList）
5. DataSource 加入 viewer（**最后一步**）
6. applySymbology + syncVersions

### 为什么 DataSource 要在最后加入 viewer

确保 Cesium 首次创建几何体时，所有属性（特别是 `extrudedHeight`）已就位。如果先加入再设属性 → Cesium 创建 flat 几何 → 设置 `extrudedHeight` 触发二次重建。

> **2026-07-24 修正**：代码曾一度在 per-entity 循环和 `applySymbology` 之前就 add（H4 只覆盖了 extrudedHeight），导致 24K entity 在场景内再经历 outline true→false 翻转和材质二次赋值。现已将 `viewer.dataSources.add()` 移到 `applySymbology` 之后——材质/outline/挤出全部在入场景前定型，几何一次成型。

---

## 8. 渲染 vs 交互分离的模式

### 当前使用的分离模式

| 表面 | 渲染层 | 交互层 | 备注 |
|------|--------|--------|------|
| 楼栋 | 3D Tiles（倾斜摄影） | GeoJSON entity（1% 透明） | drillPick 穿透 |
| 属性展示 | entity.description（CallbackProperty） | Vue 属性面板 | 按需生成，不预建 |
| 轮廓高亮 | entity._highlight（Polyline） | scene.pick 选中 | disableDepthTest 防遮挡 |

---

## 9. 待决策 / 待探索

- [ ] GeometryInstance + Primitive 方案替代 Entity 做大图层渲染（待实现）
- [ ] 多部件几何完整支持（当前 saveFeature 只写单部件，服务端防腐拦截）
- [ ] B3DM Draco 压缩（离线脚本，3.1GB → 预计 ~1.5GB）
- [ ] 从无人机正射影像提取楼栋轮廓（半自动）
- [ ] KTX2/Basis 纹理压缩（GPU 直接采样，显存省 3-6x）
- [ ] 3D Tiles 1.1 + implicit tiling（新导入模型可考虑）

---

> **更新日志**：
> - 2026-07-23：初版，涵盖挤出图层优化、3D Tiles 高度偏移、渲染交互分离、requestRenderMode 深度影响
> - 2026-07-24：tileset cacheBytes 字节制确认（maximumMemoryUsage 静默失效）、SSE 滑块对数映射、加载管线 applySymbology 前置修正、preferLeaves/foveated 启用、zoomToVisibleLayers 用 hierarchy 缓存
