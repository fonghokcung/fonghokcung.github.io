// 与 basicwebgl.frag 同效果：uv 偏移放大后 fract 平铺，输出红绿坐标渐变网格
// （与 webgl 版完全同构：gl_FragCoord / u_resolution，屏幕空间坐标）
uniform float u_time;
uniform vec2 u_resolution; // 绘制缓冲尺寸（CSS 尺寸 × pixelRatio）
varying vec2 vUv; // 未使用，保持与宿主 varying 声明一致

void main() {
  vec2 uv = (gl_FragCoord.xy / u_resolution.xy - 0.25) * 2.0;
  vec2 st = fract(uv * 4.0);
  gl_FragColor = vec4(st, 0.0, 1.0);
}
