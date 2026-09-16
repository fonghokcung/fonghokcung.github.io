// 最简顶点着色器: 直接把顶点坐标作为裁剪空间坐标输出
void main() {
  gl_Position = vec4(position, 1.0);
}
