import path from 'path';

const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const _normDataDir = path.normalize(path.resolve(DATA_DIR));

// 统一路径遍历保护：将用户传入的相对路径解析为绝对路径，确保在 DATA_DIR 内
// 返回解析后的绝对路径；路径越界抛出 Error
export const validateDataPath = (relativePath) => {
  // 剥离可能的 /data/ 或 data/ 前缀
  const clean = relativePath.replace(/^\/?data\//, '').replace(/^\//, '');
  const abs = path.resolve(DATA_DIR, clean);
  if (!path.normalize(abs).startsWith(_normDataDir + path.sep) && abs !== _normDataDir) {
    throw new Error('非法文件路径');
  }
  return abs;
};
