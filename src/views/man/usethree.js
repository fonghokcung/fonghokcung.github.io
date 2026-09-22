/**
 * Vite import 查询后缀详解（?raw 只是其中之一）：
 *
 * | 后缀          | 返回值                                             |
 * |---------------|---------------------------------------------------|
 * | （无）        | JS/JSON → 模块本体；图片等 → URL；CSS → 副作用注入 |
 * | ?raw          | 文件原始内容字符串（不做任何转换）                  |
 * | ?url          | 资源公开 URL（build 后带 hash）                     |
 * | ?inline       | 强制 base64 data URL；CSS 特例：返回 CSS 字符串     |
 * | ?no-inline    | 强制独立 URL（即使小于内联阈值）                    |
 * | ?worker       | Worker 构造函数（可追加 &inline / &url）           |
 * | ?sharedworker | SharedWorker 构造函数（多标签页共享）               |
 *
 * 本文件用 ?raw：拿到 GLSL 源码字符串塞给 ShaderMaterial。
 */
import * as THREE from 'three';
import basicthreejsVert from '@/shaders/basicthreejs.vert?raw';
import basicthreejsFrag from '@/shaders/basicthreejs.frag?raw';

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void} dispose
 */
export function useThreeTriangle(canvas) {
  // alpha: true 帧缓冲带透明通道，与原生版 getContext('webgl') 行为对齐
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // 清屏成全透明 → CSS 背景（--color3）透出来

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();

  // ShaderMaterial：内部完成 program 编译/链接，并托管 uniforms 的每帧上传
  const material = new THREE.ShaderMaterial({
    vertexShader: basicthreejsVert,
    fragmentShader: basicthreejsFrag,
    uniforms: {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(1, 1) },
    },
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  scene.add(mesh);

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      // gl_FragCoord 对应物理绘制缓冲（含 pixelRatio），分辨率需取 drawingBufferSize
      renderer.getDrawingBufferSize(material.uniforms.u_resolution.value);
    }
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let rafId = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  function loop() {
    rafId = requestAnimationFrame(loop);
    timer.update();
    material.uniforms.u_time.value = timer.getElapsed();
    renderer.render(scene, camera);
  }
  loop();

  return () => {
    cancelAnimationFrame(rafId);
    observer.disconnect();
    timer.disconnect();
    mesh.geometry.dispose();
    material.dispose();
    renderer.dispose();
  };
}
