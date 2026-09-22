/* 噪声山脉相机漫游 v2：预生成确定性闭合飞行路径，相机循环飞行。
 *
 * 思路（生成期解决碰撞，运行期零避障）：
 *  1. terrainHeight：与 noise-terrain.vert 同参的 CPU 噪声复刻，供路径生成采样
 *  2. buildFlightPath：
 *     a. 水平面绕原点撒 N 个随机半径/角度的控制点
 *     b. 每个控制点高度 = 「该点与左右邻点」地形较高者 + 爬升 → 保证连弦两端够高
 *     c. 每段弦再采样验证：弦上任意点低于地形+净空 → 抬高两端点，迭代收敛
 *     d. CatmullRomCurve3(closed) 样条 → 闭合圆滑曲线
 *  3. FlyCamera.update：t 匀速推进（0→1 循环），位置 = 曲线取点，视线 = 曲线切线
 *     曲线点全部位于山体上方，故天然永不碰撞
 */
import * as THREE from 'three';

/* —— Simplex 2D 噪声：与 noise-terrain.vert 的 GLSL snoise 逐项同构 ——
 * 此前这里复刻的是老版 value noise，而显示端已升级 Simplex——
 * 两套地形高度完全对不上，路径验证等于对错误地图修路（撞山根因） */
const C1 = 0.211324865405187; // (3-√3)/6
const C2 = 0.366025403784439; // (√3-1)/2
const C4 = 0.024390243902439; // 1/41

function fract(x) {
  return x - Math.floor(x);
}
function mod289(x) {
  return x - Math.floor(x * (1 / 289)) * 289;
}
// permute(x) = mod289((x*34+10)*x)
function permute(x) {
  const y = (x * 34 + 10) * x;
  return y - Math.floor(y * (1 / 289)) * 289;
}

function snoise(vx, vy) {
  // 斜切 + 所在单纯形判定（与 GLSL 逐行对应）
  const s = (vx + vy) * C2;
  const ix = Math.floor(vx + s);
  const iy = Math.floor(vy + s);
  const t = (ix + iy) * C1;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = 1 - i1x;
  const x1x = x0x - i1x + C1;
  const x1y = x0y - i1y + C1;
  const x2x = x0x - 1 + 2 * C1;
  const x2y = x0y - 1 + 2 * C1;

  // 置换表取三角点梯度索引
  const my = mod289(iy);
  const mx = mod289(ix);
  const p0 = permute(permute(my) + mx);
  const p1 = permute(permute(my + i1y) + mx + i1x);
  const p2 = permute(permute(my + 1) + mx + 1);

  // 径向衰减核 m⁴
  let m0 = Math.max(0.5 - (x0x * x0x + x0y * x0y), 0);
  let m1 = Math.max(0.5 - (x1x * x1x + x1y * x1y), 0);
  let m2 = Math.max(0.5 - (x2x * x2x + x2y * x2y), 0);
  m0 *= m0;
  m0 *= m0;
  m1 *= m1;
  m1 *= m1;
  m2 *= m2;
  m2 *= m2;

  // 梯度方向（12 方向 2D 投影）+ 归一化修正 + 梯度点积
  const f0 = 2 * fract(p0 * C4) - 1;
  const f1 = 2 * fract(p1 * C4) - 1;
  const f2 = 2 * fract(p2 * C4) - 1;
  const h0 = Math.abs(f0) - 0.5;
  const h1 = Math.abs(f1) - 0.5;
  const h2 = Math.abs(f2) - 0.5;
  const a0 = f0 - Math.floor(f0 + 0.5);
  const a1 = f1 - Math.floor(f1 + 0.5);
  const a2 = f2 - Math.floor(f2 + 0.5);
  const K1 = 1.79284291400159;
  const K2 = 0.85373472095314;
  m0 *= K1 - K2 * (a0 * a0 + h0 * h0);
  m1 *= K1 - K2 * (a1 * a1 + h1 * h1);
  m2 *= K1 - K2 * (a2 * a2 + h2 * h2);

  const g0 = a0 * x0x + h0 * x0y;
  const g1 = a1 * x1x + h1 * x1y;
  const g2 = a2 * x2x + h2 * x2y;
  return 130 * (m0 * g0 + m1 * g1 + m2 * g2);
}

// fBm：3 倍频叠加，与顶点着色器同参（振幅减半、频率 ×2.03 + 偏移）。
// 倍频数必须与 noise-terrain.vert 的 fbm 循环次数严格一致，否则碰撞地图失配
function fbm(x, y) {
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < 3; i++) {
    v += a * snoise(x, y);
    const nx = x * 2.03 + 19.7;
    y = y * 2.03 + 7.3;
    x = nx;
    a *= 0.5;
  }
  return v;
}

// 山体高度（世界空间）：与顶点着色器 height(pos.xy*FREQ) → z=(h-0.5)*0.9 完全一致，
// 即 z = fbm*0.45（fbm∈[−1,1] → [−0.45,0.45]）。
// FREQ 必须与 noise-terrain.vert 的 #define FREQ 严格一致，否则碰撞地图失配
const FREQ = 1.5;
export function terrainHeight(x, z) {
  return fbm(x * FREQ, z * FREQ) * 0.45;
}

const CLEARANCE = 0.07; // 路径与山体的净空（贴山掠行）
const CLIMB_BASE = 0.03; // 基础爬升
const CONTROL_COUNT = 14; // 控制点更多 → 弯曲更细碎

/* 生成确定性闭合飞行路径（每次调用随机形状不同，同一页面生命周期内固定） */
export function buildFlightPath(radius = 1.7) {
  // —— a. 水平控制点：随机游走（非均匀绕圈）→ S 弯/回旋，打破恒定右转。
  //     起点在随机方位，后续每点在上一点基础上「角度随机进退、半径大幅波动」，
  //     最后一点自动闭合回起点附近 ——
  const pts = [];
  let angle = Math.random() * Math.PI * 2;
  let r = radius * (0.5 + Math.random() * 0.4);
  for (let i = 0; i < CONTROL_COUNT; i++) {
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    pts.push(
      new THREE.Vector3(
        x,
        terrainHeight(x, z) + CLEARANCE + CLIMB_BASE * Math.random(),
        z,
      ),
    );
    // 步进角度：大范围随机（±140°），产生左弯/右弯交替；
    // 步进半径：±50% 波动。钳制在 [20%, 55%]——路径远离地形边缘（地形半宽 5），
    // 边缘方向始终有足够地形被雾吞掉，消除「出界」感
    angle += (Math.random() - 0.5) * (Math.PI * 1.55);
    r = THREE.MathUtils.clamp(
      r * (0.5 + Math.random()),
      radius * 0.2,
      radius * 0.55,
    );
  }

  // —— b. 收敛循环：对【最终样条】采样验证，违规则回写抬升量到邻近控制点，
  //     重建样条再验证——样条本身的下探也被纳入闭环 ——
  const n = pts.length;
  let curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  let worst = 0; // 全程最大亏空（兜底判断用）
  for (let iter = 0; iter < 40; iter++) {
    // 采样当前样条，找出每个控制点邻域内的最大亏空量
    const deficit = new Array(n).fill(0);
    const SAMPLES = 600;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / SAMPLES;
      const p = curve.getPointAt(t);
      const ground = terrainHeight(p.x, p.z);
      const lack = ground + CLEARANCE - p.y;
      if (lack > 0) {
        // 把亏空记到最近的控制点（参数 t × n 即点索引的浮点位置）
        const idx = Math.round(t * n) % n;
        deficit[idx] = Math.max(deficit[idx], lack);
      }
    }
    worst = Math.max(...deficit);
    // 无任何亏空 → 曲线全程安全，完成
    if (worst === 0) break;
    // 抬升：违规控制点抬足亏空，其左右邻分担一半（样条平滑需要）
    for (let i = 0; i < n; i++) {
      if (deficit[i] > 0) {
        pts[i].y += deficit[i] * 1.2;
        pts[(i - 1 + n) % n].y += deficit[i] * 0.6;
        pts[(i + 1) % n].y += deficit[i] * 0.6;
      }
    }
    curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  }
  // —— c. 兜底：迭代未收敛（样条改动互相牵制）→ 整圈统一抬到最坏亏空之上 ——
  if (worst > 0) {
    for (const p of pts) p.y += worst * 1.3;
  }
  // —— d. 下降松弛：安全前提下尽量下压路径，找回「山腰飞行」的低空感 ——
  //     逐控制点尝试下放，若引发样条违规则回退；两轮足够收敛
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      const originalY = pts[i].y;
      pts[i].y = Math.max(
        originalY - 0.5,
        terrainHeight(pts[i].x, pts[i].z) + CLEARANCE,
      ); // 激进下探 0.5
      const test = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
      let unsafe = false;
      // 只验证该点前后 1/3 圈（局部影响域），40 采样足够
      for (let s = 0; s < 40; s++) {
        const t = (((i - 1 + n) % n) + (s / 40) * 3) % n;
        const p = test.getPointAt(t / n);
        if (p.y < terrainHeight(p.x, p.z) + CLEARANCE) {
          unsafe = true;
          break;
        }
      }
      if (unsafe) pts[i].y = originalY; // 回退
    }
  }
  return new THREE.CatmullRomCurve3(pts, true, 'centripetal');
}

/* 相机沿路径循环飞行 */
export class FlyCamera {
  constructor(camera, curve) {
    this.camera = camera;
    this.curve = curve;
    this.t = 0; // 路径参数 [0,1)
    this.baseSpeed = 0.015; // 常速：每秒推进 1.5% 路径
    this.speed = this.baseSpeed; // 当前速度（向目标速度平滑趋近）
    this.minSpeedFactor = 0.005; // 急弯处最低速 = 常速的 35%

    // —— 预采样曲率表：相邻采样点切线夹角 → 局部弯曲度 [0,1] ——
    const N = 200;
    this.curvature = new Float32Array(N);
    const tanPrev = curve.getTangentAt(0).clone();
    for (let i = 1; i <= N; i++) {
      const tan = curve.getTangentAt((i % N) / N);
      // 夹角越小曲率越大：1 - dot 归一到 [0,1]（dot∈[cos45°≈0.707, 1] → [0,1] 放大）
      const dot = THREE.MathUtils.clamp(tanPrev.dot(tan), 0, 1);
      this.curvature[i % N] = THREE.MathUtils.clamp((1 - dot) * 30, 0, 1);
      tanPrev.copy(tan);
    }

    const p0 = curve.getPointAt(0);
    camera.position.copy(p0);
  }

  // 查曲率表（t 邻域取最大值，提前减速：还差一段才到弯心就开始慢）
  curvatureAt(t) {
    const N = this.curvature.length;
    let c = 0;
    for (let k = 0; k <= 10; k++) {
      // 向前看 10/200 = 5% 路径
      c = Math.max(c, this.curvature[Math.floor(((t + k / N) % 1) * N)]);
    }
    return c;
  }

  update(dt) {
    // —— 目标速度 = 常速 × (1 − 0.65×曲率)：直道全速，急弯降到 35% ——
    const target =
      this.baseSpeed *
      (1 - this.minSpeedFactor * this.curvatureAt(this.t) * 1.65);
    // 速度本身平滑趋近（指数阻尼），避免进出弯的速度跳变
    this.speed += (target - this.speed) * Math.min(1, dt * 2.5);
    this.t = (this.t + this.speed * dt) % 1;
    const pos = this.curve.getPointAt(this.t);
    const tangent = this.curve.getTangentAt(this.t); // 切线 = 视线方向
    this.camera.position.copy(pos);
    lookTargetTmp.copy(pos).addScaledVector(tangent, 2);
    this.camera.lookAt(lookTargetTmp);
  }
}

const lookTargetTmp = new THREE.Vector3();
