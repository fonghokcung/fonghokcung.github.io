uniform float u_time;
varying vec2 vUv;

void main() {
  vec2 st = fract(vUv * 4.0);
  gl_FragColor = vec4(st, 0.0, 1.0);
}
