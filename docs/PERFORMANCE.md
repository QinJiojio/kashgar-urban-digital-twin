# Performance Optimization: 8.5s → 4.4s

> Case study: 24,903 buildings with 66 fields each. GeoJSON file: 69MB (gzip 6.4MB).

## Profiling: Measure First

Before optimizing, systematic profiling was done to identify the real bottleneck:

| Phase | Time | % |
|-------|------|---|
| fetch + parse | 1,048ms | 12% |
| Entity creation (GeoJsonDataSource) | 2,526ms | 30% |
| Schema inference | ~1,600ms | 19% |
| Entity property loop | 312ms | 4% |
| **Extrusion (geometry rebuild)** | **4,637ms** | **54%** |

The biggest bottleneck was geometry rebuild -- Cesium creates flat polygons first, then rebuilds as extruded 3D solids.

## Optimizations Applied

### H1: Schema Inference De-nesting

Before: nested loop -- 66 fields × 24,903 entities = 1.6M `getValue()` calls.
After: read property names from the first entity only.
**Result: 0.06ms**

```js
// Before: O(fields × entities)
entities.forEach(ent => {
  propNames.forEach(name => {
    ent.properties[name].getValue();
  });
});

// After: O(fields)
const propNames = entities[0].properties.propertyNames;
```

### H2: Deferred Description HTML

Before: 24,903 pre-built HTML tables (~50MB memory).
After: `CallbackProperty` -- HTML generated only on InfoBox click.

```js
entity.description = new Cesium.CallbackProperty(() => {
  const props = entity.properties.getValue(time);
  let html = '<table>...';
  // Build HTML on-demand
  return html;
}, false);
```

### H4: Merge Extrusion with Entity Creation

The critical optimization. Before, entities were added to the viewer as flat polygons, then `extrudedHeight` was set -- triggering a full geometry rebuild for all 24,903 entities. After, `viewer.dataSources.add()` is deferred until AFTER extrusion is set:

```
Before: Load → Add to viewer (flat) → Set extrudedHeight (rebuild)
After:  Load → Set extrudedHeight → Add to viewer (extruded)
```

**Result: 7.2s → 3.0s (58% reduction in geometry computation)**

### D1: Altitude-based Culling

When camera altitude > 5km, `DataSource.show = false`. At city-wide zoom level, GPU load drops from 25K entities to 0.

### D2: Strip Empty Properties

36% of properties are empty (null, '', '无'). Filtered during loading. Saves 36% of `ConstantProperty` objects.

## Style Change Performance

After all JS-level optimizations, style changes (opacity, fill color) on 25K entities still take ~3s. This is a hard ceiling of Cesium's Entity system -- each entity is an independent draw call. Future direction: `GeometryInstance + Primitive` (single draw call for all buildings).

## Key Lessons

1. Always measure before optimizing -- 92% of time was in GPU actual-render, not JS
2. Understanding the internal pipeline (flat → extruded rebuild) is more valuable than generic optimization
3. Architecture-level changes (moving viewer.dataSources.add) have outsized impact vs micro-optimizations
