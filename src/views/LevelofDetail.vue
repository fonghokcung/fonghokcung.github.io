<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">LOD · 细节层次</h2>
      <p class="txt-sub">
        LOD（Level of Detail，细节层次）是 3D
        开发里最常用的性能优化手段：同一个物体准备好几份精度不同的模型，
        根据它离相机的远近动态切换——近用高精度（面数多），远用低精度（面数少），
        极远处甚至用一个简单方块代替。
      </p>
      <p class="txt-sub">
        远处的物体在屏幕上只占几个像素，再精细的细节人眼也分辨不出，
        却要和近处物体一样占用顶点、光栅化与片元开销。LOD
        把这份浪费省下来，让预算集中在玩家真正看得清的地方。
      </p>
      <p class="txt-sub">
        Three.js 用 THREE.LOD 封装这套机制：addLevel(mesh, distance)
        按由近到远注册各级模型与切换距离，每帧调用一次 lod.update(camera)，
        它会比较相机与物体的距离，自动只显示当前层级、隐藏其余层级。
      </p>
      <p class="txt-sub">
        本页在地面上排布 49 个 LOD 球体，每个物体含四级模型： 高精度球（64×32
        分段）→ 中精度（24×12）→ 低精度（8×6）→ 立方体。四个层级用黄 / 蓝 / 绿 /
        米白（取自全局配色变量）区分， 拖拽旋转、滚轮缩放，
        即可观察物体随距离变色、左上角总三角面数骤降。
      </p>
    </template>

    <template #stage>
      <div class="hud">
        <div class="hud__row">
          <span class="hud__label">总三角面数</span>
          <span class="hud__value">{{ triCount.toLocaleString() }}</span>
        </div>
        <div class="hud__row">
          <span class="hud__label">相机距离</span>
          <span class="hud__value">{{ camDist.toFixed(0) }}</span>
        </div>
        <ul class="hud__legend">
          <li v-for="(lv, i) in LOD_DEFS" :key="lv.label">
            <span class="dot" :style="{ background: '#' + lv.colorHex }"></span>
            {{ lv.label }} · {{ levelCounts[i] }} 个
          </li>
        </ul>
        <div class="hud__btns">
          <button :class="{ active: autoDolly }" @click="toggleDolly">
            {{ autoDolly ? '停止推拉' : '自动推拉' }}
          </button>
          <button :class="{ active: wireframe }" @click="toggleWireframe">
            线框
          </button>
        </div>
      </div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* LOD 演示页：49 个三级球体 + 立方体替身，颜色随当前层级变化。
 * OrbitControls 自由观察；「自动推拉」让相机沿视线方向周期缩放，
 * 无需手动操作也能看到整体 LOD 切换；HUD 实时统计面数与各层级数量 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';

const layoutRef = ref(null);

// HUD 响应式数据
const triCount = ref(0);
const camDist = ref(0);
const levelCounts = ref([0, 0, 0, 0]);
const autoDolly = ref(true);
const wireframe = ref(false);

// 层级定义：distance = 进入该级的最近距离（由近到远注册）
// 颜色取自 base.css：--color-primary / --color2 / --color3 / --color-bg
const LOD_DEFS = [
  { label: '高精度', distance: 0, colorHex: 'fbd509', seg: [64, 32] },
  { label: '中精度', distance: 18, colorHex: '3d98ff', seg: [24, 12] },
  { label: '低精度', distance: 38, colorHex: '51cd85', seg: [8, 6] },
  { label: '立方体', distance: 65, colorHex: 'f8f8f6', box: true },
];

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let lods = []; // 全部 LOD 对象，每帧 update + 统计
let sharedGeometries = []; // 四级共享几何
let sharedMaterials = []; // 四级共享材质（切换线框只需改 4 个）
let levelTris = []; // 每级单个物体的三角面数
let rafId = 0;
let disposed = false;
let frameNo = 0;

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  const skyColor = new THREE.Color('#0d1b2a');
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 110, 220);

  // 照明：半球环境光 + 主平行光
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.6);
  sun.position.set(0.5, 0.9, 0.4);
  scene.add(sun);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 24, 52);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // 不让视角钻进地面下
  controls.minDistance = 8;
  controls.maxDistance = 180;
  controls.update();

  // —— 地面网格 ——
  const grid = new THREE.GridHelper(60, 24, 0x3a4a63, 0x243044);
  grid.position.y = 0;
  scene.add(grid);

  buildSharedAssets();
  populateLods();

  onResize();
  startLoop();
}

/* ===================== 共享几何 / 材质 =====================
 * 49 个物体 × 4 级 = 196 个 mesh，但几何与材质只各建 4 份 */
function buildSharedAssets() {
  sharedGeometries = LOD_DEFS.map((def) =>
    def.box
      ? new THREE.BoxGeometry(1.5, 1.5, 1.5)
      : new THREE.SphereGeometry(1, def.seg[0], def.seg[1]),
  );
  sharedMaterials = LOD_DEFS.map((def) => {
    // 低精度球开 flatShading，切面感更明显，方便肉眼分辨「降级」
    const flat = def.box || def.seg[0] <= 8;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color('#' + def.colorHex),
      flatShading: flat,
      roughness: 0.65,
      metalness: 0.05,
    });
  });
  levelTris = sharedGeometries.map(
    (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3,
  );
}

/* ===================== 排布 7×7 的 LOD 物体 ===================== */
function populateLods() {
  const SPAN = 7;
  const GAP = 5;
  const HALF = ((SPAN - 1) * GAP) / 2;
  for (let x = 0; x < SPAN; x++) {
    for (let z = 0; z < SPAN; z++) {
      const lod = new THREE.LOD();
      LOD_DEFS.forEach((def, i) => {
        const mesh = new THREE.Mesh(sharedGeometries[i], sharedMaterials[i]);
        mesh.castShadow = false;
        lod.addLevel(mesh, def.distance);
      });
      lod.position.set(x * GAP - HALF, 1.2, z * GAP - HALF);
      scene.add(lod);
      lods.push(lod);
    }
  }
}

/* ===================== 控制按钮 ===================== */
function toggleDolly() {
  autoDolly.value = !autoDolly.value;
}

function toggleWireframe() {
  wireframe.value = !wireframe.value;
  for (const mat of sharedMaterials) mat.wireframe = wireframe.value;
}

/* ===================== 渲染循环 ===================== */
function startLoop() {
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) return;

    // 自动推拉：沿「目标→相机」方向把视距在 14~100 之间正弦拉缩，
    // OrbitControls.update 每帧从相机当前位置重建球坐标，不会与之冲突
    if (autoDolly.value) {
      const t = performance.now() * 0.001;
      const radius = 57 + 43 * Math.sin((t * Math.PI * 2) / 26);
      const dir = new THREE.Vector3()
        .subVectors(camera.position, controls.target)
        .normalize();
      camera.position.copy(controls.target).addScaledVector(dir, radius);
    }
    controls.update();

    // LOD 选择：必须每帧对每个 LOD 调用
    for (const lod of lods) lod.update(camera);

    renderer.render(scene, camera);

    // HUD 每 6 帧统计一次，避免高频响应式更新
    if (++frameNo % 6 === 0) updateHud();
  }
  loop();
}

function updateHud() {
  const counts = [0, 0, 0, 0];
  let tris = 0;
  for (const lod of lods) {
    const lv = lod.getCurrentLevel();
    counts[lv]++;
    tris += levelTris[lv];
  }
  levelCounts.value = counts;
  triCount.value = tris;
  camDist.value = camera.position.distanceTo(controls.target);
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
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  controls?.dispose();
  for (const geo of sharedGeometries) geo.dispose();
  for (const mat of sharedMaterials) mat.dispose();
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
/* 左上角 HUD：面数 / 距离 / 层级图例 / 按钮 */
.hud {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 10;
  min-width: 172px;
  padding: 10px 12px;
  color: #e6edf3;
  background: rgba(20, 30, 45, 0.72);
  border: 1px solid rgba(230, 237, 243, 0.25);
  border-radius: 8px;
  backdrop-filter: blur(4px);
}
.hud__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11px;
  line-height: 1.8;
}
.hud__label {
  color: rgba(230, 237, 243, 0.7);
}
.hud__value {
  font-weight: bold;
  font-variant-numeric: tabular-nums;
}
.hud__legend {
  margin: 8px 0 2px;
  padding-top: 8px;
  border-top: 1px solid rgba(230, 237, 243, 0.2);
  list-style: none;
}
.hud__legend li {
  display: flex;
  align-items: center;
  font-size: 11px;
  line-height: 1.9;
}
.dot {
  width: 9px;
  height: 9px;
  margin-right: 7px;
  border-radius: 2px;
}
.hud__btns {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.hud__btns button {
  flex: 1;
  padding: 5px 0;
  font-size: 11px;
  color: #e6edf3;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(230, 237, 243, 0.35);
  border-radius: 5px;
}
.hud__btns button:hover {
  background: rgba(60, 80, 105, 0.7);
}
.hud__btns button.active {
  color: #0d1b2a;
  background: #7ee787;
  border-color: #7ee787;
}
</style>
