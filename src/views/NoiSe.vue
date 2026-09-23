<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">噪声山脉</h2>

      <p class="txt-sub">
        柏林噪声（Perlin Noise） 是一种由 Ken Perlin 在 1983
        年发明的梯度噪声算法。
      </p>
      <p class="txt-sub">
        为什么需要柏林噪声呢？我们首先得说说纯随机噪声，纯随机噪声是每个像素点独立随机取值，结果像电视雪花，毫无规律。这种噪声没有空间连贯性，不适合模拟自然现象。而柏林噪声的核心目标是相邻点的值应该相近，整体平滑连续，但又带有随机性。
      </p>
      <div class="pipeline-note">
        <p class="txt-sub">
          本示例更好的做法是游戏/影视行业的标准内容管线——离线烘焙，运行时播放，
          「两山之间」的飞行效果在这条管线里几乎是必然的。
        </p>
        <p class="txt-sub">
          1. 地形生成：Gaea / World Machine / Houdini / World Creator（Blender
          亦可）用 Perlin 节点 + 水力侵蚀生成，烤死成高度图、纹理与网格；
        </p>
        <p class="txt-sub">
          2.
          路径调整：在能看见地形全貌的样条编辑器里，手工把曲线从两座山峰之间拖过去，
          并加关键帧控制高低与速度；
        </p>
        <p class="txt-sub">
          3. 导出载入：GLTF 模型 + 曲线控制点 JSON，运行时只读——不再计算噪声，
          也就没有一致性负担和路径被架高的问题。
        </p>
        <p class="txt-sub">
          关键区别是 bake-time 与
          runtime，而非程序化与手工：三维软件里同样是程序化生成，
          只在制作期烘焙。侵蚀模拟计算量大、必须离线，它产生的才是真实山脉的分水岭与山谷；
          原始 Perlin/fBm 本质只是「起伏的泡泡」。
        </p>
      </div>
      <p class="txt-sub">
        当前页面采用运行时程序化：零资产、每次刷新地形不同，代价是美学质量靠运气、
        安全靠收敛器。折中方案是地形离线烘焙、路径在导出的高度图上运行时搜索，
        兼顾真实山形与路径随机性。
      </p>
      <p class="txt-hint">质量上限在离线管线 · 灵活性在运行时管线</p>
    </template>

    <template #stage>
      <button class="overview-btn" @click="toggleMode">
        {{ isFlying ? '全貌' : '返回飞行' }}
      </button>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* 噪声山脉页面：顶点着色器用经典 Perlin 2D + fBm 生成地形，
 * 相机沿预生成闭合路径自动巡航（fly-camera.js）。
 * 两种模式：飞行（默认）/ 全貌（OrbitControls 俯瞰，路径曲线同步显隐） */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import noiseTerrainVert from '@/shaders/noise-terrain.vert?raw';
import noiseTerrainFrag from '@/shaders/noise-terrain.frag?raw';
import {
  buildFlightPath,
  CLEARANCE,
  FlyCamera,
  PERM,
  terrainHeight,
} from '@/views/noise/fly-camera';

const layoutRef = ref(null);
const isFlying = ref(true); // true=飞行模式（默认）；false=全貌模式

let renderer = null;
let scene = null;
let camera = null;
let material = null;
let flyCamera = null; // 路径飞行控制器
let controls = null; // 全貌模式的轨道控制器
let terrain = null; // 地形 mesh
let pathHelpers = []; // 路径可视化对象（仅全貌模式可见）
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
  // 雾色 = 天空色：远处地形淡入天空，看不到地形边界
  const skyColor = new THREE.Color('#0d1b2a');
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 3.2, 7.2); // 数值与片元距离雾一致

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  const flightPath = buildFlightPath(4.2);
  flyCamera = new FlyCamera(camera, flightPath);

  material = new THREE.ShaderMaterial({
    vertexShader: noiseTerrainVert,
    fragmentShader: noiseTerrainFrag,
    wireframe: true, // 线框模式；恢复实体着色删掉本行
    uniforms: {
      u_time: { value: 0 },
      uPerm: { value: PERM }, // 置换表：CPU/GPU 共享，地形逐点一致
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.6).normalize() },
      uFogColor: { value: skyColor },
      uFogNear: { value: 3.2 },
      uFogFar: { value: 7.2 },
    },
  });

  // 20 宽地形，512 分段：顶点间距须小于 fBm 最高倍频波长，否则混叠出棱角
  const geo = new THREE.PlaneGeometry(20, 20, 512, 512);
  terrain = new THREE.Mesh(geo, material);
  terrain.rotation.x = -Math.PI / 2; // PlaneGeometry 默认在 xy 平面，旋转平放
  scene.add(terrain);

  // 路径可视化：默认飞行模式隐藏，全貌模式显示
  pathHelpers = debugPathHelper(flightPath);
  for (const obj of pathHelpers) obj.visible = false;

  onResize();
  window.addEventListener('resize', onResize);
  startLoop();
}

/* ===================== 路径可视化 + 碰撞统计 =====================
 * 黄线 = 路径；路径点低于「地形+净空」处画红色垂线并计数。
 * 返回创建的对象数组，由模式切换控制显隐 */
function debugPathHelper(curve) {
  const helpers = [];
  const SEGMENTS = 400;
  const positions = [];
  const hitPositions = [];
  let hits = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const p = curve.getPointAt(i / SEGMENTS);
    positions.push(p.x, p.y, p.z);
    const ground = terrainHeight(p.x, p.z);
    if (p.y < ground + CLEARANCE) {
      hits++;
      hitPositions.push(p.x, p.y, p.z, p.x, ground, p.z);
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
  helpers.push(pathLine);
  if (hitPositions.length) {
    const hitLine = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(hitPositions, 3),
      ),
      new THREE.LineBasicMaterial({ color: 0xff2020 }),
    );
    scene.add(hitLine);
    helpers.push(hitLine);
  }
  console.log(
    `[flight-path] 采样 ${SEGMENTS + 1} 点，撞山嫌疑 ${hits} 处` +
      (hits ? '（红线=路径到地面的垂线）' : '（路径安全）'),
  );
  return helpers;
}

/* ===================== 模式切换：飞行 ⇄ 全貌 ===================== */
function toggleMode() {
  if (!renderer) return;
  isFlying.value = !isFlying.value;
  if (isFlying.value) {
    // 回飞行：controls 销毁，下一帧 flyCamera.update 把相机拉回路径当前点
    controls?.dispose();
    controls = null;
  } else {
    // 进全貌：拉高俯瞰，启用 controls
    camera.position.set(0, 12, 13);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.update();
  }
  // 雾程：飞行 3.2~7.2；全貌 100~200（实际关雾）
  const near = isFlying.value ? 3.2 : 100;
  const far = isFlying.value ? 7.2 : 200;
  scene.fog.near = near;
  scene.fog.far = far;
  material.uniforms.uFogNear.value = near;
  material.uniforms.uFogFar.value = far;
  for (const obj of pathHelpers) obj.visible = !isFlying.value;
}

/* ===================== 渲染循环 ===================== */
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
    const dt = Math.min(timer.getDelta(), 0.05); // 切后台再回来防爆发
    if (isFlying.value) flyCamera?.update(dt);
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
  controls?.dispose();
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
.pipeline-note p {
  font-style: italic;
}
.overview-btn {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 10;
  padding: 7px 16px;
  font-size: 13px;
  color: #e6edf3;
  cursor: pointer;
  background: rgba(20, 30, 45, 0.72);
  border: 1px solid rgba(230, 237, 243, 0.3);
  border-radius: 6px;
  backdrop-filter: blur(4px);
}
.overview-btn:hover {
  background: rgba(40, 55, 75, 0.9);
}
</style>
