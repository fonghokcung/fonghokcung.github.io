import basicwebglVert from '@/shaders/basicwebgl.vert?raw';
import basicwebglFrag from '@/shaders/basicwebgl.frag?raw';

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader 编译失败: ${log}`);
  }
  return shader;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void} dispose
 */
export function useWebGLTriangle(canvas) {
  const gl = canvas.getContext('webgl');
  if (!gl) throw new Error('当前浏览器不支持 WebGL');

  const vs = compile(gl, gl.VERTEX_SHADER, basicwebglVert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, basicwebglFrag);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program 链接失败: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(program);

  // 4 顶点矩形 [-0.5,0.5]² + 索引拆两个三角形（对角 2-1 共享边）
  const data = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  const locPos = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(locPos);
  gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

  const locResolution = gl.getUniformLocation(program, 'uResolution');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const { clientWidth: w, clientHeight: h } = canvas;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.uniform2f(locResolution, canvas.width, canvas.height);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let rafId = 0;
  const t0 = performance.now();
  function loop() {
    rafId = requestAnimationFrame(loop);
    gl.uniform1f(
      gl.getUniformLocation(program, 'u_time'),
      (performance.now() - t0) / 1000,
    );
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }
  loop();

  return () => {
    cancelAnimationFrame(rafId);
    observer.disconnect();
    gl.deleteBuffer(vbo);
    gl.deleteBuffer(ibo);
    gl.deleteProgram(program);
  };
}
