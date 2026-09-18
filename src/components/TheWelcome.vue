<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
// 着色器源码抽离到独立 .vert/.frag 文件（本目录 shaders/ 下），
// ?raw 由 Vite 内置支持：编译期把文件内容作为字符串内联，零运行时开销
import triangleVert from './shaders/triangle.vert?raw'
import triangleFrag from './shaders/triangle.frag?raw'

const mountRef = ref(null)

let renderer, mesh, rafId, timer

onMounted(() => {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(800, 800 * 0.618)
  mountRef.value.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  // THREE.Timer：r185+ 官方推荐时间源（Clock 的替代品）
  // connect(document) 接入 Page Visibility API：切走标签页暂停计时，回来不跳帧
  timer = new THREE.Timer()
  timer.connect(document)

  // 全屏四边形：PlaneGeometry(2,2) 坐标恰好 [-1,1]²，直通裁剪空间铺满视口；
  // 自带 position/uv/index 完整 attribute，uv 可直接在顶点着色器里消费
  const geometry = new THREE.PlaneGeometry(2, 2)

  /**
   * uniform: u_time
   * 1.在ShaderMaterial中定义
   * 2.在timer中更新
   * 3.src\components\shaders\triangle.frag中使用sin,令其在0-1变化并赋值给r通道
   */
  mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: triangleVert,
      fragmentShader: triangleFrag,
      uniforms: {
        u_time: {
          value: 0.0,
        },
      },
    }),
  )
  scene.add(mesh)

  // 渲染循环：每帧先 update() 推进时间，再把运行秒数写进 u_time 驱动颜色动画
  function loop() {
    rafId = requestAnimationFrame(loop)
    timer.update() // Timer 必须显式 update 才推进（区别于 Clock 的 getDelta 自推进）
    mesh.material.uniforms.u_time.value = timer.getElapsed()
    renderer.render(scene, camera)
  }
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  renderer?.dispose()
  mesh?.geometry?.dispose()
  mesh?.material?.dispose()
  renderer?.domElement?.remove()
})
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
