<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">噪声山脉</h2>
      <p class="txt-sub">
        Simplex 2D 噪声 → fBm 分形叠加（四倍频，振幅减半、频率翻倍）生成高度场，
        驱动 PlaneGeometry 6.6
        万顶点位移成山。相机自动漫游：沿山腰随机平滑飞行，
        前向探测地形提前转向，永不撞山。
      </p>
      <p class="txt-hint">自动巡航 · 无需操作</p>
    </template>

    <template #stage></template>
  </ThreeLayout>
</template>

<script setup>
/*
 * 噪声山脉：three.js + 顶点着色器 Simplex 2D noise → fBm 高度场。
 * 技术要点：
 *  1. 高度在顶点着色器里计算（Simplex 2D + 4 倍频 fBm），片元按海拔分层配色
 *  2. 计算法线：中心差分采样邻域高度 → vNormal，供片元做方向光照
 *  3. PlaneGeometry 高分段（256×256），旋转平放成「地形」
 *  4. 相机漫游（noise/fly-camera.js）：随机平滑飞行 + 山体避障，山体本身静止
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import ThreeLayout from '@/components/ThreeLayout.vue';
import noiseTerrainVert from '@/shaders/noise-terrain.vert?raw';
import noiseTerrainFrag from '@/shaders/noise-terrain.frag?raw';
import {
  buildFlightPath,
  FlyCamera,
  terrainHeight,
} from '@/views/noise/fly-camera';

const layoutRef = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let material = null;
let flyCamera = null; // 相机漫游控制器（随机飞行 + 避障）
let terrain = null; // 山地 mesh
let rafId = 0;
let disposed = false;

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  // 无尽感三件套之一：雾色 = 天空色，地平线处地形淡入天空，看不到边界
  const skyColor = new THREE.Color('#0d1b2a');
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 3.2, 7.2); // 数值须与 frag 距离雾一致

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  // 相机漫游 v2：预生成闭合安全路径（生成期已验证不撞山），循环飞行
  const flightPath = buildFlightPath(4.2); // 路径半径随地形放大
  flyCamera = new FlyCamera(camera, flightPath);

  material = new THREE.ShaderMaterial({
    vertexShader: noiseTerrainVert,
    fragmentShader: noiseTerrainFrag,
    uniforms: {
      u_time: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.6).normalize() },
      uFogColor: { value: skyColor }, // 与 scene.background 同色，地平线无缝
    },
  });

  // 20×20 特大地形 + 512 分段：顶点间距 0.039 必须小于 fBm 最高倍频波长，
  // 否则高频欠采样 → 混叠锯齿 + 可见三角面（256 段间距 0.078 是棱棱角角的元凶）
  const geo = new THREE.PlaneGeometry(20, 20, 512, 512);
  terrain = new THREE.Mesh(geo, material);
  terrain.rotation.x = -Math.PI / 2;
  scene.add(terrain);

  // —— 调试：飞行路径可视化（黄线 = 路径，红线 = 撞山垂线），需要时再打开 ——
  // debugPathHelper(flightPath);

  onResize();
  window.addEventListener('resize', onResize);
  startLoop();
}

/* ===================== 调试：飞行路径可视化 + 碰撞检测 =====================
 * 黄线 = 飞行路径；每个采样点与地形比较，低于「地形+净空」的段画成红色线段。
 * 净空口径与 fly-camera.js 一致（0.1）；控制台同步打印违规点数。
 * 平时隐藏；调路径时取消下方函数与 init 中调用两处注释即可 */
// eslint-disable-next-line no-unused-vars
function debugPathHelper(curve) {
  const SEGMENTS = 400;
  const positions = [];
  const hitPositions = [];
  const CLEARANCE = 0.1; // 与生成器 CLEARANCE 严格一致，避免误报
  let hits = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const p = curve.getPointAt(i / SEGMENTS);
    positions.push(p.x, p.y, p.z);
    const ground = terrainHeight(p.x, p.z);
    if (p.y < ground + CLEARANCE) {
      hits++;
      hitPositions.push(p.x, p.y, p.z, p.x, ground, p.z); // 垂直线段：路径点→地面
    }
  }
  const pathLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    ),
    new THREE.LineBasicMaterial({ color: 0xfbd509 }),
  );
  scene.add(pathLine);
  if (hitPositions.length) {
    const hitLine = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(hitPositions, 3),
      ),
      new THREE.LineBasicMaterial({ color: 0xff2020 }),
    );
    scene.add(hitLine);
  }
  console.log(
    `[flight-path] 采样 ${SEGMENTS + 1} 点，撞山嫌疑 ${hits} 处` +
      (hits ? '（红线=路径到地面的垂线）' : '（路径安全）'),
  );
}

/* ===================== 渲染循环：相机漫游需要逐帧推进 ===================== */
function startLoop() {
  const timer = new THREE.Timer();
  timer.connect(document);
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) {
      timer.disconnect();
      return;
    }
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05); // 后台切回防爆
    flyCamera?.update(dt);
    renderer.render(scene, camera);
  }
  loop();
}

function onResize() {
  if (!renderer) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  renderer.setSize(rect.width, rect.height);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}

function dispose() {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);
  terrain?.geometry.dispose();
  material?.dispose();
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
}

onMounted(() => {
  init();
});

onBeforeUnmount(() => {
  dispose();
});
</script>

<style scoped>
/* ThreeLayout 已提供舞台；本页无额外悬浮层 */
</style>
