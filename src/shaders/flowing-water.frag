uniform vec3 uSunDir;
uniform vec3 uFogColor; // 雾色 = 天空色（JS 侧注入）
uniform float uFogNear;
uniform float uFogFar;
varying float vWave;
varying vec3 vNormal;
varying vec3 vViewPos;

void main() {
  // 水色：波谷深蓝 → 波面浅蓝；波峰顶部白色泡沫
  vec3 deep = vec3(0.02, 0.12, 0.28);
  vec3 shallow = vec3(0.1, 0.35, 0.5);
  vec3 col = mix(deep, shallow, smoothstep(-0.15, 0.15, vWave));
  float crest = smoothstep(0.11, 0.18, vWave);
  col = mix(col, vec3(0.92), crest);

  // 方向光漫反射（法线随波动 → 水面有流动的明暗闪烁）
  float diff = max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);
  col *= 0.45 + 0.7 * diff;

  // 距离雾：远处水面淡入天空，地平线无边界
  float fogFactor = smoothstep(uFogNear, uFogFar, -vViewPos.z);
  col = mix(col, uFogColor, fogFactor);

  gl_FragColor = vec4(col, 1.0);
}
