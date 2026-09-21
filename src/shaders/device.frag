uniform float uTime;
uniform vec3 uLightDir;
varying vec3 vColor;
varying vec3 vNormal;
varying float vAlarm;
varying float vPhase;
void main() {
  // 简化 Lambert：环境 + 漫反射
  float diff = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
  vec3 col = vColor * (0.45 + 0.6 * diff);

  // 呼吸动画只在 GPU 算 —— CPU 每帧只写一个 uTime uniform，
  // 各台的闪烁节奏差异靠逐实例 aPhase 在着色器里错开；
  // 若在 JS 里每帧逐台 setColorAt 再上传 500×3 float，CPU 侧必卡
  // GPU side consumption: sine wave shaping x(t) = A*sin(w*t + phi)
  float breath = 0.5 + 0.5 * sin(uTime * 3.0 + vPhase);
  // vAlarm 作 0/1 门控（branchless）：只有告警机叠加呼吸亮度，
  // 运行/停机整项乘 0 归零，GPU 无分支开销
  col += vAlarm * breath * 0.55 * vColor;

  gl_FragColor = vec4(col, 1.0);
  // 色彩空间：着色器里算的是线性色，不加这段输出转 sRGB，
  // 画面整体会发暗发灰（three 只给内置材质自动接 colorspace_fragment）
  #include <colorspace_fragment>
}
