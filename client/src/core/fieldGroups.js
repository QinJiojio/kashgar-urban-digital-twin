/**
 * 字段前缀分组解析器
 * 约定：字段名以 "数字-" 开头为顶层分组，以 "数字.数字-" 开头为子分组
 * 例: "1-结构安全隐患" → 顶层分组
 *     "1.1-初筛有结构安全隐患" → 属于分组 "1" 的子字段
 */

export function parseFieldGroups(schema, groupsMeta = null) {
  if (!schema) return [];

  const fields = Object.entries(schema).filter(([key]) => key.toUpperCase() !== 'OBJECTID');
  // 解耦模型：任一字段带 group 元数据（含 null=基本信息），或显式传入 groupsMeta → 走存储模型
  const useStored = (Array.isArray(groupsMeta) && groupsMeta.length > 0)
    || fields.some(([, cfg]) => cfg && cfg.group !== undefined);
  return useStored ? parseFromMeta(fields, groupsMeta) : parseFromPrefix(fields);
}

// 旧模型：分组编码在字段名前缀里（1- / 1.1-）
function parseFromPrefix(fields) {
  const groups = {};  // { groupKey: { key, label, parentField, children: [{key, config}] } }
  const ungrouped = [];

  for (const [key, config] of fields) {
    // 匹配 "1-xxx" 或 "1.1-xxx" — 数字后跟 - 或 . 即为分组字段
    const topMatch = key.match(/^(\d+)(?:-|\.)/);
    if (topMatch) {
      const gk = topMatch[1];
      if (!groups[gk]) {
        groups[gk] = { key: gk, label: key, parentField: null, children: [], config: null };
      }
      const subMatch = key.match(/^\d+\.(\d+)-/);
      if (subMatch) {
        groups[gk].children.push({ key, config });
      } else {
        groups[gk].label = key;
        groups[gk].parentField = key;
        groups[gk].config = config;
      }
    } else {
      ungrouped.push({ key, config });
    }
  }

  const result = Object.values(groups).sort((a, b) => parseInt(a.key) - parseInt(b.key));
  for (const g of result) {
    if (!g.parentField) g.label = `分组 ${g.key}`;
  }
  if (ungrouped.length > 0) {
    result.unshift({ key: '__ungrouped__', label: '基本信息', parentField: null, children: ungrouped, config: null });
  }
  return result;
}

// 新模型：分组/顺序存在 schema 元数据里（字段 config.group / config.order + 顶层 groupsMeta）
// 兼容混合场景：部分字段带元数据、部分仅前缀（新增字段用元数据、旧字段保留前缀识别）
function parseFromMeta(fields, groupsMeta) {
  const groups = {};
  const ungrouped = [];

  // 先收集 groupsMeta 中的组定义（label / order），保证新老组的排序和标签一致
  const metaGroupDefs = new Map();
  if (Array.isArray(groupsMeta)) {
    groupsMeta.forEach(g => metaGroupDefs.set(g.id, g));
  }

  for (const [key, config] of fields) {
    let gid = config?.group;
    // 无显式 group → 尝试从字段名前缀反推（兼容旧字段）
    if (gid === undefined || gid === null) {
      const topMatch = key.match(/^(\d+)(?:-|\.)/);
      if (topMatch) gid = topMatch[1];
    }
    if (gid === undefined || gid === null) {
      ungrouped.push({ key, config, order: config?.order ?? 0 });
    } else {
      if (!groups[gid]) {
        // 标签：优先用 groupsMeta 里的 label，否则用数字编号
        const def = metaGroupDefs.get(gid);
        groups[gid] = { key: gid, label: def?.label || `分组 ${gid}`, parentField: null, children: [], config: null };
      }
      groups[gid].children.push({ key, config });
    }
  }
  // 组内字段按 order 排
  for (const gid in groups) {
    groups[gid].children.sort((a, b) => (a.config?.order ?? 0) - (b.config?.order ?? 0));
  }
  // 组顺序：优先用 groupsMeta order
  let result;
  if (metaGroupDefs.size > 0) {
    result = Object.values(groups).sort((a, b) => {
      const ao = metaGroupDefs.get(a.key)?.order ?? Infinity;
      const bo = metaGroupDefs.get(b.key)?.order ?? Infinity;
      return ao - bo;
    });
  } else {
    result = Object.values(groups).sort((a, b) => parseInt(a.key) - parseInt(b.key));
  }
  if (ungrouped.length > 0) {
    ungrouped.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    result.unshift({ key: '__ungrouped__', label: '基本信息', parentField: null, children: ungrouped, config: null });
  }
  return result;
}

/**
 * 收集分组中所有字段的 key (含父字段 + 子字段)
 */
export function getGroupFieldKeys(group) {
  const keys = [];
  if (group.parentField) keys.push(group.parentField);
  for (const child of group.children) {
    keys.push(child.key);
  }
  return keys;
}

/**
 * 检查分组是否需要自动展开：父字段值为 "True" 时强制展开
 */
export function shouldAutoExpand(group, featureProperties) {
  if (!group.parentField || !featureProperties) return false;
  return featureProperties[group.parentField] === 'True';
}

// 返回分组标题行应展示的布尔字段 key（新旧模型统一），null 表示非布尔分组
export function getHeaderBoolKey(group) {
  if (group.parentField && group.config?.format === 'boolean') return group.parentField;
  if (!group.parentField && group.children.length > 0) {
    const first = group.children[0];
    if (group.label === first.key && first.config?.format === 'boolean') return first.key;
  }
  return null;
}
