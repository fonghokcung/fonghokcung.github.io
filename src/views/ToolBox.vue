<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">ToolBox · GLB 资产陈列与自动环绕取景</h2>
      <p class="txt-sub">
        批量加载策略：GLTFLoader + Promise.allSettled 并发拉取 4 个 GLB，
        单模型失败降级为占位，页面永不阻塞；每个模型按包围盒最大维度
        归一缩放，底部对齐后等间距排开，整体居中于原点。
      </p>
      <p class="txt-sub">
        自动取景：聚合整体包围盒，由相机 FOV 反算视距与俯仰，
        保证任意模型组合一次入画。漫游相机以球坐标驱动——水平角匀速
        公转，俯仰与视距大幅正弦振荡（可达近正上方俯视），随机相位让
        每次进页面轨迹不同。
      </p>
      <p class="txt-hint">
        用户拖拽/缩放时暂停漫游，松手 2s
        后以新位姿为基准恢复，自动动画与人工操作无冲突
      </p>
    </template>

    <template #stage>
      <div v-if="loading" class="loading">模型加载中…</div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* ToolBox 演示页：GLB 资产陈列 + 自动环绕取景。
 * 资产管线：Promise.allSettled 并发加载，单点失败降级不阻塞；
 * 布局：包围盒归一缩放 → 底部对齐 → 等间距排开；
 * 取景：整体包围盒 + FOV 反算视距；
 * 漫游：球坐标驱动（水平公转 + 俯仰/视距正弦振荡），
 * 用户操作时暂停并以拖后位姿为新基准，自动与人工无冲突 */
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
      `${import.meta.env.BASE_URL}tourbox/${item.file}`,
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
  // 真正定机位的一步：抬高 35% 高度俯视，dist 决定框住全部的视距
  camera.position.set(center.x, center.y + size.y * 0.35, center.z + dist);
  controls.target.copy(center);
  controls.update();
}

/* ===================== 渲染循环 ===================== */
// 漫游式公转：水平角 + 俯仰角都随正弦缓摆（非固定圆轨道），视距也周期呼吸，
// 模拟「随便换个角度看看」的观感；速度慢，随机相位让每次进页面轨迹不同。
// 用户拖拽/缩放实时改变球坐标，漫游在新球坐标上叠加继续，互不冲突。
const ORBIT_SPEED = Math.PI / 24; // 水平角速度（rad/s）：7.5°/s，48 秒一圈
const PHI_AMP = 0.75; // 俯仰振荡幅值（rad ≈ 43°）：基准角 ±43°，保证周期性接近正上方俯视
const RHO_AMP = 1.2; // 视距振荡幅值（世界单位）：靠近看细节再拉远看全景
const PHI_MIN = 0.1; // 俯仰下限（rad ≈ 6°，接近地面平视）
const PHI_MAX = 1.45; // 俯仰上限（rad ≈ 83°，接近正上方俯视）
let autoOrbit = true;
// 漫游基准（arrange 取景后记录；用户拖拽后以新位姿为基准重设）
const orbitBase = { phi: 0.35, rho: 8 };
// 随机相位：每次进页面轨迹不同
const PHASE = {
  phi: Math.random() * Math.PI * 2,
  rho: Math.random() * Math.PI * 2,
};
// 用户拖拽期间暂停漫游（拖拽与公转抢相机的体验很差），松手 2s 后恢复；
// 恢复时以用户拖完的位姿为新的振荡基准
let userDragging = false;
let resumeAt = 0;
let rebaseNeeded = false;
function startLoop() {
  controls.addEventListener('start', () => {
    userDragging = true;
  });
  controls.addEventListener('end', () => {
    userDragging = false;
    resumeAt = performance.now() + 2000;
    rebaseNeeded = true;
  });
  let lastT = performance.now();
  let elapsed = 0;
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    elapsed += dt;

    if (autoOrbit && !userDragging && now >= resumeAt) {
      const offset = camera.position.clone().sub(controls.target);
      const rho = offset.length();
      if (rho > 0.001) {
        // 恢复漫游瞬间：把用户拖完的角度/距离记为新基准
        if (rebaseNeeded) {
          rebaseNeeded = false;
          orbitBase.phi = Math.asin(
            THREE.MathUtils.clamp(offset.y / rho, -1, 1),
          );
          orbitBase.rho = rho;
        }
        // 绝对振荡：phi/rho 直接由「基准 + 正弦」给出（不再围绕当前位置积分）
        const phi = THREE.MathUtils.clamp(
          orbitBase.phi + PHI_AMP * Math.sin(elapsed * 0.21 + PHASE.phi),
          PHI_MIN,
          PHI_MAX,
        );
        const theta = Math.atan2(offset.x, offset.z) + ORBIT_SPEED * dt;
        const nextRho = Math.max(
          1.5,
          orbitBase.rho + RHO_AMP * Math.sin(elapsed * 0.13 + PHASE.rho),
        );
        camera.position.set(
          controls.target.x + nextRho * Math.sin(theta) * Math.cos(phi),
          controls.target.y + nextRho * Math.sin(phi),
          controls.target.z + nextRho * Math.cos(theta) * Math.cos(phi),
        );
      }
    }
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
