/* URL 查询串 ?date= 解析：支持两种写法。
 *   完整日期：?date=2026-06-21（- 或 / 分隔、单位数月日皆可）
 *   快捷序号：?date=1 春分 / 2 夏至 / 3 秋分 / 4 冬至（默认当前年）
 * 无参数/非法 = 真实今天。
 * 返回 { date, text }：date 为中午 12:00 的 Date（避免跨时区日界），
 * text 为标准「YYYY-MM-DD」展示串；无参数时 text=null（用真实今天） */

export const SOLSTICE_DATES = ['03-20', '06-21', '09-23', '12-21']; // 1春分 2夏至 3秋分 4冬至

export function parseSimDate(search = location.search) {
  const urlDate = new URLSearchParams(search).get('date') || '';
  const shortcut = /^[1-4]$/.test(urlDate) ? +urlDate : 0; // 快捷序号 1-4（0=非快捷）
  const dateMatch = urlDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const simYear = dateMatch ? +dateMatch[1] : new Date().getFullYear();
  const ymdStr = shortcut
    ? `${simYear}-${SOLSTICE_DATES[shortcut - 1]}` // 快捷序号 → 当年对应节气日
    : dateMatch
      ? `${dateMatch[1]}-${String(+dateMatch[2]).padStart(2, '0')}-${String(+dateMatch[3]).padStart(2, '0')}`
      : null;
  const date = ymdStr
    ? new Date(+ymdStr.slice(0, 4), +ymdStr.slice(5, 7) - 1, +ymdStr.slice(8, 10), 12)
    : new Date();
  return { date, text: ymdStr };
}
