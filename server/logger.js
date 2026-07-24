// 轻量结构化日志：统一时间戳 + 标签格式
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const info = (tag, msg) => console.log(`[${ts()}] [${tag}] ${msg}`);
export const warn = (tag, msg) => console.warn(`[${ts()}] [${tag}] ${msg}`);
export const error = (tag, msg) => console.error(`[${ts()}] [${tag}] ${msg}`);
