/* 太阳/地球天文参数与赤纬计算 */

export const EARTH_TILT_DEG = 23.44; // 黄赤交角 ε（J2000 精确值 23°26′21.4″）

// 自转演示速度（度/真实秒）。换算「小时/秒」：每真实 1 秒模拟时间推进的小时数，
// 口径同 earth.mc665.cn。真实地球恒星日 = 23h56m = 23.9345h 转 360°
export const SPIN_DEG_PER_SEC = 18; // 每秒 18 经度
export const SPIN_HOURS_PER_SEC = ((SPIN_DEG_PER_SEC / 360) * 23.9345).toFixed(1); // '1.2'

/* 太阳赤纬角（度）：Cooper 近似公式。
 * δ = 23.44° × sin( 360°/365 × (N + 284) )，N = 一年中的第几天。
 * 决定太阳直射点纬度 = δ，亦即晨昏线与经线的夹角。
 * 春分 δ=0（晨昏线过两极⊥赤道）→ 夏至 +23.44°（北极极昼）→ 冬至 -23.44° */
export function solarDeclinationDeg(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return 23.44 * Math.sin(((360 / 365) * (dayOfYear + 284) * Math.PI) / 180);
}
