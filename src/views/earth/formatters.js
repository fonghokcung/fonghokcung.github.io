/* 面板数值格式化小工具 */

export const fmtInt = (n) => new Intl.NumberFormat('zh-CN').format(n);

// 金额（美元）人性化格式：万亿/亿单位
export function fmtUSD(n) {
  if (n == null) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} 万亿`;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  return fmtInt(n);
}
