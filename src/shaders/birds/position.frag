// 位置更新：pos += vel * delta * 15；同时累积翅膀相位（速度越快扇得越快）
// 由 GPUComputationRenderer 包裹编译（自动注入 resolution 定义与 texturePosition/textureVelocity 采样器声明）
uniform float time;
uniform float delta;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 tmpPos = texture2D(texturePosition, uv);
  vec3 position = tmpPos.xyz;
  vec3 velocity = texture2D(textureVelocity, uv).xyz;

  float phase = tmpPos.w;
  phase = mod(phase + delta + length(velocity.xz) * delta * 3.0 + max(velocity.y, 0.0) * delta * 6.0, 62.83);

  gl_FragColor = vec4(position + velocity * delta * 15.0, phase);
}
