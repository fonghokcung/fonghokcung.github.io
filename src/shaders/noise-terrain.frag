uniform vec3 uSunDir;
uniform vec3 uFogColor; // 雾色 = 天空色（JS 侧注入）
uniform float uFogNear; // 雾起始距离（调试俯瞰时拉远=实际关雾）
uniform float uFogFar; // 雾完全混合距离
varying float vHeight;
varying vec3 vNormal;
varying vec2 vPos;
varying vec3 vViewPos; // 相机空间位置（算雾距离用）

void main() {
  // 海拔分层配色：深水 → 浅滩 → 草地 → 岩石 → 雪线
  vec3 deep = vec3(0.05, 0.15, 0.35);
  vec3 shore = vec3(0.20, 0.45, 0.60);
  vec3 grass = vec3(0.25, 0.55, 0.25);
  vec3 rock = vec3(0.45, 0.40, 0.35);
  vec3 snow = vec3(0.95);

  vec3 col;
  if (vHeight < 0.32) col = mix(deep, shore, vHeight / 0.32);
  else if (vHeight < 0.45) col = mix(shore, grass, (vHeight - 0.32) / 0.13);
  else if (vHeight < 0.62) col = mix(grass, rock, (vHeight - 0.45) / 0.17);
  else if (vHeight < 0.75) col = mix(rock, snow, (vHeight - 0.62) / 0.13);
  else col = snow;

  // 方向光（世界空间近似：地形只旋转了 x=-90°，用模型矩阵变换法线）
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, normalize(uSunDir)), 0.0);
  // 高程越高，环境光贡献略增，避免阴面死黑
  float amb = 0.25 + 0.2 * vHeight;
  col *= (amb + (1.0 - amb) * diff);

  // —— 距离雾：远处淡入天空色 → 地形无边界，无穷无尽 ——
  // near/far 与 NoiSe.vue 的 scene.fog 保持一致；地形 20 宽后路径离边缘 7+，
  // 雾程随世界尺度拉长，边缘方向在入雾前已沉入天空色
  float fogFactor = smoothstep(uFogNear, uFogFar, -vViewPos.z);
  col = mix(col, uFogColor, fogFactor);

  gl_FragColor = vec4(col, 1.0);
}
