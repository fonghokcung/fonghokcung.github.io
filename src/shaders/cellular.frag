// BOS 第 11 章「噪声」开篇案例：Cellular Noise（细胞噪声 / Voronoi 图）
// 原理：每个网格格里随机撒一个"特征点"，每个像素计算自己到最近特征点的距离。
//       这张"最近距离图"就是距离场——特征点处最黑、格间竞争边界最亮，
//       多边形细胞边界不需要画，min 出来的距离场自己长出来。
// 练习约定：本文件继续使用 stpq 这组 swizzle

uniform float u_time;
varying vec2 vUv;

// 2D → 2D hash：比上一章 random 多返回一个维度。
// 两组不同的 dot 常数 ≈ 两个独立的一维 hash，分别充当代入点的 x 和 y
vec2 random2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

void main() {
  vec2 st = vUv;

  // 宽高比修正（约定同前：÷0.618 = ×1.618）
  st.s = st.s / 0.618;

  // Scale：放大 3 倍 → 画布纵向 3 格、横向约 4.85 格
  st *= 3.0;

  // Tile the space：floor/fract 分离（同 ikeda）
  //   i_st：像素所在格的整数坐标（整格共享 → 当 hash 种子）
  //   f_st：格内局部坐标 [0,1)（画格内细节）
  vec2 i_st = floor(st);
  vec2 f_st = fract(st);

  vec3 color = vec3(0.0);
  float m_dist = 1.0; // 最小距离，初始化为"不可能更远"的上限

  // 3×3 遍历：当前格 + 8 个邻居。
  // 最近的特征点可能落在隔壁格——只查本格，格边界会出现撕裂/错位
  for (int t = -1; t <= 1; t++) {
    for (int s = -1; s <= 1; s++) {
      // 邻居格相对当前格的偏移
      vec2 neighbor = vec2(float(s), float(t));

      // 邻居格的特征点随机位置 [0,1]²
      vec2 point = random2(i_st + neighbor);

      // Animate：两个分量各自的 sin 相位不同（由 point 的随机值决定），
      // 特征点在格内沿各自的 Lissajous 轨迹来回游走
      point = 0.5 + 0.5 * sin(u_time + 6.2831 * point);

      // 特征点相对像素的位置 = 格偏移 + 格内位置 - 像素格内坐标
      vec2 diff = neighbor + point - f_st;

      // 像素到该特征点的距离
      float dist = length(diff);

      // 保留更近的那个 → 9 个点中最近的距离
      m_dist = min(m_dist, dist);
    }
  }

  // 最近距离 → 灰度：特征点处 0（黑），竞争边界自然最亮
  color += m_dist;

  // 画特征点：离特征点极近（m_dist < 0.02）→ 白点
  color += 1.0 - step(0.02, m_dist);

  // 画网格线：格内坐标逼近 1（右/上边缘）→ 红线
  // color.r += step(0.98, f_st.s) + step(0.98, f_st.t);

  // 等高线版本（距离场的"等高线地图"，取消注释体验）：
  // color -= step(0.7, abs(sin(27.0 * m_dist))) * 0.5;

  gl_FragColor = vec4(color, 1.0);
}
