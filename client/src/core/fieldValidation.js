// 字段格式校验 + 下拉"其他"组合框辅助（共享于 DataDetailPanel / DataTablePanel / MobileLayout）

export const validateFieldValue = (value, format, options = []) => {
  if (!format || format === 'text' || format === 'boolean' || format === 'image') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (format === 'int' && !/^-?\d+$/.test(s)) return '请输入整数';
  if (format === 'float' && !/^-?\d+\.?\d*$/.test(s)) return '请输入小数';
  if (format === 'percent') {
    const n = parseFloat(s);
    if (isNaN(n) || n < 0 || n > 100) return '请输入 0-100 的数字';
  }
  if (format === 'date' && !/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(s)) return '请输入 YYYY-MM-DD 格式的日期';
  if (format === 'daterange') {
    const parts = s.split(' ~ ');
    if (parts.length !== 2) return '请输入 YYYY-MM-DD ~ YYYY-MM-DD 格式的时间段';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0].trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(parts[1].trim())) return '日期格式错误，需为 YYYY-MM-DD';
    if (parts[0].trim() > parts[1].trim()) return '开始日期不能晚于结束日期';
    return null;
  }
  if (format === 'select' && options.length > 0) {
    if (options.includes(s)) return null;
    if (/^其他: /.test(s)) return null; // 自定义输入
    return `请选择预设值或输入自定义值`;
  }
  return null;
};

// 下拉"其他"组合框辅助（三个组件共用）
export const isSelectCustom = (val, options) => !!(val && !(options || []).includes(val));
export const getCustomPart = (val) => val?.startsWith('其他: ') ? val.slice(4) : (val || '');
export const selectDisplayVal = (val, options) => isSelectCustom(val, options) ? '__other__' : (val || '');
