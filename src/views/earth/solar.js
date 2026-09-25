/* 太阳/地球天文参数与公转角度 */

export const EARTH_TILT_DEG = 23.44; // 黄赤交角 ε（J2000 精确值 23°26′21.4″）

// 自转演示速度（度/真实秒）。换算「小时/秒」：每真实 1 秒模拟时间推进的小时数，
// 口径同 earth.mc665.cn。真实地球恒星日 = 23h56m = 23.9345h 转 360°
export const SPIN_DEG_PER_SEC = 18; // 每秒 18 经度
export const SPIN_HOURS_PER_SEC = ((SPIN_DEG_PER_SEC / 360) * 23.9345).toFixed(1); // '1.2'

/* 公转角度 θ（弧度）：夏至 = 0，从北黄极（+Y）俯视逆时针推进，每天 2π/365。
 * 太阳方向 = (−cosθ, 0, sinθ)，始终在黄道面（xoz 平面）内：
 *   夏至 −X（北极倾向太阳，赤纬 +ε）→ 秋分 +Z → 冬至 +X（赤纬 −ε）→ 春分 −Z。
 * 赤纬 δ 是这个几何关系的自然结果：sinδ = 地轴·sunDir = sinε·cosθ，
 * 与 Cooper 近似公式 δ = ε·sin(2π(N+284)/365) 等价（偏差 < 0.5°）。 */
const SUMMER_SOLSTICE_DAY = 172; // 夏至 ≈ 6 月 21 日 = 第 172 天
export function orbitalAngle(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return ((dayOfYear - SUMMER_SOLSTICE_DAY) / 365) * 2 * Math.PI;
}
