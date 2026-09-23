/* 噪声山脉：预生成闭合飞行路径，相机沿路径循环飞行。
 *
 * 地形：教科书经典 Perlin 2D（置换表 + 梯度插值）。CPU 与 GPU 共享同一张置换表，
 * 碰撞验证地图与屏幕显示地图严格一致——这是整条方案的地基。
 * 路径：随机游走控制点（部分航段沿等高线掠山腰）→ CatmullRomCurve3 闭合样条 →
 * 收敛（亏空回写）与下降松弛（尽量贴地）交替迭代。
 * 相机：沿样条推进，曲率自适应减速，视线 = 切线。
 */
import * as THREE from 'three';

/* ===================== Perlin 2D 噪声 ===================== */

// 置换表：0..255 的排列复制成 512，perlin() 中 p[p[X]+Y] 双层查表、索引免取模。
// 经典实现硬编码一张固定排列；这里用固定种子 LCG + Fisher-Yates 洗牌生成，
// 数学等价、数值可复现（刷新后地形不变），且避免手抄 256 个数字
const permBase = (() => {
  const arr = Array.from({ length: 256 }, (_, i) => i);
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0; // Numerical Recipes LCG
    return seed / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
})();
export const PERM = new Int32Array(512);
for (let i = 0; i < 512; i++) PERM[i] = permBase[i & 255];

// 整数坐标折回 [0,255]，负数也成立；与 GPU 侧 int(mod(floor(P), 256.0)) 等价
function mod256(x) {
  return ((Math.floor(x) % 256) + 256) % 256;
}

// fade：6t⁵−15t⁴+10t³。端点处一/二阶导为 0，格点间插值无接缝痕迹
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// 梯度：hash 低 3 bit → 8 个方向（4 轴向 + 4 对角）
// 0:(1,0) 1:(1,1) 2:(0,1) 3:(-1,1) 4:(-1,0) 5:(-1,-1) 6:(0,-1) 7:(1,-1)
function grad(hash, x, y) {
  switch (hash & 7) {
    case 0:
      return x;
    case 1:
      return x + y;
    case 2:
      return y;
    case 3:
      return -x + y;
    case 4:
      return -x;
    case 5:
      return -x - y;
    case 6:
      return -y;
    case 7:
      return x - y;
  }
}

function perlin(Px, Py) {
  // 方格左下角整数坐标（折回 0..255）+ 格内小数坐标
  const X = mod256(Px);
  const Y = mod256(Py);
  const x = Px - Math.floor(Px);
  const y = Py - Math.floor(Py);
  const u = fade(x);
  const v = fade(y);

  // 双层置换表查四角梯度哈希（aa=左下, ba=右下, ab=左上, bb=右上）
  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y];
  const bb = PERM[PERM[X + 1] + Y + 1];

  // 四角「梯度·偏移」贡献，fade 加权双线性插值（先 x 后 y）
  const n00 = grad(aa, x, y);
  const n10 = grad(ba, x - 1, y);
  const n01 = grad(ab, x, y - 1);
  const n11 = grad(bb, x - 1, y - 1);
  const x1 = n00 + (n10 - n00) * u;
  const x2 = n01 + (n11 - n01) * u;
  // 理论最大幅值 √2/2 ≈ 0.707；×1.4142 归一到约 [−1,1]
  return (x1 + (x2 - x1) * v) * 1.4142;
}

// fBm：3 倍频叠加（振幅减半、频率 ×2.03 + 偏移）。
// 倍频数必须与 noise-terrain.vert 的循环次数一致，否则 CPU/GPU 地形失配
function fbm(x, y) {
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < 3; i++) {
    v += a * perlin(x, y);
    const nx = x * 2.03 + 19.7;
    y = y * 2.03 + 7.3;
    x = nx;
    a *= 0.5;
  }
  return v;
}

// 地形基准频率：20 宽地形约 30 座基本山体。必须与 vert 的 #define FREQ 一致
const FREQ = 1.5;

// 山体世界高度：与顶点着色器 pos.z = (h−0.5)*0.9 = fbm*0.45 完全一致
export function terrainHeight(x, z) {
  return fbm(x * FREQ, z * FREQ) * 0.45;
}

export const CLEARANCE = 0.06; // 贴地净空：接受偶尔触山，宁可低不可高
const MAX_ABOVE = 0.25; // 控制点相对正下方地形的高度上限
const CONTROL_COUNT = 14; // 控制点少 → 样条弯曲更少、飞行更流畅

/* 生成闭合飞行路径（每次调用形状随机，页面生命周期内固定） */
export function buildFlightPath(radius = 1.7) {
  // —— a. 控制点随机游走。部分步数为贴山模式：沿等高线方向连续走 2~4 步；
  //     其余为穿越模式：±140° 随机转向。半径钳制在中心区域，远离地形边缘 ——
  const pts = [];
  let angle = Math.random() * Math.PI * 2;
  let r = radius * (0.5 + Math.random() * 0.4);
  let contourSteps = 0; // 贴山模式剩余步数
  for (let i = 0; i < CONTROL_COUNT; i++) {
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    pts.push(
      new THREE.Vector3(
        x,
        // 高度只允许落在「地面+净空 ~ 地面+上限」窄带内，起点就不允许飞高
        terrainHeight(x, z) +
          CLEARANCE +
          Math.random() * (MAX_ABOVE - CLEARANCE),
        z,
      ),
    );
    if (contourSteps > 0) {
      // 等高线方向 = 地形梯度 ∇h 旋转 90°，±35° 偏折；随机左旋/右旋，不恒定绕山
      const e = 0.05;
      const ghx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
      const ghz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
      const contourAngle =
        Math.atan2(ghx, -ghz) + (Math.random() < 0.5 ? 0 : Math.PI);
      angle = contourAngle + (Math.random() - 0.5) * ((Math.PI / 180) * 70);
      contourSteps--;
    } else {
      angle += (Math.random() - 0.5) * (Math.PI * 1.55);
      // 35% 概率进入贴山模式，持续 2~4 步 → 航段沿山腰滑行
      if (Math.random() < 0.35)
        contourSteps = 2 + Math.floor(Math.random() * 3);
    }
    r = THREE.MathUtils.clamp(
      r * (0.5 + Math.random()),
      radius * 0.2,
      radius * 0.55,
    );
  }

  const n = pts.length;
  let curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');

  // —— b. 收敛：对样条密集采样，亏空（地面+净空 − 点高度）回写到邻近控制点；
  //     每轮抬升后再硬钳回窄带——允许残留小亏空，也不许飞高。
  //     不设整圈兜底抬升：它曾把全程架到两三倍山高 ——
  const converge = () => {
    const SAMPLES = 1200; // 采样间距 ~0.015，间隙内偏差远小于净空
    for (let iter = 0; iter < 40; iter++) {
      const deficit = new Array(n).fill(0);
      for (let s = 0; s < SAMPLES; s++) {
        const t = s / SAMPLES;
        const p = curve.getPointAt(t);
        const lack = terrainHeight(p.x, p.z) + CLEARANCE - p.y;
        if (lack > 0) {
          const idx = Math.round(t * n) % n; // 亏空记给最近的控制点
          deficit[idx] = Math.max(deficit[idx], lack);
        }
      }
      if (Math.max(...deficit) === 0) break;
      for (let i = 0; i < n; i++) {
        if (deficit[i] > 0) {
          pts[i].y += deficit[i] * 1.2; // 违规点抬足，邻点分担（样条平滑）
          pts[(i - 1 + n) % n].y += deficit[i] * 0.6;
          pts[(i + 1) % n].y += deficit[i] * 0.6;
        }
        pts[i].y = THREE.MathUtils.clamp(
          pts[i].y,
          terrainHeight(pts[i].x, pts[i].z) + CLEARANCE,
          terrainHeight(pts[i].x, pts[i].z) + MAX_ABOVE,
        );
      }
      curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    }
  };
  converge();

  // —— c. 下降松弛：逐控制点尝试下压到地面，移动控制点影响 4 段样条（i−2→i+2），
  //     受影响段全部密集验证，违规则回退——只接受安全的下放 ——
  const relax = (step, rounds = 2) => {
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < n; i++) {
        const originalY = pts[i].y;
        pts[i].y = Math.max(
          originalY - step,
          terrainHeight(pts[i].x, pts[i].z) + CLEARANCE,
        );
        const test = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
        let unsafe = false;
        for (let seg = 0; seg < 4 && !unsafe; seg++) {
          const t0 = ((i - 2 + seg + n) % n) / n;
          for (let s = 0; s < 60; s++) {
            const p = test.getPointAt((t0 + s / 60 / n) % 1);
            if (p.y < terrainHeight(p.x, p.z) + CLEARANCE) {
              unsafe = true;
              break;
            }
          }
        }
        if (unsafe) pts[i].y = originalY;
      }
    }
  };
  relax(0.5);
  // —— d. 下降的牵动可能引入新亏空：补一轮收敛，再以小步长下降收尾，
  //     保证返回曲线的最后一步是下压而非抬升 ——
  curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  converge();
  relax(0.2, 1);
  return new THREE.CatmullRomCurve3(pts, true, 'centripetal');
}

/* ===================== 相机第三人称跟随直升机飞行 ===================== */
export class FlyCamera {
  constructor(camera, curve) {
    this.camera = camera;
    this.curve = curve;
    this.model = null; // 直升机模型（异步加载后赋值）；为空时退化为第一人称
    this.rotor = null; // 主旋翼节点（每帧绕竖直轴旋转）
    this.rotorSpeed = 30; // 旋翼角速度 rad/s（约 5 转/秒）
    this.t = 0; // 路径参数 [0,1)
    this.baseSpeed = 0.08; // 常速：每秒推进 1% 路径
    this.speed = this.baseSpeed; // 当前速度（向目标速度平滑趋近）
    this.minSpeedFactor = 0.2; // 急弯处最低速度 = 常速的 35%（直道全速，曲率线性插值）
    this.chaseDistance = 2.0; // 第三人称：相机在机尾后的水平距离
    this.chaseHeight = 0.8; // 第三人称：相机相对直升机的抬高量

    // 预采样曲率表：相邻采样点切线夹角 → 局部曲率 [0,1]
    const N = 200;
    this.curvature = new Float32Array(N);
    const tanPrev = curve.getTangentAt(0).clone();
    for (let i = 1; i <= N; i++) {
      const tan = curve.getTangentAt((i % N) / N);
      const dot = THREE.MathUtils.clamp(tanPrev.dot(tan), 0, 1);
      this.curvature[i % N] = THREE.MathUtils.clamp((1 - dot) * 30, 0, 1);
      tanPrev.copy(tan);
    }
    camera.position.copy(curve.getPointAt(0));
  }

  // 前视 5% 路径内的最大曲率：提前减速，到弯心时已慢下来
  curvatureAt(t) {
    const N = this.curvature.length;
    let c = 0;
    for (let k = 0; k <= 10; k++) {
      c = Math.max(c, this.curvature[Math.floor(((t + k / N) % 1) * N)]);
    }
    return c;
  }

  update(dt) {
    // 目标速度：曲率 0 → 全速；曲率 1 → 常速 × minSpeedFactor（急弯处最低速）
    const target =
      this.baseSpeed *
      (1 - (1 - this.minSpeedFactor) * this.curvatureAt(this.t));
    this.speed += (target - this.speed) * Math.min(1, dt * 2.5); // 指数阻尼，速度不跳变
    this.t = (this.t + this.speed * dt) % 1;

    // 主旋翼旋转（即使全貌模式不显示，也无需停止；显示时始终在转）
    if (this.rotor) this.rotor.rotation.y += dt * this.rotorSpeed;

    const pos = this.curve.getPointAt(this.t);
    // 运行时兜底：正常不触发（生成期已验证）；日后地形若改为动态，也保证不进山
    const ground = terrainHeight(pos.x, pos.z) + CLEARANCE;
    if (pos.y < ground) pos.y = ground;

    const tangent = this.curve.getTangentAt(this.t);

    // 直升机模型：位置贴路径点，机头朝向切线
    if (this.model) {
      this.model.position.copy(pos);
      this.model.lookAt(lookTargetTmp.copy(pos).add(tangent));
    }

    if (this.model) {
      // 第三人称：相机在机尾后上方，沿切线自然跟随起伏；
      // 后撤点可能低于地形（爬坡时），高度兜底防穿地
      chaseTmp.copy(pos).addScaledVector(tangent, -this.chaseDistance);
      chaseTmp.y = Math.max(
        pos.y + this.chaseHeight,
        terrainHeight(chaseTmp.x, chaseTmp.z) + CLEARANCE,
      );
      this.camera.position.copy(chaseTmp);
      lookTargetTmp.copy(pos).addScaledVector(tangent, 3); // 视线越过机头看前方
      this.camera.lookAt(lookTargetTmp);
    } else {
      // 模型未加载/不可用：退化为第一人称
      this.camera.position.copy(pos);
      lookTargetTmp.copy(pos).addScaledVector(tangent, 2);
      this.camera.lookAt(lookTargetTmp); // 视线 = 轨迹切线
    }
  }
}

const lookTargetTmp = new THREE.Vector3();
const chaseTmp = new THREE.Vector3();
