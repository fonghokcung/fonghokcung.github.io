<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import triangleVert from './shaders/triangle.vert?raw';
import theFrag from './shaders/triangle.frag?raw';

const mountRef = ref(null);

let renderer, mesh, rafId, timer;

onMounted(() => {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(800, 800 * 0.618);
  mountRef.value.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  timer = new THREE.Timer();
  timer.connect(document);

  const geometry = new THREE.PlaneGeometry(2, 2);

  mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: triangleVert,
      fragmentShader: theFrag,
      uniforms: {
        u_time: {
          value: 0.0,
        },
      },
    }),
  );
  scene.add(mesh);

  function loop() {
    rafId = requestAnimationFrame(loop);
    timer.update();
    mesh.material.uniforms.u_time.value = timer.getElapsed();
    renderer.render(scene, camera);
  }
  loop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  timer?.disconnect(document); // 摘掉 Timer 挂在 document 上的 visibilitychange 监听
  renderer?.dispose();
  mesh?.geometry?.dispose();
  mesh?.material?.dispose();
  renderer?.domElement?.remove();
});
</script>

<template>
  <section class="bos-chapter">
    <h2>Shader</h2>
    <div ref="mountRef" class="shader-canvas" />
  </section>
</template>

<style scoped>
.bos-chapter {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.shader-canvas {
  width: 800px;
  height: 494.4px;
  max-width: 100%;
  border: 1px solid #ccc;
  overflow: hidden;
}

.shader-canvas canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
