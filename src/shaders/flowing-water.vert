uniform float u_time;
varying float vWave; // 波高（片元做泡沫/配色）
varying vec3 vNormal; // 中心差分法线
varying vec3 vViewPos; // 相机空间位置（片元算距离雾）

// 波高场：三层方向不同的正弦波叠加（方向·频率·振幅·速度各异），
// 小振幅波用正弦即可；大浪才需 Gerstner（波峰更尖、有水平位移）
float waveHeight(vec2 p, float t) {
  float h = 0.0;
  h += sin(dot(p, normalize(vec2(1.0, 0.3))) * 1.2 + t * 1.4) * 0.12;
  h += sin(dot(p, normalize(vec2(-0.4, 1.0))) * 1.8 + t * 1.9) * 0.07;
  h += sin(dot(p, normalize(vec2(0.7, -0.8))) * 2.8 + t * 2.6) * 0.035;
  return h;
}

void main() {
  vec3 pos = position;
  float h = waveHeight(pos.xy, u_time);
  pos.z += h;
  vWave = h;

  // 中心差分法线：在当前时刻对波高场采样邻域（动画法线须带同一 t）
  float e = 0.05;
  float hx = waveHeight(pos.xy + vec2(e, 0.0), u_time);
  float hy = waveHeight(pos.xy + vec2(0.0, e), u_time);
  vNormal = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.0));

  vViewPos = (modelViewMatrix * vec4(pos, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
