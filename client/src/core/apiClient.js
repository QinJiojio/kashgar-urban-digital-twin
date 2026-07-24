// 统一 API 客户端：消除重复的 token 读取和 headers 构造
const _token = () => sessionStorage.getItem('cesium_mvp_token') || '';

export const apiHeaders = (extra = {}) => {
  const h = { Authorization: `Bearer ${_token()}` };
  return { ...h, ...extra };
};
