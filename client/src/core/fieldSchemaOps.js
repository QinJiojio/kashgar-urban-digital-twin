// 字段 Schema 操作（共享于 DataTablePanel / MobileSchemaEditor 等）
// 解耦后：新模型图层（fieldGroupsMeta 存在）用干净字段名 + group/order 元数据；
// 旧模型图层（无元数据）保留名字前缀路径，逐步迁移。
import { fieldSchema, fieldGroupsMeta, saveFieldFormat, getLayerState } from '../store/mapState';

// 判断图层是否已用"解耦"新模型（有分组元数据，含 group=null 即"基本信息"）
// group !== undefined 足以区分新旧：旧字段无 group 属性(undefined)，新字段有 group(null 或字符串)
export const isDecoupledLayer = (layerId) => {
  if (Array.isArray(fieldGroupsMeta[layerId])) return true;
  const schema = fieldSchema[layerId] || {};
  return Object.values(schema).some(c => c && c.group !== undefined);
};

// 旧模型：按分组选择器把字段名拼成带前缀的 key（与历史逻辑一致）

// 新模型：计算字段应归入的 group id 及其在组内 order，并在选"新分组"时产出新增的 group。
// groupSel: '' = 基本信息(null) / 已有组 id / '__new__'
export function resolveGroupAssignment(layerId, groupSel, newGroupLabel) {
  const groups = (fieldGroupsMeta[layerId] || []).map(g => ({ ...g }));
  const schema = fieldSchema[layerId] || {};
  let groupId = null;
  let addedGroup = null;

  if (groupSel === '__new__') {
    // 生成唯一 group id（g + 最大数字 +1）
    let maxN = 0;
    for (const g of groups) { const m = String(g.id).match(/^g(\d+)$/); if (m) maxN = Math.max(maxN, parseInt(m[1])); }
    groupId = `g${maxN + 1}`;
    const maxOrder = groups.reduce((mx, g) => Math.max(mx, g.order ?? 0), -1);
    addedGroup = { id: groupId, label: (newGroupLabel || `分组 ${maxN + 1}`).trim(), order: maxOrder + 1 };
    groups.push(addedGroup);
  } else if (groupSel && groupSel !== '') {
    groupId = groupSel;
  } // else 基本信息 → null

  // 组内 order = 该组现有字段数（追加到末尾）
  let order = 0;
  for (const k in schema) {
    const g = schema[k]?.group ?? null;
    if (g === groupId) order++;
  }
  return { groupId, order, groups }; // groups 为含新增组的完整列表（写回 saveFieldFormat 用）
}

// 在新模型图层上：把"加字段"产生的元数据（字段 group/order + 可能的新 group）持久化到 schema 文件。
// 注意：字段属性键已由调用方通过 PUT /api/layers/:id/schema action=add 写入 GeoJSON；此处只补元数据。
export async function persistNewFieldMeta(layerId, cleanKey, format, groupId, order, groupsFull) {
  const schema = fieldSchema[layerId] || {};
  // 构造完整 fields（保留已有，追加新字段的 group/order/format/label）
  const fields = {};
  for (const k in schema) {
    if (k.toUpperCase() === 'OBJECTID') continue;
    const c = schema[k] || {};
    fields[k] = { label: c.label || k, ...(c.format ? { format: c.format } : {}), ...(c.options ? { options: c.options } : {}),
                  group: c.group ?? null, order: c.order ?? 0 };
  }
  fields[cleanKey] = { label: cleanKey, ...(format ? { format } : {}), group: groupId, order };
  // 始终传 groupsMeta：null 时传当前值，避免覆盖丢失已有分组标签
  const groups = groupsFull || fieldGroupsMeta[layerId] || [];
  await saveFieldFormat(layerId, fields, groups);
}

// 计算"在 afterKey 列之后插入"的归组与中点 order：
// group = afterKey 所在组；order = (afterKey.order + 同组紧邻右邻.order)/2（无右邻则 afterKey.order+1）
export function computeInsertOrder(layerId, afterKey) {
  const schema = fieldSchema[layerId] || {};
  // 插到最前：归基本信息组（group=null），order 比该组现有最小 order 还小
  if (afterKey === '__head__') {
    let minOrder = Infinity;
    for (const k in schema) {
      if (k.toUpperCase() === 'OBJECTID') continue;
      if ((schema[k]?.group ?? null) !== null) continue;
      minOrder = Math.min(minOrder, schema[k]?.order ?? 0);
    }
    return { group: null, order: (minOrder === Infinity ? 0 : minOrder) - 1 };
  }
  const a = schema[afterKey];
  if (!a) return null;
  const group = a.group ?? null;
  const leftOrder = a.order ?? 0;
  // 同组中 order 严格大于 leftOrder 的最小者 = 紧邻右邻
  let rightOrder = null;
  for (const k in schema) {
    if (k === afterKey || k.toUpperCase() === 'OBJECTID') continue;
    if ((schema[k]?.group ?? null) !== group) continue;
    const o = schema[k]?.order ?? 0;
    if (o > leftOrder && (rightOrder === null || o < rightOrder)) rightOrder = o;
  }
  const order = rightOrder === null ? leftOrder + 1 : (leftOrder + rightOrder) / 2;
  return { group, order };
}
