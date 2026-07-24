# Multi-User Collaborative Editing System

> 5 departments simultaneously editing 25,000+ buildings without data conflicts.

## Architecture

Three-tier versioning system to detect changes at different granularities:

| Tier | Key | Trigger | Usage |
|------|-----|---------|-------|
| Feature | `layerId:featureId` | Every PATCH/DELETE | Precise per-feature conflict detection |
| Layer | `layer:layerId` | PATCH/DELETE/schema change | Structural change detection (new/deleted features) |
| Tree | `_tree` | Config changes, reorder | Layer tree structure sync |

## Lock Lifecycle

```
Focus on field → Check stale (layer-level, lightweight)
Save field   → Check conflict (feature-level, precise)
               ↓
         Stale detected?
         ↓ Yes          ↓ No
    Reload layer    Save normally
    Auto-merge      (PATCH ~5KB)
    non-conflicting
    fields
```

## Conflict Auto-Resolution

When a stale is detected during save, the system doesn't just show an error -- it attempts automatic resolution:

1. Reload the latest data from server
2. Compare the server's current value with the original value when the user started editing
3. If server value == original (field NOT modified by others) → re-apply user's edit + retry save
4. If server value ≠ original (field WAS modified by others) → show conflict warning

This means most conflicts are resolved silently. Only true simultaneous edits to the same field trigger a user-facing notification.

## Backend: Per-File Mutex

GeoJSON files are protected by `withFileLock` mutations:

```js
const done = await withFileLock(filePath, async () => {
  const data = JSON.parse(await fs.readFile(filePath));
  // Atomic read-modify-write
  const feature = data.features.find(f => f.properties.OBJECTID === id);
  Object.assign(feature.properties, patch);
  await fs.writeFile(filePath, JSON.stringify(data));
});
```

## Why Not WebSockets?

The platform uses PATCH-based optimistic locking rather than WebSocket real-time sync. This was a deliberate choice:
- The data changes infrequently (building attributes don't update every second)
- PATCH is simpler to debug, deploy, and reason about
- Users in government offices often have unreliable networks -- optimistic locking is more resilient

## Key Design Decisions

1. **Attribute editing doesn't hold locks** -- only check versions. Geometry editing (vertex/move/delete) does hold locks because geometry changes are harder to auto-merge.

2. **`markSaved` bumps local version BEFORE releasing server lock** -- eliminates the yield window where your own save triggers your own stale detection.

3. **After `reloadLayer`, always find entities by OBJECTID traversal** -- old Cesium entity IDs are destroyed with the previous DataSource.
