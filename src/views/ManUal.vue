<script setup>
/**
 * 原生 WebGL vs three.js 并排对比页：同一份 triangle.vert/frag，
 * 左边裸 WebGL 手写全套管线，右边 three.js 托管——逐块对应看框架做了什么。
 * 场景逻辑全部在 man/usewebgl.js 与 man/usethree.js，本组件只做挂载与清理。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useWebGLTriangle } from '@/views/man/usewebgl';
import { useThreeTriangle } from '@/views/man/usethree';

const webglCanvasRef = ref(null);
const threeCanvasRef = ref(null);
let disposeWebGL = null;
let disposeThree = null;

onMounted(() => {
  disposeWebGL = useWebGLTriangle(webglCanvasRef.value);
  disposeThree = useThreeTriangle(threeCanvasRef.value);
});

onBeforeUnmount(() => {
  disposeWebGL?.();
  disposeThree?.();
  disposeWebGL = null;
  disposeThree = null;
});
</script>
<template>
  <div class="ManUal__vue">
    <section class="WebGL">
      <canvas ref="webglCanvasRef"></canvas>
    </section>
    <section class="threejs">
      <canvas ref="threeCanvasRef"></canvas>
    </section>
  </div>
</template>
<style scoped>
/* 預設（移动端 <768px）：上下两行，两个 canvas 各占半屏高 */
.ManUal__vue {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 1fr;
  height: 100vh;
  height: 100dvh;
  .WebGL,
  .threejs {
    position: relative;
    display: block;
    border: 10px solid black;
    min-width: 0;
    min-height: 0;
    /* canvas 铺满父级：块级默认 inline 基线会留缝，显式 block + 100% 尺寸 */
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      background: var(--color3);
    }
  }
}

/* 桌面端 ≥768px：左右两栏并排对比 */
@media (min-width: 768px) {
  .ManUal__vue {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
}
</style>
