uniform float u_time;
uniform sampler2D uPermTex; // 置换表纹理（256×1，R 通道存表项 0..255）
varying float vHeight; // 海拔 [0,1]
varying vec3 vNormal; // 中心差分法线（世界近似）
varying vec2 vPos; // 平面局部坐标（供片元等高线/调试）
varying vec3 vViewPos; // 相机空间位置（片元算距离雾用）

// ===================== 教科书经典 Perlin 2D（Ken Perlin Improved Noise 结构） =====================
// 与 fly-camera.js 的 JS perlin() 严格同构（同一张置换表、同一个梯度集、同一个归一系数）。
// 四步：整数坐标折回 256 → fade 曲线 → p[p[X]+Y] 查四角梯度 → 双线性插值。
// 注：GLSL ES 1.00 没有位运算符（&），用 mod 代替；没有 switch，用 if 链

// 查表：索引折回 0..255 后取纹理像素中心（half-texel 偏移，避免线性过滤串色）。
// 表项以 byte 存在 R 通道，采样值是 归一化 float，乘 255 取整即还原原值
int permAt(int i) {
  int idx = int(mod(float(i), 256.0));
  vec2 uv = vec2((float(idx) + 0.5) / 256.0, 0.5);
  return int(floor(texture2D(uPermTex, uv).r * 255.0 + 0.5));
}

int mod256(float n) {
  return int(mod(floor(n), 256.0)); // GLSL mod 对负数也给正值，与 JS ((%256)+256)%256 等价
}

float fade(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); // 6t⁵−15t⁴+10t³
}

// 梯度函数：hash 低 3 bit → 8 方向（4 轴向 + 4 对角）
// 0:(1,0) 1:(1,1) 2:(0,1) 3:(-1,1) 4:(-1,0) 5:(-1,-1) 6:(0,-1) 7:(1,-1)
float grad(int hash, float x, float y) {
  int h = int(mod(float(hash), 8.0));
  if (h == 0) return x;
  if (h == 1) return x + y;
  if (h == 2) return y;
  if (h == 3) return -x + y;
  if (h == 4) return -x;
  if (h == 5) return -x - y;
  if (h == 6) return -y;
  return x - y;
}

float perlin(float Px, float Py) {
  // 1. 方格左下角整数坐标（折回 0..255）+ 格内小数坐标
  int X = mod256(Px);
  int Y = mod256(Py);
  float x = Px - floor(Px);
  float y = Py - floor(Py);
  // 2. fade 曲线
  float u = fade(x);
  float v = fade(y);
  // 3. 双层置换表查四角梯度哈希（aa=左下, ba=右下, ab=左上, bb=右上）
  int aa = permAt(permAt(X) + Y);
  int ab = permAt(permAt(X) + Y + 1);
  int ba = permAt(permAt(X + 1) + Y);
  int bb = permAt(permAt(X + 1) + Y + 1);
  // 4. 四角贡献 + 双线性插值：先 x 后 y
  float n00 = grad(aa, x, y);
  float n10 = grad(ba, x - 1.0, y);
  float n01 = grad(ab, x, y - 1.0);
  float n11 = grad(bb, x - 1.0, y - 1.0);
  float x1 = n00 + (n10 - n00) * u;
  float x2 = n01 + (n11 - n01) * u;
  // 2D Perlin 理论最大幅值 √2/2 ≈ 0.707；×1.4142 归一到约 [−1,1]
  return (x1 + (x2 - x1) * v) * 1.4142;
}

// fBm：3 倍频叠加，振幅减半频率翻倍。
// 倍频数与 fly-camera.js 的 fbm 严格同步！最高倍频波长 = 1/(1.5×2.03²) ≈ 0.16，
// 顶点间距 0.039（512 段）→ 4 采样/波长，无混叠棱角
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * perlin(p.x, p.y);
    p = p * 2.03 + vec2(19.7, 7.3);
    a *= 0.5;
  }
  return v; // 约 [−1,1]
}

// 地形基准频率：20 宽地形 ×1.5 → 疏朗开阔。必须与 fly-camera.js 的 FREQ 严格一致！
#define FREQ 1.5

// 高度函数：单一入口，法线差分也调它，保证一致。
// 注意：不许含任何随时间变化的项（CPU 侧 terrainHeight 无从验证动态地形）
float height(vec2 p) {
  return fbm(p) * 0.5 + 0.5; // → [0,1]
}

void main() {
  vec3 pos = position; // PlaneGeometry 默认 xy 平面
  float h = height(pos.xy * FREQ);
  pos.z = (h - 0.5) * 0.9; // 抬升为地形高度
  vHeight = h;
  vPos = pos.xy;

  // 中心差分求法线：对高度函数在邻域采样。
  // e 取顶点间距量级（0.039）：比网格更细的差分只会采样到网格表现不了的细节，
  // 法线与几何脱节 → 明暗碎噪
  float e = 0.05;
  float hx = height((pos.xy + vec2(e, 0.0)) * FREQ);
  float hy = height((pos.xy + vec2(0.0, e)) * FREQ);
  // z = (h-0.5)*0.9 → dz/de ≈ (h邻-h本)*0.9/e；法线 = -dh/dx, -dh/dy, 1
  vec3 n = normalize(vec3(-(hx - h) * 0.9 / e, -(hy - h) * 0.9 / e, 1.0));
  vNormal = n;

  vViewPos = (modelViewMatrix * vec4(pos, 1.0)).xyz; // 相机空间坐标，-z 为前向距离
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
