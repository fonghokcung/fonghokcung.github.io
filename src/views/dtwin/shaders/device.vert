attribute float aAlarm; // 逐实例：是否告警
attribute float aPhase; // 逐实例：呼吸相位，避免 500 台同步齐闪
varying vec3 vColor;
varying vec3 vNormal;
varying float vAlarm;
varying float vPhase;
void main() {
  vColor = instanceColor;  // three 在 USE_INSTANCING_COLOR 下自动注入的逐实例色
  vAlarm = aAlarm;
  vPhase = aPhase;
  // 等比缩放下用 3x3 变换法线即可
  vNormal = normalize(mat3(instanceMatrix) * normal);
  // modelViewMatrix = viewMatrix * modelMatrix（three 内置并集），
  // instanceMatrix 必须紧贴 position：逐实例变换作用在最内层局部坐标上
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
