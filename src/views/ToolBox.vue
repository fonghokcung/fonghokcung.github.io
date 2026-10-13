<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">TourBox · 模型并排陈列</h2>
      <p class="txt-sub">
        并排加载 /tourbox 目录下的 4 个 GLB 模型（白 / 蓝 / 黄 / 黑 四色），
        各自独立摆放、统一缩放、底部对齐，OrbitControls 自由环视。
        加载完成后底部对齐（y 归零）并自动取整体包围盒定相机距离。
      </p>
      <p class="txt-hint">拖拽旋转 · 滚轮缩放 · 右键平移</p>
    </template>

    <template #stage>
      <div v-if="loading" class="loading">模型加载中…</div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* TourBox 演示页：GLTFLoader 并排载入 public/tourbox 下的 4 个 glb。
 * 排列策略：各模型独立包围盒 → 底部对齐 + 水平等间距排开 →
 * 统一缩放到相同高度，相机自动框住全部模型 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';

const layoutRef = ref(null);
const loading = ref(true);

// public/tourbox 下的模型清单（中文文件名由 Vite 原样代理，无需编码处理）
const MODELS = [
  { file: '黑色.glb', label: '黑色' },
  { file: '白色.glb', label: '白色' },
  { file: '蓝色.glb', label: '蓝色' },
  { file: '黄色.glb', label: '黄色' },
];

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let rafId = 0;
let disposed = false;

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value?.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d1b2a');

  // 照明：半球环境光 + 主平行光 + 补光，白色模型不欠曝、黑色模型有轮廓
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.8));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  // 加载期间 loading 提示已覆盖注意力，原点相机渲染空场景合法，无需预设机位

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.8, 0);

  const grid = new THREE.GridHelper(20, 20, 0x3a4a63, 0x243044);
  scene.add(grid);

  loadModels();
  onResize();
  startLoop();
}

/* ===================== 加载并排布模型 ===================== */
// 单个 glb → { model, width, label }；失败 resolve null（allSettled 聚合，不阻塞其余）
function loadOne(item) {
  return new Promise((resolve) => {
    new GLTFLoader().load(
      `/tourbox/${item.file}`,
      (gltf) => {
        if (disposed) return resolve(null);
        const model = gltf.scene;

        // 统一缩放：按包围盒最高维度归一（模型大小不一也能并排等高）
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        model.scale.setScalar(2.2 / maxDim);

        // 缩放后重算包围盒：底部对齐 y=0（落地），量出缩放后宽度
        const scaledBox = new THREE.Box3().setFromObject(model);
        model.position.y = -scaledBox.min.y;
        const width = scaledBox.getSize(new THREE.Vector3()).x;

        resolve({ model, width, label: item.label });
      },
      undefined,
      () => resolve(null), // 404 等失败 → null 占位，其余模型照常排布
    );
  });
}

async function loadModels() {
  const root = new THREE.Group();
  scene.add(root);

  // allSettled：全失败也不抛异常，结果顺序与 MODELS 一一对应
  const settled = await Promise.allSettled(MODELS.map(loadOne));
  if (disposed) return;

  const boxes = settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);
  for (const b of boxes) root.add(b.model);

  arrange(boxes);
  loading.value = false;
}

// 水平等间距排开：间距 = 相邻宽度均值的一半，整体居中于原点
function arrange(boxes) {
  if (!boxes.length) return; // 全部加载失败：维持默认相机位，避免除零得 0 视距
  const GAP = 0.6;
  const totalW =
    boxes.reduce((sum, b) => sum + b.width, 0) + GAP * (boxes.length - 1);
  let cursor = -totalW / 2;
  for (const b of boxes) {
    b.model.position.x = cursor + b.width / 2;
    cursor += b.width + GAP;
  }

  // 相机框住全部：按整体包围盒对角线定距离
  const all = new THREE.Box3();
  for (const b of boxes) all.expandByObject(b.model);
  const size = all.getSize(new THREE.Vector3());
  const center = all.getCenter(new THREE.Vector3());
  const dist =
    (Math.max(size.x, size.y) / 2 / Math.tan((Math.PI / 180) * 22.5)) * 1.25;
  // 真正定机位 的一步。
  camera.position.set(center.x, center.y + size.y * 0.35, center.z + dist);
  controls.target.copy(center);
  controls.update();
}

/* ===================== 渲染循环 ===================== */
function startLoop() {
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
  }
  loop();
}

/* ===================== 自适应 / 清理 ===================== */
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
  disposed = true;
  cancelAnimationFrame(rafId);
  controls?.dispose();
  scene?.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    }
  });
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
}

onMounted(() => {
  init();
});

onBeforeUnmount(() => {
  dispose();
});
</script>

<style scoped>
.loading {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 10;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(13, 27, 42, 0.8);
  color: #e6edf3;
  font-size: 13px;
}
</style>
