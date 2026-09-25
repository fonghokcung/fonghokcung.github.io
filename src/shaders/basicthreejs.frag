// Circle wave —— @patriciogv (2015) 对 @beesandbombs processing 版的移植。
// 结构：iq 渐梯度噪声 + 极坐标波形调制圆环半径 + 内外相减描边
uniform float u_time;
uniform vec2 u_resolution; // 绘制缓冲尺寸（CSS 尺寸 × pixelRatio）
varying vec2 vUv; // 保留备用

// 每个整数格点一个 [−1,1]² 伪随机向量（经典 sin·大数 hash）
vec2 random2(vec2 st) {
  st = vec2(dot(st, vec2(127.1, 311.7)), dot(st, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(st) * 43758.5453123);
}

// Gradient Noise by Inigo Quilez — iq/2013
// 与 Perlin 同族：格点随机向量 · 该格内偏移量，点积后 smoothstep 权重双线性插值
float noise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      dot(random2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
      dot(random2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)),
      u.x
    ),
    mix(
      dot(random2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
      dot(random2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)),
      u.x
    ),
    u.y
  );
}

float shape(vec2 st, float radius) {
  st = vec2(0.5) - st; // 圆心移到画布中心
  float r = length(st) * 2.0; // 归一半径：中心 0，四角 ~1.41
  float a = atan(st.y, st.x); // 方位角
  // 沿角度的旋转行波：mod 周期化取中心对称 → m 随角度/时间波动
  float m = abs(mod(a + u_time * 2.0, 3.14 * 2.0) - 3.14) / 3.6;
  float f = radius;
  // m += noise(st + u_time * 0.1) * 0.5; // 噪声扰动行波强度
  // f += sin(a * 50.0) * noise(st) * 0.1; // 50 瓣高频细齿 × 噪声
  f = f + noise(st) * sin(a * 4.0 + u_time * 0.8) * 0.1;
  // f += sin(a * 20.0) * 0.1 * pow(m, 2.0); // 20 瓣低频起伏 × 行波包络
  // return 1.0 - smoothstep(f, f + 0.007, r); // 圆盘 + 0.007 软边抗锯齿
  return 1.0 - step(f, r);
}

float shapeBorder(vec2 st, float radius, float width) {
  return shape(st, radius) - shape(st, radius - width); // 外盘减内盘 = 描边
}

void main() {
  vec2 st = gl_FragCoord.xy / u_resolution.xy;
  vec3 color = vec3(1.0) * shape(st, 0.5);
  // vec3 color = vec3(1.0) * shapeBorder(st, 0.8, 0.02);
  gl_FragColor = vec4(1.0 - color, 1.0); // 反相输出：黑环白底
}
