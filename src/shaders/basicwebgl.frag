precision mediump float;

uniform vec2 uResolution;

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution - 0.25) * 2.0;
  vec2 st = fract(uv * 4.0);
  gl_FragColor = vec4(st, 0.0, 1.0);
}
