# Architecture Decisions

> Key technical decisions, trade-offs, and design patterns behind this 3D urban digital twin platform.

## 1. Rendering-Interaction Separation

**Problem**: UAV tilt photography models (3D Tiles/B3DM) cover entire city blocks as single merged meshes. The B3DM batch tables contain only internal fragment IDs — no per-building identifiers. But the platform needs per-building click interaction, attribute editing, and search.

**Decision**: Two-layer proxy architecture:
- 3D Tiles layer handles visual rendering only (does not respond to clicks)
- GeoJSON extruded polygon layer (1% opacity, visually invisible) serves as the interaction proxy — reusing the entire Entity infrastructure (property panel, editing, search, filtering, thematic rendering, collaborative locks)

**Click passthrough**: `drillPick` (multi-object ray casting) replaces `pick` — filters out `Cesium3DTileFeature` results, returns the first `Cesium.Entity`.

**Why not rebuild B3DM with per-building batch table IDs**:
- Would require re-running the entire photogrammetry pipeline (3.1GB × 4 areas)
- Even after rebuilding, a GeoJSON layer is still needed for attribute management
- Cesium's batch table interaction is far less capable than the Entity system

## 2. Cesium Entity vs Primitive Performance Ceiling

**Problem**: 24,903 building entities. Each entity = independent JS object + Cesium Visualizer + GPU draw call. Style changes (opacity, fill color) take ~3 seconds.

| Dimension | Entity (current) | 3D Tiles (oblique photography) | Primitive (future) |
|-----------|-----------------|-------------------------------|-------------------|
| Features per draw call | 1 | N (batched) | N (batched) |
| Style change latency | ~3s (25K entities) | <1ms (uniform update) | <1ms |
| Interaction | Full | None | Custom (scene.pick + OBJECTID) |

**Decision**: After exhausting JS-level optimizations (precomputed colors, outline entity removal, material change detection), the ~3s ceiling is accepted as an architectural limitation of the Entity system. Further improvement requires migrating to `GeometryInstance + Primitive` (single draw call) — planned for future iteration.

**JS-level optimizations applied**:
- Uniform color precomputation outside entity loop (avoids 25K redundant `fromCssColorString` calls)
- heightField layers skip outline polyline entities entirely (halves render entity count)
- Color/width assignments guarded by change detection (avoids marking geometry dirty when unchanged)

## 3. requestRenderMode Cascading Effects

**Context**: `requestRenderMode: true` reduces Cesium's render rate from 60fps to ~2fps when idle (97% power savings). But it fundamentally changes what triggers a render cycle.

**Operations that require explicit `requestRender()`** (do NOT auto-trigger):

| Operation | Auto? | Fix |
|-----------|-------|-----|
| `viewer.entities.add/remove` | ✅ | — |
| Camera movement | ✅ (0.5s window) | — |
| `entity.show` toggle | ❌ | `requestRender()` |
| `DataSource.entities.removeById()` | ❌ | `requestRender()` |
| Thematic render (`applySymbology`) | ❌ | `requestRender()` |
| GPS position/orientation update | ❌ | `requestRender()` |
| `tileset.modelMatrix` change | ❌ | `requestRender()` + `makeStyleDirty()` |

**Critical discovery**: Setting `tileset.modelMatrix` alone does not trigger GPU update for already-loaded tiles. The setter calls `_updateTransforms()` (root-level only), but child tile GPU transforms need `makeStyleDirty()` to force a full tile tree traversal and content re-evaluation. Five failed approaches were attempted before reaching this solution.

**Bounding sphere trap**: `tileset.boundingSphere.center` is updated by Cesium after `modelMatrix` changes. Using it as a reference for the next height calculation causes alternating 2n-height jumps. Fix: save `tileset._baseCenter` at load time and use it for all subsequent calculations.

**API caveats**:
- **Never use `primitives.remove()`** — it always destroys the object (Cesium 1.139 has no `false` parameter)
- **Never manipulate `_primitives` internal array** — bypasses Cesium bookkeeping, causes duplicate references

## 4. Large-Layer Loading Optimization

For the 24,903-building residential layer (69MB GeoJSON, gzip 6.4MB):

| # | Optimization | Impact |
|---|-------------|--------|
| H1 | Schema inference de-nesting — read property names from 1st entity only | 1.6M → 66 `getValue()` calls |
| H2 | `CallbackProperty` for entity.description — generate InfoBox HTML on-demand | ~50MB memory saved |
| H4 | Extrude before adding DataSource to viewer — avoids flat→extruded geometry rebuild | 7.2s → 3.0s |
| D1 | Camera altitude culling — `DataSource.show = false` above 5km | GPU load 25K → 0 at city zoom |
| D2 | Strip empty properties during loading (null/''/无) | 36% fewer `ConstantProperty` objects |

## 5. 3D Tiles Tree Structure

The oblique photography tilesets use a nested 9-level LOD pyramid (not flat 2-level):
- Root `tileset.json` → external reference to `Block/tileset.json`
- Internal 9-level tree: L1:1 → L9:850 (1,668 b3dm files total)
- `skipLevelOfDetail: true` operates correctly — visible LOD transitions are Cesium skipping intermediate levels

**Batch table limitation**: All b3dm files contain only `fragmentId` — modeling software internal fragment numbers, not building IDs. This is the root cause requiring the rendering-interaction separation architecture.

## 6. Collaborative Editing Design

**Three-tier versioning**:
- Feature version (`layerId:featureId`): precise per-feature conflict detection
- Layer version (`layer:layerId`): structural change detection (schema, new/deleted features)
- Tree version (`_tree`): layer tree structure sync

**Attribute editing without locks**: Instead of holding locks during editing, the system checks versions at save time and auto-merges non-conflicting fields. Locks are only held for geometry editing (vertex/move/delete).

**Per-file mutex**: Server-side `withFileLock` ensures atomic read-modify-write for GeoJSON files.

## 7. Future Directions

- [ ] `GeometryInstance + Primitive` for large-layer rendering (single draw call)
- [ ] Full MultiPolygon/MultiLineString geometry support in saveFeature
- [ ] B3DM Draco compression (offline script, 3.1GB → estimated ~1.5GB)
- [ ] Semi-automated building footprint extraction from UAV orthophotos
- [ ] KTX2/Basis texture compression for GPU-direct sampling
