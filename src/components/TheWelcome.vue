<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
// 着色器源码抽离到独立 .vert/.frag 文件（本目录 shaders/ 下），
// ?raw 由 Vite 内置支持：编译期把文件内容作为字符串内联，零运行时开销
import triangleVert from './shaders/triangle.vert?raw'
import triangleFrag from './shaders/triangle.frag?raw'

const mountRef = ref(null)

let renderer, mesh

onMounted(() => {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(800, 800 * 0.618)
  mountRef.value.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  // 三角形顶点: (0,0), (0.5,0), (0,1)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.5, 0, 0, 0, 1, 0], 3))

  mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: triangleVert, fragmentShader: triangleFrag }))
  scene.add(mesh)

  renderer.render(scene, camera)
})

onBeforeUnmount(() => {
  renderer?.dispose()
  mesh?.geometry?.dispose()
  mesh?.material?.dispose()
  renderer?.domElement?.remove()
})
</script>

<template>
  <section class="bos-chapter">
    <h2>最简 Shader 模板 — 黄色三角形</h2>
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
  height: 494.4px; /* 800 * 0.618 */
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
