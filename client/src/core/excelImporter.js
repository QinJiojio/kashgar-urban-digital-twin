import * as XLSX from 'xlsx';

/**
 * Excel 导入解析器
 * 自动探测分组模式（双行表头 / 前缀编码 / 单行平铺），解析字段、分组和数据行。
 *
 * 模式探测优先级：
 *   1. 双行表头：第1行含合并单元格 + 第2行全是字段名
 *   2. 前缀编码：第1行 ≥2 个字段匹配 /^\d+[.-]/
 *   3. 单行平铺：全部归入"基本信息"
 */

/**
 * 解析 Excel 文件，返回结构化结果
 * @param {File|ArrayBuffer} file - 文件对象或 ArrayBuffer
 * @returns {Promise<{mode, groups, fields, rows, totalRows, sheetName}>}
 */
export async function parseExcelFile(file) {
  const data = file instanceof ArrayBuffer ? file : await readFileAsArrayBuffer(file);
  const workbook = XLSX.read(data, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // 取原始范围
  const ref = sheet['!ref'];
  if (!ref) return { mode: 'flat', groups: [], fields: [], rows: [], totalRows: 0, sheetName };

  const range = XLSX.utils.decode_range(ref);
  const merges = sheet['!merges'] || [];

  // 读原始二维数组（包含合并单元格的空值）
  const rawMatrix = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      row.push(cell ? cell.v : undefined);
    }
    rawMatrix.push(row);
  }

  // 展开合并单元格（填充向右）
  const expanded = rawMatrix.map(row => [...row]);
  for (const merge of merges) {
    const val = rawMatrix[merge.s.r]?.[merge.s.c];
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (expanded[r]) expanded[r][c] = val;
      }
    }
  }

  // 如果只有 1 行（仅表头无数据）
  if (rawMatrix.length < 1) {
    return { mode: 'flat', groups: [], fields: [], rows: [], totalRows: 0, sheetName };
  }

  // ========= 模式探测 =========
  const headerRow0 = expanded[0] || [];
  const headerRow1 = expanded.length > 1 ? expanded[1] : null;
  const dataStartRow = detectMode(headerRow0, headerRow1, merges, rawMatrix);

  let mode, groups, fields;

  if (dataStartRow === 2) {
    // 方案 A：双行表头
    mode = 'double-row';
    const parsed = parseDoubleRowHeader(expanded[0], expanded[1]);
    groups = parsed.groups;
    fields = parsed.fields;
  } else if (dataStartRow === 1) {
    // 方案 B 或 C：根据前缀匹配数判断
    const prefixCount = headerRow0.filter(h => h !== undefined && h !== null && /^\d+[.-]/.test(String(h))).length;
    if (prefixCount >= 2) {
      mode = 'prefix';
      const parsed = parsePrefixHeader(headerRow0);
      groups = parsed.groups;
      fields = parsed.fields;
    } else {
      mode = 'flat';
      groups = [];
      fields = parseFlatHeader(headerRow0);
    }
  } else {
    // 退化：第一行就是数据（无表头）
    mode = 'flat';
    groups = [];
    fields = [];
  }

  // ========= 读数据行 =========
  const rows = [];
  for (let r = dataStartRow; r < expanded.length; r++) {
    const row = expanded[r];
    // 跳过全空行
    const allEmpty = row.every(c => c === undefined || c === null || String(c).trim() === '');
    if (allEmpty) continue;

    const props = {};
    for (let ci = 0; ci < fields.length; ci++) {
      const f = fields[ci];
      if (!f || f.skip) continue;
      let val = row[f.colIndex];
      if (val === undefined || val === null) {
        val = '';
      } else if (f.inferredType === 'date' && typeof val === 'number') {
        // XLSX 日期序列号转换
        val = excelDateToString(val);
      } else {
        val = String(val);
      }
      // 布尔值归一化：真值→True，其余一律→False
      if (f.inferredType === 'boolean' && val) {
        const truthy = ['true', 'TRUE', 'True', '是', '☑'];
        val = truthy.includes(val) ? 'True' : 'False';
      }
      props[f.key] = val;
    }
    rows.push(props);
  }

  // ========= 类型推断 =========
  inferFieldTypes(fields, rows);

  return { mode, groups, fields, rows, totalRows: rows.length, sheetName };
}

/**
 * 探测数据起始行
 * 返回 2 = 双行表头（第2行是字段名，数据从第3行开始）
 * 返回 1 = 单行表头（第1行是字段名，数据从第2行开始）
 * 返回 0 = 无表头（数据从第1行开始）
 */
function detectMode(headerRow0, headerRow1, merges, rawMatrix) {
  // 判断 row0 是否为分组名行（双行表头模式）
  // 条件：有合并单元格 OR row0 多为短文本 + row1 多为长文本
  if (headerRow1) {
    const hasMerges = merges.length > 0;
    // 检查 row0 非空值是否像分组名（不含 OBJECTID 这种字段名）
    const h0Values = headerRow0.filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    const h1Values = headerRow1.filter(v => v !== undefined && v !== null && String(v).trim() !== '');

    // row1 有更多、更具体的字段名
    const h1LooksLikeFields = h1Values.length >= h0Values.length
      && h1Values.some(v => /OBJECTID|FID|id|名称|编号|日期|面积|数量/i.test(String(v)));

    if (hasMerges || (h1LooksLikeFields && h0Values.length > 0)) {
      return 2;
    }
  }
  return 1;
}

/**
 * 方案 A：双行表头解析
 * row0 = 分组名（合并单元格已展开），row1 = 字段名
 */
function parseDoubleRowHeader(groupRow, fieldRow) {
  const groups = [];
  const groupMap = new Map(); // 分组名 → group 对象
  const fields = [];

  // 空白列跳过
  const validCols = [];
  for (let i = 0; i < fieldRow.length; i++) {
    if (fieldRow[i] !== undefined && fieldRow[i] !== null && String(fieldRow[i]).trim() !== '') {
      validCols.push(i);
    }
  }

  let groupOrder = 0;

  for (const ci of validCols) {
    let rawGroupName = groupRow[ci];
    if (rawGroupName !== undefined && rawGroupName !== null) {
      rawGroupName = String(rawGroupName).trim();
    } else {
      rawGroupName = '';
    }

    // 归一化分组名：剥离可能的数字前缀（如 "1-结构安全" → "结构安全"）
    const groupInfo = normalizeGroupName(rawGroupName);

    if (!groupMap.has(groupInfo.id)) {
      const groupObj = {
        id: groupInfo.id,
        label: groupInfo.label,
        order: groupOrder++,
      };
      groupMap.set(groupInfo.id, groupObj);
      groups.push(groupObj);
    }

    const fieldKey = String(fieldRow[ci]).trim();
    // 跳过 OBJECTID 列的独立处理（如果 Excel 明确标为 OBJECTID）
    const isOid = fieldKey.toUpperCase() === 'OBJECTID';

    fields.push({
      key: fieldKey,
      colIndex: ci,
      group: groupInfo.id,
      order: fields.filter(f => f.group === groupInfo.id).length,
      inferredType: 'text',
      skip: false,
      isOid,
    });
  }

  return { groups, fields };
}

/**
 * 方案 B：前缀编码解析
 * row0 = 含前缀的字段名（如 "1-结构安全隐患"、"1.1-初筛"）
 */
function parsePrefixHeader(headerRow) {
  const groups = [];
  const groupMap = new Map();
  const fields = [];
  let groupOrder = 0;

  for (let ci = 0; ci < headerRow.length; ci++) {
    const raw = headerRow[ci];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    const key = String(raw).trim();
    const topMatch = key.match(/^(\d+)(?:-|\.)/);

    let groupId = null; // null = 基本信息
    if (topMatch) {
      groupId = `g${topMatch[1]}`;
      if (!groupMap.has(groupId)) {
        const label = key.replace(/^\d+[.-]/, ''); // 去掉前缀
        groupMap.set(groupId, { id: groupId, label, order: groupOrder++ });
        groups.push({ id: groupId, label, order: groupOrder - 1 });
      }
    }

    fields.push({
      key,
      colIndex: ci,
      group: groupId,
      order: fields.filter(f => f.group === groupId).length,
      inferredType: 'text',
      skip: false,
      isOid: key.toUpperCase() === 'OBJECTID',
    });
  }

  return { groups, fields };
}

/**
 * 方案 C：单行平铺（无分组）
 */
function parseFlatHeader(headerRow) {
  const fields = [];
  for (let ci = 0; ci < headerRow.length; ci++) {
    const raw = headerRow[ci];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    const key = String(raw).trim();
    fields.push({
      key,
      colIndex: ci,
      group: null,
      order: ci,
      inferredType: 'text',
      skip: false,
      isOid: key.toUpperCase() === 'OBJECTID',
    });
  }
  return fields;
}

/**
 * 归一化分组名：支持数字前缀（1-xxx）或纯数字
 * 返回 { id: string, label: string }
 */
function normalizeGroupName(raw) {
  if (!raw) return { id: '__ungrouped__', label: '基本信息' };

  // 匹配 "1-结构安全" 或 "1.结构安全"
  const match = raw.match(/^(\d+)[.-]?\s*(.+)/);
  if (match) {
    return { id: `g${match[1]}`, label: match[2] };
  }

  // 匹配纯数字如 "1"
  const pureNum = raw.match(/^(\d+)$/);
  if (pureNum) {
    return { id: `g${pureNum[1]}`, label: `分组 ${pureNum[1]}` };
  }

  // 其他：用原始名做 id（kebab-case）
  return { id: raw, label: raw };
}

/**
 * 类型推断：读前 100 行的值，推断每个字段的类型
 */
function inferFieldTypes(fields, rows) {
  const SAMPLE_SIZE = 100;
  const sampleRows = rows.slice(0, SAMPLE_SIZE);

  for (const field of fields) {
    if (field.isOid) {
      field.inferredType = 'int';
      continue;
    }

    const values = sampleRows
      .map(r => r[field.key])
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '');

    if (values.length === 0) {
      field.inferredType = 'text';
      continue;
    }

    // 布尔检测：列中同时出现真值和假值即判定为勾选（-等其他符号一律作否）
    const trueSet = new Set(['是', '☑', 'True', 'TRUE', 'true']);
    const falseSet = new Set(['否', '☐', 'False', 'FALSE', 'false']);
    const hasTrue = values.some(v => trueSet.has(String(v)));
    const hasFalse = values.some(v => falseSet.has(String(v)));
    if (hasTrue && hasFalse) {
      field.inferredType = 'boolean';
      continue;
    }

    // 整数检测
    if (values.every(v => /^-?\d+$/.test(String(v).trim()))) {
      field.inferredType = 'int';
      continue;
    }

    // 浮点数检测
    if (values.every(v => /^-?\d+(\.\d+)?$/.test(String(v).trim()))) {
      field.inferredType = 'float';
      continue;
    }

    // 百分比检测
    if (values.every(v => /^-?\d+(\.\d+)?%$/.test(String(v).trim()))) {
      field.inferredType = 'percent';
      continue;
    }

    // 下拉选项检测：唯一值 ≤ 值的30% 且 ≤ 20 种
    const unique = new Set(values.map(v => String(v)));
    if (unique.size <= Math.min(values.length * 0.3, 20) && unique.size >= 2) {
      field.inferredType = 'select';
      field.inferredOptions = [...unique].slice(0, 50);
      continue;
    }

    field.inferredType = 'text';
  }
}

/**
 * 将 XLSX 日期序列号转为 'YYYY-MM-DD' 字符串
 */
function excelDateToString(serial) {
  // Excel 日期序列号从 1900-01-01 开始（注意 1900 年的闰年 bug：serial > 60 时偏移 +1）
  const epoch = Date.UTC(1900, 0, 1);
  let days = Math.floor(serial);
  // 处理 Excel 1900 年闰年 bug：1900-02-29 不存在，但 Excel 认为存在（serial=60）
  if (days > 60) days -= 1; // serial 61 实际是 1900-03-01
  const ms = epoch + (days - 1) * 86400000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 将 File 对象读取为 ArrayBuffer
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 校验并清洗解析结果，返回警告列表
 * @returns {string[]} warnings
 */
export function validateParseResult(parsed) {
  const warnings = [];

  // 重复字段名检测
  const seen = new Map();
  for (const f of parsed.fields) {
    if (seen.has(f.key)) {
      warnings.push(`字段名 "${f.key}" 重复（列 ${seen.get(f.key) + 1} 和 ${f.colIndex + 1}）`);
    }
    seen.set(f.key, f.colIndex);
  }

  // 数据行数警告
  if (parsed.totalRows === 0) {
    warnings.push('未检测到数据行');
  }
  if (parsed.totalRows > 50000) {
    warnings.push(`数据行数较多（${parsed.totalRows} 行），导入可能需要一些时间`);
  }

  // 分组名为空但非基本信息组
  for (const g of parsed.groups) {
    if (!g.label || g.label.trim() === '') {
      warnings.push(`存在空名称的分组（列顺序 ${g.order + 1}）`);
    }
  }

  return warnings;
}

// 导出类型标签映射（供 UI 使用）
export const TYPE_LABELS = {
  text: '文本',
  int: '整数',
  float: '小数',
  percent: '百分比',
  date: '日期',
  daterange: '时间段',
  select: '下拉选项',
  boolean: '布尔/勾选',
  image: '图片',
};

export const TYPE_OPTIONS = Object.keys(TYPE_LABELS);
