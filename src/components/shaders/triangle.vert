// 最简顶点着色器: 直接把顶点坐标作为裁剪空间坐标输出，
// 同时把 uv attribute 经 varying 传给片元着色器

varying vec2 vUv; // 类型必须声明：uv 是 vec2，缺类型 → 编译错误
void main() {
  vUv = uv; // uv 由 three.js 几何体自带（BufferGeometry 未设置 uv 时值为默认 [0,1]）
  gl_Position = vec4(position, 1.0);
}
