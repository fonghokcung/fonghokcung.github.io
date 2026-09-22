uniform float u_time;
varying float vHeight; // 海拔 [0,1]
varying vec3 vNormal; // 中心差分法线（世界近似）
varying vec2 vPos; // 平面局部坐标（供片元等高线/调试）
varying vec3 vViewPos; // 相机空间位置（片元算距离雾用）

// ===================== Simplex 2D 噪声（Ian McEwan / Ashima Arts 标准实现） =====================
// 与 value noise 的本质区别：格点存随机「梯度向量」而非数值，
// 单纯形（三角形）晶格代替方格 → 无轴对齐伪影，输出 [−1,1]

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}
vec2 mod289(vec2 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}
vec3 permute(vec3 x) {
  return mod289((x * 34.0 + 10.0) * x);
}

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187, // (3.0 - sqrt(3.0)) / 6.0  格点偏移
    0.366025403784439, // 0.5 * (sqrt(3.0) - 1.0)  斜切量
    -0.577350269189626, // -1.0 + 2.0 * C.x
    0.024390243902439 // 1.0 / 41.0               置换表步长
  );
  // 斜切正方形→单纯形网格：s = (x+y)*F2
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx); // 回到未斜切空间的相对坐标

  // 判断落在哪个单纯形三角形（下三角 or 上三角）
  vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);

  // 三个角点的未斜切坐标
  vec2 x1 = x0 - i1 + C.xx;
  vec2 x2 = x0 - 1.0 + 2.0 * C.xx;

  // 置换表取三个角点的随机梯度索引
  i = mod289(i);
  vec3 p = permute(
    permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0)
  );

  // 三个角点的梯度（12 个方向的 2D 投影）与贡献
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  m = m * m;
  m = m * m;

  // 梯度表：permute 结果映射到方向向量
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;

  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h); // 归一化修正

  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.y = a0.y * x1.x + h.y * x1.y;
  g.z = a0.z * x2.x + h.z * x2.y;

  return 130.0 * dot(m, g); // [−1,1]
}

// fBm：4 倍频叠加，振幅减半频率翻倍（Simplex 版）
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * snoise(p);
    p = p * 2.03 + vec2(19.7, 7.3);
    a *= 0.5;
  }
  return v; // 约 [−1,1]
}

// 高度函数：单一入口，法线差分也调它，保证一致
float height(vec2 p) {
  return fbm(p + vec2(u_time * 0.02, 0.0)) * 0.5 + 0.5; // → [0,1]
}

void main() {
  vec3 pos = position; // PlaneGeometry 默认 xy 平面
  float h = height(pos.xy * 3.0);
  pos.z = (h - 0.5) * 0.9; // 抬升为地形高度
  vHeight = h;
  vPos = pos.xy;

  // 中心差分求法线：对高度函数在邻域采样
  float e = 0.02;
  float hx = height((pos.xy + vec2(e, 0.0)) * 3.0);
  float hy = height((pos.xy + vec2(0.0, e)) * 3.0);
  // z = (h-0.5)*0.9 → dz/de ≈ (h邻-h本)*0.9/e；法线 = -dh/dx, -dh/dy, 1
  vec3 n = normalize(vec3(-(hx - h) * 0.9 / e, -(hy - h) * 0.9 / e, 1.0));
  vNormal = n;

  vViewPos = (modelViewMatrix * vec4(pos, 1.0)).xyz; // 相机空间坐标，-z 为前向距离
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
