// `gl_FragCoord` 是光栅化阶段按像素固定生成的解析坐标
uniform float u_time;
uniform vec2 u_resolution; // 绘制缓冲尺寸（CSS 尺寸 × pixelRatio）
varying vec2 vUv;

float rand(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

void main() {
  float r = rand(gl_FragCoord.xy / u_resolution.xy);
  gl_FragColor = vec4(vec3(r), 1.0);
}
